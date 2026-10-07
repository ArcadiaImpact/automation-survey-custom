# Automation Survey — Measuring Automation in AI Safety Research

A single-page survey with typed grid questions (100-point distribution with a
live sum check, and an active-human-hours grid) that Google Forms cannot express.

## Editing the survey

**All text lives in [`content.js`](content.js)** — titles, every question,
hints, button labels. `index.html` is layout and logic only; you should not
need to touch it.

- To add a paragraph under any section title, add a string to that section's
  `preamble: []` array. Plain text, or `<strong>…</strong>` for bold.
- To add/remove optional questions, edit `optional.questions`.
- The task categories used by both grids are in `tasks`. Rename them freely,
  but never change a task's `id` (or an optional question's `key`) once
  responses are coming in: those are the column names in the results sheet.

## Running locally

Open `index.html` in a browser (the page loads `content.js` from the same
folder). Or `python3 -m http.server` and visit http://localhost:8000.

## Hosting

Any static host works. For GitHub Pages: repo Settings → Pages → deploy from
the `main` branch root.

## Saving responses

Responses are written to a Google Sheet by a small Apps Script
([`apps-script/Code.gs`](apps-script/Code.gs)):

- every edit is saved immediately in the respondent's browser;
- after Start, anonymous drafts are saved to the server without the optional
  email address;
- abandoned drafts expire from active storage after 48 hours;
- revisions and response IDs make retries safe and prevent delayed drafts from
  replacing submitted responses;
- final submissions remain in the main Sheet and receive rolling daily CSV
  backups; and
- analysis uses only rows whose `status` is `submitted`.

One-time deployment, retention, backup, and pre-launch checks are in
[`SETUP.md`](SETUP.md). The approved architecture and implementation plan are
in
[`docs/superpowers/specs/2026-10-07-survey-response-persistence-design.md`](docs/superpowers/specs/2026-10-07-survey-response-persistence-design.md)
and
[`docs/superpowers/plans/2026-10-07-survey-response-persistence.md`](docs/superpowers/plans/2026-10-07-survey-response-persistence.md).

While `submit.endpoint` in `content.js` is empty, the page runs as a mock:
Submit only shows the JSON payload a submission will contain, and nothing is stored.
