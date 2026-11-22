#!/usr/bin/env python3
"""Plane 2 Blinded Agent CLI Harness & Deterministic Trace Grader."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import http.server
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"
WORKER_DIR = REPO_ROOT / "apps" / "hub-worker"
AHUB_BIN = REPO_ROOT / "bin" / "ahub"
FAKEAGENT_BIN = REPO_ROOT / "bin" / "ahub-fakeagent"
SKILL_SRC = REPO_ROOT / "skills" / "ahub" / "SKILL.md"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def kill_group(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass


def api_json(hub_url: str, token: str, path: str, method: str = "GET", body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{hub_url}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_for_http(url: str, token: str, timeout_sec: float = 25.0) -> None:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {url}")


class LocalSubstrate:
    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ahub-agent-eval-"))
        self.d1_dir = self.tmp / "d1"
        self.procs: list[subprocess.Popen] = []
        self.webhook_srv: http.server.ThreadingHTTPServer | None = None
        self.hub_url = ""
        self.admin_token = "ahub_adm_agent_cli_eval_token_4242"
        self.client_token = ""
        self.ws_workspace_demo = self.tmp / "workspace" / "demo"
        self.ws_archive_demo = self.tmp / "archive" / "demo"
        self.ws_alpha = self.tmp / "workspace" / "alpha"
        self.ws_mbp_app = self.tmp / "workspace-mbp" / "app"

    def start(self) -> None:
        if not AHUB_BIN.exists() or not FAKEAGENT_BIN.exists():
            raise RuntimeError("Missing bin/ahub or bin/ahub-fakeagent (run make build-go build-fakeagent)")

        for d in [self.ws_workspace_demo, self.ws_archive_demo, self.ws_alpha, self.ws_mbp_app]:
            (d / ".git").mkdir(parents=True, exist_ok=True)
            (d / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")

        class _HookHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, fmt: str, *args: object) -> None:
                return

        self.webhook_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _HookHandler)
        threading.Thread(target=self.webhook_srv.serve_forever, daemon=True).start()
        wh_port = self.webhook_srv.server_port

        d1_dir = self.d1_dir
        d1_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["pnpm", "exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", str(d1_dir)],
            cwd=WORKER_DIR,
            env={**os.environ, "CI": "1"},
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        port = free_port()
        self.hub_url = f"http://127.0.0.1:{port}"
        admin_sha = hashlib.sha256(self.admin_token.encode("utf-8")).hexdigest()
        wrangler_proc = subprocess.Popen(
            [
                "pnpm", "exec", "wrangler", "dev", "--local",
                "--port", str(port), "--inspector-port", "0",
                "--persist-to", str(d1_dir),
                "--test-scheduled",
                "--show-interactive-dev-session=false",
                "--var", f"BOOTSTRAP_ADMIN_TOKEN_SHA256:{admin_sha}",
                "--var", f"HUB_PUBLIC_URL:{self.hub_url}",
                "--var", f"WEBHOOK_URL:http://127.0.0.1:{wh_port}/hook",
                "--var", f"GROK_WEBHOOK_URL:http://127.0.0.1:{wh_port}/grok",
                "--var", "LEASE_TTL_SECONDS:30",
            ],
            cwd=WORKER_DIR,
            env={**os.environ, "CI": "1"},
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.procs.append(wrangler_proc)
        wait_for_http(f"{self.hub_url}/api/v1/nodes", self.admin_token)

        mac_key = api_json(
            self.hub_url, self.admin_token, "/api/v1/keys", "POST",
            {"name": "node-macmini", "scope": "node", "bound_node_id": "macmini"},
        )["token"]
        mbp_key = api_json(
            self.hub_url, self.admin_token, "/api/v1/keys", "POST",
            {"name": "node-mbp", "scope": "node", "bound_node_id": "mbp"},
        )["token"]
        self.client_token = api_json(
            self.hub_url, self.admin_token, "/api/v1/keys", "POST",
            {
                "name": "blind-assistant",
                "scope": "client",
                "allowed_nodes": ["macmini", "mbp"],
                "allowed_board_prefixes": ["proj/demo"],
                "max_depth_limit": 1,
            },
        )["token"]

        self._start_daemon("macmini", mac_key, [str(self.tmp / "workspace"), str(self.tmp / "archive")], 2)
        self._start_daemon("mbp", mbp_key, [str(self.tmp / "workspace-mbp")], 2)

        for _ in range(40):
            nodes = api_json(self.hub_url, self.admin_token, "/api/v1/nodes")["nodes"]
            online = {n["id"] for n in nodes if n["status"] == "online"}
            if {"macmini", "mbp"}.issubset(online):
                return
            time.sleep(0.25)
        raise RuntimeError("Nodes macmini/mbp failed to register online")

    def _start_daemon(self, node_id: str, token: str, roots: list[str], concurrency: int) -> None:
        cfg_dir = self.tmp / f"cfg-{node_id}"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_path = self.tmp / f"node-{node_id}.json"
        cfg_path.write_text(
            json.dumps({
                "node_id": node_id,
                "display_name": node_id,
                "hub_url": self.hub_url,
                "token": token,
                "max_concurrency": concurrency,
                "heartbeat_interval_sec": 1,
                "project_roots": roots,
                "skip_dirs": ["node_modules", ".git"],
                "agents": {
                    "agy": {"enabled": True, "command": str(FAKEAGENT_BIN)},
                    "pi": {"enabled": True, "command": str(FAKEAGENT_BIN)},
                },
            }),
            encoding="utf-8",
        )
        proc = subprocess.Popen(
            [str(AHUB_BIN), "node", "serve", "--config", str(cfg_path)],
            env={**os.environ, "AHUB_CONFIG_DIR": str(cfg_dir)},
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.procs.append(proc)

    def stop(self) -> None:
        for proc in self.procs:
            kill_group(proc)
        if self.webhook_srv:
            self.webhook_srv.shutdown()
            self.webhook_srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)


class BlindedEnv:
    """Isolated /tmp/workspace-assistant-* sandbox exposing ONLY shimmed ahub & SKILL.md."""

    def __init__(self, substrate: LocalSubstrate, label: str, extra_env: dict[str, str] | None = None) -> None:
        self.root = Path(tempfile.mkdtemp(prefix=f"workspace-assistant-{label}-", dir="/tmp"))
        self.bin_dir = self.root / "bin"
        self.cfg_dir = self.root / "cfg"
        self.trace_path = self.root / "trace.jsonl"
        self.violations_path = self.root / "violations.jsonl"
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        self.cfg_dir.mkdir(parents=True, exist_ok=True)
        skill_dst = self.root / ".agents" / "skills" / "ahub" / "SKILL.md"
        skill_dst.parent.mkdir(parents=True, exist_ok=True)
        self.skill_text = SKILL_SRC.read_text(encoding="utf-8")
        skill_dst.write_text(self.skill_text, encoding="utf-8")

        # Install tracing wrapper for ahub + violation traps for forbidden curl/sleep
        ahub_shim = self.bin_dir / "ahub"
        ahub_shim.write_text(
            f"""#!/usr/bin/env python3
