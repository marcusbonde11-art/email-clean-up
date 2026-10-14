/**
 * Classifier: decides what happens to one inbox thread.
 *
 * Everything in this file is pure JavaScript with no Google services, so it
 * can be unit tested in Node (see test/classifier.test.js). Main.js feeds it
 * threads fetched from the Gmail API and acts on the verdict.
 *
 * Order of precedence (first match wins):
 *   1. In a folder you created by hand        -> SKIP (never touched)
 *   2. Never-delete list (attachment, receipt/order/confirmation, wife,
 *      school/kids, work-critical, bills, starred, your own replies) -> KEEP
 *   3. Your Decision markings (this email, then this sender)        -> KEEP / DELETE
 *   4. Clear delete rules (marketing, never-opened newsletters,
 *      impersonal automated notifications)                          -> DELETE
 *   5. Ordinary personal email from a person                        -> KEEP
 *   6. Anything else                                                -> UNSURE (logged for review)
 */

const ACTION = { DELETE: 'DELETE', KEEP: 'KEEP', UNSURE: 'UNSURE', SKIP: 'SKIP' };

const FIXED_FOLDERS = ['Receipts', 'School', 'Work', 'Bills'];

/** Builds a case-insensitive regex matching any of the given phrases as whole words. */
function phraseRe_(phrases) {
  return new RegExp('(?<![\\w])(?:' + phrases.join('|') + ')(?![\\w])', 'i');
}

const RECEIPT_RE = phraseRe_([
  'receipts?', 'invoices?', 'order confirmation', 'order confirmed', 'your order', 'your purchase',
  'purchase confirmation', 'order (?:has )?shipped', 'has shipped', 'out for delivery', 'was delivered',
  'has been delivered', 'payment (?:received|confirmation|confirmed|successful)',
  'thanks? (?:you )?for your (?:order|purchase|payment)', 'booking (?:confirmation|confirmed)',
  'reservation (?:confirmation|confirmed)', 'tracking number', 'refund (?:issued|processed|confirmation)',
  'return label', 'e-?tickets?', 'boarding pass', 'itinerary',
]);

// "Order #112-3345", "Confirmation number: ABC12345", "Invoice no. 20931", "#1234567"
const ORDER_NUMBER_RE = new RegExp(
  '(?:\\b(?:order|confirmation|booking|reservation|invoice|receipt|ticket|transaction|reference)' +
  '\\s*(?:number|no\\.?|num|#|id|code)\\s*[:#]?\\s*(?=[A-Z0-9-]*\\d)[A-Z0-9-]{4,})' +
  '|(?:#\\s?\\d{5,}\\b)', 'i');

const BILL_RE = phraseRe_([
  'your (?:\\w+ )?bill', 'bill (?:is )?(?:ready|available|due)', 'new bill', 'bill pay(?:ment)?',
  'billing statement', '(?:e-?)?statement (?:is )?(?:ready|available)', 'your (?:monthly |account )?statement',
  'payment (?:is )?due', 'amount due', 'balance due', 'past due', 'minimum payment', 'auto-?pay',
  'utility bill', 'premium (?:is )?due',
]);

const SCHOOL_RE = phraseRe_([
  'schools?', 'teachers?', 'classroom', 'homework', 'pta', 'pto', 'principal', 'report cards?',
  'parent[- ]teacher', 'field trip', 'day ?care', 'preschool', 'pre-?k', 'kindergarten', 'elementary',
  'middle school', 'high school', 'school district', 'recess', 'lunch (?:account|balance|menu)',
  'bus (?:route|schedule)', 'yearbook', 'graduation', 'pediatrics?', 'pediatrician', 'babysitter',
  'summer camp', 'scouts?', 'little league', 'recital', 'carpool', 'permission slip', 'tuition',
  'enrol?lment',
]);

const SCHOOL_SERVICE_DOMAINS = [
  'seesaw.me', 'classdojo.com', 'brightwheel.com', 'parentsquare.com', 'remind.com', 'schoology.com',
  'powerschool.com', 'skyward.com', 'infinitecampus.com', 'infinitecampus.org', 'classroom.google.com',
  'konstella.com', 'tadpoles.com', 'procaresoftware.com', 'schoolmessenger.com', 'bloomz.net',
  'bloomz.com', 'signupgenius.com', 'k12.com', 'parentlink.net', 'finalsite.net',
];
const SCHOOL_DOMAIN_RE = /(?:\.k12\.|\.edu$|isd\.(?:org|net|us)$|schools?\.(?:org|net|us)$|\.sch\.)/i;

