// Shared core for agent-team: agent adapters, discovery, team config, and the headless runner.
// Node built-ins only.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENT_TEAM_HOME || path.join(os.homedir(), '.agent-team');
export const ROLES = ['implementer', 'tester', 'reviewer', 'joker'];
export const DEFAULT_MODE = { implementer: 'write', tester: 'write', reviewer: 'read-only', joker: 'write' };

const DSH_APP = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DSH_DESKTOP_PATCH = path.join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml');

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function which(bin) {
  const r = spawnSync('/bin/sh', ['-c', `command -v "${bin}"`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...opts });
  return r.status === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------- adapters
// Each adapter: detect() -> bin path | null, models(bin) -> [{id, name, efforts[]}],
// buildRun({bin, model, effort, mode, cwd, prompt, scratch}) -> {cmd, args, stdin, env, readOutput(stdout)}
// and interactive({bin, model, effort, prompt}) -> {cmd, args} for orchestrator launch.

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];

// Strip the parent Claude Code session's markers so a child `claude -p` starts as its own session.
function childClaudeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') delete env[k];
  }
  return env;
}

export const ADAPTERS = {
  claude: {
    label: 'Claude Code',
    canOrchestrate: true,
    readOnlyEnforced: true,
    detect: () => which('claude'),
    models: () => CLAUDE_MODELS.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })),
    buildRun({ bin, model, effort, mode, prompt }) {
      const args = ['-p', '--model', model, '--output-format', 'json'];
      if (effort) args.push('--effort', effort);
      if (mode === 'read-only') args.push('--permission-mode', 'plan');
      else if (mode === 'full') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep');
      return {
        cmd: bin, args, stdin: prompt, env: childClaudeEnv(),
        readOutput(stdout) {
          try { const j = JSON.parse(stdout); return { text: j.result ?? '', session: j.session_id, isError: !!j.is_error }; }
          catch { return { text: stdout }; }
        },
      };
    },
    interactive: ({ bin, model, effort, prompt }) => ({
      cmd: bin, args: ['--model', model, ...(effort ? ['--effort', effort] : []), prompt], env: childClaudeEnv(),
    }),
  },

  codex: {
    label: 'Codex CLI',
    canOrchestrate: true,
    readOnlyEnforced: true,
    detect: () => which('codex'),
    models(bin) {
      const out = capture(bin, ['debug', 'models']);
      if (!out) return [];
      let data; try { data = JSON.parse(out); } catch { return []; }
      const list = Array.isArray(data) ? data : data.models || [];
      return list
        .filter((m) => m && m.slug && m.visibility !== 'hide')
        .map((m) => ({
          id: m.slug,
          name: m.display_name || m.slug,
          efforts: (m.supported_reasoning_levels || []).map((e) => (typeof e === 'string' ? e : e.effort)).filter(Boolean),
          defaultEffort: m.default_reasoning_level,
        }));
    },
    buildRun({ bin, model, effort, mode, cwd, prompt, scratch }) {
      const last = path.join(scratch, 'codex-last-message.txt');
      const args = ['exec', '-m', model, '--skip-git-repo-check', '-C', cwd, '-o', last];
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      if (mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('-s', mode === 'read-only' ? 'read-only' : 'workspace-write');
      args.push('-');
      return {
        cmd: bin, args, stdin: prompt,
        readOutput(stdout) {
          const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : stdout;
          return { text };
        },
      };
    },
    interactive: ({ bin, model, effort, prompt }) => ({
      cmd: bin, args: ['-m', model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), prompt],
    }),
  },

  opencode: {
    label: 'OpenCode',
    canOrchestrate: true,
    readOnlyEnforced: true,
    detect: () => which('opencode') || (fs.existsSync(path.join(os.homedir(), '.opencode/bin/opencode')) ? path.join(os.homedir(), '.opencode/bin/opencode') : null),
    models(bin) {
      const out = capture(bin, ['models', '--verbose'], { timeout: 120_000 });
      if (!out) return [];
      // Output is repeated blocks of "provider/model\n{...json...}\n".
      const models = [];
      const lines = out.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const head = lines[i].trim();
        if (!/^[^\s{}]+\/[^\s{}]+$/.test(head) || !lines[i + 1]?.startsWith('{')) continue;
        let depth = 0, j = i + 1, buf = [];
        for (; j < lines.length; j++) {
          buf.push(lines[j]);
          depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
          if (depth === 0) break;
        }
        try {
          const m = JSON.parse(buf.join('\n'));
          models.push({ id: head, name: m.name || head, efforts: Object.keys(m.variants || {}) });
        } catch { models.push({ id: head, name: head, efforts: [] }); }
        i = j;
      }
      return models;
    },
    buildRun({ bin, model, effort, mode, prompt }) {
      const args = ['run', '-m', model, '--format', 'json'];
      if (effort) args.push('--variant', effort);
      if (mode === 'read-only') args.push('--agent', 'plan');
      args.push(prompt);
      return {
        cmd: bin, args, stdin: null,
        readOutput(stdout) {
          const texts = []; let session;
          for (const line of stdout.split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
              const ev = JSON.parse(line);
              session ||= ev.sessionID;
              if (ev.type === 'text' && ev.part?.text) texts.push(ev.part.text);
            } catch { /* not an event line */ }
          }
          return { text: texts.join('\n\n') || stdout, session };
        },
      };
    },
    interactive: ({ bin, model, prompt }) => ({ cmd: bin, args: ['-m', model, '--prompt', prompt] }),
  },

  dsh: {
    label: 'DeepSeek Harness',
    canOrchestrate: false,
    readOnlyEnforced: false,
    detect: () => which('dsh') || (fs.existsSync(DSH_APP) ? DSH_APP : null),
    models() {
      const models = [{ id: 'deepseek-official/deepseek-flash', name: 'DeepSeek Flash (official, harness default)', efforts: [] }];
      return models.concat(parseDshProviders(DSH_DESKTOP_PATCH));
    },
    buildRun({ bin, model, effort, prompt, scratch }) {
      const slash = model.indexOf('/');
      const provider = slash > 0 ? model.slice(0, slash) : 'deepseek-official';
      const modelId = slash > 0 ? model.slice(slash + 1) : model;
      const overlay = path.join(scratch, 'dsh-overlay.yml');
      fs.writeFileSync(overlay, [
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        `    provider: ${JSON.stringify(provider)}`,
        `    model: ${JSON.stringify(modelId)}`,
        ...(effort ? [`    reasoningEffort: ${JSON.stringify(effort)}`] : []),
        // The headless profile ships with the local credential store off; the desktop app keeps API keys there.
        '- id: credentials',
        '  name: "@deepseek-ai/dsh-credentials-local"',
        '  disabled: false',
        '',
      ].join('\n'));
      const args = ['--profile', 'headless'];
      if (fs.existsSync(DSH_DESKTOP_PATCH)) args.push('--patch', DSH_DESKTOP_PATCH);
      args.push('--patch', overlay, '-');
      return { cmd: bin, args, stdin: prompt, readOutput: (stdout) => ({ text: stdout }) };
    },
    interactive: null,
  },
};