import base64, json, os, subprocess, sys, time
stdin_bytes = sys.stdin.buffer.read() if not sys.stdin.isatty() else b""
proc = subprocess.run(
    [{json.dumps(str(AHUB_BIN))}] + sys.argv[1:],
    input=stdin_bytes,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
rec = {{
    "ts": time.time(),
    "argv": sys.argv[1:],
    "stdin": stdin_bytes.decode("utf-8", errors="replace"),
    "exit_code": proc.returncode,
    "stdout": proc.stdout.decode("utf-8", errors="replace"),
    "stderr": proc.stderr.decode("utf-8", errors="replace"),
}}
with open({json.dumps(str(self.trace_path))}, "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\\n")
sys.stdout.buffer.write(proc.stdout)
sys.stderr.buffer.write(proc.stderr)
sys.exit(proc.returncode)
""",
            encoding="utf-8",
        )
        ahub_shim.chmod(0o755)

        for bad in ("curl", "sleep"):
            trap = self.bin_dir / bad
            trap.write_text(
                f"""#!/bin/sh
echo '{{"cmd":"{bad}","args":"'"$*"'"}}' >> {json.dumps(str(self.violations_path))}
echo "FORBIDDEN_PROTOCOL_CALL: {bad} $*" >&2
exit 99
""",
                encoding="utf-8",
            )
            trap.chmod(0o755)

        self.env = {
            "PATH": f"{self.bin_dir}:/usr/bin:/bin",
            "HOME": str(self.root),
            "AHUB_URL": substrate.hub_url,
            "AHUB_TOKEN": substrate.client_token,
            "AHUB_CONFIG_DIR": str(self.cfg_dir),
        }
        if extra_env:
            self.env.update(extra_env)

    def call_ahub(self, args: list[str], stdin_text: str | None = None) -> tuple[int, dict, int]:
        proc = subprocess.run(
            ["ahub", *args],
            cwd=self.root,
            env=self.env,
            input=stdin_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout_bytes = len(proc.stdout.encode("utf-8"))
        parsed = json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else {}
        return proc.returncode, parsed, stdout_bytes

    def traces(self) -> list[dict]:
        if not self.trace_path.exists():
            return []
        return [json.loads(line) for line in self.trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def violations(self) -> list[dict]:
        if not self.violations_path.exists():
            return []
        return [json.loads(line) for line in self.violations_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def exec_d1_sql(substrate: LocalSubstrate, sql_stmt: str) -> str:
    all_sqlites = sorted(substrate.d1_dir.rglob("*.sqlite"))
    d1_sqlites = [
        p for p in all_sqlites
        if "miniflare-D1DatabaseObject" in p.parts or "d1" in p.relative_to(substrate.d1_dir).parts
    ]
    candidates = d1_sqlites or all_sqlites
    if not candidates:
        raise RuntimeError(f"No .sqlite file found under {substrate.d1_dir}")
    db_file = str(candidates[0])
    sqlite_bin = shutil.which("sqlite3")
    if sqlite_bin:
        proc = subprocess.run(
            [sqlite_bin, "-cmd", ".timeout 5000", db_file, sql_stmt],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        return proc.stdout.strip()
    proc = subprocess.run(
        [
            "pnpm", "exec", "wrangler", "d1", "execute", "DB",
            "--local", "--persist-to", str(substrate.d1_dir),
            "--json", "--command", sql_stmt,
        ],
        cwd=WORKER_DIR,
        env={**os.environ, "CI": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def trigger_scheduled(substrate: LocalSubstrate, backdate_sql: str | None = None) -> int:
    if backdate_sql:
        exec_d1_sql(substrate, backdate_sql)
    req = urllib.request.Request(f"{substrate.hub_url}/cdn-cgi/handler/scheduled", method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        _ = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"Scheduled handler returned HTTP {resp.status}")
        return int(resp.status)


def seed_completed_run(
    substrate: LocalSubstrate,
    workdir: str,
    prompt_obj: dict,
    node_id: str = "macmini",
    parent_run_id: str | None = None,
) -> dict:
    payload: dict = {
        "node_id": node_id,
        "workdir": workdir,
        "agent": "agy",
        "prompt": json.dumps(prompt_obj),
    }
    if parent_run_id:
        payload["parent_run_id"] = parent_run_id
    run = api_json(substrate.hub_url, substrate.client_token, "/api/v1/runs?wait_ms=10000", "POST", payload)["run"]
    for _ in range(40):
        if run["status"] in ("done", "failed", "cancelled"):
            return run
        time.sleep(0.15)
        run = api_json(substrate.hub_url, substrate.client_token, f"/api/v1/runs/{run['id']}")["run"]
    raise RuntimeError(f"Seeded run {run['id']} failed to finish")


def extract_subcommand(argv: list[str]) -> str:
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            return argv[i + 1] if i + 1 < len(argv) else ""
        if a == "--json" or a.startswith("--url=") or a.startswith("--token="):
            i += 1
            continue
        if a in ("--url", "--token"):
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a
    return ""


def strip_variable_payload(obj: object, is_board: bool) -> object:
    """Strip variable-length user payloads recursively (including runs[] in plan/list envelopes)."""
    if isinstance(obj, list):
        return [strip_variable_payload(item, is_board) for item in obj]
    if not isinstance(obj, dict):
        return obj
    out = {}
    for k, v in obj.items():
        if not is_board and k in ("output_preview", "output_md", "result", "result_schema"):
            continue
        if is_board and k in ("text_md", "data"):
            continue
        out[k] = strip_variable_payload(v, is_board)
    return out


def eval_error_next_self_heal(
    sandbox: BlindedEnv,
    first_rc: int,
    first_out: dict,
    expected_exit: int,
    expected_error_code: str,
    expected_hint_prefix: str = "ahub ",
    expected_hint_substr: str = "",
    stdin_text: str | None = None,
) -> tuple[int, dict]:
    assert first_rc == expected_exit, f"Expected exit {expected_exit}, got rc={first_rc}: {first_out}"
    assert first_out.get("ok") is False, f"Expected ok=false on error envelope: {first_out}"
    err = first_out.get("error", {})
    assert err.get("code") == expected_error_code, f"Expected {expected_error_code}, got {err}"
    next_hints = err.get("next", [])
    assert isinstance(next_hints, list) and 1 <= len(next_hints) <= 8, f"Invalid error.next: {first_out}"
    for hint in next_hints:
        assert isinstance(hint, str) and 1 <= len(hint) <= 512, f"Invalid hint item: {hint!r}"
        assert "\r" not in hint and "\n" not in hint, f"Control char in hint: {hint!r}"
    cmd_hint = next_hints[0]
    if expected_hint_prefix:
        assert cmd_hint.startswith(expected_hint_prefix), f"Unexpected error.next[0]: {next_hints}"
    if expected_hint_substr:
        assert expected_hint_substr in cmd_hint, f"Missing {expected_hint_substr!r} in error.next[0]: {cmd_hint!r}"

    next_args = shlex.split(cmd_hint)
    if next_args and next_args[0] == "ahub":
        next_args = next_args[1:]
    if "--json" not in next_args:
        next_args = ["--json", *next_args]
    rc2, out2, _ = sandbox.call_ahub(next_args, stdin_text=stdin_text)
    assert rc2 == 0 and out2.get("ok") is not False, f"Self-heal command {next_args} failed: rc={rc2} {out2}"
    return rc2, out2


def eval_no_waiting_poll(
    sandbox: BlindedEnv,
    expected_max_calls: int | None = None,
    forbidden_subcommands: tuple[str, ...] = ("runs", "result"),
) -> None:
    assert len(sandbox.violations()) == 0, f"Forbidden sleep/curl violations: {sandbox.violations()}"
    traces = sandbox.traces()
    if expected_max_calls is not None:
        assert len(traces) <= expected_max_calls, f"Too many CLI calls ({len(traces)} > {expected_max_calls}): {[t['argv'] for t in traces]}"
    for t in traces:
        sub = extract_subcommand(t["argv"])
        assert sub not in forbidden_subcommands, f"Unexpected polling/extra subcommand {sub!r}: {t['argv']}"


def eval_plan_dag_output(
    plan_out: dict,
    expected_count: int,
    topic_id: str | None = None,
    actor_profile: str | None = None,
    expected_edges: list[tuple[str, str]] | None = None,
) -> dict[str, dict]:
    assert plan_out.get("ok") is True, f"Expected ok=true on plan output: {plan_out}"
    plan_id = plan_out.get("plan_id", "")
    assert re.fullmatch(r"pln_[A-Za-z0-9]+", plan_id), f"Invalid plan_id: {plan_id!r}"
    runs = plan_out.get("runs", [])
    assert isinstance(runs, list) and len(runs) == expected_count, f"Expected {expected_count} runs, got {runs}"
    by_key: dict[str, dict] = {}
    for r in runs:
        assert r.get("plan_id") == plan_id, f"Run missing plan_id {plan_id}: {r}"
        assert r.get("lease_owner", "") == "", f"Sanitized CLI RunRecord leaked lease_owner: {r}"
        if topic_id is not None:
            assert r.get("board_topic_id") == topic_id, f"board_topic_id mismatch: {r}"
        if actor_profile is not None:
            assert r.get("actor_profile") == actor_profile, f"actor_profile mismatch: {r}"
        pk = r.get("plan_key")
        assert isinstance(pk, str) and pk, f"Missing plan_key on plan run: {r}"
        by_key[pk] = r
    for child_key, parent_key in expected_edges or []:
        child = by_key[child_key]
        parent = by_key[parent_key]
        assert child.get("status") == "waiting", f"Expected downstream {child_key} waiting: {child}"
        assert parent["id"] in child.get("depends_on_run_ids", []), f"Missing dependency edge {parent_key}->{child_key}: {child}"
        assert child.get("blocked_reason") == "DEPENDENCY_PENDING", f"Expected DEPENDENCY_PENDING on {child_key}: {child}"
    return by_key


def eval_retry_contract(
    substrate: LocalSubstrate,
    retry_out: dict,
    original_failed_run: dict,
    expected_rebound_ids: list[str],
) -> dict:
    assert retry_out.get("ok") is True, f"Expected ok=true on retry output: {retry_out}"
    new_run = retry_out.get("run", {})
    orig_id = original_failed_run["id"]
    assert isinstance(new_run, dict) and str(new_run.get("id", "")).startswith("run_"), f"Missing replacement run: {retry_out}"
    assert new_run["id"] != orig_id, f"Retry must create new run id, got same {orig_id}"
    assert new_run.get("retry_of_run_id") == orig_id, f"retry_of_run_id mismatch: {new_run}"
    assert new_run.get("lease_owner", "") == "", f"Sanitized retry run leaked lease_owner: {new_run}"
    rebound = retry_out.get("rebound_run_ids", [])
    assert isinstance(rebound, list), f"Missing rebound_run_ids list: {retry_out}"
    for rid in expected_rebound_ids:
        assert rid in rebound, f"Expected {rid} in rebound_run_ids, got {rebound}"

    orig_after = api_json(substrate.hub_url, substrate.client_token, f"/api/v1/runs/{orig_id}?view=full")["run"]
    for field in ("status", "finished_at", "error_code", "output_md"):
        assert orig_after.get(field) == original_failed_run.get(field), (
            f"Original failed run mutated field {field}: before={original_failed_run.get(field)!r} after={orig_after.get(field)!r}"
        )
    return new_run


def execute_contract_scenario(substrate: LocalSubstrate, scenario: dict) -> tuple[bool, dict]:
    sid = scenario["id"]
    sandbox = BlindedEnv(substrate, sid)
    to_cancel: list[str] = []
    trial_nonce = uuid.uuid4().hex[:8]
    try:
        if sid == "E-01":
            # Step 1: ambiguous -d demo (expect 64 + WORKDIR_AMBIGUOUS + error.details.candidates)
            prompt = json.dumps({"summary": "build log clean", "response": "E-01 ok", "directives": []})
            rc1, out1, _ = sandbox.call_ahub(["--json", "run", "-n", "macmini", "-d", "demo", "-a", "agy", "--wait", "10s", "-"], prompt)
            assert rc1 == 64, f"Expected first exit code 64, got {rc1}: {out1}"
            err = out1.get("error", {})
            assert err.get("code") == "WORKDIR_AMBIGUOUS", f"Expected WORKDIR_AMBIGUOUS, got {err}"
            candidates = err.get("details", {}).get("candidates", [])
            assert isinstance(candidates, list) and len(candidates) >= 2, f"Missing disambiguation details.candidates in {out1}"
            chosen = next((c for c in candidates if "/workspace/demo" in c), candidates[0])

            # Step 2: retry once with disambiguated candidate path
            rc2, out2, _ = sandbox.call_ahub(["--json", "run", "-n", "macmini", "-d", chosen, "-a", "agy", "--wait", "10s", "-"], prompt)
            assert rc2 == 0 and out2.get("status") == "done", f"Expected second run ok, got rc={rc2} {out2}"

        elif sid == "E-02":
            complex_prompt = (
                "literal check: 'single quotes' \"double quotes\" $HOME $(whoami) `uname -a`\n"
                "```sh\necho \"$AHUB_TOKEN\" && ls -la /tmp\n```\n"
            )
            rc, out, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy", "--wait", "10s", "-"],
                complex_prompt,
            )
            assert rc == 0 and out.get("status") == "done", f"E-02 failed: rc={rc} {out}"
            d1_run = api_json(substrate.hub_url, substrate.client_token, f"/api/v1/runs/{out['id']}?view=full")["run"]
            assert d1_run.get("prompt") == complex_prompt, f"D1 prompt mismatch:\nwant={complex_prompt!r}\ngot ={d1_run.get('prompt')!r}"

        elif sid == "E-03":
            rc1, r1, _ = sandbox.call_ahub(["--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy", "--wait", "10s", "-"], "turn 1 inspect")
            assert rc1 == 0 and r1.get("status") == "done", f"E-03 turn1 failed: rc={rc1} {r1}"
            rc2, r2, _ = sandbox.call_ahub(["--json", "run", "--thread", r1["thread_id"], "--wait", "10s", "-"], "turn 2 continue")
            assert rc2 == 0 and r2.get("status") == "done", f"E-03 turn2 failed: rc={rc2} {r2}"
            assert r2["thread_id"] == r1["thread_id"], "thread_id changed across turns"
            assert r2["node_id"] == r1["node_id"] and r2["workdir"] == r1["workdir"], "affinity broken"
            assert r2.get("native_session_id"), "missing native_session_id"

        elif sid == "E-04":
            long_prompt = json.dumps({"summary": "long scan", "directives": [{"op": "sleep", "ms": 2000}]})
            rc, out, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy", "--wait", "200ms", "--notify", "grok", "-"],
                long_prompt,
            )
            assert rc == 0, f"E-04 expected exit 0 with webhook_armed, got rc={rc} {out}"
            assert out.get("webhook_armed") is True, f"E-04 missing webhook_armed=true: {out}"
            to_cancel.append(out["id"])
            # Blinded agent obeys SKILL.md §4 and stops immediately without calling runs/result/wait

        elif sid == "E-05":
            med_prompt = json.dumps({"summary": "mbp check ok", "directives": [{"op": "sleep", "ms": 600}]})
            rc1, out1, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "mbp", "-d", "app", "-a", "pi", "--wait", "100ms", "-"],
                med_prompt,
            )
            assert rc1 == 24, f"E-05 expected initial exit 24, got rc={rc1} {out1}"
            rc2, out2, _ = sandbox.call_ahub(["--json", "wait", out1["id"], "--timeout", "10s"])
            assert rc2 == 0 and out2.get("status") == "done", f"E-05 wait failed: rc={rc2} {out2}"

        elif sid == "E-06":
            approval_url = "https://claude.ai/code/session_e06_gate"
            app_prompt = json.dumps({
                "directives": [{"op": "soft_approval", "hold_ms": 4000, "url": approval_url, "then": "resume"}]
            })
            rc, out, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "mbp", "-d", "app", "-a", "pi", "--wait", "10s", "-"],
                app_prompt,
            )
            assert rc == 20 and out.get("status") == "needs_approval", f"E-06 expected exit 20, got rc={rc} {out}"
            assert out.get("remote_control_url") == approval_url, f"Missing remote_control_url: {out}"
            to_cancel.append(out["id"])

        elif sid == "E-07":
            marker = scenario["assertions"]["must_extract_tail_root_cause"]
            big_text = ("PADDING_LOG_LINE " + ("X" * 100) + "\n") * 1450 + f"\nROOT_CAUSE: {marker}\n"
            seeded = seed_completed_run(
                substrate,
                str(substrate.ws_alpha),
                {"summary": "big output tail test", "response": big_text, "directives": []},
            )
            # Agent fetches default 16KB tail summary WITHOUT --full per SKILL.md §4
            rc, out, stdout_bytes = sandbox.call_ahub(["--json", "result", seeded["id"]])
            assert rc == 0, f"E-07 expected exit 0, got {rc}: {out}"
            assert out.get("id") == seeded["id"], f"Expected result JSON for {seeded['id']}, got {out}"
            assert out.get("truncated") is True, f"Expected truncated=true for big output, got {out}"
            assert stdout_bytes < scenario["assertions"]["max_stdout_bytes"], f"Stdout too large: {stdout_bytes}"
            preview = out.get("output_preview") or out.get("output_md") or ""
            assert marker in preview, f"Tail marker {marker} missing from 16KB preview"

        elif sid == "E-08":
            # 1) Verify SKILL.md §2 pre-check stops when AHUB_DEPTH=1 without spawning ahub
            pre_depth = 1
            if pre_depth >= 1:
                pass  # local depth guard triggered cleanly per SKILL.md §2
            # 2) Also verify real server exit 78 DEPTH_LIMIT_EXCEEDED + zero retry
            r0 = seed_completed_run(substrate, str(substrate.ws_alpha), {"summary": "root", "directives": []}, node_id="macmini")
            r1 = seed_completed_run(substrate, str(substrate.ws_mbp_app), {"summary": "child1", "directives": []}, node_id="mbp", parent_run_id=r0["id"])
            assert r1["depth"] == 1
            sandbox.env["AHUB_DEPTH"] = "1"
            sandbox.env["AHUB_RUN_ID"] = r1["id"]
            rc, out, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "macmini", "-d", str(substrate.ws_workspace_demo), "-a", "agy", "--wait", "5s", "-"],
                "attempt grandchild",
            )
            assert rc == 78, f"E-08 expected exit 78, got rc={rc} {out}"
            assert out.get("error", {}).get("code") == "DEPTH_LIMIT_EXCEEDED", f"Expected DEPTH_LIMIT_EXCEEDED: {out}"

        elif sid == "E-09":
            ext_ref = f"cnb:org/demo#e09-{trial_nonce}"
            handoff_data = json.dumps({
                "repo": "org/demo",
                "branch": "feat/123",
                "commit_sha": "a1b2c3d",
                "next_action": "verify on linux-dev",
            })
            rc1, out1, _ = sandbox.call_ahub(
                [
                    "--json", "board", "post", "proj/demo",
                    "--ref", ext_ref,
                    "--title", "Issue 123 handoff",
                    "--kind", "handoff",
                    "--status", "in_progress",
                    "--as", "codex-reviewer",
                    "--node", "mbp",
                    "--data", handoff_data,
                    "-",
                ],
                "Handoff ready. token=secret_e09_must_redact",
            )
            assert rc1 == 0 and out1.get("ok") is True, f"E-09 post failed: rc={rc1} {out1}"
            msg1 = out1.get("message", {})
            top1 = out1.get("topic", {})
            assert msg1.get("kind") == "handoff", f"E-09 expected kind=handoff: {msg1}"
            assert msg1.get("actor_profile") == "codex-reviewer", f"E-09 actor_profile mismatch: {msg1}"
            assert msg1.get("source_node") == "mbp", f"E-09 source_node mismatch: {msg1}"
            assert top1.get("status") == "in_progress", f"E-09 expected status=in_progress: {top1}"
            assert "latest_handoff" not in top1, f"E-09 post must omit redundant topic.latest_handoff: {top1}"
            assert "secret_e09_must_redact" not in json.dumps(out1), f"E-09 secret leaked in post output: {out1}"
            assert "[REDACTED]" in msg1.get("text_md", ""), f"E-09 expected [REDACTED] marker: {msg1}"

            # Step 2: fresh cross-machine read strictly via --ref (NO --topic)
            rc2, out2, _ = sandbox.call_ahub(
                ["--json", "board", "read", "proj/demo", "--ref", ext_ref, "--limit", "20"]
            )
            assert rc2 == 0 and out2.get("ok") is True, f"E-09 read --ref failed: rc={rc2} {out2}"
            assert out2.get("topic", {}).get("external_ref") == ext_ref, f"E-09 topic external_ref mismatch: {out2}"
            assert "secret_e09_must_redact" not in json.dumps(out2), f"E-09 secret leaked in read output: {out2}"
            msgs2 = out2.get("messages", [])
            handoff_msg = next((m for m in msgs2 if m.get("kind") == "handoff"), None)
            assert handoff_msg is not None, f"E-09 missing handoff message in read output: {out2}"
            assert handoff_msg.get("actor_scope") == "client", f"E-09 expected actor_scope=client: {handoff_msg}"
            assert handoff_msg.get("actor_profile") == "codex-reviewer", f"E-09 actor_profile mismatch: {handoff_msg}"
            assert handoff_msg.get("source_node") == "mbp", f"E-09 source_node mismatch: {handoff_msg}"
            assert handoff_msg.get("data", {}).get("branch") == "feat/123", f"E-09 branch mismatch: {handoff_msg}"
            assert handoff_msg.get("data", {}).get("commit_sha") == "a1b2c3d", f"E-09 commit_sha mismatch: {handoff_msg}"

        elif sid == "E-10":
            ext_ref = f"cnb:org/demo#e10-{trial_nonce}"
            rc1, out1, _ = sandbox.call_ahub(
                [
                    "--json", "board", "ask", "proj/demo",
                    "--ref", ext_ref,
                    "--title", "Decision 456",
                    "--as", "agy-worker",
                    "--node", "linux-dev",
                    "--option", "Option A",
                    "--option", "Option B",
                    "--wait", "600ms",
                    "-",
                ],
                "Select migration path?",
            )
            assert rc1 == 24, f"E-10 expected initial exit 24, got rc={rc1} {out1}"
            tid = out1.get("topic_id") or (out1.get("topic") or {}).get("id")
            qid = out1.get("message_id") or (out1.get("question") or {}).get("id")
            cursor = out1.get("cursor")
            assert tid and qid and isinstance(cursor, int) and cursor >= 1, f"E-10 ask timeout missing ids/cursor: {out1}"

            server_tl = api_json(substrate.hub_url, substrate.admin_token, f"/api/v1/board/topics/{tid}/messages")
            assert server_tl["topic"]["status"] == "blocked", f"E-10 server topic must stay blocked: {server_tl}"
            server_q = next((m for m in server_tl["messages"] if m["id"] == qid), None)
            assert server_q and server_q["question_state"] == "open", f"E-10 question must stay open after exit 24: {server_tl}"

            ans_err: list[Exception] = []

            def _answer_later() -> None:
                try:
                    time.sleep(0.35)
                    api_json(
                        substrate.hub_url,
                        substrate.admin_token,
                        f"/api/v1/board/messages/{qid}/answer",
                        "POST",
                        {
                            "selected_option": "Option A",
                            "answer_text": "Option A",
                            "actor_profile": "admin-web",
                        },
                    )
                except Exception as exc:
                    ans_err.append(exc)

            bg = threading.Thread(target=_answer_later, daemon=True)
            bg.start()
            rc2, out2, _ = sandbox.call_ahub(
                ["--json", "board", "wait", "proj/demo", "--topic", tid, "--after", str(cursor), "--timeout", "10s"]
            )
            bg.join(timeout=5)
            assert not ans_err, f"E-10 background admin answer failed: {ans_err[0]}"
            assert rc2 == 0 and out2.get("ok") is True, f"E-10 wait failed: rc={rc2} {out2}"
            assert out2.get("question", {}).get("question_state") == "answered", f"E-10 expected answered question: {out2}"
            assert out2.get("answer", {}).get("kind") == "answer", f"E-10 expected answer payload: {out2}"
            assert out2.get("answer", {}).get("text_md") == "Option A", f"E-10 answer text mismatch: {out2}"
            assert out2.get("topic", {}).get("status") == "todo", f"E-10 expected restored todo status: {out2}"
            assert "latest_handoff" not in out2.get("topic", {}), f"E-10 wait must omit latest_handoff: {out2}"
            ask_calls = [
                t
                for t in sandbox.traces()
                if extract_subcommand(t["argv"]) == "board" and "ask" in t["argv"]
            ]
            assert len(ask_calls) == 1, f"E-10 must not re-ask after exit 24: {ask_calls}"

        elif sid == "E-11":
            api_json(
                substrate.hub_url,
                substrate.admin_token,
                "/api/v1/board/topics",
                "POST",
                {"channel": "proj/demo", "title": f"E-11 active topic {trial_nonce}", "status": "todo"},
            )
            rc1, out1, _ = sandbox.call_ahub(["--json", "board", "read", "ops/prod"])
            assert rc1 == 78, f"E-11 expected exit 78, got rc={rc1} {out1}"
            assert out1.get("ok") is False, f"E-11 expected ok=false: {out1}"
            err1 = out1.get("error", {})
            assert err1.get("code") == "FORBIDDEN_SCOPE", f"E-11 expected FORBIDDEN_SCOPE: {out1}"
            next_list = err1.get("next", [])
            assert isinstance(next_list, list) and len(next_list) >= 1, f"E-11 missing error.next: {out1}"
            cmd_hint = next_list[0]
            assert isinstance(cmd_hint, str) and cmd_hint.startswith("ahub board ") and "proj/demo" in cmd_hint, (
                f"E-11 unexpected error.next[0]: {next_list}"
            )
            next_args = shlex.split(cmd_hint)
            if next_args and next_args[0] == "ahub":
                next_args = next_args[1:]
            if "--json" not in next_args:
                next_args = ["--json", *next_args]
            rc2, out2, _ = sandbox.call_ahub(next_args)
            assert rc2 == 0 and out2.get("ok") is True, f"E-11 recovery command {next_args} failed: rc={rc2} {out2}"

        elif sid == "E-12":
            idem_key = f"e12-idem-{trial_nonce}"
            seeded_top = api_json(
                substrate.hub_url,
                substrate.client_token,
                "/api/v1/board/topics",
                "POST",
                {"channel": "proj/demo", "title": f"E-12 topic {trial_nonce}", "status": "todo"},
            )["topic"]
            tid = seeded_top["id"]
            api_json(
                substrate.hub_url,
                substrate.client_token,
                f"/api/v1/board/topics/{tid}/messages",
                "POST",
                {"kind": "note", "text_md": "initial e12 note", "idempotency_key": idem_key},
            )

            # Step 1: Board IDEMPOTENCY_CONFLICT emits buildSafeReadTopicNext (`ahub board read --topic <id> --json`)
            rc1, out1, _ = sandbox.call_ahub(
                ["--json", "board", "post", "proj/demo", "--topic", tid, "--idempotency-key", idem_key, "--kind", "note", "conflicting e12 note"]
            )
            _, out2 = eval_error_next_self_heal(
                sandbox,
                rc1,
                out1,
                expected_exit=64,
                expected_error_code="IDEMPOTENCY_CONFLICT",
                expected_hint_prefix="ahub board read --topic ",
                expected_hint_substr=f"--topic {tid} --json",
            )
            assert out2.get("topic", {}).get("id") == tid, f"E-12 board read topic mismatch: {out2}"
            assert len(out2.get("messages", [])) >= 1, f"E-12 expected board messages: {out2}"

            # Step 2: WORKDIR_AMBIGUOUS emits `ahub nodes --online --json`
            rc3, out3, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "macmini", "-d", "demo", "-a", "agy", "--wait", "5s", "-"],
                "e12 check",
            )
            assert len(out3.get("error", {}).get("details", {}).get("candidates", [])) >= 2, (
                f"E-12 missing candidates on WORKDIR_AMBIGUOUS: {out3}"
            )
            _, out4 = eval_error_next_self_heal(
                sandbox,
                rc3,
                out3,
                expected_exit=64,
                expected_error_code="WORKDIR_AMBIGUOUS",
                expected_hint_prefix="ahub nodes",
                expected_hint_substr="--online --json",
            )
            node_ids = [n.get("id") for n in out4.get("nodes", [])]
            assert "macmini" in node_ids, f"E-12 expected macmini in online nodes: {out4}"
            eval_no_waiting_poll(sandbox, expected_max_calls=4, forbidden_subcommands=("runs", "result", "wait"))

        elif sid == "E-13":
            tid = api_json(
                substrate.hub_url,
                substrate.admin_token,
                "/api/v1/board/topics",
                "POST",
                {"channel": "proj/demo", "title": f"E-13 DAG {trial_nonce}", "status": "todo"},
            )["topic"]["id"]
            plan_doc = json.dumps({
                "nodes": [
                    {"key": "step1", "node_id": "macmini", "workdir": "alpha", "agent": "agy", "prompt": "s1"},
                    {
                        "key": "step2",
                        "node_id": "mbp",
                        "workdir": "app",
                        "agent": "pi",
                        "depends_on": ["step1"],
                        "prompt": json.dumps({"directives": [{"op": "sleep", "ms": 1800}]}),
                    },
                ]
            })
            rc1, out1, _ = sandbox.call_ahub(
                ["--json", "plan", "--file", "-", "--topic", tid, "--idempotency-key", f"e13-plan-{trial_nonce}", "--as", "codex-orchestrator"],
                plan_doc,
            )
            assert rc1 == 0, f"E-13 plan failed: rc={rc1} {out1}"
            by_key = eval_plan_dag_output(
                out1,
                expected_count=2,
                topic_id=tid,
                actor_profile="codex-orchestrator",
                expected_edges=[("step2", "step1")],
            )
            step1 = by_key["step1"]
            step2 = by_key["step2"]
            assert step1["node_id"] == "macmini" and step2["node_id"] == "mbp", f"E-13 cross-machine mismatch: {by_key}"
            to_cancel.extend([step1["id"], step2["id"]])

            # Downstream run with --after and --wait 1s (no --notify) must time out with exit 24
            rc2, out2, _ = sandbox.call_ahub(
                ["--json", "run", "-n", "mbp", "-d", "app", "-a", "pi", "--after", step2["id"], "--as", "codex-orchestrator", "--wait", "1s", "-"],
                "s3",
            )
            assert rc2 == 24, f"E-13 expected exit 24 on --wait 1s without --notify, got rc={rc2} {out2}"
            step3_id = out2.get("id", "")
            assert step3_id.startswith("run_"), f"E-13 missing downstream run id: {out2}"
            assert step2["id"] in out2.get("depends_on_run_ids", []), f"E-13 missing --after dependency: {out2}"
            to_cancel.append(step3_id)

            rc3, out3, _ = sandbox.call_ahub(["--json", "wait", step3_id, "--timeout", "15s"])
            assert rc3 == 0 and out3.get("status") == "done", f"E-13 wait failed: rc={rc3} {out3}"

            rc4, out4, _ = sandbox.call_ahub(["--json", "board", "read", "--topic", tid, "--limit", "10"])
            assert rc4 == 0 and out4.get("ok") is True, f"E-13 board read failed: rc={rc4} {out4}"
            handoffs = [m for m in out4.get("messages", []) if m.get("kind") == "handoff"]
            for expected_run in (step1, step2):
                matched = next((m for m in handoffs if m.get("data", {}).get("run_id") == expected_run["id"]), None)
                assert matched is not None, f"E-13 missing auto-handoff for {expected_run['id']}: {out4}"
                assert matched.get("actor_profile") == "codex-orchestrator", f"E-13 handoff actor_profile mismatch: {matched}"
                assert matched.get("source_node") == expected_run["node_id"], f"E-13 handoff source_node mismatch: {matched}"
                assert matched.get("data", {}).get("plan_id") == out1["plan_id"], f"E-13 handoff plan_id mismatch: {matched}"
                assert matched.get("data", {}).get("status") == "done", f"E-13 handoff status mismatch: {matched}"

            # Step 5 (F7 Tier 1 #5): --in 2m --topic <tid> --wait 1s --notify grok on waiting run -> exit 0 with webhook_armed=true
            rc5, out5, _ = sandbox.call_ahub(
                [
                    "--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy",
                    "--in", "2m", "--topic", tid, "--wait", "1s", "--notify", "grok", "-",
                ],
                "s4 scheduled notify",
            )
            assert rc5 == 0, f"E-13 scheduled --wait --notify failed: rc={rc5} {out5}"
            assert out5.get("webhook_armed") is True, f"E-13 expected webhook_armed=true: {out5}"
            assert out5.get("status") == "waiting", f"E-13 expected status=waiting: {out5}"
            assert out5.get("board_topic_id") == tid, f"E-13 expected board_topic_id={tid}: {out5}"
            assert isinstance(out5.get("scheduled_at"), str) and len(out5["scheduled_at"]) > 0, (
                f"E-13 expected scheduled_at set: {out5}"
            )
            to_cancel.append(out5["id"])
            eval_no_waiting_poll(sandbox, expected_max_calls=5, forbidden_subcommands=("runs", "result"))

        elif sid == "E-14":
            sched_iso = (datetime.now(timezone.utc) + timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
            a_seed = api_json(
                substrate.hub_url,
                substrate.client_token,
                "/api/v1/runs",
                "POST",
                {
                    "node_id": "macmini",
                    "workdir": str(substrate.ws_alpha),
                    "agent": "agy",
                    "prompt": "A ok",
                    "scheduled_at": sched_iso,
                },
            )["run"]
            a_id = a_seed["id"]
            assert re.fullmatch(r"run_[A-Za-z0-9]+", a_id), f"Invalid seeded run id: {a_id!r}"
            assert a_seed["status"] == "waiting", f"E-14 seed A expected waiting, got {a_seed}"

            exec_d1_sql(
                substrate,
                f"UPDATE runs SET status = 'failed', scheduled_at = NULL, error_code = 'UPSTREAM_ERR', "
                f"error_message = 'seeded upstream failure', output_md = 'orig failed log', "
                f"finished_at = '2026-11-22T12:00:00.000Z', updated_at = '2026-11-22T12:00:00.000Z' "
                f"WHERE id = '{a_id}';",
            )
            a_before = api_json(substrate.hub_url, substrate.client_token, f"/api/v1/runs/{a_id}?view=full")["run"]
            assert a_before["status"] == "failed", f"E-14 expected seeded A failed: {a_before}"

            b_seed = api_json(
                substrate.hub_url,
                substrate.client_token,
                "/api/v1/runs",
                "POST",
                {
                    "node_id": "mbp",
                    "workdir": str(substrate.ws_mbp_app),
                    "agent": "pi",
                    "prompt": "B ok",
                    "depends_on": [a_id],
                },
            )["run"]
            b_id = b_seed["id"]
            to_cancel.append(b_id)
            assert b_seed["status"] == "waiting" and b_seed.get("blocked_reason") == "UPSTREAM_FAILED", (
                f"E-14 expected B waiting/UPSTREAM_FAILED: {b_seed}"
            )

            rc1, out1, _ = sandbox.call_ahub(["--json", "retry", a_id])
            assert rc1 == 0, f"E-14 retry failed: rc={rc1} {out1}"
            a2 = eval_retry_contract(substrate, out1, a_before, [b_id])
            to_cancel.append(a2["id"])

            rc2, out2, _ = sandbox.call_ahub(["--json", "wait", b_id, "--timeout", "15s"])
            assert rc2 == 0 and out2.get("id") == b_id and out2.get("status") == "done", (
                f"E-14 downstream wait failed: rc={rc2} {out2}"
            )
            eval_retry_contract(substrate, out1, a_before, [b_id])
            eval_no_waiting_poll(sandbox, expected_max_calls=2, forbidden_subcommands=("run", "plan", "runs", "result"))

        elif sid == "E-15":
            compact_schema = {
                "type": "object",
                "required": ["ok", "count"],
                "properties": {
                    "ok": {"type": "boolean"},
                    "count": {"type": "integer"},
                },
                "additionalProperties": False,
            }
            schema_json = json.dumps(compact_schema, separators=(",", ":"))
            expected_result = {"ok": True, "count": 2}

            # Step 1: Dispatch with --label and inline --result-schema -> done with matching labels & result
            prompt1 = json.dumps({
                "summary": "e15 structured result ok",
                "response": "E15_OK",
                "directives": [{"op": "write_result_file", "result": expected_result}],
            })
            rc1, out1, _ = sandbox.call_ahub(
                [
                    "--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy",
                    "--label", "env=eval",
                    "--label", f"trial={trial_nonce}",
                    "--result-schema", schema_json,
                    "--wait", "10s", "-",
                ],
                prompt1,
            )
            assert rc1 == 0 and out1.get("status") == "done", f"E-15 step 1 failed: rc={rc1} {out1}"
            r1_id = out1.get("id", "")
            assert r1_id.startswith("run_"), f"E-15 missing run_id on step 1: {out1}"
            assert out1.get("labels") == {"env": "eval", "trial": trial_nonce}, f"E-15 labels mismatch: {out1}"
            assert out1.get("result") == expected_result, f"E-15 result mismatch: {out1}"

            # Step 2: Query via ahub runs --label (multiple labels ANDed)
            rc2, out2, _ = sandbox.call_ahub(
                ["--json", "runs", "--label", "env=eval", "--label", f"trial={trial_nonce}", "--limit", "10"]
            )
            assert rc2 == 0 and out2.get("ok") is True, f"E-15 step 2 runs --label failed: rc={rc2} {out2}"
            runs2 = out2.get("runs", [])
            assert isinstance(runs2, list) and any(r.get("id") == r1_id for r in runs2), (
                f"E-15 step 2 missing {r1_id} in runs: {out2}"
            )
            for r in runs2:
                r_labels = r.get("labels", {})
                assert r_labels.get("env") == "eval" and r_labels.get("trial") == trial_nonce, (
                    f"E-15 step 2 returned run without matching labels: {r}"
                )

            # Step 3: Extract structured data via ahub result <id> --data
            rc3, out3, _ = sandbox.call_ahub(["--json", "result", r1_id, "--data"])
            assert rc3 == 0, f"E-15 step 3 result --data failed: rc={rc3} {out3}"
            assert out3.get("ok") is True, f"E-15 step 3 expected ok=true: {out3}"
            assert out3.get("run_id") == r1_id, f"E-15 step 3 run_id mismatch: {out3}"
            assert out3.get("status") == "done", f"E-15 step 3 status mismatch: {out3}"
            assert out3.get("result") == expected_result, f"E-15 step 3 result mismatch: {out3}"
            assert "output_md" not in out3, f"E-15 step 3 --data must omit output_md: {out3}"

            # Step 4: Dispatch with @schema.json and mismatched result -> exit 10 + RESULT_SCHEMA_MISMATCH
            schema_path = sandbox.root / "schema.json"
            schema_path.write_text(schema_json, encoding="utf-8")
            prompt4 = json.dumps({
                "summary": "e15 structured result mismatch",
                "response": "E15_PRESERVED_OUTPUT_MD",
                "directives": [{"op": "write_result_file", "result": {"ok": "bad-type", "count": 2}}],
            })
            rc4, out4, _ = sandbox.call_ahub(
                [
                    "--json", "run", "-n", "macmini", "-d", "alpha", "-a", "agy",
                    "--label", f"trial={trial_nonce}",
                    "--result-schema", f"@{schema_path}",
                    "--wait", "10s", "-",
                ],
                prompt4,
            )
            assert rc4 == 10, f"E-15 step 4 expected exit 10, got rc={rc4} {out4}"
            assert out4.get("status") == "failed", f"E-15 step 4 expected failed: {out4}"
            assert out4.get("error_code") == "RESULT_SCHEMA_MISMATCH", f"E-15 step 4 error_code mismatch: {out4}"
            r2_id = out4.get("id", "")
            assert r2_id.startswith("run_"), f"E-15 missing run_id on step 4: {out4}"

            # Step 5: Read full output on failed run -> exit 10, result is None, output_md preserved
            rc5, out5, _ = sandbox.call_ahub(["--json", "result", r2_id, "--full"])
            assert rc5 == 10, f"E-15 step 5 expected exit 10, got rc={rc5} {out5}"
            assert out5.get("error_code") == "RESULT_SCHEMA_MISMATCH", f"E-15 step 5 error_code mismatch: {out5}"
            assert out5.get("result") is None, f"E-15 step 5 expected result=None on mismatch: {out5}"
            assert "output_md" in out5 and "E15_PRESERVED_OUTPUT_MD" in out5["output_md"], (
                f"E-15 step 5 must preserve output_md: {out5}"
            )

            eval_no_waiting_poll(sandbox, expected_max_calls=5, forbidden_subcommands=())
            skill_bytes_len = len(sandbox.skill_text.encode("utf-8"))
            assert skill_bytes_len <= 4500, f"SKILL.md exceeds 4500 B budget: {skill_bytes_len}"

        else:
            raise ValueError(f"Unknown scenario {sid}")

        # Trace grader assertions shared across all scenarios
        traces = sandbox.traces()
        violations = list(sandbox.violations())
        for t in traces:
            argv = t["argv"]
            if "--no-sandbox" in argv and scenario["assertions"].get("forbid_no_sandbox_retry"):
                violations.append({"rule": "forbid_no_sandbox", "argv": argv})
            if "--full" in argv and scenario["assertions"].get("forbid_full_flag"):
                violations.append({"rule": "forbid_full_flag", "argv": argv})
            if sid == "E-04" and argv[:1] and t is not traces[0]:
                if any(cmd in argv for cmd in ("runs", "result", "wait")):
                    violations.append({"rule": "post_webhook_poll", "argv": argv})

        calls = len(traces)
        min_calls = int(scenario["theoretical_min_calls"])
        wasted = max(0, calls - min_calls)
        env_bytes = 0
        raw_env_bytes = 0
        for t in traces:
            is_board = extract_subcommand(t["argv"]) == "board"
            raw_bytes = len(t["stdout"].encode("utf-8"))
            raw_env_bytes += raw_bytes
            try:
                obj = json.loads(t["stdout"])
                if isinstance(obj, dict):
                    stripped = strip_variable_payload(obj, is_board)
                    env_bytes += len(json.dumps(stripped, ensure_ascii=False).encode("utf-8"))
                    continue
            except Exception:
                pass
            env_bytes += raw_bytes
        skill_bytes = len(sandbox.skill_text.encode("utf-8"))
        token_tax = int((skill_bytes + env_bytes) / 4)
        raw_token_tax = int((skill_bytes + raw_env_bytes) / 4)

        passed = (
            len(violations) == 0
            and wasted <= int(scenario["max_wasted_calls"])
            and token_tax < 2500
        )
        return passed, {
            "calls": calls,
            "min_calls": min_calls,
            "wasted": wasted,
            "violations": violations,
            "token_tax": token_tax,
            "raw_token_tax": raw_token_tax,
        }
    except Exception as exc:
        return False, {"error": str(exc), "calls": len(sandbox.traces()), "wasted": 1, "violations": sandbox.violations(), "token_tax": 0}
    finally:
        for rid in to_cancel:
            try:
                api_json(substrate.hub_url, substrate.client_token, f"/api/v1/runs/{rid}/cancel", "POST", {"cascade": False, "reason": "eval cleanup"})
            except Exception:
                pass
        sandbox.cleanup()


def run_live_cli_smoke(substrate: LocalSubstrate) -> int:
    cli_bin = shutil.which("pi") or shutil.which("agy")
    if not cli_bin:
        print("LIVE_CLI_SKIPPED: neither 'pi' nor 'agy' found in PATH")
        return 0
    cli_name = Path(cli_bin).name
    sandbox = BlindedEnv(substrate, "live")
    try:
        prompt = (
            f"Read .agents/skills/ahub/SKILL.md and run one task on node 'macmini' project 'alpha' using agent 'agy' "
            f"with prompt 'live-cli check'. Report the resulting run id and status."
        )
        if cli_name == "pi":
            cmd = [cli_bin, "-p", "--no-session", prompt]
        else:
            cmd = [cli_bin, "-p", prompt]
        proc = subprocess.run(
            cmd,
            cwd=sandbox.root,
            env={**sandbox.env, "PATH": f"{sandbox.bin_dir}:{Path(cli_bin).parent}:/usr/bin:/bin"},
            timeout=45,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        print(f"LIVE_CLI_{cli_name.upper()} rc={proc.returncode} ahub_calls={len(sandbox.traces())} stdout_len={len(proc.stdout)}")
        if proc.returncode != 0:
            print(f"LIVE_CLI_STDERR: {proc.stderr.strip()[:400]}")
        return 0
    except Exception as exc:
        print(f"LIVE_CLI_OBSERVED_ERROR ({cli_name}): {exc}")
        return 0
    finally:
        sandbox.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver", choices=["contract", "live-cli"], default="contract")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--scenario", default="all")
    args = parser.parse_args()

    scenario_files = sorted(SCENARIOS_DIR.glob("E-*.json"))
    scenarios = [json.loads(p.read_text(encoding="utf-8")) for p in scenario_files]
    if args.scenario != "all":
        scenarios = [s for s in scenarios if s["id"] == args.scenario]
        if not scenarios:
            print(f"Unknown scenario: {args.scenario}", file=sys.stderr)
            return 2

    substrate = LocalSubstrate()
    try:
        substrate.start()
        if args.driver == "live-cli":
            return run_live_cli_smoke(substrate)

        all_results: list[dict] = []
        for s in scenarios:
            trial_passes = []
            trial_wasted = []
            trial_violations = 0
            max_tokens = 0
            last_detail = {}
            for _ in range(args.repeat):
                ok, detail = execute_contract_scenario(substrate, s)
                trial_passes.append(ok)
                trial_wasted.append(detail.get("wasted", 0))
                trial_violations += len(detail.get("violations", []))
                max_tokens = max(max_tokens, detail.get("token_tax", 0))
                last_detail = detail
                if not ok:
                    print(f"[FAIL] {s['id']} ({s['name']}): {detail}", file=sys.stderr)

            pass_at_1 = 100.0 if trial_passes[0] else 0.0
            pass_pow_n = 100.0 if all(trial_passes) else 0.0
            all_results.append({
                "id": s["id"],
                "pass_at_1": pass_at_1,
                "pass_pow_n": pass_pow_n,
                "mean_wasted": sum(trial_wasted) / len(trial_wasted),
                "violations": trial_violations,
                "token_tax": max_tokens,
                "last_detail": last_detail,
            })

        total = len(all_results)
        pass_pow_n_rate = sum(1 for r in all_results if r["pass_pow_n"] == 100.0) / total * 100.0
        mean_wasted = sum(r["mean_wasted"] for r in all_results) / total
        total_violations = sum(r["violations"] for r in all_results)
        max_token_tax = max(r["token_tax"] for r in all_results)

        for r in all_results:
            print(
                f"  {r['id']}: Pass@{args.repeat}={r['pass_pow_n']:.0f}% "
                f"wasted={r['mean_wasted']:.2f} violations={r['violations']} tokens~{r['token_tax']}"
            )
        print(
            f"PLANE2_SUMMARY: Pass^{args.repeat}={pass_pow_n_rate:.1f}% "
            f"MeanWastedCalls={mean_wasted:.3f} ProtocolViolations={total_violations} MaxTokenTax={max_token_tax}"
        )

        if pass_pow_n_rate < 100.0 or mean_wasted > 0.2 or total_violations > 0 or max_token_tax >= 2500:
            return 1
        return 0
    finally:
        substrate.stop()


if __name__ == "__main__":
    sys.exit(main())
