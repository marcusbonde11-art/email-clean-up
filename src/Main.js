/**
 * Entry points:
 *   setup()       Run once by hand. Creates the review sheet and the weekly trigger, then starts the trial run.
 *   runNow()      Starts a run immediately (trial or live, depending on the Settings tab).
 *   weeklyRun()   Called by the weekly trigger.
 *   continueRun() Called by the short-lived continuation trigger while a run is in progress.
 *   showStatus()  Logs the progress of the current run.
 *   uninstall()   Removes all triggers and run state (the sheet and labels are left alone).
 *
 * A run is a small state machine saved in Script Properties so it can span many
 * 6-minute executions: learn -> sweep -> trash (live only) -> folders -> finish.
 */

function setup() {
  const ss = ensureSpreadsheet_();
  installWeeklyTrigger_();
  console.log('Review sheet: ' + ss.getUrl());
  if (!readSettings_().wifeEmails.length) {
    console.log('Next: open the Settings tab, fill in at least your wife\'s email address, then run runNow() ' +
      'to start the trial. (The weekly trigger would also start it.)');
    return;
  }
  startRun_();
}

function runNow() { startRun_(); }

function weeklyRun() { startRun_(); }

function continueRun() { runSegment_(); }

function showStatus() {
  const state = loadState_();
  console.log(state ? JSON.stringify(state, null, 2) : 'No run in progress.');
  console.log('Review sheet: ' + spreadsheet_().getUrl());
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  clearState_();
  console.log('Triggers removed. The sheet and Gmail labels were left as they are.');
}

function installWeeklyTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyRun')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyRun').timeBased().everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay[CONFIG.WEEKLY_DAY]).atHour(CONFIG.WEEKLY_HOUR).create();
}

function startRun_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.log('Another execution holds the lock; skipping this start.');
    return;
  }
  try {
    ensureSpreadsheet_();
    const existing = loadState_();
    if (existing && Date.now() - existing.startedAt < CONFIG.STALE_RUN_MS) {
      console.log('The run started ' + new Date(existing.startedAt) + ' is still in progress and continues on its own.');
      scheduleContinuation_();
      return;
    }
    const settings = readSettings_();
    const notes = [];
    if (existing) notes.push('The previous run (started ' + new Date(existing.startedAt) + ') never finished and was replaced.');
    let mode = settings.trialApproved ? 'LIVE' : 'TRIAL';
    if (mode === 'LIVE' && !settings.wifeEmails.length) {
      mode = 'TRIAL';
      notes.push('Trial is approved, but no wife email address is set in Settings, so this run stayed a trial.');
    }
    saveState_({
      runId: 'run-' + Utilities.getUuid().slice(0, 8),
      mode: mode,
      startedAt: Date.now(),
      phase: 'learn',
      pass: 0,
      pageToken: '',
      offset: 0,
      cursor: 0,
      errors: 0,
      counts: { checked: 0, deleted: 0, trashed: 0, review: 0, kept: 0, skipped: 0, sorted: 0 },
      sortedBy: {},
      newFolders: [],
      notes: notes,
    });
    saveSenders_({});
  } finally {
    lock.releaseLock();
  }
  runSegment_();
}

function runSegment_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    const state = loadState_();
    if (!state) {
      clearContinuation_();
      return;
    }
    const deadline = Date.now() + CONFIG.SEGMENT_BUDGET_MS;
    try {
      while (state.phase !== 'done' && Date.now() < deadline) {
        PHASES[state.phase](state, deadline);
        saveState_(state);
      }
      state.errors = 0;
    } catch (e) {
      console.error(e && e.stack || e);
      state.errors = (state.errors || 0) + 1;
      if (state.errors >= CONFIG.MAX_SEGMENT_ERRORS) {
        addNote_(state, 'Stopped early after repeated errors: ' + e.message);
        try {
          phaseFinish_(state);
        } catch (e2) {
          console.error(e2);
        }
        state.phase = 'done';
      }
    }
    if (state.phase === 'done') {
      clearState_();
      clearContinuation_();
    } else {
      saveState_(state);
      scheduleContinuation_();
    }
  } finally {
    lock.releaseLock();
  }
}