// Minimal reader for the `llm-pi-ai` providers block in a DeepSeek Harness patch file.
function parseDshProviders(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let inProviders = false, provIndent = -1, provider = null, cur = null, inEfforts = false, effIndent = -1;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line === 'providers:') { inProviders = true; provIndent = -1; continue; }
    if (!inProviders) continue;
    if (/^- id: /.test(line) && indent <= 2) { flush(); inProviders = false; continue; }
    if (inEfforts && indent > effIndent) {
      const k = line.match(/^"?([\w-]+)"?:/);
      if (k && cur) cur.efforts.push(k[1]);
      continue;
    }
    inEfforts = false;
    const prov = line.match(/^([\w.-]+):\s*$/);
    if (prov && (provIndent === -1 || indent === provIndent)) { flush(); provIndent = indent; provider = prov[1]; continue; }
    const id = line.match(/^- id:\s*"?([^"]+?)"?\s*$/);
    if (id && provider) { flush(); cur = { id: `${provider}/${id[1]}`, name: id[1], efforts: [] }; continue; }
    const name = line.match(/^name:\s*(.+)$/);
    if (name && cur) { cur.name = name[1].replace(/^"|"$/g, ''); continue; }
    if (line === 'reasoningEfforts:') { inEfforts = true; effIndent = indent; continue; }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- discovery
