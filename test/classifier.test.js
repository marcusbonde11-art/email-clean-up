const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the Apps Script file the way Apps Script does: as a plain global script.
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'Classifier.js'), 'utf8');
const { classifyThread, normalizeThread, folderNameFor, planUnsubscribe, parseMailto, ACTION } = vm.runInNewContext(
  source + '\n;({ classifyThread, normalizeThread, folderNameFor, planUnsubscribe, parseMailto, ACTION })');

// Objects from the vm context have a different Object prototype; compare them as plain data.
const plain = o => JSON.parse(JSON.stringify(o));

/** Builds a Gmail API thread resource (format=metadata). */
function raw({ id = 't1', from = 'Someone <someone@example.com>', subject = '', snippet = '', labels = ['INBOX'],
  headers = {}, extra = [] } = {}) {
  const hdrs = Object.assign({ From: from, Subject: subject }, headers);
  return {
    id,
    messages: [
      { labelIds: labels, snippet, internalDate: '1700000000000',
        payload: { headers: Object.keys(hdrs).map(name => ({ name, value: hdrs[name] })) } },
      ...extra,
    ],
  };
}

const BULK = { 'List-Unsubscribe': '<mailto:unsub@example.com>' };

function ctx(over = {}) {
  return Object.assign({
    settings: { wifeEmails: ['wife@family.net'], workDomains: ['acme.com'], workKeywords: [], kidNames: ['tobias'],
      schoolTerms: ['lincoln elementary'] },
    rules: { keepSenders: new Set(), deleteSenders: new Set(), keepThreads: new Set(), deleteThreads: new Set() },
    agentLabelIds: new Set(),
    senderFolders: {},
    senderEverOpened: () => false,
  }, over);
}

function classify(r, c = ctx(), flags) {
  return classifyThread(normalizeThread(r, flags), c);
}

test('deletes unambiguous marketing', () => {
  const v = classify(raw({ from: 'Old Navy <deals@email.oldnavy.com>', subject: '50% off everything - ends tonight!',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }));
  assert.equal(v.action, ACTION.DELETE);
  assert.match(v.reason, /Marketing/);
});

test('deletes a newsletter you never opened, keeps it for review once you have opened that sender', () => {
  const r = raw({ from: 'Weekly Digest <hello@substack-writer.com>', subject: 'Issue 42: thoughts on gardens',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], headers: BULK });
  assert.equal(classify(r).action, ACTION.DELETE);
  assert.equal(classify(r).reason, 'Newsletter / mailing list you have never opened');
  const opened = classify(raw({ from: 'Weekly Digest <writer@substack-writer.com>', subject: 'Issue 42',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], headers: BULK }), ctx({ senderEverOpened: () => true }));
  assert.equal(opened.action, ACTION.UNSURE);
});

test('deletes impersonal automated notifications', () => {
  const v = classify(raw({ from: 'Nextdoor <no-reply@rs.email.nextdoor.com>', subject: 'Trending in your neighborhood',
    labels: ['INBOX', 'CATEGORY_SOCIAL'] }));
  assert.equal(v.action, ACTION.DELETE);
  assert.match(v.reason, /Automated notification/);
});

test('notifications relaying a personal message go to review', () => {
  const v = classify(raw({ from: 'LinkedIn <messages-noreply@linkedin.com>', subject: 'Dana sent you a new message',
    labels: ['INBOX', 'CATEGORY_SOCIAL'], headers: BULK }));
  assert.equal(v.action, ACTION.UNSURE);
});

test('security alerts are never auto-deleted', () => {
  const v = classify(raw({ from: 'Google <no-reply@accounts.google.com>', subject: 'Security alert: new sign-in',
    labels: ['INBOX', 'CATEGORY_UPDATES'] }));
  assert.equal(v.action, ACTION.UNSURE);
  assert.match(v.reason, /account security/);
});

test('never deletes anything with an attachment, even marketing', () => {
  const v = classify(raw({ from: 'Shop <deals@email.shop.com>', subject: '50% off sale, shop now',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }), ctx(), { hasAttachment: true });
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.reason, 'Has an attachment');
});

