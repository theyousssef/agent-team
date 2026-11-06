# agent-team

A skill that turns one coding-agent session into an **orchestrator** of other agents installed on your machine. Each role can be a different CLI, model, and thinking effort:

| Role | What it does | Default access |
|---|---|---|
| **orchestrator** | the session you talk to: plans, writes briefs, reviews results, decides | — |
| **implementer** (1 or more) | writes the code | read/write the working tree, never commits |
| **tester** | writes and runs tests, reports PASS/FAIL | read/write |
| **reviewer** | finds bugs and gives a SHIP / FIX FIRST verdict | read-only |
| **joker** | the assistant that does exactly what it's told | read/write |

It also has a **debate mode**: the orchestrator and any member (or a one-off model) argue a question over several rounds of constructive back-and-forth, then write up a conclusion.

Inspired by [amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills).

## Supported agents

| Key | CLI | Models come from | Efforts | Can orchestrate |
|---|---|---|---|---|
| `claude` | Claude Code | built-in list (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) | low … max | yes |
| `codex` | Codex CLI | `codex debug models` | per model (low … ultra) | yes |
| `opencode` | OpenCode | `opencode models --verbose`, including `ollama-cloud/*` | per model variants | yes |
| `bob` | IBM Bob Shell | not listable: `default` (server-selected) or any id you type, passed to `bob -m` | none | yes |
| `dsh` | DeepSeek Harness | your harness config (`~/.dsh/profiles/desktop/cordis.patch.yml`), e.g. `ollama-cloud/deepseek-v4.1-flash:1017` | off / low / medium / high | team member only |

You can see what's installed with `agent-team discover`.

## Install

```sh
cd ~/Documents/delegate-skill
./install.sh                 # links the skill into ~/.claude/skills (Claude Code + OpenCode) and ~/.codex/skills, writes
                             # ~/.bob/rules/agent-team.md for Bob Shell, adds `agent-team` to ~/.local/bin
./install.sh --session-hook  # optional: Claude Code shows your roster at every new session
./install.sh --uninstall
```

Requirements: Node 18+, and each CLI you want to use must already be logged in. For DeepSeek Harness, save the Ollama Cloud key on its **Models** page; the skill reads it from the harness's own credential store.

The skill folder is a symlink, so edits in this repo take effect immediately.

**Per agent:**

- **Claude Code**: skill at `~/.claude/skills/agent-team`; use `/agent-team`.
- **OpenCode**: also reads `~/.claude/skills`, so it picks up the same link; ask it to "set up my agent team".
- **Codex**: skill at `~/.codex/skills/agent-team`; use `$agent-team`. The CLI is found on `PATH`, via `CODEX_BIN`, or inside the VS Code / Cursor / Windsurf "OpenAI ChatGPT" extension if you only have that.
- **Bob Shell**: Bob has no skills feature, so the installer writes `~/.bob/rules/agent-team.md`, a short rules file Bob loads into every session. It tells Bob to read `SKILL.md` and run `team.mjs` through its command tool. Ask Bob to "set up my agent team". Remove it with `./install.sh --uninstall` (only if the installer created it).

## Using it

### Option A: start a session from the terminal (pick everything up front)

```sh
agent-team              # pick orchestrator → implementer(s) → tester → reviewer → joker, then launch
agent-team --quick      # reuse the saved team and launch straight away
agent-team --scope project   # save this team only for the current repo (.agent-team.json)
agent-team --refresh    # re-probe installed CLIs/models first (after installing or updating a CLI)
```

For each role it asks **agent → model → thinking effort**, offering only the models and efforts that agent actually supports. Type `s` to skip a role and `c` to enter a custom model id. It then opens the orchestrator you picked (e.g. `claude --model claude-opus-5-5 --effort high`) with the skill already active.

### Option B: inside a session you already have open

In Claude Code type `/agent-team`; in Codex type `$agent-team` (or just ask "set up my agent team"). The orchestrator lists the installed agents, models, and efforts and asks you role by role. A running session can't change its own model, so to change the orchestrator it will point you to `/model` or to `agent-team` in a terminal.

### Example: Opus 5.5 orchestrating DeepSeek 1017

