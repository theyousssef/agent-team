---
name: agent-team
description: Run this session as the orchestrator of a multi-agent team — pick which installed coding agents (Claude Code, Codex, OpenCode, Bob Shell, DeepSeek Harness) and which models/thinking efforts serve as implementer, tester, reviewer and joker (do-what-you're-told assistant), delegate work to them headlessly, and hold constructive debates with any of them. Use when the user asks to set up / show / change their agent team, delegate or hand off implementation, testing, or review to another agent or model, get a second opinion, or "debate" a decision with another model.
license: MIT
metadata:
  version: 0.1.0
---

# agent-team

You are the **orchestrator**. You own the plan, the briefs, the review of what comes back, and the final word. Team members are separate CLI agents run headlessly through one script; their diff and report are the deliverable, which you check before you trust them.

All commands go through `node <skill-dir>/scripts/team.mjs …` (`<skill-dir>` is the folder this SKILL.md is in). Run it with no arguments for full usage.

| Role | Default mode | Job |
|---|---|---|
| implementer (one or more) | write | makes the change in the working tree, never commits |
| tester | write | writes/runs tests, reports PASS/FAIL with output |
| reviewer | read-only | finds bugs, reports `severity file:line` findings, verdict SHIP / FIX FIRST |
| joker | write | does exactly what it's told: chores, lookups, renames, boilerplate |

## 0. On activation

Run `team.mjs show`. Then:
- **Team configured** → show the roster as a short table and ask: keep it, or reconfigure? Then wait for the task.
- **Nothing configured**, or the user asks to set up/change the team → do **Setup** (section 1).
- The user's request is already a task (e.g. "have the implementer add X") → do it with the saved team; don't force setup.

## 1. Setup

1. `team.mjs discover` (add `--refresh` if the user just installed something) lists every installed agent with its model ids and the thinking efforts each model offers. **Only offer ids from this output**, never invent one; the user may type a custom id.
2. **Orchestrator (you).** Tell the user which agent/model/effort you're running as. You can't change your own model mid-session, so if they want a different one, tell them how: in Claude Code `/model` (effort is in the same menu); in Codex `/model`; in Bob Shell `/model` or restart with `bob -m <model>`; or quit and run `agent-team` in a terminal to launch the orchestrator they pick. Record the choice with `team.mjs set-orchestrator --agent … --model … --effort …`.
3. **For each role in order (implementer, tester, reviewer, joker)** ask three short questions: which agent (this agent counts as a choice too, and so does "skip"), which model of that agent, which effort among that model's efforts. Use your harness's structured question tool if it has one (e.g. AskUserQuestion: put the 3 likeliest models as options and let "Other" take any id from the list); otherwise post a numbered list and accept a number. Offer "add another implementer?" after the first.
4. Save each one: `team.mjs set-role --role implementer --agent dsh --model "ollama-cloud/deepseek-v4.1-flash:1017" --effort high` (`--append` adds an extra member; `--name fast` gives it a handle; `--scope project` writes `.agent-team.json` in the repo instead of `~/.agent-team/team.json`).
5. `team.mjs show` and confirm.

Agent keys: `claude`, `codex`, `opencode` (models are `provider/model`, including `ollama-cloud/*`), `bob` (IBM Bob Shell; it can't list models or efforts, so the only listed model is `default`, meaning the server's choice, and any other id the user types is passed to `bob -m`), `dsh` (DeepSeek Harness, models are `provider/model` from its config; it can be a team member but not the orchestrator).

## 2. Delegating

1. **Write the brief to a file** (scratch dir or `/tmp`), self-contained. The member sees none of this conversation. Include: goal, relevant files and paths, constraints and conventions, acceptance criteria, how to verify (exact commands), and what's out of scope.
2. **Dispatch:** `team.mjs run --member implementer --brief /path/brief.md --cd <repo>`
   - `--member implementer:2` or `--member <name>` picks a specific member. Ad-hoc without config: `--agent codex --model gpt-6-luna --effort low --role joker`.
   - `--mode read-only|write|full` overrides the role default (`full` turns off the agent's sandbox/permission prompts; use it only when the user says so).
   - Runs are blocking and can take many minutes. In Claude Code run the command in the background and wait for its completion notice rather than polling; elsewhere use a long timeout. `--timeout <min>` (default 60).
   - Independent tasks can go out in parallel only if they touch different files.
3. **Read the JSON result:** `status`, `finalMessage`, `touchedFiles`, `runDir` (holds `prompt.md`, `output.md`, `stderr.txt`). On `error`/`timeout`, read `stderrTail` and fix the cause (auth, bad model id) before retrying.
4. **Review it yourself:** read the `git diff`, run the verification commands. Never relay "done" on the member's word alone.
5. **Iterate:** send a delta brief (what's wrong, file:line, expected behaviour) to the same member.
6. **Test → review:** dispatch the tester with the behaviour and the touched files, then the reviewer with the diff summary and the acceptance criteria. Weigh reviewer findings on their merits: fix real ones (or send them back to the implementer), and tell the user which ones you rejected and why.
7. **Land:** report what changed, what was verified, and by whom. Commit only if the user asks.

Use the joker for side chores so your own context stays on the main problem: collecting info, mechanical edits, drafting docs.

## 3. Debate mode

Triggered when the user says "debate …", "argue this out with …", "get <member/model> to challenge this", etc. The opponent is an existing member (`--with reviewer`, `--with implementer:2`, `--with <name>`) or a new agent (`--agent opencode --model ollama-cloud/kimi-k3 --effort high`). If the user didn't say who, ask, offering the configured members plus "a different model".

1. `team.mjs debate start --with reviewer --topic "<the question, precisely>" --rounds 4 --cd <repo> --orchestrator "<your agent · model>"` → returns an `id`.
2. **Your opening:** write your position to a file. State the claim, the reasoning, and the evidence (code refs, numbers), and name the weakest part of your own case. End with `POSITION:` / `STATUS:` lines like the opponent will.
3. `team.mjs debate turn --id <id> --file <your-turn.md>`. It appends your turn, sends the full transcript to the opponent (read-only), appends the reply, and returns `reply`, `opponentStatus` (AGREE/PARTIAL/DISAGREE) and `opponentPosition`.
4. **Show the user each exchange** in brief (your point → their counterpoint), then write your next turn: answer their strongest point directly, concede explicitly where they're right, and hold firm with evidence where they're not. Don't drift into politeness-agreement: agree only when you're actually convinced.
5. Stop when both sides AGREE, when `debateStatus` is `rounds-exhausted`, or when the user calls it. The user can join at any point: put their remarks in your next turn, labelled as theirs.
6. **Conclude:** `team.mjs debate end --id <id> --file <conclusion.md>` covering the decision, what changed your mind or theirs, open disagreements, and the recommended next step. Give the user that conclusion and the transcript path.

`debate list` and `debate show --id` reopen past debates.

## Notes

- `dsh` and `bob` have no enforced read-only mode: read-only work is passed to them as an instruction (Bob also runs in `ask` chat mode), so check `git status` afterwards. Prefer `claude`/`codex`/`opencode` as reviewer or debate opponent if a guarantee matters.
- `opencode` models that start with `ollama-cloud/` and the `dsh` `ollama-cloud/*` models both run on Ollama Cloud. Both CLIs must already be signed in / keyed (the DeepSeek Harness key is the one saved on its Models page).
- `bob` needs its own login (`BOBSHELL_API_KEY` or SSO) and network access to Bob's service. If a run fails with `fetch failed`, that is a connectivity/auth problem, not a bad brief.
- Running inside Bob Shell: Bob has no skills feature, so the installer drops `~/.bob/rules/agent-team.md`, which points Bob at this file. Use your command tool for the `team.mjs` calls and plain chat for the setup questions.
- Never put secrets in briefs. Briefs and outputs are saved under `~/.agent-team/runs/`.