test('receipts and order numbers are protected and filed in Receipts', () => {
  const v = classify(raw({ from: 'Amazon.com <auto-confirm@amazon.com>', subject: 'Your Amazon.com order #112-4459921-1234',
    labels: ['INBOX', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.folder, 'Receipts');
  const conf = classify(raw({ from: 'Hotel <noreply@hotel.com>', subject: 'See you soon',
    snippet: 'Confirmation number: HX88213', labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }));
  assert.equal(conf.action, ACTION.KEEP);
});

test('bills are protected and filed in Bills', () => {
  const v = classify(raw({ from: 'PG&E <alerts@notifications.pge.com>', subject: 'Your energy bill is ready',
    labels: ['INBOX', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.folder, 'Bills');
});

test('email from your wife is never deleted, even if it looks automated', () => {
  const v = classify(raw({ from: 'Wife <Wife@Family.net>', subject: 'Fwd: 40% off sale', headers: BULK,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.reason, 'From your wife');
});

test('school and kid email is protected and filed in School', () => {
  const k12 = classify(raw({ from: 'Office <office@lincoln.k12.ca.us>', subject: 'Picture day reminder',
    labels: ['INBOX', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(k12.action, ACTION.KEEP);
  assert.equal(k12.folder, 'School');
  const dojo = classify(raw({ from: 'ClassDojo <no-reply@classdojo.com>', subject: 'New story posted',
    labels: ['INBOX', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(dojo.action, ACTION.KEEP);
  const kid = classify(raw({ from: 'Coach <noreply@teamsnap.com>', subject: 'Tobias - practice moved',
    labels: ['INBOX', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(kid.action, ACTION.KEEP);
  assert.equal(kid.folder, 'School');
});

test('back-to-school marketing is flagged for review instead of protected or deleted', () => {
  const v = classify(raw({ from: 'Target <deals@em.target.com>', subject: 'Back to school deals: 30% off',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }));
  assert.equal(v.action, ACTION.UNSURE);
});

test('work-domain email is protected and filed in Work', () => {
  const v = classify(raw({ from: 'Boss <boss@acme.com>', subject: 'Quick question' }));
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.folder, 'Work');
  const payroll = classify(raw({ from: 'ADP <SecurityServices_NoReply@adp.com>', subject: 'Your pay stub is ready',
    labels: ['INBOX', 'CATEGORY_UPDATES'] }));
  assert.equal(payroll.action, ACTION.KEEP);
  assert.equal(payroll.folder, 'Work');
});

test('anything in a hand-made folder is skipped entirely', () => {
  const v = classify(raw({ from: 'Shop <deals@email.shop.com>', subject: '50% off sale',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS', 'Label_42'], headers: BULK }));
  assert.equal(v.action, ACTION.SKIP);
});

test('folders the agent created do not block cleanup, and are not re-filed', () => {
  const v = classify(raw({ from: 'Shop <deals@email.shop.com>', subject: '50% off sale',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS', 'Label_7'], headers: BULK }), ctx({ agentLabelIds: new Set(['Label_7']) }));
  assert.equal(v.action, ACTION.DELETE);
  const kept = classify(raw({ from: 'Boss <boss@acme.com>', labels: ['INBOX', 'Label_7'] }),
    ctx({ agentLabelIds: new Set(['Label_7']) }));
  assert.equal(kept.action, ACTION.KEEP);
  assert.equal(kept.folder, null);
});

test('personal email from a person is kept without logging', () => {
  const v = classify(raw({ from: 'Sam Lee <sam.lee@gmail.com>', subject: 'Dinner Saturday?' }));
  assert.equal(v.action, ACTION.KEEP);
  assert.equal(v.orgSender, false);
});

test('conversations you replied to are kept', () => {
  const v = classify(raw({ from: 'Store <support@store.com>', subject: 'Re: my return', headers: BULK,
    extra: [{ labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'me@gmail.com' }] } }] }));
  assert.equal(v.action, ACTION.KEEP);
});

test('learned sender rules apply, but never override the never-delete list', () => {
  const rules = { keepSenders: new Set(['news@paper.com']), deleteSenders: new Set(['info@gym.com']),
    keepThreads: new Set(), deleteThreads: new Set(['t9']) };
  const c = ctx({ rules, senderEverOpened: () => true });
  assert.equal(classify(raw({ from: 'Paper <news@paper.com>', subject: '20% off subscriptions, shop now',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }), c).action, ACTION.KEEP);
  assert.equal(classify(raw({ from: 'Gym <info@gym.com>', subject: 'Class schedule update', headers: BULK }), c).action,
    ACTION.DELETE);
  const receipt = classify(raw({ id: 't9', from: 'Gym <info@gym.com>', subject: 'Your receipt', headers: BULK }), c);
  assert.equal(receipt.action, ACTION.KEEP);
});

test('starred mail is protected', () => {
  const v = classify(raw({ from: 'Shop <deals@email.shop.com>', subject: '50% off sale',
    labels: ['INBOX', 'STARRED', 'CATEGORY_PROMOTIONS'], headers: BULK }));
  assert.equal(v.action, ACTION.KEEP);
});

test('recurring-sender folders route that sender\'s unsorted mail', () => {
  const v = classify(raw({ from: 'Costco <costco@online.costco.com>', subject: 'Warehouse hours update', headers: BULK }),
    ctx({ senderFolders: { 'costco@online.costco.com': 'Costco' }, senderEverOpened: () => true }));
  assert.equal(v.folder, 'Costco');
});

test('normalizeThread reads sender, unread state and decodes snippets', () => {
  const t = normalizeThread(raw({ from: '"Chase" <no.reply@alertsp.chase.com>', snippet: 'It&#39;s here &amp; ready',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'] }));
  assert.equal(t.fromEmail, 'no.reply@alertsp.chase.com');
  assert.equal(t.fromName, 'Chase');
  assert.equal(t.category, 'updates');
  assert.equal(t.allUnread, true);
  assert.equal(t.snippet, "It's here & ready");
});

test('folder names are plain language', () => {
  assert.equal(folderNameFor('Costco Wholesale', 'x@online.costco.com'), 'Costco Wholesale');
  assert.equal(folderNameFor('', 'news@mail.patagonia.com'), 'Patagonia');
  assert.equal(folderNameFor('"Team Strava"', 'no-reply@strava.com'), 'Strava');
  assert.equal(folderNameFor('noreply', 'alerts@bbc.co.uk'), 'Bbc');
});

test('never-opened newsletters are marked for unsubscribing; other deletions are not', () => {
  const news = classify(raw({ from: 'Weekly <hello@weekly.com>', subject: 'Issue 1',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], headers: BULK }));
  assert.equal(news.unsubscribe, true);
  const promo = classify(raw({ from: 'Old Navy <deals@email.oldnavy.com>', subject: '50% off, shop now',
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: BULK }));
  assert.equal(promo.action, ACTION.DELETE);
  assert.ok(!promo.unsubscribe);
});

test('planUnsubscribe prefers one-click, then email, then a plain link', () => {
  const both = '<mailto:u@list.com?subject=stop>, <https://list.com/u?x=1>';
  assert.deepEqual(plain(planUnsubscribe(both, 'List-Unsubscribe=One-Click')),
    { method: 'One-click link', target: 'https://list.com/u?x=1' });
  assert.deepEqual(plain(planUnsubscribe(both, '')), { method: 'Email request', target: 'mailto:u@list.com?subject=stop' });
  assert.deepEqual(plain(planUnsubscribe('<https://list.com/u>', '')), { method: 'Link', target: 'https://list.com/u' });
  assert.equal(planUnsubscribe('', ''), null);
  assert.equal(planUnsubscribe('<javascript:alert(1)>', ''), null);
});

test('parseMailto reads the address and strips header-injection attempts', () => {
  assert.deepEqual(plain(parseMailto('mailto:leave@list.org?subject=unsubscribe%20me&body=bye')),
    { to: 'leave@list.org', subject: 'unsubscribe me', body: 'bye' });
  assert.deepEqual(plain(parseMailto('mailto:leave@list.org')), { to: 'leave@list.org', subject: 'unsubscribe', body: 'unsubscribe' });
  assert.equal(parseMailto('mailto:a@b.org,c@d.org'), null);
  assert.equal(parseMailto('mailto:not-an-address'), null);
  assert.equal(parseMailto('mailto:x@y.org?subject=hi%0D%0ABcc:%20evil@z.com').subject, 'hi Bcc: evil@z.com');
});
