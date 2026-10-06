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
- The task categories used by both grids are in `tasks`.

## Running locally

Open `index.html` in a browser (the page loads `content.js` from the same
folder). Or `python3 -m http.server` and visit http://localhost:8000.

## Hosting

Any static host works. For GitHub Pages: repo Settings → Pages → deploy from
the `main` branch root.

## Status

Submission is currently a mock: the Submit button shows the exact JSON payload
a submission will contain, and nothing is stored. Backend wiring (Google Form
endpoint or a database) is the next step; set `mock.enabled` in `content.js`
to `false` once wired.
