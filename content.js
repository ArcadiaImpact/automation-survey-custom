// ============================================================
// Arcadia Impact — Automation Survey: ALL editable text lives here.
// Edit freely; index.html renders whatever this file says.
// - "preamble" on any section = extra paragraphs shown under its title.
//   Add as many strings to the array as you like (plain text, or <strong>…</strong> for bold).
// - optional.questions: add/remove objects to change the optional section.
// ============================================================
window.CONTENT = {
  pageTitle: "Measuring Automation in AI Safety Research — Arcadia Impact",
  brand: "Arcadia Impact",
  brandUrl: "https://www.arcadiaimpact.org/alignment",   // the header name links here, in a new tab
  footer: "Arcadia Impact · Measuring automation in AI safety research",

  intro: {
    title: "Why We’re Doing This",
    paragraphs: [
      "We want to understand the state of automated research in AI safety compared with capabilities research. Right now, there's no existing way to measure this.",

      "Frontier labs have started publishing how much of their AI R&D is now done by AI <a href='https://www.anthropic.com/institute/measuring-pace-of-ai-development#footnote-1' target='_blank' rel='noopener noreferrer'>[1]</a><a href='https://openai.com/index/research-acceleration-view-inside-openai/' target='_blank' rel='noopener noreferrer'>[2]</a>, but they do not separate safety from capabilities. We want to take the first step towards measuring this for AI safety, and learn which tasks AIs help speed up and what the bottlenecks are. We acknowledge that measuring this accurately seems hard, but we think a scrappy point estimate will be valuable. Part of this process is figuring out how to measure this better.",

      "We hope these results provide AI safety researchers, strategists, and policymakers with evidence to guide research, funding, and policy. Over time, we want this to become a public baseline that tracks the capabilities–safety gap and pushes labs to report the two separately.",

      "<strong>Dual Use & Privacy</strong>",
      "We acknowledge that insights gained from this survey have the potential to speed up capabilities work. We will not release scaffolds, advice, or artifacts that we think could speed up capabilities research. All individual responses will be anonymised and kept private, and we will only publish aggregated results. You can skip any question, especially if you think answering could cause harm.",

    ],
    startLabel: "Start"
  },

  // The five task categories used by both grids.
  // "id" is the column name in the results sheet. Change "name"/"detail" freely,
  // but NEVER change an id once the survey is live (it would split the data).
  tasks: [
    { id: "conceptual", name: "Conceptual / strategy work, idea generation", detail: "Reading relevant literature, papers, etc." },
    { id: "design", name: "Experiment design", detail: "Writing experiment plans; designing environments, datasets, and metrics" },
    { id: "infra", name: "Building experiment infra", detail: "Writing code to implement the experiment plan" },
    { id: "running", name: "Running experiments", detail: "Launching and orchestrating training runs; running evals" },
    { id: "writing", name: "Writing / communication", detail: "Analysing and interpreting results; writing docs for colleagues or external audiences, and papers" },
    { id: "collaborating", name: "Collaborating", detail: "People management, peer collaboration, meetings, mentorship, and project/research management" }
  ],

  about: {
    title: "Questions",
    preamble: [],
    email: { label: "Email", hint: "Optional — if you opt in for future communications and surveys." },
    jobTitle: {
      label: "Job Title",
      options: ["Fellow", "Member of Technical Staff", "Research Lead", "Programme Manager", "Senior Leadership"],
      otherLabel: "Other", otherPlaceholder: "Please specify your job title"
    },
    roleType: {
      label: "Role type",
      options: ["Technical AI Safety", "Policy / Governance", "Field-building", "Grant-making"],
      otherLabel: "Other", otherPlaceholder: "Please specify your role type"
    },
    experience: { label: "Coding experience (total overall years with and without AI assistance)",
      options: ["< 1 year", "1-2 years", "2–5 years", "5+ years"] },
    usage: { label: "Describe how you use AIs to help with your work",
      hint: "What types of tasks, bespoke scaffolds, sub-agents, Claude vs Codex, etc.? Please give as much detail as possible!" }
  },

  points: {
    title: "Distribute 100 points",
    preamble: [
      "Over the last 3 months, how much did each of these six categories contribute to your outputs or the work your role is expected to deliver?",
      "Count accordingly even if AI now does most of it. For example, if most of your outputs come from experiments but AI mostly runs them, experiments still get a high share."
    ],
    colTask: "Task category",
    colPoints: "Points",
    totalLabel: "Total",
    needHint: "needs to be exactly 100",
    badCellHint: "each value must be between 0 and 100",
    okHint: "Nice, carry on.",
    overSuffix: " over",
    toGoSuffix: " to go"
  },

  hours: {
    title: "Active human time on a recent project",
    preamble: [
      "<strong>Pick one recent project to anchor your answers.</strong>",
      "Choose the most recent research output you finished, such as a paper, blog post, or report. If this doesn't apply to you, choose the project you've spent the most time on recently, even if it's exploratory.",
      "For each category below, think about the related tasks you completed as part of that project."
    ],
    reminders: [
      "Active hours means your own hands-on time prompting, reviewing, and fixing. Don't count time spent waiting on AI while you did something else.",
      "Leave a row blank if this is not a task you do for your role",
      "For this question, we’d appreciate a few more minutes of your time to be as accurate as you can.",
    ],
    instructionLead: "For each category, answer all four questions:",
    instructions: [
      "How many active hours would you have spent doing the same task to the same quality without AI assistance?",
      "How many active hours would you have spent doing the same task to the same quality using AI models/tools from 1 year ago?",
      "How many active hours do you spend on it now, using current AI tools?",
      "How many active hours do you predict you’ll spend on it 6 months from now?"
    ],
    oneYearAgoGuide: [
      "Available 1 year ago: Cursor, Claude Code, GPT-5, GPT-5 Codex, Sonnet 4.5, and Haiku 4.5.",
      "Out of scope: Claude Opus 4.5, GPT-5.1, Gemini 3, and Grok 4.1 were released after October 2025."
    ],
    colTask: "Task",
    eraHeaders: ["Without AI assistance", "Using AI tools from 1 year ago", "Using current AI tools", "Projection 6 months from now"],
    cellPlaceholder: "hrs",
    notes: { label: "Notes on your estimates",
      hint: "Optional — anything that makes these numbers easier to interpret (what the representative tasks were, where you're least sure…)." },
    errIncomplete: "Every cell needs a number (0 is fine). Incomplete rows: "
  },

  barriers: {
    title: "Automation barriers",
    preamble: [],
    highvalue: { label: "What research tasks would be the highest value for you to automate that you currently aren’t or can’t?" },
    reason: { label: "For the tasks you mentioned above, what’s stopping you? If you have tried, describe what you did and what went wrong.",
      hint: "For example: “I can do task X better than the model, because…” / “Task X is too hard to define and give the model enough context” / “It’s annoying to hand off task X to AIs because…” (for example, running into auto-mode refusals)." },
    tracking: { label: "How do you keep track of what the agents did?" }
  },

  optional: {
    title: "",
    preamble: [],
    questions: []
  },

  nav: { next: "Next", back: "Back", submit: "Submit" },
  validation: {
    stillNeeded: "Still needed: ",
    aboutLabels: { jobTitle: "job title", roleType: "role type", experience: "coding experience", usage: "how you use AIs" },
    barrierLabels: { highvalue: "highest-value tasks", reason: "what is stopping you", tracking: "agent tracking" }
  },
  // Where responses are sent. Paste the Apps Script web app URL here (see SETUP.md).
  // While this is empty, the page runs as a mock: Submit only shows the payload.
  submit: {
    endpoint: "https://script.google.com/macros/s/AKfycbxbIV0tw_cK9fWpGrlk-dihlwKojSnovu02f1vn_25Rst-JojwQ1GJ0qDfylgwpXQaK/exec",
    sending: "Sending…",
    saving: "Saving…",
    saved: "Saved",
    savedOffline: "Saved on this device — offline",
    saveFailed: "Could not reach the server — your answers remain on this device",
    retry: "Try again",
    errNetwork: "Your answers were not saved yet — please check your connection and press Try again. Nothing you typed has been lost.",
    errServer: "Something went wrong saving your answers (nothing you typed has been lost). Please press Try again. If it keeps failing, email us and we'll sort it out. Error: ",
    errNumbers: "Hours must be 0 or more. Check: ",
    draftRestored: "We restored the answers you started earlier on this device.",
    contact: "If you want to reach out to us about this work, contact <a href='mailto:angel@arcadiaimpact.org'>angel@arcadiaimpact.org</a>.",
    thanksTitle: "Thank you — your response is saved",
    thanksBody: "We really appreciate the time. If you opted in with your email, we'll be in touch about follow-ups."
  },

  mock: {
    badge: "mock — nothing is saved",
    dialogTitle: "This is a mock",
    dialogTag: "not wired up",
    dialogBody: "Nothing was sent or stored. When we connect it to your response store (Google Form endpoint or a database), this exact payload is what each submission will contain:",
    closeLabel: "Close"
  }
};
