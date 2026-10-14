/**
 * The "Email Cleanup Review" Google Sheet: creation, reading and writing.
 */

const COLUMNS = {
  REVIEW: ['Sender', 'Subject', 'Date', 'Reason', 'Decision', 'Link', 'Sender Email', 'Thread ID', 'Logged On'],
  TRIAL: ['Sender', 'Subject', 'Date', 'Why it would be deleted', 'Decision', 'Link', 'Sender Email',
    'Thread ID', 'Logged On'],
  RULES: ['Sender Email', 'Rule', 'Learned From', 'Learned On'],
  FOLDERS: ['Created On', 'Folder Name', 'Why', 'Emails Filed'],
  DELETED: ['Sender', 'Subject', 'Date', 'Rule', 'Link', 'Status', 'Sender Email', 'Thread ID', 'Run ID'],
  RUNS: ['Started', 'Finished', 'Mode', 'Threads Checked', 'Deleted', 'New Review Rows', 'Kept',
    'Sorted into Folders', 'New Folders', 'Notes'],
};

const HIDDEN_COLUMNS = {
  REVIEW: ['Sender Email', 'Thread ID'],
  TRIAL: ['Sender Email', 'Thread ID'],
  DELETED: ['Thread ID', 'Run ID'],
};

const SETTING = {
  TRIAL_APPROVED: 'Trial approved',
  WIFE: 'Wife email addresses',
  WORK_DOMAINS: 'Work email domains',
  WORK_KEYWORDS: 'Extra work keywords',
  KIDS: 'Kid names',
  SCHOOL: 'School names or domains',
  MODE: 'Current mode',
  LAST_RUN: 'Last run finished',
};

const SETTINGS_ROWS = [
  [SETTING.TRIAL_APPROVED, false, 'Tick this once the Trial Deletions tab looks right. Real deletions start on ' +
    'the next weekly run. Until then every run is a trial: nothing is deleted or moved.'],
  [SETTING.WIFE, '', 'Comma-separated. Email from these addresses is never deleted or moved. Required before ' +
    'real deletions start.'],
  [SETTING.WORK_DOMAINS, '', 'Comma-separated, e.g. acme.com. Email from these domains is protected and filed ' +
    'under Work.'],
  [SETTING.WORK_KEYWORDS, '', 'Comma-separated words or project names that mark an email as work.'],
  [SETTING.KIDS, '', 'Comma-separated first names. Email mentioning them is protected and filed under School.'],
  [SETTING.SCHOOL, '', 'Comma-separated school names or email domains (e.g. "Lincoln Elementary, lincolnps.org").'],
  ['', '', ''],
  [SETTING.MODE, 'Trial', 'Filled in by the agent.'],
  [SETTING.LAST_RUN, '', 'Filled in by the agent.'],
];

const TAB_ORDER = ['REVIEW', 'TRIAL', 'SETTINGS', 'RULES', 'FOLDERS', 'DELETED', 'RUNS'];

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('No review sheet yet. Run setup() first.');
  return SpreadsheetApp.openById(id);
}

function ensureSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  if (props.getProperty('SPREADSHEET_ID')) {
    ss = spreadsheet_();
  } else {
    ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    ss.getSheets()[0].setName(CONFIG.TAB.REVIEW);
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  TAB_ORDER.forEach((key, i) => ensureTab_(ss, key, i));
  return ss;
}

function ensureTab_(ss, key, index) {
  const name = CONFIG.TAB[key];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name, index);
  if (sh.getLastRow() > 0) return sh;

  if (key === 'SETTINGS') {
    sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]).setFontWeight('bold');
    sh.getRange(2, 1, SETTINGS_ROWS.length, 3).setValues(SETTINGS_ROWS);
    sh.getRange(2, 2).insertCheckboxes();
    sh.getRange(2, 1, SETTINGS_ROWS.length, 1).setFontWeight('bold');
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(2, 320);
    sh.setColumnWidth(3, 620);
    sh.getRange(2, 3, SETTINGS_ROWS.length, 1).setWrap(true);
    sh.setFrozenRows(1);
    return sh;
  }

  const cols = COLUMNS[key];
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  (HIDDEN_COLUMNS[key] || []).forEach(h => sh.hideColumns(cols.indexOf(h) + 1));
  // IDs are text; without this Sheets may turn an all-digit ID into a rounded number.
  ['Thread ID', 'Run ID', 'Sender Email'].filter(h => cols.indexOf(h) !== -1)
    .forEach(h => sh.getRange(1, cols.indexOf(h) + 1, sh.getMaxRows(), 1).setNumberFormat('@'));
  const widths = { Sender: 240, Subject: 360, Reason: 340, 'Why it would be deleted': 300, Rule: 260,
    Notes: 420, Why: 360, 'Sender Email': 240, 'Learned From': 360, 'Folder Name': 200 };
  cols.forEach((h, i) => { if (widths[h]) sh.setColumnWidth(i + 1, widths[h]); });
  if (cols.indexOf('Decision') !== -1) applyDecisionValidation_(sh, cols.indexOf('Decision') + 1);
  return sh;
}

