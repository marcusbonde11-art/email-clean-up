/**
 * Thin wrappers over the Gmail advanced service (Gmail API v1).
 */

const META_HEADERS = ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'List-Id', 'Precedence',
  'Auto-Submitted', 'Feedback-ID'];

let LABELS_BY_NAME_ = null;
let MAIL_BASE_URL_ = null;

function listThreads_(query, pageToken, pageSize) {
  const opts = { q: query, maxResults: pageSize || CONFIG.PAGE_SIZE };
  if (pageToken) opts.pageToken = pageToken;
  const res = Gmail.Users.Threads.list('me', opts);
  return { ids: (res.threads || []).map(t => t.id), next: res.nextPageToken || '' };
}

/** @return {?Object} normalized thread, or null if it no longer exists */
function fetchThread_(id, flags) {
  try {
    const raw = Gmail.Users.Threads.get('me', id, { format: 'metadata', metadataHeaders: META_HEADERS });
    return normalizeThread(raw, flags);
  } catch (e) {
    if (/not found|404/i.test(String(e.message))) return null;
    throw e;
  }
}

function threadLabelIds_(id) {
  const raw = Gmail.Users.Threads.get('me', id, { format: 'minimal' });
  const labels = new Set();
  (raw.messages || []).forEach(m => (m.labelIds || []).forEach(l => labels.add(l)));
  return Array.from(labels);
}

/** Adds a label. Mail stays in the inbox; nothing is archived or moved out. */
function labelThread_(id, labelId) {
  Gmail.Users.Threads.modify({ addLabelIds: [labelId] }, 'me', id);
}

/** Moves a thread to Gmail's Trash (recoverable there for 30 days). */
function trashThread_(id) {
  Gmail.Users.Threads.trash('me', id);
}

function labelsByName_() {
  if (!LABELS_BY_NAME_) {
    LABELS_BY_NAME_ = {};
    (Gmail.Users.Labels.list('me').labels || []).forEach(l => { LABELS_BY_NAME_[l.name.toLowerCase()] = l.id; });
  }
  return LABELS_BY_NAME_;
}

/**
 * Returns the ID of the label with this name, creating it if needed. Labels this
 * agent creates are recorded so they are never mistaken for hand-made folders.
 */
function ensureFolderLabel_(name, sender) {
  const existing = labelsByName_()[name.toLowerCase()];
  if (existing) return existing;
  const label = Gmail.Users.Labels.create(
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me');
  const agent = loadAgentLabels_();
  agent[label.id] = { name: name, sender: sender || null, createdAt: Date.now() };
  saveAgentLabels_(agent);
  LABELS_BY_NAME_[name.toLowerCase()] = label.id;
  return label.id;
}

/** Cached per run segment: has the user ever opened (read) an email from this sender? */
function makeOpenedChecker_() {
  const memo = {};
  const cache = CacheService.getScriptCache();
  return email => {
    if (email in memo) return memo[email];
    const key = ('opened:' + email).slice(0, 240);
    const cached = cache.get(key);
    let opened;
    if (cached !== null) {
      opened = cached === '1';
    } else {
      opened = listThreads_('from:' + email + ' is:read', '', 1).ids.length > 0;
      cache.put(key, opened ? '1' : '0', 6 * 60 * 60);
    }
    memo[email] = opened;
    return opened;
  };
}

function threadLink_(id) {
  if (MAIL_BASE_URL_ === null) {
    const user = Session.getEffectiveUser().getEmail();
    MAIL_BASE_URL_ = 'https://mail.google.com/mail/u/' + (user || '0') + '/';
  }
  return '=HYPERLINK("' + MAIL_BASE_URL_ + '#all/' + id + '","Open")';
}

/**
 * Carries out one unsubscribe plan from planUnsubscribe().
 * @return {{status: string, details: string}} status is 'Succeeded' or 'Failed'
 */
function attemptUnsubscribe_(method, target) {
  try {
    if (method === 'Email request') {
      const mail = parseMailto(target);
      if (!mail) return { status: 'Failed', details: 'Unsubscribe address could not be read' };
      const raw = 'To: ' + mail.to + '\r\nSubject: ' + mail.subject +
        '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + mail.body;
      Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }, 'me');
      return { status: 'Succeeded', details: 'Unsubscribe email sent to ' + mail.to };
    }
    const oneClick = method === 'One-click link';
    const res = UrlFetchApp.fetch(target, oneClick
      ? { method: 'post', payload: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded',
        muteHttpExceptions: true, followRedirects: true }
      : { method: 'get', muteHttpExceptions: true, followRedirects: true });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return { status: 'Succeeded', details: oneClick ? 'One-click unsubscribe accepted (HTTP ' + code + ')'
        : 'Unsubscribe link opened (HTTP ' + code + '); some senders also ask you to confirm on their page' };
    }
    return { status: 'Failed', details: 'Sender\'s server answered HTTP ' + code };
  } catch (e) {
    return { status: 'Failed', details: String(e.message).slice(0, 200) };
  }
}
