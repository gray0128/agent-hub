import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptPreview, redactBoardData, redactJsonValue, redactSecrets } from "./redact.ts";

test("redactSecrets masks tokens and passwords while keeping shell variables", () => {
  const sample = [
    "ahub --token ahub_cli_secret987654 run",
    "Authorization: Bearer bearer_secret_123456",
    "https://user:pass123@example.com/hook?token=qsec_999",
    "password=my_plain_password",
    'echo "$AHUB_TOKEN" <NODE_TOKEN>'
  ].join("\n");

  const out = redactSecrets(sample);
  for (const leak of ["secret987654", "bearer_secret_123456", "pass123", "qsec_999", "my_plain_password"]) {
    assert.equal(out.includes(leak), false);
  }
  assert.equal(out.includes("ahub_cli_[REDACTED]"), true);
  assert.equal(out.includes('echo "$AHUB_TOKEN" <NODE_TOKEN>'), true);
});

test("redactSecrets covers space flags, curl -u, X-API-Key, quoted passwords with spaces, and bearer prose", () => {
  const cases = [
    ["ahub --token raw_cli_tok_123 --json", "ahub --token [REDACTED] --json"],
    ['ahub --password "my secret pass" --webhook-key wh_999', 'ahub --password "[REDACTED]" --webhook-key [REDACTED]'],
    ["ahub auth login --url https://ahub.bobocai.win --token-stdin", "ahub auth login --url https://ahub.bobocai.win --token-stdin"],
    ["curl -u alice:s3cr3t https://example.com", "curl -u [REDACTED] https://example.com"],
    ['curl -sSu "alice:my pass" --proxy-user bob:sec2 https://x.com', 'curl -sSu "[REDACTED]" --proxy-user [REDACTED] https://x.com'],
    ["curl -H 'X-API-Key: key_abc_123' -H 'X-Webhook-Key: whk_123' https://x.com", "curl -H 'X-API-Key: [REDACTED]' -H 'X-Webhook-Key: [REDACTED]' https://x.com"],
    ['PASSWORD="a b" TOKEN=\'c d\' has_token=true token_source=env', 'PASSWORD="[REDACTED]" TOKEN=\'[REDACTED]\' has_token=true token_source=env'],
    ['{"api_key":"sk-live-1234567890abcdef","token_source":"env","has_token":"true"}', '{"api_key":"[REDACTED]","token_source":"env","has_token":"true"}'],
    ["fix bearer authentication and bearer middleware configuration", "fix bearer authentication and bearer middleware configuration"],
    ["Bearer 2026-11-17T00:00:00Z", "Bearer 2026-11-17T00:00:00Z"],
    ["Bearer my_secret_token_99", "Bearer [REDACTED]"],
    ['{"cmd": "curl -u \\"alice:my pass\\" && X-API-Key: sec99"}', '{"cmd": "curl -u \\"[REDACTED]\\" && X-API-Key: [REDACTED]"}'],
    [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
      "[REDACTED_PRIVATE_KEY]"
    ]
  ];

  for (const [input, expected] of cases) {
    const once = redactSecrets(input);
    assert.equal(once, expected, `mismatch for ${input}`);
    assert.equal(redactSecrets(once), once, `idempotency failed for ${input}`);
  }
});

test("redactSecrets preserves E-02 multiline shell snippet verbatim", () => {
  const e02 =
    "literal check: 'single quotes' \"double quotes\" $HOME $(whoami) `uname -a`\n" +
    "```sh\necho \"$AHUB_TOKEN\" && ls -la /tmp\n```\n";
  assert.equal(redactSecrets(e02), e02);
});

