'use strict';
// Project templates: instructions, starter tasks and starter project memories.
const TEMPLATES = [
  {
    id: 'software', name: 'Software project', color: '#5ca8ff', description: 'An app, website or tool you are building with AI coding agents.',
    instructions: 'Read the project memories before changing code. Follow the existing code style. Run the tests before saying something works and report results honestly. Record architecture decisions, setup steps and gotchas as project memories. Keep the task board current.',
    tasks: [['Write down how to run, build and test the project', 'high'], ['Record the architecture and key decisions', 'medium'], ['List known bugs and rough edges', 'medium']],
    notes: [['Architecture', 'decision', '# Architecture\n\nHow the pieces fit together. Agents: update this when you change the structure.\n'], ['How to run and test', 'reference', '# How to run and test\n\n- Install:\n- Run:\n- Test:\n']],
  },
  {
    id: 'research', name: 'Research', color: '#3ee6a0', description: 'Investigating a question with sources, notes and conclusions.',
    instructions: 'Prefer primary sources and cite them with links. Separate facts, inferences and open questions. Save each important source as a project memory with a summary. Keep a running "Findings" note up to date.',
    tasks: [['Define the research question and what a good answer looks like', 'high'], ['Collect and summarise the key sources', 'medium'], ['Write up findings and open questions', 'medium']],
    notes: [['Research question', 'plan', '# Research question\n\nWhat exactly are we trying to find out, and why?\n'], ['Findings', 'reference', '# Findings\n\n## Facts\n\n## Inferences\n\n## Open questions\n']],
  },
  {
    id: 'content', name: 'Content & writing', color: '#e66bff', description: 'Articles, videos, posts or a newsletter.',
    instructions: 'Match the user\'s voice (see the "Voice and style" memory). Draft in Markdown, keep drafts in Mind write items or project memories, and never publish anything without the user approving it.',
    tasks: [['Write the voice and style guide', 'high'], ['Plan the next 5 pieces', 'medium']],
    notes: [['Voice and style', 'reference', '# Voice and style\n\nTone, words to use and avoid, formatting rules, examples of past work.\n'], ['Content calendar', 'plan', '# Content calendar\n\n| Date | Piece | Status |\n|---|---|---|\n']],
  },
  {
    id: 'minecraft-mod', name: 'Minecraft mod', color: '#ffc35c', description: 'A Fabric/Forge mod: versions, build, in-game testing.',
    instructions: 'Check the pinned Minecraft, loader and mapping versions in the project memories before changing build files. Run the unit tests and report build results separately from in-game results. Record every in-game test with what was actually observed. Follow the target server\'s rules; do not build automation the server prohibits.',
    tasks: [['Record the pinned versions (Minecraft, loader, API, Java, Gradle)', 'high'], ['Write the in-game test checklist', 'medium'], ['Document how to build and install the jar', 'medium']],
    notes: [['Versions and environment', 'reference', '# Versions and environment\n\n- Minecraft:\n- Loader:\n- API:\n- Java:\n- Gradle:\n'], ['In-game test log', 'log', '# In-game test log\n\nDate · what was tested · what was observed\n']],
  },
  {
    id: 'personal', name: 'Personal goal', color: '#9b7bff', description: 'A habit, plan, trip, purchase or anything personal.',
    instructions: 'Keep things simple and practical. Ask before making assumptions about money, health or schedules. Track decisions and progress in project memories.',
    tasks: [['Write down the goal and what success looks like', 'high'], ['Break it into the first three steps', 'medium']],
    notes: [['Goal', 'plan', '# Goal\n\nWhat, why, by when.\n']],
  },
];

function createFromTemplate(store, templateId, { title, description, folder }) {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error('Unknown template');
  const p = store.create('project', { title: title || t.name, description: description || t.description, color: t.color, instructions: t.instructions, folder: folder || undefined, template: t.id });
  for (const [task, priority] of t.tasks) store.create('task', { title: task, priority, project: p.slug });
  for (const [nt, type, body] of t.notes) store.create('note', { title: nt, type, body, project: p.slug });
  return p;
}

module.exports = { TEMPLATES, createFromTemplate };