// Work-critical: protected from deletion (unless it is clearly marketing).
const WORK_CRITICAL_RE = phraseRe_([
  'payroll', 'pay ?stubs?', 'paychecks?', 'timesheets?', 'offer letter', 'job offer', 'interview',
  'performance review', 'onboarding', 'w-?2', '1099', 'benefits enrollment', 'direct deposit',
  'contract', 'signature requested', 'please sign', 'docusign', 'action required', 'deadline',
  'meeting (?:invite|invitation|request|notes)', 'invitation:', 'urgent',
]);
// Stronger subset used to file email into the Work folder.
const WORK_FOLDER_RE = phraseRe_([
  'payroll', 'pay ?stubs?', 'timesheets?', 'offer letter', 'job offer', 'performance review',
  'onboarding', 'w-?2', 'benefits enrollment',
]);

const PROMO_RES = [
  /\d{1,2}\s?% off/i, /\$\d+ off\b/i, /\bsale\b/i, /\bdeals?\b/i, /\bdiscount/i, /\bcoupons?\b/i,
  /\bpromo(?:tion)?s?\b/i, /\bfree shipping\b/i, /\blimited[- ]time\b/i, /\blast chance\b/i,
  /\bends (?:tonight|today|soon|sunday|midnight)\b/i, /\bshop (?:now|the|our)\b/i, /\bnew arrivals?\b/i,
  /\bclearance\b/i, /\b(?:black friday|cyber monday|prime day)\b/i, /\bexclusive (?:offer|access|deal)/i,
  /\bdon'?t miss\b/i, /\bflash\b/i, /\bgift guide\b/i, /\b(?:bogo|buy one,? get one)\b/i,
  /\bsave (?:up to )?\$?\d+/i, /\bspecial offer\b/i, /\boffer (?:ends|expires)\b/i, /\bjust for you\b/i,
  /\bearn (?:points|rewards|cash ?back)\b/i, /\bbest ?sellers?\b/i, /\bwhile supplies last\b/i,
];

// Topics that are automated but too important to delete without asking.
const SENSITIVE_TOPICS = [
  ['account security', phraseRe_([
    'password', 'passcode', 'verification code', 'security (?:alert|code|notice|check)', 'sign-?in',
    'log-?in', 'new device', '2-step', 'two-factor', '2fa', 'suspicious', 'unusual activity',
    'account (?:locked|suspended|disabled|recovery)', 'verify your (?:email|account|identity)',
  ])],
  ['money or banking', phraseRe_([
    'bank', 'deposit', 'withdrawal', 'transfer', 'wire', 'fraud', 'credit (?:card|report|score)',
    'tax(?:es)?', 'irs', 'refund', 'loan', 'mortgage',
  ])],
  ['health', phraseRe_([
    'appointment', 'prescription', 'pharmacy', 'lab results?', 'test results?', 'patient', 'doctor',
    'dental', 'dentist', 'clinic', 'hospital', 'insurance claim', 'explanation of benefits',
  ])],
  ['travel', phraseRe_(['flight', 'boarding', 'itinerary', 'check-?in', 'gate change', 'reservation'])],
  ['legal or government', phraseRe_([
    'court', 'jury', 'dmv', 'license renewal', 'passport', 'visa', 'voter', 'ballot', 'legal notice',
    'subpoena', 'social security',
  ])],
];

// Notifications that relay something a real person wrote or did.
const PERSONAL_HINT_RE = phraseRe_([
  'sent you a (?:new )?message', 'messaged you', 'new message from', 'replied to (?:you|your)',
  'commented on', 'mentioned you', 'tagged you', 'invited you', 'shared (?:a |an )?\\w* ?with you',
  'wants to connect', 'sent you', 'wrote:',
]);
const REPLY_SUBJECT_RE = /^\s*(?:re|fwd?|fw)\s*:/i;

const AUTOMATED_LOCAL_RE = new RegExp('(?:^|[-_.+])(?:' + [
  'no-?reply', 'do-?not-?reply', 'donotreply', 'notifications?', 'notify', 'alerts?', 'updates?',
  'news(?:letters?)?', 'mailer(?:-daemon)?', 'postmaster', 'bounces?', 'automated', 'auto-?confirm',
  'digest', 'info', 'hello', 'team', 'marketing', 'promo(?:tions?)?', 'offers?', 'deals?', 'e?mails?',
  'e?news', 'community', 'support', 'service', 'accounts?', 'billing', 'orders?', 'shipping', 'reply',
].join('|') + ')(?:$|[-_.+\\d])', 'i');
const MARKETING_LOCAL_RE =
  /(?:^|[-_.+])(?:marketing|promo(?:tions?)?|offers?|deals?|sales|shop|store|news(?:letters?)?)(?:$|[-_.+\d])/i;
