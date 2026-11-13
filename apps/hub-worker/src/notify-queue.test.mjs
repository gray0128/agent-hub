import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolve bundler-style extensionless TS imports for Node ESM test execution
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file://")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const candidate = path.resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { processNotifyBatch } = await import("./notify-queue.ts");

function createMockDb(initialRun) {
  const runs = new Map([[initialRun.id, { ...initialRun }]]);
  return {
    runs,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...params) {
          args = params;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM runs WHERE id = ?1")) {
            return runs.get(args[0]) ?? null;
          }
          return null;
        },
        async run() {
          if (sql.includes("SET notify_status = 'failed'")) {
            const r = runs.get(args[1]);
            if (r) {
              r.notify_status = "failed";
              r.updated_at = args[0];
            }
          } else if (sql.includes("SET notify_status = 'sent'")) {
            const r = runs.get(args[1]);
            if (r) {
              r.notify_status = "sent";
              r.updated_at = args[0];
            }
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
      return stmt;
    }
  };
}

test("processNotifyBatch retries HTTP 500 across attempts 1..4 and marks notify_status='failed' at attempt 5", async (t) => {
  let hits = 0;
  let lastAuthHeader = "";
  const server = http.createServer((req, res) => {
    hits += 1;
    lastAuthHeader = req.headers.authorization ?? "";
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const mockDb = createMockDb({
    id: "run_01RETRY",
    thread_id: "thr_01RETRY",
    root_run_id: "run_01RETRY",
    node_id: "macmini",
    workdir: "/tmp/demo",
    agent: "agy",
    status: "done",
    resolved_model: "carbon",
    resolved_effort: "high",
    native_session_id: "sess_1",
    duration_ms: 120,
    remote_control_url: "",
    summary: "ok",
    output_bytes: 2,
    notify_status: "queued"
  });

  const env = {
    DB: mockDb,
    WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
    WEBHOOK_KEY: "whsec_test_123",
    HUB_PUBLIC_URL: "https://ahub.bobocai.win"
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    let acked = false;
    let retriedDelay = null;
    await processNotifyBatch(
      {
        messages: [
          {
            attempts: attempt,
            body: {
              run_id: "run_01RETRY",
              event: "done",
              target: "webhook"
            },
            ack() {
              acked = true;
            },
            retry(opts) {
              retriedDelay = opts?.delaySeconds ?? 0;
            }
          }
        ]
      },
      env
    );
    assert.equal(acked, false, `attempt ${attempt} must retry rather than ack`);
    assert.equal(retriedDelay, Math.min(30, 2 ** attempt));
    assert.equal(mockDb.runs.get("run_01RETRY").notify_status, "queued");
  }

  let finalAcked = false;
  let finalRetried = false;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 5,
          body: {
            run_id: "run_01RETRY",
            event: "done",
            target: "webhook"
          },
          ack() {
            finalAcked = true;
          },
          retry() {
            finalRetried = true;
          }
        }
      ]
    },
    env
  );

  assert.equal(hits, 5);
  assert.equal(lastAuthHeader, "Bearer whsec_test_123");
  assert.equal(finalAcked, true, "attempt 5 must ack cleanly for DLQ state");
  assert.equal(finalRetried, false);
  assert.equal(mockDb.runs.get("run_01RETRY").notify_status, "failed");
});

test("processNotifyBatch marks notify_status='sent' on HTTP 200 and acks once", async (t) => {
  let hits = 0;
  let receivedPayload = null;
  const server = http.createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      receivedPayload = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const mockDb = createMockDb({
    id: "run_01SENT",
    thread_id: "thr_01SENT",
    root_run_id: "run_01SENT",
    node_id: "mbp",
    workdir: "/tmp/demo",
    agent: "pi",
    status: "done",
    resolved_model: "gpt-5",
    resolved_effort: "medium",
    native_session_id: "sess_2",
    duration_ms: 85,
    remote_control_url: "",
    summary: "done",
    output_bytes: 42,
    notify_status: "queued"
  });

  let acked = false;
  await processNotifyBatch(
    {
      messages: [
        {
          attempts: 1,
          body: { run_id: "run_01SENT", event: "done", target: "grok" },
          ack() {
            acked = true;
          },
          retry() {
            assert.fail("HTTP 200 should not retry");
          }
        }
      ]
    },
    {
      DB: mockDb,
      GROK_WEBHOOK_URL: `http://127.0.0.1:${port}/grok`,
      HUB_PUBLIC_URL: "https://ahub.bobocai.win"
    }
  );

  assert.equal(hits, 1);
  assert.equal(acked, true);
  assert.equal(mockDb.runs.get("run_01SENT").notify_status, "sent");
  assert.equal(receivedPayload.fetch_full_cmd, "ahub result run_01SENT --full --json");
});