const DISCOVERY = path.join(HOME, 'discovery.json');

export function discover({ refresh = false } = {}) {
  const cached = readJSON(DISCOVERY);
  if (!refresh && cached && Date.now() - Date.parse(cached.at) < 24 * 3600_000) return cached;
  const agents = {};
  for (const [key, a] of Object.entries(ADAPTERS)) {
    const bin = a.detect();
    agents[key] = bin
      ? { installed: true, label: a.label, bin, canOrchestrate: a.canOrchestrate, readOnlyEnforced: a.readOnlyEnforced, models: safe(() => a.models(bin), []) }
      : { installed: false, label: a.label };
  }
  const result = { at: new Date().toISOString(), agents };
  writeJSON(DISCOVERY, result);
  return result;
}
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

// ---------------------------------------------------------------- team config
// Project config (.agent-team.json in the git root or cwd) wins over the global one.
export function projectConfigPath(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return path.join(r.status === 0 ? r.stdout.trim() : cwd, '.agent-team.json');
}
export const GLOBAL_CONFIG = path.join(HOME, 'team.json');

export function loadTeam(cwd) {
  const proj = projectConfigPath(cwd);
  if (fs.existsSync(proj)) return { path: proj, scope: 'project', team: normalize(readJSON(proj, {})) };
  return { path: GLOBAL_CONFIG, scope: 'global', team: normalize(readJSON(GLOBAL_CONFIG, {})) };
}
export function saveTeam(team, scope = 'global', cwd) {
  const p = scope === 'project' ? projectConfigPath(cwd) : GLOBAL_CONFIG;
  writeJSON(p, { ...normalize(team), updatedAt: new Date().toISOString() });
  return p;
}
export function normalize(t) {
  const team = { version: 1, orchestrator: t?.orchestrator || null, roles: {} };
  for (const r of ROLES) team.roles[r] = Array.isArray(t?.roles?.[r]) ? t.roles[r] : t?.roles?.[r] ? [t.roles[r]] : [];
  return team;
}

export function validateMember(m, disc) {
  const a = disc.agents[m.agent];
  if (!ADAPTERS[m.agent]) return `unknown agent "${m.agent}" (known: ${Object.keys(ADAPTERS).join(', ')})`;
  if (!a?.installed) return `agent "${m.agent}" is not installed`;
  if (!m.model) return 'model is required';
  const model = a.models.find((x) => x.id === m.model);
  if (!model) return null; // custom ids are allowed; the CLI will reject a bad one at run time
  if (m.effort && model.efforts.length && !model.efforts.includes(m.effort))
    return `effort "${m.effort}" not offered by ${m.model} (offers: ${model.efforts.join(', ')})`;
  return null;
}