// Sending subdomains typical of bulk-mail platforms: news.brand.com, em.brand.com, e2.brand.com ...
const BULK_DOMAIN_RE =
  /^(?:e|em|email|mail|mailer|mailing|news|newsletter|info|offers|promo|marketing|send|engage|reply|mkt)\d*\./i;

const PERSONAL_REASON = 'Personal email from a person';

/**
 * Turns a Gmail API thread (format=metadata) into the flat shape the classifier uses.
 * @param {Object} raw  Gmail API Thread resource.
 * @param {Object} flags  Facts known from the search pass, e.g. {hasAttachment: true}.
 */
function normalizeThread(raw, flags) {
  flags = flags || {};
  const msgs = raw.messages || [];
  const first = msgs[0] || {};
  const last = msgs[msgs.length - 1] || first;
  const labelsOf = m => m.labelIds || [];
  const labels = new Set();
  msgs.forEach(m => labelsOf(m).forEach(l => labels.add(l)));
  const incoming = msgs.filter(m => labelsOf(m).indexOf('SENT') === -1);
  const ref = incoming[0] || first; // judge the thread by the first message someone sent you
  const from = parseAddress(header_(ref, 'From'));
  const senders = [];
  msgs.forEach(m => {
    const e = parseAddress(header_(m, 'From')).email;
    if (e && senders.indexOf(e) === -1) senders.push(e);
  });
  const category = ['PERSONAL', 'SOCIAL', 'PROMOTIONS', 'UPDATES', 'FORUMS']
    .filter(c => labels.has('CATEGORY_' + c)).map(c => c.toLowerCase())[0] || 'personal';
  return {
    id: raw.id,
    subject: header_(ref, 'Subject') || header_(first, 'Subject'),
    snippet: decodeEntities_(last.snippet || ''),
    fromName: from.name,
    fromEmail: from.email,
    fromDomain: from.domain,
    senders: senders,
    labelIds: Array.from(labels),
    userLabelIds: Array.from(labels).filter(l => /^Label_/.test(l)),
    category: category,
    allUnread: incoming.length > 0 && incoming.every(m => labelsOf(m).indexOf('UNREAD') !== -1),
    starred: labels.has('STARRED'),
    sentByMe: labels.has('SENT'),
    hasAttachment: !!flags.hasAttachment,
    purchaseCategory: !!flags.purchaseCategory,
    listUnsubscribe: header_(ref, 'List-Unsubscribe'),
    listUnsubscribePost: header_(ref, 'List-Unsubscribe-Post'),
    listId: header_(ref, 'List-Id'),
    precedence: header_(ref, 'Precedence'),
    autoSubmitted: header_(ref, 'Auto-Submitted'),
    feedbackId: header_(ref, 'Feedback-ID'),
    date: Number(last.internalDate) || 0,
    messageCount: msgs.length,
  };
}

function header_(msg, name) {
  const headers = (msg.payload && msg.payload.headers) || [];
  const lower = name.toLowerCase();
  const h = headers.find(x => String(x.name).toLowerCase() === lower);
  return h ? String(h.value) : '';
}

function parseAddress(value) {
  const v = String(value || '').trim();
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : v).trim().toLowerCase();
  return { name: m ? m[1].trim() : '', email: email, domain: email.split('@')[1] || '' };
}

