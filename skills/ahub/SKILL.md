---
name: ahub
description: Dispatch, schedule, DAG-plan, retry, monitor, and cancel coding tasks across machines (macmini, mbp, linux-dev), and coordinate handoffs or blocking Q&A via ahub CLI.
---

# ahub Cross-Machine Dispatch

Use `ahub` CLI only; never hand-craft HTTP requests.

## Workflow

1. **Discover nodes/workspaces** (if node/agent/project unclear):
   `ahub nodes --online --json`

2. **Safety pre-check**:
   - `AHUB_DEPTH >= 1`: finish locally; do not dispatch (`ahub run`/`plan`) unless authorized.
   - Never put raw tokens/secrets in prompts or board posts.

3. **Dispatch, schedule, plan, or retry** (pass `-` via stdin to avoid quoting):
   - New thread:
     `ahub run -n <node> -d <project_or_path> -a <agent> [-m <model@effort>] [--wait 45s] --json - <<'EOF'`
   - Continue thread (keeps native session):
     `ahub run --thread <thr_id> [--wait 45s] --json - <<'EOF'`
   - Chain/schedule/labels/schema/handoff (`--after` repeatable/CSV; `--in 1m..7d`; `--topic` auto-posts `handoff`; `--as` profile; `--label k=v` <=16, no `ahub.*`; `--result-schema <json|@file|->` <=16KB, never `-` for both schema & prompt; `waiting` exits `0` unless `--wait`):
     `ahub run -n <node> -d <proj> -a <agent> [--after <run_id>] [--in 5m] [--topic <top_id>] [--as <profile>] [--label k=v] [--result-schema @schema.json] --json -`
   - DAG (`<=20` nodes, `<=60` edges) & retry (terminal run immutable; rebinds `waiting` deps):
     `ahub plan --file - [--topic <top_id>] [--as <profile>] [--idempotency-key <k>] --json < plan.json`
     `ahub retry <failed_or_cancelled_run_id> [--model <m@e>] [--effort <e>] [--timeout <dur>] [--as <profile>] [--json]`
   - Inspect: `ahub runs [--status waiting] [--plan <pln_id>] [--topic <top_id>] [--label k=v] [--json]`; `ahub result <run_id> [--data] [--full] [--json]`; `ahub cancel <run_id> [--cascade] [--json]`.
   - If `AHUB_RESULT_FILE` is set in env, write valid JSON (`<=64KB`) to it before exit.
   - Use `--notify grok` if callback available. Show masked prompt + `run_id`/`thread_id` on dispatch; never call `ahub result` post-run for raw `prompt`.

4. **Outcomes by exit code**:
   - `0` (`done` or `waiting` w/o `--wait`): Read `summary`/`output_preview` (`ahub result <id> --data --json` for `result`; `--full --json` only if needed).
   - `0` (`running` + `webhook_armed: true`): Share `run_id`/`thread_id` & masked prompt; stop until callback (no polling).
   - `24` (timeout): Run `ahub wait <run_id> --timeout 15m --json` over WS (no `sleep`/polling).
   - `20` (`needs_approval`): Surface `remote_control_url` immediately; never retry with `--no-sandbox`.
   - `64` (`WORKDIR_AMBIGUOUS`/`DEPENDENCY_CYCLE_DETECTED`/`INVALID_STATE_TRANSITION`): Use `error.details.candidates`, fix cycle, or check state.
   - `10` (`failed`/`cancelled`): Check `error_code`/`error_message` (on `RESULT_SCHEMA_MISMATCH`, read preserved `output_md` via `--full --json`); `ahub retry` to resume DAG.
   - `75`: Transient network/5xx/draining; safe to retry.
   - `78`: Check `error.code`/`error.message`; never retry `DEPTH_LIMIT_EXCEEDED`, `DELEGATION_CYCLE_DETECTED`, or `FORBIDDEN_SCOPE`.

5. **Report & redact**:
   - Report `thread_id`/`run_id` & `summary` (or `remote_control_url`). Mask tokens, passwords, keys, and webhook secrets.

6. **Native activity & progress** (no `workdir` lock):
   - `admin` inspect (`client` exits `78`): `ahub activity [--node <n>] [--agent <a>] [--kind interaction_needed|turn_summary|progress] [--unacked] [--limit 20] [--json]`
   - Milestone (never mount `PostToolUse`; non-urgent coalesces 60s quiet + 300s cooldown): `ahub native-emit --agent <a> --kind progress --session-id <sid> --dir "$PWD" --title "<t>" --summary -`

7. **Board (`ahub board`)**:
   - Caller creds (`--token`/`AHUB_TOKEN`/`credentials`) only, never `node.json` (`ahub_nod_*`). Non-`admin` posts are untrusted; no secrets.
   - `ahub board post <ch> [--ref <r>] --kind handoff|note|artifact [--status <s>] [--as <p>] [--node <n>] [--data <json>] --json -` (no push)
   - `ahub board read [<ch>] [--ref <r>|--topic <id>] [--after <c>] [--limit 20] [--json]`
   - `ahub board ask <ch> [--ref <r>] [--as <p>] [--node <n>] [--option <o>] [--wait 30m] --json -` (pushes `admin`, blocks topic; exit `24` keeps `open`—never cancel/re-ask; resume: `ahub board wait <ch> --topic <id> --after <c> --json`)
   - Follow `error.next[]`.
