#!/bin/sh
# Install agent-team: link the skill into Claude Code / OpenCode / Codex, add a rules file for Bob Shell
# (Bob has no skills directory), and put `agent-team` on PATH.
# OpenCode reads ~/.claude/skills too, so the Claude Code link covers it.
#   ./install.sh                  skill + launcher
#   ./install.sh --session-hook   also add a Claude Code SessionStart hook that shows the roster
#   ./install.sh --uninstall
set -e
root=$(cd "$(dirname "$0")" && pwd -P)
skill="$root/skills/agent-team"
targets="$HOME/.claude/skills $HOME/.codex/skills"
bindir="$HOME/.local/bin"
bobrules="$HOME/.bob/rules/agent-team.md"
marker="<!-- managed by agent-team install.sh -->"

if [ "$1" = "--uninstall" ]; then
  for t in $targets; do [ -L "$t/agent-team" ] && rm "$t/agent-team" && echo "removed $t/agent-team"; done
  [ -L "$bindir/agent-team" ] && rm "$bindir/agent-team" && echo "removed $bindir/agent-team"
  if [ -f "$bobrules" ] && grep -qF "$marker" "$bobrules"; then rm "$bobrules" && echo "removed $bobrules"; fi
  echo "(SessionStart hook, if added, stays in ~/.claude/settings.json — remove the agent-team entry by hand)"
  exit 0
fi

for t in $targets; do
  mkdir -p "$t"
  if [ -e "$t/agent-team" ] && [ ! -L "$t/agent-team" ]; then echo "skip $t/agent-team (exists, not a link)"; continue; fi
  ln -sfn "$skill" "$t/agent-team" && echo "linked $t/agent-team"
done
# Bob Shell has no skills: it loads every file in ~/.bob/rules/ into its context, so install a short rules file
# that tells Bob when to use agent-team and where the full instructions are.
if command -v bob >/dev/null 2>&1 || [ -d "$HOME/.bob" ]; then
  if [ -e "$bobrules" ] && ! grep -qF "$marker" "$bobrules"; then
    echo "skip $bobrules (exists, not created by agent-team)"
  else
    mkdir -p "$(dirname "$bobrules")"
    cat > "$bobrules" <<BOBRULES
$marker
# agent-team

You can act as the orchestrator of a multi-agent team (implementer, tester, reviewer, joker, plus debates with other models).
When the user asks to set up, show or change their agent team, to delegate implementation / testing / review to another
agent or model, to get a second opinion, or to "debate" a decision: read $skill/SKILL.md first and follow it exactly.
It is a skill written for Claude Code; in Bob, run its shell commands (node $skill/scripts/team.mjs ...) with your
command-execution tool, and ask the user setup questions in plain chat (a numbered list is fine).
BOBRULES
    echo "wrote $bobrules"
  fi
fi

mkdir -p "$bindir"
ln -sf "$root/bin/agent-team" "$bindir/agent-team" && echo "linked $bindir/agent-team"
case ":$PATH:" in *":$bindir:"*) ;; *) echo "note: add $bindir to PATH";; esac

if [ "$1" = "--session-hook" ]; then
  node - "$skill/scripts/team.mjs" <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const p = path.join(os.homedir(), '.claude', 'settings.json');
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-agent-team');
const command = `node "${process.argv[2]}" banner`;
s.hooks ??= {}; s.hooks.SessionStart ??= [];
if (!JSON.stringify(s.hooks.SessionStart).includes('team.mjs" banner')) {
  s.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command }] });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  console.log(`added SessionStart hook to ${p} (backup: settings.json.bak-agent-team)`);
} else console.log('SessionStart hook already present');
JS
fi
node "$skill/scripts/team.mjs" discover --refresh >/dev/null && echo "discovered installed agents → ~/.agent-team/discovery.json"