function decodeEntities_(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * @param {Object} t  Thread from normalizeThread().
 * @param {Object} ctx
 *   settings: {wifeEmails, workDomains, workKeywords, kidNames, schoolTerms} (lowercase lists)
 *   rules: {keepSenders, deleteSenders, keepThreads, deleteThreads} (Sets)
 *   agentLabelIds: Set of label IDs this agent created (all other user labels are hand-made)
 *   senderFolders: {email: folderName} for folders the agent created for a recurring sender
 *   senderEverOpened: function(email) -> boolean
 * @return {{action: string, reason: string, folder: ?string, orgSender: boolean}}
 */
function classifyThread(t, ctx) {
  const s = ctx.settings;
  const rules = ctx.rules;
  const agentLabelIds = ctx.agentLabelIds || new Set();
  if (t.userLabelIds.some(id => !agentLabelIds.has(id))) {
    return verdict_(ACTION.SKIP, 'Already in a folder you created', null, false);
  }

  const text = (t.subject || '') + ' ' + (t.snippet || '');
  const local = t.fromEmail.split('@')[0] || '';
  const bulk = isBulk_(t);
  const automated = AUTOMATED_LOCAL_RE.test(local) || isAutoSubmitted_(t);
  const orgSender = bulk || automated;
  const promo = promoScore_(t, text, local);
  const marketingLike = bulk && promo >= 1;
  const unsorted = t.userLabelIds.length === 0;
  const folder = unsorted ? folderFor_(t, text, s, ctx, marketingLike) : null;
  const keep = reason => verdict_(ACTION.KEEP, reason, folder, orgSender);
  const unsure = reason => verdict_(ACTION.UNSURE, reason, folder, orgSender);
  const del = reason => verdict_(ACTION.DELETE, reason, null, orgSender);

  const protectedBy = protectionReason_(t, text, s, marketingLike);
  if (protectedBy) return keep(protectedBy);

  if (rules.keepThreads.has(t.id)) return keep('You marked this email Keep');
  if (rules.deleteThreads.has(t.id)) return del('You marked this email Delete');
  if (rules.keepSenders.has(t.fromEmail)) return keep('Learned rule: you keep email from this sender');
  if (rules.deleteSenders.has(t.fromEmail)) return del('Learned rule: you delete email from this sender');

  if (marketingLike && (SCHOOL_RE.test(text) || WORK_CRITICAL_RE.test(text))) {
    return unsure('Mentions school, kids or work, but looks like marketing');
  }
  if (!orgSender) return keep(PERSONAL_REASON);

  if (REPLY_SUBJECT_RE.test(t.subject || '')) return unsure('Looks like a reply or forward; may be personal');
  const topic = sensitiveTopic_(text);
  if (bulk && promo >= 2 && topic !== 'account security') return del('Marketing / promotional email');
  if (PERSONAL_HINT_RE.test(text)) return unsure('Automated email that may carry a personal message');
  if (topic) return unsure('Automated email about ' + topic + '; not safe to auto-delete');
  if (bulk && t.allUnread && t.fromEmail && !ctx.senderEverOpened(t.fromEmail)) {
    const v = del('Newsletter / mailing list you have never opened');
    v.unsubscribe = true; // unsubscribe first, then delete
    return v;
  }
  if (automated && (bulk || t.category === 'updates' || t.category === 'social')) {
    return del('Automated notification with no personal content');
  }
  if (bulk) {
    return unsure(t.category === 'promotions'
      ? 'In Promotions, but not clearly marketing and you have opened this sender before'
      : 'Mailing-list email from a sender you have opened before; not clearly marketing');
  }
  return unsure('Automated sender; could not confirm it has no personal content');
}

function verdict_(action, reason, folder, orgSender) {
  const keepsFolder = action === ACTION.KEEP || action === ACTION.UNSURE;
  return { action: action, reason: reason, folder: keepsFolder ? folder : null, orgSender: orgSender };
}

function isAutoSubmitted_(t) {
  return !!t.autoSubmitted && !/^no$/i.test(t.autoSubmitted.trim());
}

function isBulk_(t) {
  return !!(t.listUnsubscribe || t.listId || t.feedbackId || isAutoSubmitted_(t) ||
    /^(?:bulk|list|junk)$/i.test((t.precedence || '').trim()) || BULK_DOMAIN_RE.test(t.fromDomain));
}

function promoScore_(t, text, local) {
  let score = PROMO_RES.filter(re => re.test(text)).length;
  if (t.category === 'promotions') score++;
  if (MARKETING_LOCAL_RE.test(local)) score++;
  return score;
}

function sensitiveTopic_(text) {
  const hit = SENSITIVE_TOPICS.find(pair => pair[1].test(text));
  return hit ? hit[0] : null;
}

function protectionReason_(t, text, s, marketingLike) {
  if (t.hasAttachment) return 'Has an attachment';
  if (t.starred) return 'Starred';
  if (t.senders.some(e => s.wifeEmails.indexOf(e) !== -1)) return 'From your wife';
  if (t.sentByMe) return 'A conversation you replied to';
  if (t.purchaseCategory) return 'Gmail tagged it as a purchase or reservation';
  if (RECEIPT_RE.test(text) || ORDER_NUMBER_RE.test(text)) {
    return 'Looks like a receipt, invoice, order or confirmation';
  }
  if (BILL_RE.test(text)) return 'Looks like a bill or statement';
  if (isSchoolSender_(t, s) || matchesTerm_(text, s.kidNames) || matchesTerm_(text, s.schoolTerms)) {
    return 'School or kid related';
  }
  if (isWorkSender_(t, s) || matchesTerm_(text, s.workKeywords)) return 'Work-critical';
  if (!marketingLike && SCHOOL_RE.test(text)) return 'School or kid related';
  if (!marketingLike && WORK_CRITICAL_RE.test(text)) return 'Looks work-critical';
  return null;
}

function folderFor_(t, text, s, ctx, marketingLike) {
  if (BILL_RE.test(text)) return 'Bills';
  if (t.purchaseCategory || RECEIPT_RE.test(text) || ORDER_NUMBER_RE.test(text)) return 'Receipts';
  if (isSchoolSender_(t, s) || matchesTerm_(text, s.kidNames) || matchesTerm_(text, s.schoolTerms) ||
      (!marketingLike && SCHOOL_RE.test(text))) {
    return 'School';
  }
  if (isWorkSender_(t, s) || matchesTerm_(text, s.workKeywords) ||
      (!marketingLike && WORK_FOLDER_RE.test(text))) {
    return 'Work';
  }
  return (ctx.senderFolders && ctx.senderFolders[t.fromEmail]) || null;
}

function isSchoolSender_(t, s) {
  return t.senders.some(e => {
    const d = e.split('@')[1] || '';
    return SCHOOL_DOMAIN_RE.test(d) || SCHOOL_SERVICE_DOMAINS.some(x => domainIs_(d, x)) ||
      s.schoolTerms.some(x => x.indexOf('.') !== -1 && domainIs_(d, x.replace(/^@/, '')));
  });
}

function isWorkSender_(t, s) {
  return t.senders.some(e => {
    const d = e.split('@')[1] || '';
    return s.workDomains.some(x => domainIs_(d, x));
  });
}

function domainIs_(domain, target) {
  return domain === target || domain.slice(-(target.length + 1)) === '.' + target;
}

function matchesTerm_(text, terms) {
  return (terms || []).some(term => {
    if (!term || (term.indexOf('.') !== -1 && term.indexOf(' ') === -1)) return false; // domains: see isSchoolSender_
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![\\w])' + escaped + '(?![\\w])', 'i').test(text);
  });
}