// "implementer", "implementer:2", or a member name.
export function resolveMember(team, ref) {
  const [role, idx] = ref.split(':');
  if (ROLES.includes(role)) {
    const list = team.roles[role];
    const m = list[idx ? Number(idx) - 1 : 0];
    if (!m) throw new Error(`no ${role}${idx ? ` #${idx}` : ''} configured — run setup first`);
    return { role, ...m };
  }
  for (const r of ROLES) for (const m of team.roles[r]) if (m.name === ref) return { role: r, ...m };
  throw new Error(`no team member "${ref}"`);
}

export function describe(m) {
  return `${m.agent} · ${m.model}${m.effort ? ` · ${m.effort}` : ''}`;
}

// ---------------------------------------------------------------- runner
const PREAMBLE = {
  implementer: `You are the IMPLEMENTER on a multi-agent team. An orchestrator wrote the brief below and will review your diff.
- Make the change in the working tree. Do not commit, push, or rewrite git history.
- Stay inside the brief's scope; if something blocks you, stop and say so rather than guessing.
- Finish with: a summary of what you changed (file list), how you verified it, and anything left undone.`,
  tester: `You are the TESTER on a multi-agent team.
- Write or update tests for the behaviour described below, run them, and report results with the exact commands and output.
- Do not change production code unless the brief explicitly says to; if you find a bug, report it with a failing test.
- Do not commit. Finish with: PASS/FAIL summary, tests added, commands run.`,
  reviewer: `You are the REVIEWER on a multi-agent team. Review only; do not edit any files.
- Look for correctness bugs, regressions, security issues, and missing tests in the change described below.
- Report each finding as: severity (high/medium/low), file:line, what's wrong, a concrete failure scenario, and the fix.
- If you find nothing serious, say so plainly. Finish with a one-line verdict: SHIP / FIX FIRST.`,
  joker: `You are the ASSISTANT on a multi-agent team. Do exactly what the instruction below asks — nothing more, nothing less.
- Do not commit. Report briefly what you did and the result.`,
};

export function newRunDir(kind = 'runs') {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  return { id, dir: ensureDir(path.join(HOME, kind, id)) };
}

function gitStatus(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? new Set(r.stdout.split('\n').filter(Boolean)) : null;
}

export async function runMember({ member, task, cwd, mode, timeoutMin = 60, preamble = true, runDir }) {
  const disc = discover();
  const a = ADAPTERS[member.agent];
  const info = disc.agents[member.agent];
  if (!a || !info?.installed) throw new Error(`agent "${member.agent}" is not available`);
  mode ||= DEFAULT_MODE[member.role] || 'write';
  const { id, dir } = runDir || newRunDir();
  let prompt = task;
  if (preamble && PREAMBLE[member.role]) prompt = `${PREAMBLE[member.role]}\n\n---\n\n${task}`;
  if (mode === 'read-only' && !a.readOnlyEnforced)
    prompt = `IMPORTANT: this is a READ-ONLY task. Do not create, modify, or delete any files.\n\n${prompt}`;
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);

  const spec = a.buildRun({ bin: info.bin, model: member.model, effort: member.effort, mode, cwd, prompt, scratch: dir });
  const before = gitStatus(cwd);
  const started = Date.now();
  const { code, signal, stdout, stderr, timedOut } = await exec(spec, cwd, timeoutMin * 60_000);
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr);
  const parsed = spec.readOutput(stdout);
  fs.writeFileSync(path.join(dir, 'output.md'), parsed.text || '');
  const after = gitStatus(cwd);
  const touched = before && after ? [...after].filter((l) => !before.has(l)).map((l) => l.slice(3)) : null;

  const result = {
    id, status: timedOut ? 'timeout' : code === 0 && !parsed.isError ? 'ok' : 'error',
    exitCode: code, signal, role: member.role, member: describe(member), mode,
    readOnlyEnforced: mode !== 'read-only' || a.readOnlyEnforced,
    durationSec: Math.round((Date.now() - started) / 1000),
    session: parsed.session || null, touchedFiles: touched, runDir: dir,
    stderrTail: code === 0 ? undefined : stderr.split('\n').filter(Boolean).slice(-8).join('\n'),
    finalMessage: parsed.text?.trim() || '',
  };
  writeJSON(path.join(dir, 'result.json'), result);
  return result;
}

function exec(spec, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, { cwd, env: spec.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
    if (spec.stdin != null) child.stdin.end(spec.stdin); else child.stdin.end();
  });
}