const PHASES = {
  learn: phaseLearn_,
  sweep: phaseSweep_,
  trash: phaseTrash_,
  folders: phaseFolders_,
  finish: phaseFinish_,
};

/** Step 1: turn last weeks' Decision markings into rules before touching anything. */
function phaseLearn_(state) {
  const changed = learnRules_();
  if (changed) addNote_(state, 'Learned ' + changed + ' sender rule(s) from your Decision markings.');
  if (state.mode === 'LIVE') {
    FIXED_FOLDERS.forEach(name => {
      if (labelsByName_()[name.toLowerCase()]) return;
      ensureFolderLabel_(name);
      appendRows_('FOLDERS', [[new Date(), name, 'One of the four fixed folders', 0]]);
    });
  }
  state.phase = 'sweep';
}

/** Step 2: classify every inbox thread, log to the sheet, and file into folders. */
function phaseSweep_(state, deadline) {
  const ctx = buildSweepContext_(state);
  const out = { REVIEW: [], TRIAL: [], DELETED: [] };
  const senders = loadSenders_();
  const flush = () => {
    Object.keys(out).forEach(key => { appendRows_(key, out[key]); out[key] = []; });
    saveSenders_(senders);
  };
  try {
    while (Date.now() < deadline) {
      const pass = CONFIG.PASSES[state.pass];
      if (!pass) {
        state.phase = state.mode === 'LIVE' ? 'trash' : 'folders';
        state.cursor = 0;
        return;
      }
      const page = listThreads_(pass.query, state.pageToken);
      for (; state.offset < page.ids.length; state.offset++) {
        if (Date.now() >= deadline) return;
        processThread_(page.ids[state.offset], pass, state, ctx, out, senders);
      }
      flush();
      if (page.next) {
        state.pageToken = page.next;
      } else {
        state.pass++;
        state.pageToken = '';
      }
      state.offset = 0;
      saveState_(state);
    }
  } finally {
    flush();
  }
}

function buildSweepContext_(state) {
  const agent = loadAgentLabels_();
  const senderFolders = {};
  Object.keys(agent).forEach(id => { if (agent[id].sender) senderFolders[agent[id].sender] = agent[id].name; });
  return {
    settings: readSettings_(),
    rules: readRules_(),
    agentLabelIds: new Set(Object.keys(agent)),
    senderFolders: senderFolders,
    senderEverOpened: makeOpenedChecker_(),
    reviewLogged: new Set(readColumn_('REVIEW', 'Thread ID')),
    trialLogged: new Set(readColumn_('TRIAL', 'Thread ID')),
    pendingDeletes: new Set(readTable_('DELETED')
      .filter(r => r['Run ID'] === state.runId).map(r => String(r['Thread ID']))),
  };
}