/** Plain-language folder name for a recurring sender, e.g. "Costco" or "Chase". */
function folderNameFor(name, email) {
  let n = String(name || '')
    .replace(/["']/g, '')
    .replace(/\s+(?:via|from)\s.*$/i, '')
    .replace(/\b(?:no-?reply|team|newsletters?|notifications?|updates?|news|mailer)\b/gi, '')
    .replace(/[^\p{L}\p{N}&\s.-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  if (n.length < 2 || n.indexOf('@') !== -1) {
    const parts = (String(email).split('@')[1] || '').split('.').filter(Boolean);
    let i = parts.length - 2;
    if (i > 0 && /^(?:co|com|org|net|ac|gov|edu)$/.test(parts[i])) i--;
    n = parts[Math.max(i, 0)] || '';
  }
  if (n === n.toLowerCase()) n = n.replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
  return n.slice(0, 40).trim();
}

/**
 * Picks how to unsubscribe from a mailing list using its List-Unsubscribe headers.
 * Preference: one-click (RFC 8058) > email request > plain link.
 * @return {{method: string, target: string}|null} null when there is no usable option
 */
function planUnsubscribe(listUnsubscribe, listUnsubscribePost) {
  const entries = (String(listUnsubscribe || '').match(/<[^>]+>/g) || []).map(e => e.slice(1, -1).trim());
  const https = entries.find(e => /^https?:\/\/[^\s]+$/i.test(e));
  const mailto = entries.find(e => /^mailto:[^\s@]+@[^\s@?]+(?:\?.*)?$/i.test(e));
  if (https && /List-Unsubscribe=One-Click/i.test(String(listUnsubscribePost || ''))) {
    return { method: 'One-click link', target: https };
  }
  if (mailto) return { method: 'Email request', target: mailto };
  if (https) return { method: 'Link', target: https };
  return null;
}

/** Splits "mailto:a@b.com?subject=x&body=y" into parts with no line breaks (no header injection). */
function parseMailto(target) {
  const m = String(target).match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  const clean = v => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const params = {};
  (m[2] || '').split('&').forEach(pair => {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    try {
      params[pair.slice(0, i).toLowerCase()] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    } catch (e) { /* ignore malformed parameter */ }
  });
  let to;
  try { to = clean(decodeURIComponent(m[1])); } catch (e) { to = clean(m[1]); }
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) return null;
  return { to: to, subject: clean(params.subject) || 'unsubscribe', body: clean(params.body) || 'unsubscribe' };
}
