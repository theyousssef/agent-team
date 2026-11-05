#!/bin/sh
# Install agent-team: link the skill into Claude Code and Codex, and put `agent-team` on PATH.
#   ./install.sh                  skill + launcher
#   ./install.sh --session-hook   also add a Claude Code SessionStart hook that shows the roster
#   ./install.sh --uninstall
set -e
root=$(cd "$(dirname "$0")" && pwd -P)
skill="$root/skills/agent-team"
targets="$HOME/.claude/skills $HOME/.codex/skills"
bindir="$HOME/.local/bin"

if [ "$1" = "--uninstall" ]; then
  for t in $targets; do [ -L "$t/agent-team" ] && rm "$t/agent-team" && echo "removed $t/agent-team"; done
  [ -L "$bindir/agent-team" ] && rm "$bindir/agent-team" && echo "removed $bindir/agent-team"
  echo "(SessionStart hook, if added, stays in ~/.claude/settings.json — remove the agent-team entry by hand)"
  exit 0
fi

for t in $targets; do
  mkdir -p "$t"
  if [ -e "$t/agent-team" ] && [ ! -L "$t/agent-team" ]; then echo "skip $t/agent-team (exists, not a link)"; continue; fi
  ln -sfn "$skill" "$t/agent-team" && echo "linked $t/agent-team"
done
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