test("redactSecrets runs in linear time on 100KB adversarial inputs", () => {
  const bigPem = "-----BEGIN RSA PRIVATE KEY-----\n" + "A".repeat(120_000);
  const bigCurl = "curl " + "-u alice:secret99 ".repeat(5_500) + "https://example.com";
  const t0 = performance.now();
  const outPem = redactSecrets(bigPem);
  const outCurl = redactSecrets(bigCurl);
  const elapsedMs = performance.now() - t0;

  assert.equal(outPem, bigPem);
  assert.equal(outCurl.includes("secret99"), false);
  assert.equal(redactSecrets(outCurl), outCurl);
  assert.ok(elapsedMs < 250, `expected <250ms, got ${elapsedMs.toFixed(2)}ms`);
});

test("buildPromptPreview bounds long prompts and sets promptTruncated", () => {
  const longText = "a".repeat(1300) + " ahub_cli_tailsecret99";
  const { promptPreview, promptTruncated } = buildPromptPreview(longText, 1200);
  assert.equal(promptTruncated, true);
  assert.equal(promptPreview.includes("tailsecret99"), false);
  assert.equal(promptPreview.endsWith("...[truncated]"), true);
});

test("redactBoardData handles deep nesting iteratively, key-aware redaction, placeholders, DAGs, and cycles", () => {
  // 500-level nested object and array
  let deepObj = { secret: "sk-live-deep500secret123456" };
  for (let i = 0; i < 500; i++) {
    deepObj = { nested: deepObj };
  }
  const redactedDeepObj = redactBoardData(deepObj);
  let cursor = redactedDeepObj;
  for (let i = 0; i < 500; i++) {
    cursor = cursor.nested;
  }
  assert.equal(cursor.secret, "[REDACTED]");

  let deepArr = ["sk-live-deeparrsecret123456"];
  for (let i = 0; i < 100; i++) {
    deepArr = [deepArr];
  }
  const redactedDeepArr = redactBoardData({ items: deepArr });
  let arrCursor = redactedDeepArr.items;
  for (let i = 0; i < 100; i++) {
    arrCursor = arrCursor[0];
  }
  assert.equal(arrCursor[0], "[REDACTED]");

  // Key-context redaction & placeholder preservation
  const keyAware = redactBoardData({
    api_key: "plain_secret_987654321",
    env_api_key: "$MY_API_KEY",
    braced_token: "${MY_TOKEN}",
    angle_secret: "<APP_SECRET>",
    has_token: "true",
    token_source: "env",
    nested: {
      token: "my_plain_token_12345",
      webhookKey: "plain_webhook_key_123"
    }
  });
  assert.equal(keyAware.api_key, "[REDACTED]");
  assert.equal(keyAware.env_api_key, "$MY_API_KEY");
  assert.equal(keyAware.braced_token, "${MY_TOKEN}");
  assert.equal(keyAware.angle_secret, "<APP_SECRET>");
  assert.equal(keyAware.has_token, "true");
  assert.equal(keyAware.token_source, "env");
  assert.equal(keyAware.nested.token, "[REDACTED]");
  assert.equal(keyAware.nested.webhookKey, "[REDACTED]");
  assert.deepEqual(redactBoardData(keyAware), keyAware);

  // Shared DAG reference & circular cycle guard
  const shared = { api_key: "plain_shared_secret" };
  const dag = redactBoardData({ a: shared, b: shared });
  assert.equal(dag.a.api_key, "[REDACTED]");
  assert.equal(dag.b.api_key, "[REDACTED]");

  const cyclic = { token: "plain_cycle_secret" };
  cyclic.self = cyclic;
  const redactedCyclic = redactJsonValue(cyclic);
  assert.equal(redactedCyclic.token, "[REDACTED]");
  assert.equal(redactedCyclic.self, "[Circular]");

  assert.equal(
    redactSecrets('{"AHUB_TOKEN":"__MISSING__","AWS_SECRET_ACCESS_KEY":"__MISSING__"}'),
    '{"AHUB_TOKEN":"__MISSING__","AWS_SECRET_ACCESS_KEY":"__MISSING__"}'
  );
});
