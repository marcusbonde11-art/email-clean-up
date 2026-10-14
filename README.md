# Email Clean-Up: weekly Gmail cleanup and organization agent

A Google Apps Script agent that cleans and organizes your Gmail inbox once a week. It runs inside
your own Google account. No server, API keys or extra subscriptions are needed.

- **Deletes automatically:** clear marketing emails, newsletters you have never opened, and
  automated notifications with no personal content. This covers every date range, past and future.
- **Never deletes or moves:** anything with an attachment, receipts, invoices, order confirmations,
  anything with a confirmation or order number, email from your wife, school or kid email,
  work-critical email, and anything already in a folder you made yourself.
- **Asks you about everything else:** each unclear email becomes a row in the Google Sheet
  **Email Cleanup Review**. You mark it **Delete** or **Keep**, and the agent learns that as a
  rule for the sender.
- **Organizes:** it files unsorted inbox mail into **Receipts**, **School**, **Work** and
  **Bills**. When a sender keeps showing up, it may create up to two new folders per week, named
  after that sender.
- **Trial first:** until you approve the trial, nothing is deleted, moved or labelled. Every email
  it *would* delete is listed in the **Trial Deletions** tab for you to check.

## One-time setup (about 10 minutes)

1. Go to <https://script.google.com>, click **New project**, and name it `Email Cleanup Agent`.
2. Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**.
   On the same page, set **Time zone** to your own. The weekly run uses it: Sundays around 7 am.
3. Go back to the **Editor**. Replace the contents of `appsscript.json` with
   [`src/appsscript.json`](src/appsscript.json), but keep the time zone you just picked.
