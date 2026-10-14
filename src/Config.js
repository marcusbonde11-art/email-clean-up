/**
 * Operational settings. Personal details (your wife's address, work domains,
 * kid names, school names) live in the Settings tab of the Google Sheet, so you
 * never need to edit code to change them.
 */
const CONFIG = {
  SPREADSHEET_NAME: 'Email Cleanup Review',

  TAB: {
    REVIEW: 'Email Cleanup Review',
    TRIAL: 'Trial Deletions',
    SETTINGS: 'Settings',
    RULES: 'Learned Rules',
    FOLDERS: 'Folder Log',
    DELETED: 'Deletion Log',
    UNSUB: 'Unsubscribe Log',
    RUNS: 'Run Log',
  },

  // Weekly schedule, in the script project's time zone (appsscript.json).
  WEEKLY_DAY: 'SUNDAY',
  WEEKLY_HOUR: 7,

  MAX_NEW_FOLDERS_PER_WEEK: 2,
  // A sender needs at least this many unsorted inbox emails before it earns its own folder.
  NEW_FOLDER_MIN_THREADS: 5,
  // Older matching emails are filed by later weekly runs. Kept small so run state fits in Script Properties.
  MAX_THREADS_FILED_PER_NEW_FOLDER: 150,

  // Apps Script stops a run after 6 minutes, so work is done in segments that
  // hand off to a continuation trigger until the whole inbox is processed.
  SEGMENT_BUDGET_MS: 4.5 * 60 * 1000,
  CONTINUE_AFTER_MS: 60 * 1000,
  STALE_RUN_MS: 6 * 24 * 60 * 60 * 1000,
  MAX_SEGMENT_ERRORS: 5,
  PAGE_SIZE: 100,
  MAX_TRACKED_SENDERS: 80,

  // The inbox (all five tabs) is swept in three non-overlapping passes so each
  // thread is fetched once and facts like "has an attachment" come from Gmail search.
  PASSES: [
    { query: 'in:inbox has:attachment', flags: { hasAttachment: true } },
    { query: 'in:inbox -has:attachment {category:purchases category:reservations}',
      flags: { purchaseCategory: true } },
    { query: 'in:inbox -has:attachment -category:purchases -category:reservations', flags: {} },
  ],
};