function processThread_(id, pass, state, ctx, out, senders) {
  let t;
  try {
    t = fetchThread_(id, pass.flags);
  } catch (e) {
    addNote_(state, 'Could not read one email (' + e.message + '); it will be checked next week.');
    return;
  }
  if (!t) return;
  const v = classifyThread(t, ctx);
  const live = state.mode === 'LIVE';
  state.counts.checked++;

  if (v.action === ACTION.SKIP) {
    state.counts.skipped++;
    return;
  }
  if (v.action === ACTION.DELETE) {
    state.counts.deleted++;
    if (live && !ctx.pendingDeletes.has(t.id)) {
      out.DELETED.push([sender_(t), subject_(t), new Date(t.date), v.reason, threadLink_(t.id), 'Pending',
        t.fromEmail, t.id, state.runId]);
      ctx.pendingDeletes.add(t.id);
    } else if (!live && !ctx.trialLogged.has(t.id)) {
      out.TRIAL.push([sender_(t), subject_(t), new Date(t.date), v.reason, '', threadLink_(t.id), t.fromEmail,
        t.id, new Date()]);
      ctx.trialLogged.add(t.id);
    }
    return;
  }
  if (v.action === ACTION.UNSURE) {
    if (!ctx.reviewLogged.has(t.id)) {
      out.REVIEW.push([sender_(t), subject_(t), new Date(t.date), v.reason, '', threadLink_(t.id), t.fromEmail,
        t.id, new Date()]);
      ctx.reviewLogged.add(t.id);
      state.counts.review++;
    }
  } else {
    state.counts.kept++;
  }

  if (v.folder) {
    if (live) labelThread_(t.id, ensureFolderLabel_(v.folder));
    state.counts.sorted++;
    state.sortedBy[v.folder] = (state.sortedBy[v.folder] || 0) + 1;
  } else if (t.userLabelIds.length === 0 && v.orgSender && ctx.settings.wifeEmails.indexOf(t.fromEmail) === -1) {
    trackSender_(senders, t);
  }
}

/** Step 3 (live only): move everything queued in the Deletion Log to Gmail's Trash. */
function phaseTrash_(state, deadline) {
  const sh = tab_('DELETED');
  const cols = COLUMNS.DELETED;
  const last = sh.getLastRow();
  if (last < 2) {
    state.phase = 'folders';
    return;
  }
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const statusIdx = cols.indexOf('Status');
  const idIdx = cols.indexOf('Thread ID');
  const runIdx = cols.indexOf('Run ID');
  const start = state.cursor || 0;
  const statuses = [];
  let i = start;
  for (; i < values.length && Date.now() < deadline; i++) {
    const row = values[i];
    let status = row[statusIdx];
    if (row[runIdx] === state.runId && status === 'Pending') {
      try {
        trashThread_(String(row[idIdx]));
        status = 'Moved to Trash';
        state.counts.trashed++;
      } catch (e) {
        status = /not found|404/i.test(String(e.message)) ? 'Already gone' : 'Failed: ' + e.message;
      }
    }
    statuses.push([status]);
  }
  if (statuses.length) sh.getRange(2 + start, statusIdx + 1, statuses.length, 1).setValues(statuses);
  state.cursor = i;
  if (i >= values.length) {
    state.phase = 'folders';
    state.cursor = 0;
  }
}

/** Step 4: create up to two new folders for senders that keep showing up unsorted. */
function phaseFolders_(state, deadline) {
  const live = state.mode === 'LIVE';
  const agent = loadAgentLabels_();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const createdThisWeek = Object.keys(agent).filter(id => agent[id].sender && agent[id].createdAt > weekAgo).length;
  // In a trial nothing is created, so proposals made earlier in this run count against the limit.
  let slots = CONFIG.MAX_NEW_FOLDERS_PER_WEEK - createdThisWeek - (live ? 0 : state.newFolders.length);
  const existingNames = labelsByName_();
  const mappedSenders = new Set(Object.keys(agent).map(id => agent[id].sender).filter(Boolean));
  const senders = loadSenders_();
  const candidates = Object.keys(senders)
    .filter(email => senders[email][1] >= CONFIG.NEW_FOLDER_MIN_THREADS && !mappedSenders.has(email))
    .sort((a, b) => senders[b][1] - senders[a][1]);

  for (let c = 0; c < candidates.length && slots > 0 && Date.now() < deadline; c++) {
    const email = candidates[c];
    const name = folderNameFor(senders[email][0], email);
    if (!name || existingNames[name.toLowerCase()] ||
        FIXED_FOLDERS.some(f => f.toLowerCase() === name.toLowerCase()) ||
        state.newFolders.some(f => f.indexOf(name + ' (') === 0)) continue;
    // The sender counts are approximate; confirm against the live inbox.
    const unsorted = listThreads_('in:inbox from:' + email, '', CONFIG.MAX_THREADS_FILED_PER_NEW_FOLDER).ids
      .filter(id => !threadLabelIds_(id).some(l => /^Label_/.test(l)));
    if (unsorted.length < CONFIG.NEW_FOLDER_MIN_THREADS) continue;

    const why = unsorted.length + ' unsorted emails from ' + email;
    if (!live) {
      state.newFolders.push(name + ' (would create: ' + why + ')');
      slots--;
      continue;
    }
    const labelId = ensureFolderLabel_(name, email);
    let filed = 0;
    for (let i = 0; i < unsorted.length && Date.now() < deadline; i++) {
      labelThread_(unsorted[i], labelId);
      filed++;
    }
    appendRows_('FOLDERS', [[new Date(), name, 'Recurring sender: ' + why, filed]]);
    state.newFolders.push(name);
    state.counts.sorted += filed;
    state.sortedBy[name] = (state.sortedBy[name] || 0) + filed;
    slots--;
  }
  if (Date.now() < deadline) state.phase = 'finish';
}