In a terminal, run `agent-team`, then pick Claude Code → `claude-opus-5-5` → `high` for the orchestrator, and DeepSeek Harness → `ollama-cloud/deepseek-v4.1-flash:1017` → `high` for the implementer. Or set it directly:

```sh
agent-team set-orchestrator --agent claude --model claude-opus-5-5 --effort high
agent-team set-role --role implementer --agent dsh --model "ollama-cloud/deepseek-v4.1-flash:1017" --effort high
agent-team set-role --role tester      --agent opencode --model ollama-cloud/kimi-k3 --effort high
agent-team set-role --role reviewer    --agent codex --model gpt-6.1-sol --effort xhigh
agent-team set-role --role joker       --agent claude --model claude-haiku-5-5 --effort low
agent-team show
```

Then just talk to the orchestrator:

- "Have the implementer add pagination to `/api/users`, then the tester covers it, then the reviewer checks it."
- "Ask the joker to collect every TODO in `src/` into a list."
- "Send this to implementer 2 as well and compare the approaches." (add more with `set-role --append`)

The orchestrator writes a self-contained brief, dispatches it, reads the result and `git diff`, re-runs the checks itself, and sends fixes back if needed. Nothing gets committed unless you ask.

### Debate mode

Ask for it in plain words:

- "Debate with the reviewer whether we should use a queue or cron for this."
- "Debate this design with codex gpt-6.1-sol at xhigh." (a one-off opponent that isn't on your team)
- "Argue it out with the implementer, 3 rounds."

Each round: the orchestrator posts its argument (claim, evidence, and the weakest part of its own case), and the opponent sees the full transcript and replies. Both sides concede where the other is right and end each turn with `POSITION:` and `STATUS: AGREE | PARTIAL | DISAGREE`. The debate stops when both agree, when the rounds run out (default 4), or when you say so. You can chip in at any point. At the end you get a conclusion: the decision, who changed their mind and why, and anything still open. Opponents run read-only: they can read the repo to check claims but can't change it.

Past debates: `agent-team debate list`, `agent-team debate show --id <id>`.

## Command reference

```sh
agent-team discover [--refresh]          # installed agents, models, efforts
agent-team options --agent dsh           # one agent's models + efforts
agent-team show                          # current team
agent-team run --member implementer --brief brief.md --cd .     # dispatch a configured member
agent-team run --agent codex --model gpt-6-luna --effort low --role joker --prompt "…"   # ad-hoc
agent-team debate start --with reviewer --topic "…" --rounds 4
agent-team debate turn --id <id> --file my-turn.md
agent-team debate end  --id <id> --message "Decision: …"
```

`run` options: `--member implementer:2` or `--member <name>` picks a specific member; `--mode read-only|write|full` overrides the role default (`full` turns off that CLI's sandbox and approvals, so use it with care); `--timeout <min>` (default 60). It prints JSON with `status`, `finalMessage`, `touchedFiles`, and `runDir`.

## Files

```
~/.agent-team/team.json        global team          (.agent-team.json in a repo overrides it)
~/.agent-team/discovery.json   cached agent/model scan (refreshed daily or with --refresh)
~/.agent-team/runs/<id>/       prompt.md, output.md, stdout/stderr, result.json for every dispatch
~/.agent-team/debates/<id>/    transcript.md + per-round run logs
```

## Limits

- **DeepSeek Harness and Bob Shell have no enforced read-only mode.** For reviewer/debate work they only get a "don't modify files" instruction (Bob also runs in `ask` chat mode). Prefer Claude, Codex, or OpenCode where you need a guarantee.
- The orchestrator can't switch its own model mid-session; use `/model` or relaunch with `agent-team`.
- Bob Shell can't list its models or efforts, so thinking effort is not offered for it. A `bob` run needs network access to Bob's service and a login (`BOBSHELL_API_KEY` or SSO).
- Claude's model list is built in. Pass any other id with `c` in the picker or `--model` on the CLI.
- Ollama's local CLI (`ollama`) isn't required. Ollama Cloud models run through OpenCode (`ollama-cloud/*`) or DeepSeek Harness.
- Runs block until the member finishes; in Claude Code the orchestrator runs them in the background.
