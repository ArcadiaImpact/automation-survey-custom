# Saving responses: setup (≈10 minutes, one time)

Responses go into a Google Sheet. A small Google Apps Script attached to that
sheet ([`apps-script/Code.gs`](apps-script/Code.gs)) receives each submission
and writes one row per respondent. The survey page only shows "thank you"
after the script confirms the row was written.

## 1. Create the sheet

1. Create a new Google Sheet **inside a Shared Drive** (not someone's My Drive),
   e.g. "Automation survey — responses". If the person who owns it leaves the
   org, a sheet in My Drive (and its script) can stop working.
2. Leave it empty. The script creates a `responses` tab and its header row.

## 2. Add the script

1. In the sheet: **Extensions → Apps Script**.
2. Delete what is in `Code.gs` and paste in the whole of
   [`apps-script/Code.gs`](apps-script/Code.gs). Save (⌘S).

## 3. Deploy it as a web app

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

> If "Anyone" is not offered in step 2, the Workspace admin has blocked
> sharing outside the organisation. Ask them to allow it for you, or the form
> will only work for people signed in to an arcadiaimpact.org account.

## 4. Check the URL works for anonymous visitors

Open the `/exec` URL in a **private/incognito window**. You should see:

```
{"ok":true,"message":"Automation survey endpoint is running."}
```

If you see a Google sign-in page instead, "Who has access" is not set to
"Anyone". Fix that before going further.

## 5. Point the survey at it

In [`content.js`](content.js), paste the URL into `submit.endpoint`:

```js
submit: {
  endpoint: "https://script.google.com/macros/s/XXXX/exec",
```

Commit and push to `main`. The "mock" badge disappears, and Submit now saves.

## 6. Test before sending the link to anyone

- [ ] Submit one full response from a laptop in an incognito window. A row appears in the sheet.
- [ ] Submit one from a phone.
- [ ] Turn wifi off, press Submit: you should see an error and keep your answers. Turn wifi on, press **Try again**: "thank you", and still only one row for that attempt.
- [ ] Fill half the form, close the tab, reopen the link: your answers are back.
- [ ] Type `=1+1` in a text box: the sheet shows the text `=1+1`, not `2`.
- [ ] **Delete the test rows** (keep row 1, the header) before launch.

## Changing things later

- **Wording** (titles, hints, labels, task names): edit `content.js` freely.
  Each response records a `content_version` code, which changes automatically
  whenever `content.js` changes. You can always tell which wording someone saw.
- **Never change** a task `id` or an optional question `key` once responses
  are coming in. These are the sheet's column names. Changing one splits the
  data into two columns.
- **Adding a question** to `optional.questions`: no script change needed. A
  new column appears automatically the first time someone answers it.
- **Editing the script itself:** **Deploy → Manage deployments** → pencil icon
  → Version: **New version** → Deploy. Do *not* use "New deployment", which
  creates a different URL and would break the survey until `content.js` is updated.

## Analysing the results

**File → Download → CSV**, then for example:

```python
import pandas as pd
df = pd.read_csv("responses.csv")
df.filter(like="points.").describe()                 # 100-point split per task
df.filter(like="hours_active_human.").describe()     # hours per task × era
```

Columns look like `points.design` and `hours_active_human.design.now`. Each
row is one respondent. Retries overwrite their own row, so there are no
duplicates to clean up. The `raw_json` column holds every response exactly as
it was sent. If a column ever looks wrong, rebuild from that.
