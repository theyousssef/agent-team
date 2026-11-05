#!/usr/bin/env node
// Interactive launcher: pick the orchestrator (agent + model + effort) and the role agents,
// save the team, then start the orchestrator session with the agent-team skill engaged.
//   agent-team            full picker (offers to reuse the saved team)
//   agent-team --quick    reuse the saved team as-is and launch
//   agent-team --scope project   save to .agent-team.json in this repo instead of globally
//   agent-team --refresh | --dry-run   re-probe installed agents | print the launch command instead of running it
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, ROLES, discover, loadTeam, saveTeam, describe } from './lib.mjs';

const SKILL_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
const args = process.argv.slice(2);
const scopeArg = args.includes('--scope') ? args[args.indexOf('--scope') + 1] : null;
// Line queue instead of rl.question so answers piped in ahead of the prompts aren't dropped.
const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines = [], waiting = [];
let closed = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
function ask(q) {
  process.stdout.write(q);
  if (lines.length) { const l = lines.shift(); if (!process.stdin.isTTY) console.log(l); return Promise.resolve(l); }
  if (closed) { console.error('\nagent-team: input closed'); process.exit(1); }
  return new Promise((res) => waiting.push((l) => { if (l === null) { console.error('\nagent-team: input closed'); process.exit(1); } res(l); }));
}
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function pick(title, items, { allowSkip = false, allowCustom = false, defaultIndex = 0 } = {}) {
  console.log(`\n${bold(title)}`);
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${it.label}${i === defaultIndex ? dim('  (default)') : ''}`));
  if (allowCustom) console.log(`   c. type a custom id`);
  if (allowSkip) console.log(`   s. skip`);
  for (;;) {
    const ans = (await ask('> ')).trim().toLowerCase();
    if (!ans) return items[defaultIndex]?.value;
    if (allowSkip && ans === 's') return null;
    if (allowCustom && ans === 'c') return { custom: (await ask('id: ')).trim() };
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
    console.log('  pick a number from the list');
  }
}

async function pickMember(disc, title, { orchestrator = false, allowSkip = true } = {}) {
  const agents = Object.entries(disc.agents).filter(([, a]) => a.installed && (!orchestrator || a.canOrchestrate));
  const agent = await pick(`${title} — which agent?`, agents.map(([k, a]) => ({ label: `${a.label} (${k})`, value: k })), { allowSkip });
  if (!agent) return null;
  const models = disc.agents[agent].models;
  let model = await pick(`${title} — which ${ADAPTERS[agent].label} model?`, models.map((m) => ({ label: `${m.id}${m.name !== m.id ? dim(` — ${m.name}`) : ''}`, value: m })), { allowCustom: true });
  if (model.custom) model = { id: model.custom, efforts: [] };
  let effort = null;
  if (model.efforts.length) {
    const def = Math.max(0, model.efforts.indexOf(model.defaultEffort || 'high'));
    effort = await pick(`${title} — thinking effort for ${model.id}?`, model.efforts.map((e) => ({ label: e, value: e })), { defaultIndex: def });
  }
  return { agent, model: model.id, ...(effort ? { effort } : {}) };
}

async function yes(q, def = true) {
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a ? a.startsWith('y') : def;
}

const disc = discover({ refresh: args.includes('--refresh') });
const loaded = loadTeam();
let team = loaded.team;
const hasTeam = team.orchestrator && ROLES.some((r) => team.roles[r].length);

console.log(bold('\nagent-team'));
console.log('Installed agents: ' + Object.entries(disc.agents).map(([k, a]) => (a.installed ? `✓ ${k}` : dim(`✗ ${k}`))).join('  '));

let reuse = false;
if (hasTeam) {
  console.log(`\nSaved team (${loaded.scope}):`);
  console.log(`  orchestrator: ${describe(team.orchestrator)}`);
  for (const r of ROLES) if (team.roles[r].length) console.log(`  ${r}: ${team.roles[r].map(describe).join(' | ')}`);
  reuse = args.includes('--quick') || (await yes('\nReuse this team?'));
}

if (!reuse) {
  team.orchestrator = await pickMember(disc, 'ORCHESTRATOR (this session)', { orchestrator: true, allowSkip: false });
  for (const role of ROLES) {
    const list = [];
    for (;;) {
      const m = await pickMember(disc, `${role.toUpperCase()}${list.length ? ` #${list.length + 1}` : ''}`, { allowSkip: true });
      if (!m) break;
      list.push(m);
      if (role !== 'implementer' || !(await yes(`Add another ${role}?`, false))) break;
    }
    team.roles[role] = list;
  }
  const scope = scopeArg || (await yes('\nSave for this project only (.agent-team.json)? No = global default', false) ? 'project' : 'global');
  console.log(`saved → ${saveTeam(team, scope)}`);
}
rl.close();

const o = team.orchestrator;
const adapter = ADAPTERS[o.agent];
const prompt = `Use the agent-team skill (${SKILL_MD}). The team is already configured — run \`team.mjs show\`, print the roster in one short table, then wait for my task. Do not start setup unless I ask.`;
const { cmd, args: cargs, env } = adapter.interactive({ bin: disc.agents[o.agent].bin, model: o.model, effort: o.effort, prompt });
if (args.includes('--dry-run')) { console.log(JSON.stringify({ cmd, args: cargs }, null, 2)); process.exit(0); }
console.log(dim(`\nlaunching ${describe(o)} …\n`));
const child = spawn(cmd, cargs, { stdio: 'inherit', env: env || process.env });
child.on('exit', (code) => process.exit(code ?? 0));
