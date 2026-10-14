const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./fakes');

const BULK = { 'List-Unsubscribe': '<mailto:u@x.com>' };

function thread(id, { from, subject = '', snippet = '', labels = [], headers = {}, attachment = false,
  purchase = false } = {}) {
  const hdrs = Object.assign({ From: from, Subject: subject }, headers);
  const t = {
    id,
    messages: [{ labelIds: ['INBOX', ...labels], snippet, internalDate: '1760000000000',
      payload: { headers: Object.keys(hdrs).map(name => ({ name, value: hdrs[name] })) } }],
  };
  const email = from.match(/<([^>]+)>/)[1].toLowerCase();
  t._matches = q => {
    if (/is:read/.test(q)) return false; // no sender has ever been opened
    if (/^in:inbox from:/.test(q)) return q.endsWith(email);
    if (/^in:inbox has:attachment$/.test(q)) return attachment;
    if (/^in:inbox -has:attachment \{category:purchases/.test(q)) return !attachment && purchase;
    if (/^in:inbox -has:attachment -category:purchases/.test(q)) return !attachment && !purchase;
    throw new Error('unexpected query ' + q);
  };
  return t;
}

function inbox() {
  const costco = Array.from({ length: 6 }, (_, i) => thread('costco' + i, {
    from: 'Costco <costco@online.costco.com>', subject: 'Warehouse update ' + i, headers: BULK }));
  return [
    thread('promo', { from: 'Old Navy <deals@email.oldnavy.com>', subject: '50% off everything, ends tonight',
      labels: ['CATEGORY_PROMOTIONS'], headers: BULK }),
    thread('news', { from: 'Garden Weekly <hello@gardenweekly.com>', subject: 'Issue 12',
      labels: ['UNREAD', 'CATEGORY_UPDATES'], headers: BULK }),
    thread('receipt', { from: 'Amazon <auto-confirm@amazon.com>', subject: 'Your order #112-3345678',
      labels: ['CATEGORY_UPDATES'], headers: BULK }),
    thread('attach', { from: 'Shop <deals@email.shop.com>', subject: '50% off sale', headers: BULK,
      labels: ['CATEGORY_PROMOTIONS'], attachment: true }),
    thread('wife', { from: 'Jo <jo@family.net>', subject: 'Fwd: look at this sale, 40% off', headers: BULK,
      labels: ['CATEGORY_PROMOTIONS'] }),
    thread('security', { from: 'Google <no-reply@accounts.google.com>', subject: '=IMPORTXML("x") Security alert',
      labels: ['CATEGORY_UPDATES'] }),
    thread('handmade', { from: 'Shop <deals@email.shop.com>', subject: '70% off sale', headers: BULK,
      labels: ['CATEGORY_PROMOTIONS', 'Label_1'] }),
    thread('friend', { from: 'Sam <sam@gmail.com>', subject: 'Dinner?' }),
    ...costco,
  ];
}

function setSetting(world, name, value) {
  const sh = world.sheet('Settings');
  const row = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().findIndex(r => r[0] === name) + 1;
  sh.getRange(row, 2).setValue(value);
}

function mark(world, tab, threadId, decision) {
  const sh = world.sheet(tab);
  const rows = sh.rowsAsObjects();
  const i = rows.findIndex(r => r['Thread ID'] === threadId);
  assert.ok(i >= 0, threadId + ' should be logged in ' + tab);
  sh.getRange(i + 2, 5).setValue(decision);
}

function drain(world) {
  let i = 0;
  for (; i < 500 && world.triggers.some(t => t.getHandlerFunction() === 'continueRun'); i++) {
    world.api.continueRun();
  }
  assert.ok(!world.triggers.some(t => t.getHandlerFunction() === 'continueRun'), 'run should finish');
  world.segments = (world.segments || 0) + i;
}

function scenario(world) {
  world.labels.push({ id: 'Label_1', name: 'My Stuff' }); // a folder made by hand

  // 1. setup() creates the sheet and the weekly trigger; the trial starts once Settings are filled in.
  world.api.setup();
  assert.ok(world.triggers.some(t => t.getHandlerFunction() === 'weeklyRun'));
  assert.equal(world.sheet('Run Log').getLastRow(), 1, 'no run before the wife\'s address is set');
  setSetting(world, 'Wife email addresses', 'jo@family.net');
  world.api.runNow();
  drain(world);
  assert.deepEqual(world.state.trashed, [], 'trial deletes nothing');
  assert.deepEqual(world.state.labelled, [], 'trial moves or labels nothing');
  const trial = world.sheet('Trial Deletions').rowsAsObjects();
  assert.deepEqual(trial.map(r => r['Thread ID']).sort(), ['news', 'promo']);
  const review = world.sheet('Email Cleanup Review').rowsAsObjects();
  assert.deepEqual(review.map(r => r['Thread ID']).sort(),
    ['costco0', 'costco1', 'costco2', 'costco3', 'costco4', 'costco5', 'security']);
  assert.equal(review[0].Decision, '');
  assert.match(String(review[0].Link), /^=HYPERLINK\("https:\/\/mail\.google\.com\/mail\/u\/me@gmail\.com\/#all\//);
  let runs = world.sheet('Run Log').rowsAsObjects();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].Mode, 'Trial');
  assert.match(runs[0]['New Folders'], /^Costco \(would create/);

  // 2. Approval with the wife's address removed keeps it a trial.
  setSetting(world, 'Trial approved', true);
  setSetting(world, 'Wife email addresses', '');
  world.api.runNow();
  drain(world);
  assert.deepEqual(world.state.trashed, []);
  runs = world.sheet('Run Log').rowsAsObjects();
  assert.equal(runs[1].Mode, 'Trial');
  assert.match(runs[1].Notes, /no wife email address/);
  assert.equal(world.sheet('Trial Deletions').rowsAsObjects().length, 2, 'no duplicate trial rows');

  // 3. Mark decisions, restore the wife's address, and run for real.
  setSetting(world, 'Wife email addresses', 'jo@family.net');
  mark(world, 'Trial Deletions', 'news', 'Keep');
  mark(world, 'Email Cleanup Review', 'security', 'Keep');
  world.api.runNow();
  drain(world);

  assert.deepEqual(world.state.trashed, ['promo'], 'only the marketing email is deleted');
  const rules = world.sheet('Learned Rules').rowsAsObjects();
  assert.deepEqual(rules.map(r => [r['Sender Email'], r.Rule]).sort(),
    [['hello@gardenweekly.com', 'Keep'], ['no-reply@accounts.google.com', 'Keep']]);
  const labelName = id => world.labels.find(l => l.id === id).name;
  const filed = world.state.labelled.map(([id, l]) => id + ':' + labelName(l)).sort();
  assert.deepEqual(filed, ['costco0:Costco', 'costco1:Costco', 'costco2:Costco', 'costco3:Costco',
    'costco4:Costco', 'costco5:Costco', 'receipt:Receipts']);
  assert.ok(!world.state.labelled.some(([id]) => ['handmade', 'wife', 'friend', 'attach'].includes(id)));
  const folders = world.sheet('Folder Log').rowsAsObjects().map(r => r['Folder Name']);
  assert.deepEqual(folders, ['Receipts', 'School', 'Work', 'Bills', 'Costco']);
  const deleted = world.sheet('Deletion Log').rowsAsObjects();
  assert.deepEqual(deleted.map(r => [r['Thread ID'], r.Status]), [['promo', 'Moved to Trash']]);
  runs = world.sheet('Run Log').rowsAsObjects();
  assert.equal(runs[2].Mode, 'Live');
  assert.equal(runs[2].Deleted, 1);
  assert.equal(runs[2]['New Folders'], 'Costco');
  // 7 from the first trial, plus the wife's forward, which went to review (not deletion) while her
  // address was blank in step 2. Nothing is logged twice.
  const reviewIds = world.sheet('Email Cleanup Review').rowsAsObjects().map(r => r['Thread ID']);
  assert.equal(reviewIds.length, 8);
  assert.equal(new Set(reviewIds).size, 8);
  assert.ok(reviewIds.includes('wife'));

  // 4. The next week: nothing new to delete, no further folders.
  world.api.runNow();
  drain(world);
  runs = world.sheet('Run Log').rowsAsObjects();
  assert.equal(runs[3].Deleted, 0);
  assert.equal(runs[3]['New Folders'], 'none');
  assert.equal(world.state.labelled.length, 7);
}

test('trial, approval and live runs behave as specified', () => {
  scenario(makeWorld(inbox()));
});

test('the same outcome when every run is split across many short segments', () => {
  const world = makeWorld(inbox());
  world.tickPerCall(20 * 1000); // each Date.now() call costs 20s, so a segment covers only a few steps
  scenario(world);
  assert.ok(world.segments > 4, 'runs were actually split (' + world.segments + ' continuations)');
});

test('sender-controlled text cannot become a spreadsheet formula', () => {
  const world = makeWorld(inbox());
  world.api.setup();
  world.sheet('Settings').getRange(3, 2).setValue('jo@family.net');
  world.api.runNow();
  drain(world);
  const written = world.state.ss.getSheets().flatMap(s => s.written);
  assert.ok(written.includes("'=IMPORTXML(\"x\") Security alert"), 'subject written as text');
  const formulas = written.filter(v => typeof v === 'string' && v.startsWith('='));
  assert.ok(formulas.length > 0 && formulas.every(v => v.startsWith('=HYPERLINK("https://mail.google.com/')));
});
