# Saving responses: setup

Responses go into a Google Sheet. A small Google Apps Script attached to that
sheet ([`apps-script/Code.gs`](apps-script/Code.gs)) receives anonymous drafts
and final submissions. The survey page only shows "thank you" after the script
confirms the final response was written.

## 1. Create the sheet

1. Create a new Google Sheet **inside a Shared Drive** (not someone's My Drive),
   e.g. "Automation survey — responses". If the person who owns it leaves the
   org, a sheet in My Drive (and its script) can stop working.
2. Leave it empty. The script creates fixed-schema `responses` and
   `response_events` tabs on the first save.
3. Create a restricted folder in the same Shared Drive for submitted-response
   CSV backups. Copy the folder ID from its URL.

If an older version of this survey has already written responses, do not delete
them. Export them first and use a new empty Sheet for this version; the fixed
schema intentionally rejects unexpected existing headers.

## 2. Add the script

1. In the sheet: **Extensions → Apps Script**.
2. Delete what is in `Code.gs` and paste in the whole of
   [`apps-script/Code.gs`](apps-script/Code.gs). Save (⌘S).

## 3. Configure maintenance and alerts

1. In Apps Script, open **Project Settings → Script Properties**.
2. Add `BACKUP_FOLDER_ID` with the restricted backup folder's ID.
3. Add `ALERT_EMAIL` with the operator address that should receive internal
   save-failure alerts. Alerts are limited to one per hour.
4. Select `installMaintenanceTriggers` in the function menu and click **Run**.
   Authorize Sheets, Drive, and Mail access.
5. Open **Triggers** and confirm exactly:
   - one hourly `cleanupExpiredDrafts` trigger; and
   - one daily `backupSubmittedResponses` trigger.

Running `installMaintenanceTriggers` again replaces only these two managed
triggers, so it is safe after script updates.

## 4. Deploy it as a web app

1. **Deploy → New deployment**. Click the gear next to "Select type" → **Web app**.
2. Set:
   - **Execute as:** Me
   - **Who has access:** **Anyone**. Not "Anyone with a Google account", and not
     "Anyone within Arcadia Impact". Respondents are outside the org and won't
     be signed in.
3. **Deploy** → **Authorize access**. Google will warn that the app "hasn't
   been verified". That's expected for your own script: **Advanced → Go to
   … (unsafe)** → Allow.
4. Copy the **Web app URL** (it ends in `/exec`).

For every later script update, use **Deploy → Manage deployments → pencil
icon → Version: New version → Deploy**. Do not create another deployment:
that would create a new URL and leave the survey pointing at old code.

> If "Anyone" is not offered in step 2, the Workspace admin has blocked
> sharing outside the organisation. Ask them to allow it for you, or the form
> will only work for people signed in to an arcadiaimpact.org account.

## 5. Check the URL works for anonymous visitors

Open the `/exec` URL in a **private/incognito window**. You should see:

```
{"ok":true,"message":"Automation survey endpoint is running."}
```

If you see a Google sign-in page instead, "Who has access" is not set to
"Anyone". Fix that before going further.

## 6. Point the survey at it

In [`content.js`](content.js), paste the URL into `submit.endpoint`:

```js
submit: {
  endpoint: "https://script.google.com/macros/s/XXXX/exec",
```

Commit and push to the production branch. The "mock" badge disappears and
background saving starts after the respondent presses Start.

## 7. Test before sending the link to anyone

- [ ] Press Start and enter a partial response. A `draft` row appears in
  `responses`, an event appears in `response_events`, and neither contains the
  optional email.
- [ ] Type rapidly. Revisions increase and no two events share an `event_key`.
- [ ] Turn Wi-Fi off and continue typing. The page says the answers remain on
  this device. Restore Wi-Fi and confirm the latest snapshot reaches the Sheet.
- [ ] Refresh and close/reopen the survey before 48 hours. The local answers
  return.
- [ ] Submit one full response from a laptop in an incognito window. The row
  changes to `submitted` and the thank-you page appears only after the write.
- [ ] Submit from a phone.
- [ ] Retry the same final request. There is still one current response and one
  event for that revision.
- [ ] Send a later draft for a submitted response. Its status stays
  `submitted`.
- [ ] Send an unknown answer key. The request is rejected and no Sheet header
  is added.
- [ ] Type `=1+1` in a text box. The Sheet shows `=1+1`, not `2`.
- [ ] Change a test draft's `updated_at` to more than 48 hours ago, run
  `cleanupExpiredDrafts`, and confirm its current row and all events disappear.
- [ ] Run `backupSubmittedResponses`. Parse the CSV and confirm it contains
  submitted rows only and preserves commas, quotes, and multiline answers.
- [ ] Run `notifyOwner_` from the Apps Script function menu and confirm
  `ALERT_EMAIL` receives one message. A second run within an hour must not send
  another.
- [ ] Delete test response/event rows and test backup files before launch.

The respondent-disclosure copy described in the architecture spec is deferred
and is not part of this release.

## Retention and recovery

- Browser-local drafts are discarded on the next visit after 48 hours.
- Abandoned server drafts and all their events are removed from active storage
  after 48 hours without an accepted save.
- Submitted responses remain in the main Sheet.
- A submitted-only CSV backup is created daily. Backup files older than 90 days
  are moved to trash, leaving approximately 90 rolling daily backups.
- The 48-hour deletion applies to active survey storage. Google may retain
  service-level revision history or disaster-recovery copies under its own
  retention terms.

## Changing things later

- **Wording** (titles, hints, labels, task names): edit `content.js` freely.
  Each response records a `content_version` code, which changes automatically
  whenever `content.js` changes. You can always tell which wording someone saw.
- **Never change** a task `id` or an optional question `key` once responses
  are coming in. These are the sheet's column names. Changing one splits the
  data into two columns.
- **Adding or removing a question:** update the browser payload, Apps Script
  allowlist, fixed columns, and tests together. Public requests cannot create
  columns automatically.
- **Editing the script itself:** deploy a new version of the existing
  deployment so the `/exec` URL remains unchanged.

## Analysing the results

**File → Download → CSV**, then for example:

```python
import pandas as pd
df = pd.read_csv("responses.csv")
df = df[df["status"] == "submitted"]
df.filter(like="points.").describe()                 # 100-point split per task
df.filter(like="hours_active_human.").describe()     # hours per task × era
```

Columns look like `points.design` and `hours_active_human.design.now`. Each
current row is one respondent. Retries update their row, so there are no
duplicate current responses to clean up. Analyse only `status = submitted`.
The `raw_json` columns retain the accepted payload, while `response_events`
provides revision recovery.