/** Step 5: record the run in the Run Log tab. */
function phaseFinish_(state) {
  const live = state.mode === 'LIVE';
  const sorted = Object.keys(state.sortedBy).map(k => k + ': ' + state.sortedBy[k]).join(', ') || 'none';
  const notes = state.notes.slice();
  if (!live) notes.unshift('Trial run: nothing was deleted, moved or labelled.');
  appendRows_('RUNS', [[
    new Date(state.startedAt),
    new Date(),
    live ? 'Live' : 'Trial',
    state.counts.checked,
    live ? state.counts.trashed : state.counts.deleted + ' would be deleted',
    state.counts.review,
    state.counts.kept,
    live ? sorted : 'would sort: ' + sorted,
    state.newFolders.join(', ') || 'none',
    notes.join('\n'),
  ]]);
  writeSettingStatus_(SETTING.MODE, live ? 'Live' : 'Trial');
  writeSettingStatus_(SETTING.LAST_RUN, new Date());
  state.phase = 'done';
}

function sender_(t) {
  return t.fromName ? t.fromName + ' <' + t.fromEmail + '>' : t.fromEmail;
}

function subject_(t) {
  return t.subject || '(no subject)';
}

/** Approximate top-N sender counts (space-saving), kept small enough for Script Properties. */
function trackSender_(senders, t) {
  const email = t.fromEmail;
  if (!email) return;
  if (senders[email]) {
    senders[email][1]++;
    return;
  }
  const keys = Object.keys(senders);
  let base = 0;
  if (keys.length >= CONFIG.MAX_TRACKED_SENDERS) {
    const min = keys.reduce((a, b) => (senders[b][1] < senders[a][1] ? b : a));
    base = senders[min][1];
    delete senders[min];
  }
  senders[email] = [String(t.fromName || '').slice(0, 40), base + 1];
}

function addNote_(state, note) {
  if (state.notes.indexOf(note) === -1 && state.notes.length < 15) state.notes.push(note);
}

// ---- persistence -----------------------------------------------------------

function loadJson_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v ? JSON.parse(v) : fallback;
}

function saveJson_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function loadState_() { return loadJson_('RUN_STATE', null); }
function saveState_(state) { saveJson_('RUN_STATE', state); }
function loadSenders_() { return loadJson_('RUN_SENDERS', {}); }
function saveSenders_(senders) { saveJson_('RUN_SENDERS', senders); }
function loadAgentLabels_() { return loadJson_('AGENT_LABELS', {}); }
function saveAgentLabels_(labels) { saveJson_('AGENT_LABELS', labels); }

function clearState_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('RUN_STATE');
  props.deleteProperty('RUN_SENDERS');
}

function scheduleContinuation_() {
  clearContinuation_();
  ScriptApp.newTrigger('continueRun').timeBased().after(CONFIG.CONTINUE_AFTER_MS).create();
}

function clearContinuation_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueRun')
    .forEach(t => ScriptApp.deleteTrigger(t));
}
