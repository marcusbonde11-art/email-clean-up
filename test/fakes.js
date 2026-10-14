/**
 * Minimal in-memory fakes of the Apps Script services the agent uses, so a whole
 * run (trial and live) can be exercised in Node.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeRange {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) {
        const v = (this.sheet.cells[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (this.row + this.rows - 1 > this.sheet.maxRows) throw new Error('Range out of bounds');
    values.forEach((line, r) => line.forEach((v, c) => {
      const row = this.sheet.cells[this.row - 1 + r] || (this.sheet.cells[this.row - 1 + r] = []);
      this.sheet.written.push(v);
      // Mimic Sheets: a leading apostrophe forces text and is not shown.
      row[this.col - 1 + c] = typeof v === 'string' && v[0] === "'" ? v.slice(1) : v;
    }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const row = this.sheet.cells[this.row - 1 + r];
      if (row) row[this.col - 1 + c] = '';
    }
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setWrap() { return this; }
  insertCheckboxes() { return this; }
  setDataValidation() { return this; }
  setNumberFormat() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.written = []; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      if ((this.cells[i] || []).some(v => v !== '' && v !== undefined)) return i + 1;
    }
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  setFrozenRows() {}
  hideColumns() {}
  setColumnWidth() {}
  /** Rows as objects keyed by the header row. */
  rowsAsObjects() {
    const [header, ...rows] = this.getRange(1, 1, this.getLastRow(), 12).getValues();
    return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]).filter(([h]) => h)));
  }
}

class FakeSpreadsheet {
  constructor(name) { this.name = name; this.sheets = [new FakeSheet('Sheet1')]; }
  getId() { return 'sheet-1'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/sheet-1'; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n, i) { const s = new FakeSheet(n); this.sheets.splice(i, 0, s); return s; }
}

/**
 * @param {Array} threads  Gmail API thread resources (format=metadata) plus test-only fields:
 *   _matches: function(query) -> boolean, used to decide which search passes return the thread.
 */
function makeWorld(threads) {
  const props = {};
  const triggers = [];
  const labels = [{ id: 'INBOX', name: 'INBOX' }];
  const state = { ss: null, trashed: [], labelled: [], fetched: [], sent: [], events: [], uuids: 0,
    now: Date.parse('2026-10-18T07:00:00Z') };
  const byId = id => threads.find(t => t.id === id);
  const inInbox = t => !state.trashed.includes(t.id);

  const Gmail = {
    Users: {
      Threads: {
        list(_, opts) {
          const matches = threads.filter(t => inInbox(t) && t._matches(opts.q));
          const start = Number(opts.pageToken || 0);
          const page = matches.slice(start, start + opts.maxResults);
          return { threads: page.map(t => ({ id: t.id })),
            nextPageToken: start + opts.maxResults < matches.length ? String(start + opts.maxResults) : undefined };
        },
        get(_, id) {
          const t = byId(id);
          if (!t) throw new Error('Not Found');
          return JSON.parse(JSON.stringify({ id: t.id, messages: t.messages }));
        },
        modify(body, _, id) {
          const t = byId(id);
          t.messages.forEach(m => { m.labelIds = Array.from(new Set([...(m.labelIds || []), ...body.addLabelIds])); });
          state.labelled.push([id, body.addLabelIds[0]]);
        },
        trash(_, id) { state.trashed.push(id); state.events.push('trash:' + id); },
      },
      Messages: {
        send(body) {
          const raw = Buffer.from(body.raw, 'base64url').toString('utf8');
          state.sent.push(raw);
          state.events.push('send:' + raw.match(/^To: (.*)$/m)[1]);
        },
      },
      Labels: {
        list() { return { labels: labels.slice() }; },
        create(body) {
          const l = { id: 'Label_' + (labels.length + 100), name: body.name };
          labels.push(l);
          return l;
        },
      },
    },
  };

  const globals = {
    console: { log() {}, error() {} },
    Gmail,
    SpreadsheetApp: {
      create(name) { state.ss = new FakeSpreadsheet(name); return state.ss; },
      openById() { return state.ss; },
      newDataValidation() {
        const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) };
        return b;
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; },
      }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@gmail.com' }) },
    Utilities: {
      getUuid: () => (++state.uuids).toString(16).padStart(8, '0') + '-0000',
      Charset: { UTF_8: 'UTF-8' },
      base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64url'),
    },
    UrlFetchApp: {
      fetch(url, opts) {
        state.fetched.push([opts.method, url, opts.payload || '']);
        state.events.push('fetch:' + url);
        return { getResponseCode: () => (/fail/.test(url) ? 500 : 200) };
      },
    },
    ScriptApp: {
      WeekDay: { SUNDAY: 'SUNDAY' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger(fn) {
        const b = { timeBased: () => b, everyWeeks: () => b, onWeekDay: () => b, atHour: () => b, after: () => b,
          create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
        return b;
      },
    },
  };

  const context = vm.createContext(globals);
  const src = path.join(__dirname, '..', 'src');
  ['Classifier.js', 'Config.js', 'Sheet.js', 'Gmail.js', 'Main.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), context, { filename: f });
  });
  const api = vm.runInContext(
    '({ setup, runNow, continueRun, CONFIG, resetCaches: () => { LABELS_BY_NAME_ = null; } })', context);
  /** Makes every Date.now() call advance the clock, to force runs to split into many segments. */
  const tickPerCall = ms => vm.runInContext(
    '(() => { let t = ' + state.now + '; Date.now = () => (t += ' + ms + '); })()', context);
  return { api, state, props, triggers, labels, tickPerCall, sheet: name => state.ss.getSheetByName(name) };
}

module.exports = { makeWorld };
