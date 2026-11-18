---
name: ahub
description: Dispatch, resume, monitor, and cancel coding or inspection tasks across registered machines (macmini, mbp, linux-dev, etc.) using the ahub CLI. Use when asked to run tasks on another machine, delegate work to a specific local agent (agy, pi, omp, codex, claude), or inspect remote workspace code.
---

# ahub Cross-Machine Task Dispatch

Use the `ahub` CLI as the sole interface to `agent-hub`. Do not hand-craft HTTP requests.

## Workflow

1. **Discover nodes and workspaces first** (when unsure of node names, agents, or project keys):
   ```sh
   ahub nodes --online --json
   ```

2. **Check delegation safety before dispatching**:
   - Inspect `AHUB_DEPTH`. If you are already executing inside a delegated task at depth >= 1, do not call `ahub run` unless explicitly authorized; complete the work locally and return your findings.
   - Never pass secrets or raw credentials inside the prompt.

3. **Dispatch or continue a task via stdin** (always pass `-` to avoid shell quoting issues):
   - New task thread:
     ```sh
     ahub run -n <node_id> -d <project_key_or_path> -a <agent> [-m <model>@<effort>] --wait 45s --json - <<'EOF'
     <clear, self-contained task instructions>
     EOF
     ```
   - Follow-up in an existing thread (preserves native agent session on that node):
     ```sh
     ahub run --thread <thread_id> --wait 45s --json - <<'EOF'
     <follow-up instructions>
     EOF
     ```
   - When running inside an environment with a webhook callback (e.g. Grok Bot), add `--notify grok`.
   - **Show prompt at dispatch time**: On `ahub run`, display the masked prompt with `run_id` / `thread_id`; never rely on `ahub result` post-completion for raw `prompt`.

4. **Handle wait outcomes by exit code**:
   - Exit `0` with `status: "done"`: Read `summary` and `output_preview` directly. Use `ahub result <run_id> --full --json` only if full output is needed.
   - Exit `0` with `status: "running"` and `webhook_armed: true`: Share `run_id` / `thread_id` and the masked prompt, note async execution, and stop until callback.
   - Exit `24` (local wait timed out without `--notify`): Call `ahub wait <run_id> --timeout 15m --json` to keep waiting over WebSocket.
   - Exit `20` (`status: "needs_approval"`): Immediately surface `remote_control_url` to the user for human approval.
   - Exit `64` (`WORKDIR_AMBIGUOUS`): Re-run using one of the exact paths returned in `error.details.candidates`.
   - Exit `10` (`status: "failed"`): Read `error_code` and `error_message` on the run record.
   - Exit `78`: Read `error.code` and `error.message`; do not blindly retry on `DEPTH_LIMIT_EXCEEDED`, `DELEGATION_CYCLE_DETECTED`, or `FORBIDDEN_SCOPE`.

5. **Report results and protect prompt privacy**:
   - On `done`, `failed`, `cancelled`, or `needs_approval`, report `thread_id` / `run_id` and `summary` (or `remote_control_url`).
   - Do **not** call `ahub result` to fetch `prompt` post-completion; `ahub_run_completed` callbacks may reference redacted `prompt_preview` only as a fallback.
   - **Mandatory redaction**: Never output raw tokens, passwords, bearer credentials, API keys, or webhook secrets when displaying any prompt or output; mask sensitive values before replying.