function applyDecisionValidation_(sh, col) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Delete', 'Keep'], true).setAllowInvalid(false).build();
  sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function tab_(key) {
  return ensureTab_(spreadsheet_(), key, TAB_ORDER.indexOf(key));
}

/** Appends rows after the last row, growing the sheet if needed. */
function appendRows_(key, rows) {
  if (!rows.length) return;
  const sh = tab_(key);
  const start = sh.getLastRow() + 1;
  const needed = start + rows.length - 1 - sh.getMaxRows();
  if (needed > 0) sh.insertRowsAfter(sh.getMaxRows(), needed);
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows.map(r => r.map(safeCell_)));
  if (needed > 0 && COLUMNS[key].indexOf('Decision') !== -1) {
    applyDecisionValidation_(sh, COLUMNS[key].indexOf('Decision') + 1);
  }
}

/** Stops sender-controlled text (e.g. a subject starting with "=") from being read as a formula. */
function safeCell_(v) {
  if (typeof v !== 'string' || /^=HYPERLINK\("https:\/\/mail\.google\.com\//.test(v)) return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** Returns data rows as objects keyed by header, plus _row (1-based sheet row). */
function readTable_(key) {
  const sh = tab_(key);
  const cols = COLUMNS[key];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map((row, i) => {
    const o = { _row: i + 2 };
    cols.forEach((h, j) => { o[h] = row[j]; });
    return o;
  });
}

function readColumn_(key, header) {
  const sh = tab_(key);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, COLUMNS[key].indexOf(header) + 1, last - 1, 1).getValues()
    .map(r => String(r[0])).filter(Boolean);
}

function readSettings_() {
  const sh = tab_('SETTINGS');
  const map = {};
  sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues()
    .forEach(r => { map[String(r[0]).trim()] = r[1]; });
  const list = v => String(v == null ? '' : v).split(/[,;\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const approved = map[SETTING.TRIAL_APPROVED];
  return {
    trialApproved: approved === true || /^(?:true|yes|y|x)$/i.test(String(approved).trim()),
    wifeEmails: list(map[SETTING.WIFE]),
    workDomains: list(map[SETTING.WORK_DOMAINS]).map(d => d.replace(/^@/, '')),
    workKeywords: list(map[SETTING.WORK_KEYWORDS]),
    kidNames: list(map[SETTING.KIDS]),
    schoolTerms: list(map[SETTING.SCHOOL]),
  };
}

function writeSettingStatus_(name, value) {
  const sh = tab_('SETTINGS');
  const keys = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  const i = keys.findIndex(r => String(r[0]).trim() === name);
  if (i !== -1) sh.getRange(i + 1, 2).setValue(value);
}

function normDecision_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'delete') return 'Delete';
  if (s === 'keep') return 'Keep';
  return null;
}

/**
 * Turns Decision markings (Review and Trial tabs) into per-sender rules stored in
 * the Learned Rules tab. If one sender has both Keep and Delete markings, Keep wins.
 * @return {number} how many rules were added or changed
 */
function learnRules_() {
  const bySender = new Map();
  ['REVIEW', 'TRIAL'].forEach(key => readTable_(key).forEach(r => {
    const decision = normDecision_(r.Decision);
    const email = String(r['Sender Email'] || '').trim().toLowerCase();
    if (!decision || !email) return;
    const cur = bySender.get(email);
    if (!cur || (decision === 'Keep' && cur.decision !== 'Keep')) {
      bySender.set(email, { decision: decision, subject: String(r.Subject || '') });
    }
  }));

  const merged = new Map();
  readTable_('RULES').forEach(r => {
    const email = String(r['Sender Email'] || '').trim().toLowerCase();
    if (email) merged.set(email, [email, normDecision_(r.Rule) || r.Rule, r['Learned From'], r['Learned On']]);
  });
  let changed = 0;
  bySender.forEach((d, email) => {
    const cur = merged.get(email);
    if (!cur || cur[1] !== d.decision) {
      merged.set(email, [email, d.decision, d.subject, new Date()]);
      changed++;
    }
  });
  if (!changed) return 0;

  const sh = tab_('RULES');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, COLUMNS.RULES.length).clearContent();
  const rows = Array.from(merged.values()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  appendRows_('RULES', rows);
  return changed;
}

function readRules_() {
  const rules = { keepSenders: new Set(), deleteSenders: new Set(), keepThreads: new Set(), deleteThreads: new Set() };
  readTable_('RULES').forEach(r => {
    const email = String(r['Sender Email'] || '').trim().toLowerCase();
    const rule = normDecision_(r.Rule);
    if (email && rule === 'Keep') rules.keepSenders.add(email);
    if (email && rule === 'Delete') rules.deleteSenders.add(email);
  });
  ['REVIEW', 'TRIAL'].forEach(key => readTable_(key).forEach(r => {
    const decision = normDecision_(r.Decision);
    const id = String(r['Thread ID'] || '');
    if (id && decision === 'Keep') rules.keepThreads.add(id);
    if (id && decision === 'Delete') rules.deleteThreads.add(id);
  }));
  return rules;
}
