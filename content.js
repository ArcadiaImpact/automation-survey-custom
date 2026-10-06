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
  footer: "Arcadia Impact · Measuring automation in AI safety research",

  intro: {
    title: "Measuring automation in AI safety research",
    paragraphs: [
      "Anthropic and OpenAI have started publishing how much of their AI R&D is now done by AIs. We want the equivalent picture for AI safety: how researchers like you actually use agents today, what resists automation, and how this changes over time.",
      "Most questions take seconds. Two short grids ask for time estimates — that's where accuracy matters most. Thank you!"
    ],
    startLabel: "Start"
  },

  // The five task categories used by both grids.
  tasks: [
    { name: "Conceptual / strategy / RRL", detail: "idea generation, strategy work, related-work review" },
    { name: "Experiment design", detail: "experiment plans, environments, datasets, metrics" },
    { name: "Building experiment infra", detail: "writing code to implement the plan" },
    { name: "Running experiments", detail: "launching & orchestrating runs, running evals" },
    { name: "Writing / communication", detail: "analysing results, docs, papers" }
  ],

  about: {
    title: "About you",
    preamble: [],
    email: { label: "Email", hint: "Optional — only if you opt in for future comms & follow-up surveys." },
    role: { label: "Role / title" },
    experience: { label: "AI safety experience",
      options: ["≤ 3 months", "< 1 year", "< 2 years", "2–5 years", "5+ years"] },
    org: { label: "Org type",
      options: ["Fellowship", "Independent", "Research org", "Frontier lab (MTS)"],
      otherLabel: "Other", otherPlaceholder: "Your org type" },
    usage: { label: "How do you use AIs to help with your work?",
      hint: "Type of tasks, bespoke scaffolds, sub-agents, Claude vs Codex, etc. — as much detail as possible!" }
  },

  points: {
    title: "Where does your work go?",
    preamble: [
      "Distribute 100 points across the five task categories by the volume of work in your role. The total updates as you type — it has to land on exactly 100 before you can continue."
    ],
    colTask: "Task category",
    colPoints: "Points",
    totalLabel: "Total",
    needHint: "needs to be exactly 100",
    okHint: "perfect — carry on",
    overSuffix: " over",
    toGoSuffix: " to go"
  },

  hours: {
    title: "Active human time per task",
    preamble: [
      "From your most recent completed publishable output, think of one representative task per category. Enter <strong>active human hours</strong> — prompting, reviewing, fixing, monitoring. Time waiting on the agent does not count. All cells are required — if a category isn't part of your role, enter 0."
    ],
    colTask: "Task",
    eraHeaders: ["Without agentic AI", "Models from 1 yr ago", "Now", "In 6 months (projected)"],
    cellPlaceholder: "hrs",
    notes: { label: "Notes on your estimates",
      hint: "Optional — anything that makes these numbers easier to interpret (what the representative tasks were, where you're least sure…)." },
    errIncomplete: "Every cell needs a number (0 is fine). Incomplete rows: "
  },

  barriers: {
    title: "Automation barriers",
    preamble: [],
    highvalue: { label: "What tasks would be the highest value for you to automate that you currently aren't or can't?" },
    reason: { label: "For those tasks, what's the main reason? If you've tried, what went wrong?",
      hint: "e.g. hard to verify outputs, too much context to explain, cost, safeguards/refusals — if it's a capability issue, please be specific. \"I can do task X better than the model, because…\" / \"I have no way of checking if models do it well\" / \"too hard to give the model enough context\" / \"annoying to hand off because… (auto-mode refusals etc.)\"" },
    hardais: { label: "What in AI safety work specifically do you think is hard to automate?" },
    fraction: { label: "Of the research outputs you produced in the last 3 months, roughly what fraction would simply not exist without AI assistance?",
      options: ["0%", "<10%", "10–30%", "30–60%", "60–80%", ">80%"],
      commentPlaceholder: "Expound if you like (optional)" },
    tracking: { label: "How do you keep track of what the agents did?" }
  },

  optional: {
    title: "Optional extras",
    preamble: [],
    // Add or remove questions freely; "key" names the field in the stored response.
    questions: [
      { key: "own_metrics", label: "Are you already tracking automation metrics in your own org?" },
      { key: "referrals", label: "Who else should we talk to?" }
    ]
  },

  nav: { next: "Next", back: "Back", submit: "Submit" },
  validation: {
    stillNeeded: "Still needed: ",
    aboutLabels: { role: "role", experience: "experience", org: "org type", usage: "how you use AIs" },
    barrierLabels: { highvalue: "highest-value tasks", reason: "main reason", hardais: "hard to automate", fraction: "fraction question", tracking: "agent tracking" }
  },
  mock: {
    enabled: true,
    badge: "mock — nothing is saved",
    dialogTitle: "This is a mock",
    dialogTag: "not wired up",
    dialogBody: "Nothing was sent or stored. When we connect it to your response store (Google Form endpoint or a database), this exact payload is what each submission will contain:",
    closeLabel: "Close"
  }
};
