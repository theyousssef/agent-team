#!/usr/bin/env node
// agent-team CLI. Run with no arguments for usage.
import fs from 'node:fs';
import path from 'node:path';
import {
  ADAPTERS, ROLES, HOME, discover, loadTeam, saveTeam, validateMember, resolveMember, describe,
  runMember, newRunDir, readJSON, writeJSON, ensureDir,
} from './lib.mjs';

const USAGE = `agent-team — orchestrate implementer / tester / reviewer / joker agents and debates

  team.mjs discover [--refresh] [--json]       installed agents with their models and efforts
  team.mjs options --agent <a> [--json]        models + efforts one agent offers
  team.mjs show [--json]                       the current team (project config wins over global)
  team.mjs set-orchestrator --agent <a> --model <m> [--effort <e>] [--scope global|project]
  team.mjs set-role --role <r> --agent <a> --model <m> [--effort <e>] [--name <n>] [--append] [--scope ...]
  team.mjs clear-role --role <r> [--scope ...]
  team.mjs run --member <role[:N]|name> (--brief <file> | --prompt <text> | stdin)
               [--cd <dir>] [--mode write|read-only|full] [--timeout <min>] [--no-preamble]
  team.mjs run --agent <a> --model <m> [--effort <e>] [--role <r>] ...   ad-hoc agent, no config needed
  team.mjs debate start (--with <role[:N]|name> | --agent <a> --model <m> [--effort <e>])
               --topic <text> [--rounds <n>] [--cd <dir>] [--orchestrator <label>]
  team.mjs debate turn --id <id> (--file <file> | --message <text> | stdin)
  team.mjs debate show --id <id> | debate end --id <id> (--file|--message) | debate list
  team.mjs banner                              short roster for session-start hooks

roles: ${ROLES.join(', ')}    agents: ${Object.keys(ADAPTERS).join(', ')}`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['refresh', 'json', 'append', 'no-preamble'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const die = (msg) => { console.error(`agent-team: ${msg}`); process.exit(2); };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
function textInput(o, fileKey = 'brief', textKey = 'prompt') {
  if (o[fileKey]) return fs.readFileSync(o[fileKey], 'utf8');
  if (o[textKey]) return o[textKey];
  if (!process.stdin.isTTY) return readStdin();
  return '';
}

function printDiscovery(d) {
  for (const [key, a] of Object.entries(d.agents)) {
    if (!a.installed) { console.log(`✗ ${key} (${a.label}) — not installed`); continue; }
    console.log(`✓ ${key} (${a.label})${a.canOrchestrate ? '' : ' — subagent only'}${a.readOnlyEnforced ? '' : ' — read-only is advisory'}`);
    for (const m of a.models) console.log(`    ${m.id}${m.efforts.length ? `  [${m.efforts.join(', ')}]` : ''}`);
  }
  console.log(`\n(cached ${d.at}; --refresh to re-probe)`);
}

function printTeam({ team, path: p, scope }) {
  const o = team.orchestrator;
  console.log(`Team (${scope}: ${p})`);
  console.log(`  orchestrator : ${o ? describe(o) : '— not recorded —'}`);
  for (const r of ROLES) {
    const list = team.roles[r];
    if (!list.length) { console.log(`  ${r.padEnd(12)} : —`); continue; }
    list.forEach((m, i) => console.log(`  ${(i ? '' : r).padEnd(12)} ${i ? ' ' : ':'} ${list.length > 1 ? `[${r}:${i + 1}] ` : ''}${m.name ? `${m.name} = ` : ''}${describe(m)}`));
  }
}

function memberFromFlags(o, disc) {
  const m = { agent: o.agent, model: o.model, ...(o.effort ? { effort: o.effort } : {}), ...(o.name ? { name: o.name } : {}) };
  const err = validateMember(m, disc);
  if (err) die(err);
  return m;
}

async function cmdRun(o) {
  const cwd = path.resolve(o.cd || process.cwd());
  let member;
  if (o.member) member = resolveMember(loadTeam(cwd).team, o.member);
  else if (o.agent) member = { role: o.role || 'joker', ...memberFromFlags(o, discover()) };
  else die('run needs --member or --agent/--model');
  if (o.mode && !['write', 'read-only', 'full'].includes(o.mode)) die('--mode must be write, read-only, or full');
  const task = textInput(o);
  if (!task.trim()) die('empty brief: pass --brief <file>, --prompt <text>, or pipe stdin');
  console.error(`agent-team: dispatching ${member.role} → ${describe(member)} in ${cwd} …`);
  const res = await runMember({
    member, task, cwd, mode: o.mode, timeoutMin: Number(o.timeout || 60), preamble: !o['no-preamble'],
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.status === 'ok' ? 0 : 1);
}

// ---------------------------------------------------------------- debate
const DEBATE_RULES = (topic, me, them, round, max) => `You are in a structured, constructive DEBATE with ${me}, the orchestrating agent. You are ${them}.
Topic: ${topic}

Rules:
- Engage with the strongest version of the other side's argument; quote the specific claim you're answering.
- Be concrete: cite code (file:line), data, failure scenarios, or trade-offs — not generalities.
- Concede points that are right, explicitly. Changing your mind on evidence is a win, not a loss.
- Push back where you disagree and offer a better alternative, not just criticism.
- Keep it focused: at most ~400 words per turn.
- You may read files in the working directory to check claims; this is a discussion only, so do not modify anything.
- End your turn with exactly these two lines:
  POSITION: <your current position in one sentence>
  STATUS: AGREE | PARTIAL | DISAGREE

This is round ${round} of at most ${max}. The full transcript so far follows.`;

const debatesDir = () => ensureDir(path.join(HOME, 'debates'));
function loadDebate(id) {
  const dir = path.join(debatesDir(), id || die('--id required'));
  const meta = readJSON(path.join(dir, 'meta.json')) || die(`no debate ${id}`);
  return { dir, meta, transcriptPath: path.join(dir, 'transcript.md') };
}

async function cmdDebate(o) {
  const sub = o._[1];
  if (sub === 'list') {
    for (const id of fs.readdirSync(debatesDir()).sort()) {
      const m = readJSON(path.join(debatesDir(), id, 'meta.json'));
      if (m) console.log(`${id}  [${m.status}] round ${m.round}/${m.maxRounds}  vs ${m.opponentLabel} — ${m.topic}`);
    }
    return;
  }
  if (sub === 'start') {
    const cwd = path.resolve(o.cd || process.cwd());
    const topic = o.topic || die('--topic required');
    const opponent = o.with
      ? resolveMember(loadTeam(cwd).team, o.with)
      : o.agent ? { role: 'debater', ...memberFromFlags(o, discover()) } : die('debate start needs --with or --agent/--model');
    const { id, dir } = newRunDir('debates');
    const orch = o.orchestrator || 'the orchestrator';
    const meta = {
      id, topic, cwd, opponent, opponentLabel: `${opponent.role} (${describe(opponent)})`, orchestratorLabel: orch,
      round: 0, maxRounds: Number(o.rounds || 4), status: 'open', createdAt: new Date().toISOString(),
    };
    writeJSON(path.join(dir, 'meta.json'), meta);
    fs.writeFileSync(path.join(dir, 'transcript.md'), `# Debate: ${topic}\n\n- Orchestrator: ${orch}\n- Opponent: ${meta.opponentLabel}\n- Max rounds: ${meta.maxRounds}\n`);
    console.log(JSON.stringify({ id, transcript: path.join(dir, 'transcript.md'), opponent: meta.opponentLabel, maxRounds: meta.maxRounds }, null, 2));
    return;
  }
  if (sub === 'turn') {
    const { dir, meta, transcriptPath } = loadDebate(o.id);
    if (meta.status !== 'open') die(`debate ${meta.id} is ${meta.status}`);
    const msg = textInput(o, 'file', 'message');
    if (!msg.trim()) die('empty message');
    meta.round += 1;
    fs.appendFileSync(transcriptPath, `\n## Round ${meta.round} — ${meta.orchestratorLabel}\n\n${msg.trim()}\n`);
    const prompt = `${DEBATE_RULES(meta.topic, meta.orchestratorLabel, meta.opponentLabel, meta.round, meta.maxRounds)}\n\n${fs.readFileSync(transcriptPath, 'utf8')}\n\nWrite your round ${meta.round} reply now.`;
    console.error(`agent-team: debate round ${meta.round}/${meta.maxRounds} → ${meta.opponentLabel} …`);
    const res = await runMember({
      member: meta.opponent, task: prompt, cwd: meta.cwd, mode: 'read-only', preamble: false,
      runDir: { id: `${meta.id}-r${meta.round}`, dir: ensureDir(path.join(dir, `round-${meta.round}`)) },
      timeoutMin: Number(o.timeout || 30),
    });
    const reply = res.finalMessage || `(no reply — ${res.status}: ${res.stderrTail || ''})`;
    fs.appendFileSync(transcriptPath, `\n## Round ${meta.round} — ${meta.opponentLabel}\n\n${reply}\n`);
    const status = (reply.match(/STATUS:\s*(AGREE|PARTIAL|DISAGREE)/i)?.[1] || 'UNKNOWN').toUpperCase();
    const position = reply.match(/POSITION:\s*(.+)/i)?.[1]?.trim() || null;
    if (meta.round >= meta.maxRounds) meta.status = 'rounds-exhausted';
    writeJSON(path.join(dir, 'meta.json'), meta);
    console.log(JSON.stringify({ id: meta.id, round: meta.round, maxRounds: meta.maxRounds, opponentStatus: status, opponentPosition: position, debateStatus: meta.status, runStatus: res.status, transcript: transcriptPath, reply }, null, 2));
    return;
  }
  if (sub === 'show') { console.log(fs.readFileSync(loadDebate(o.id).transcriptPath, 'utf8')); return; }
  if (sub === 'end') {
    const { dir, meta, transcriptPath } = loadDebate(o.id);
    const msg = textInput(o, 'file', 'message');
    fs.appendFileSync(transcriptPath, `\n## Conclusion (${meta.orchestratorLabel})\n\n${msg.trim() || '(none recorded)'}\n`);
    meta.status = 'closed';
    writeJSON(path.join(dir, 'meta.json'), meta);
    console.log(transcriptPath);
    return;
  }
  die('debate subcommands: start | turn | show | end | list');
}

// ---------------------------------------------------------------- main
const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
const scope = o.scope === 'project' ? 'project' : undefined;

switch (cmd) {
  case 'discover': {
    const d = discover({ refresh: o.refresh });
    if (o.json) console.log(JSON.stringify(d, null, 2)); else printDiscovery(d);
    break;
  }
  case 'options': {
    const a = discover().agents[o.agent || die('--agent required')];
    if (!a?.installed) die(`agent "${o.agent}" not installed`);
    if (o.json) console.log(JSON.stringify(a.models, null, 2));
    else a.models.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. ${m.id} — ${m.name}${m.efforts.length ? `  efforts: ${m.efforts.join(', ')}` : '  efforts: (default only)'}`));
    break;
  }
  case 'show': {
    const t = loadTeam();
    if (o.json) console.log(JSON.stringify(t, null, 2)); else printTeam(t);
    break;
  }
  case 'set-orchestrator': {
    const t = loadTeam();
    t.team.orchestrator = memberFromFlags(o, discover());
    console.log(`saved → ${saveTeam(t.team, scope || t.scope)}`);
    break;
  }
  case 'set-role': {
    if (!ROLES.includes(o.role)) die(`--role must be one of ${ROLES.join(', ')}`);
    const t = loadTeam();
    const m = memberFromFlags(o, discover());
    t.team.roles[o.role] = o.append ? [...t.team.roles[o.role], m] : [m];
    console.log(`saved → ${saveTeam(t.team, scope || t.scope)}`);
    break;
  }
  case 'clear-role': {
    if (!ROLES.includes(o.role)) die(`--role must be one of ${ROLES.join(', ')}`);
    const t = loadTeam();
    t.team.roles[o.role] = [];
    console.log(`saved → ${saveTeam(t.team, scope || t.scope)}`);
    break;
  }
  case 'run': await cmdRun(o); break;
  case 'debate': await cmdDebate(o); break;
  case 'banner': {
    const t = loadTeam();
    const filled = ROLES.filter((r) => t.team.roles[r].length);
    if (!filled.length) console.log('agent-team: no team configured yet. Ask to "set up my agent team" (agent-team skill) to pick orchestrator, implementer, tester, reviewer and joker models.');
    else {
      console.log('agent-team roster (use the agent-team skill to delegate, debate, or reconfigure):');
      for (const r of filled) console.log(`- ${r}: ${t.team.roles[r].map(describe).join(' | ')}`);
      console.log('At the start of this session, show this roster to the user and ask whether to keep it or reconfigure (agent-team skill, setup flow).');
    }
    break;
  }
  default: console.log(USAGE); process.exit(cmd ? 2 : 0);
}