4. Create one script file for each file in [`src/`](src/) (`+` → **Script**). Name them `Classifier`,
   `Config`, `Sheet`, `Gmail` and `Main`, and paste in the matching file's contents. You can delete
   the default `Code.gs`.
   *Alternative:* use [clasp](https://github.com/google/clasp). Copy `.clasp.json.example` to
   `.clasp.json`, put in the Script ID from **Project Settings**, then run
   `npm i -g @google/clasp && clasp login && clasp push`.
5. In the function dropdown at the top, pick **`setup`** and click **Run**. Approve the permission
   prompt (Gmail, Sheets, triggers). If Google warns that the app is unverified, click
   **Advanced → Go to Email Cleanup Agent**. This is your own script.
6. The execution log prints the link to a new Google Sheet called **Email Cleanup Review**. It is
   also in your Google Drive. Open its **Settings** tab and fill in:
   - **Wife email addresses** (required): one address or several, separated by commas.
   - **Work email domains**, **Extra work keywords**, **Kid names**, **School names or domains**
     (optional, but they make the protection rules more accurate).
7. Back in the script editor, run **`runNow`** to start the **trial run**. A big inbox takes several
   minutes, possibly a few hours: the agent keeps going in 5-minute segments by itself. When the
   **Run Log** tab gets a row with Mode = `Trial`, the trial is finished.

## Approving the trial

1. Open the **Trial Deletions** tab. It lists every email the agent would have deleted, with the
   reason. Use the **Open** link to look at any of them.
2. If something should not be deleted, set its **Decision** to **Keep**. That sender becomes a
   "keep" rule from now on.
3. Optionally, go through the **Email Cleanup Review** tab now as well.
4. If the pattern looks wrong, tell me (or edit `src/Classifier.js`). To re-check, run `runNow`
   again. Each trial only adds emails that are not already listed.
5. When you are happy, tick **Trial approved** in the **Settings** tab. The next weekly run is a
   real one. To start it right away, run `runNow`.

The agent will not run for real while **Wife email addresses** is empty, even if the trial is
approved.

## What each weekly run does

1. **Learns from you first.** It reads every **Decision** you have entered in the Review and
   Trial Deletions tabs and saves each one as a per-sender rule in **Learned Rules**. If one
   sender has both Keep and Delete markings, Keep wins. The exact email you marked is handled the
   way you said.
2. **Checks the whole inbox:** Primary, Promotions, Social, Updates and Forums. For each email:

   | Check (in this order) | Result |
   |---|---|
   | Has a label/folder you created by hand | Not touched at all |
   | Attachment · receipt / invoice / order / confirmation or order number · Gmail "purchases" or "reservations" · bill or statement · from your wife · school or kid related · work domain or work-critical · starred · a conversation you replied to | Kept (never deleted, never archived) |
   | You marked it, or its sender has a learned rule | Your decision |
   | Looks like a reply or forward | Logged for review |
   | Clear marketing (mailing-list email with promotional language) | Deleted |
   | Notification that may carry a personal message ("X sent you a message", "commented on…") | Logged for review |
   | Automated email about account security, money, health, travel or legal matters | Logged for review |
   | Mailing-list email you have never opened from a sender you have never opened | Deleted |
   | Automated notification (no-reply style sender) in Updates/Social or from a mailing list | Deleted |
   | Ordinary email from a person | Kept |
   | Anything else | Logged for review |

3. **Logs unclear emails** to the **Email Cleanup Review** tab: Sender, Subject, Date, Reason, a blank
   **Decision** column (Delete / Keep), and a link to the email. An email is only logged once.
4. **Deletes** by moving emails to Gmail's **Trash**. You can still recover them there for 30
   days. Each deletion is recorded in the **Deletion Log** tab.
5. **Sorts** unsorted inbox email into **Receipts**, **School**, **Work** and **Bills**. It also
   continues filing into folders it created earlier for recurring senders. Sorting adds the Gmail
   label and leaves the email in the inbox. That way "never move" stays true for protected mail,
   and the email still shows up in the folder.
6. **Creates up to 2 new folders per week**, but only for a company or mailing-list sender with at
   least 5 unsorted inbox emails. Personal contacts and your wife never get one. The folder name is
   in plain language (e.g. `Costco`). Each new folder is recorded in the **Folder Log** tab.
7. **Writes a summary row** to **Run Log**: emails checked, deleted, newly logged for review, kept,
   sorted, new folders, and any notes.

## The Google Sheet

| Tab | What it's for |
|---|---|
| Email Cleanup Review | Unclear emails. Fill in **Decision** with Delete or Keep. |
| Trial Deletions | Everything the trial would have deleted. Mark **Keep** on any mistakes. |
| Settings | Trial approval, wife's address, work/school/kid details, current mode. |
| Learned Rules | Per-sender rules built from your decisions. To change one, change the Decision in the Review tab. |
| Folder Log | Every folder the agent created, and why. |
| Deletion Log | Every email moved to Trash, with the rule that triggered it. |
| Run Log | One row per run. |

Don't delete rows from the Review tab after you mark them. Rules are rebuilt from those markings,
although rules already saved in **Learned Rules** stay there.

## Script functions

| Function | Use |
|---|---|
| `setup` | First-time setup. Safe to re-run (it won't duplicate the sheet or the trigger). |
| `runNow` | Start a run immediately (trial or live, depending on Settings). |
| `showStatus` | Print the progress of a run that is still going. |
| `uninstall` | Remove the weekly trigger. The sheet and your Gmail labels are left alone. |

## Developing

```bash
npm test     # unit tests for the classifier, plus full trial → live runs against fake Gmail/Sheets
```

- `src/Classifier.js`: all the delete / keep / review / folder rules (pure JS, unit tested)
- `src/Main.js`: the weekly run (learn → sweep → trash → folders → finish), split into segments to
  fit Apps Script's 6-minute limit
- `src/Sheet.js`, `src/Gmail.js`: Google Sheets and Gmail API wrappers
- `src/Config.js`: schedule, folder limits and search passes

### Automatic deploys (optional)

The CI workflow runs the tests on every push. It can also push `src/` to your Apps Script project
whenever `main` changes. To turn that on, add two repository secrets:

- `SCRIPT_ID`: from Apps Script **Project Settings → Script ID**
- `CLASPRC_JSON`: the contents of `~/.clasprc.json` after you run `clasp login` on your computer
