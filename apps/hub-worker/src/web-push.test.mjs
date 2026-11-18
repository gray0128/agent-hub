import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { toBase64Url, fromBase64Url } = await import("./webhook-crypto.ts");
const {
  createVapidAuthorizationHeader,
  encodePushPayload,
  encryptWebPushPayload,
  getVapidConfig,
  sendWebPushNotification,
  validatePushEndpointUrl,
  validateSubscriptionKeys
} = await import("./web-push.ts");

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

// Independent RFC 8291 / 8188 decryptor using raw HMAC-SHA-256 (deliberately avoids WebCrypto HKDF deriveBits).
async function independentDecryptAes128Gcm(frame, uaKeyPair, authBytes) {
  assert.ok(frame.length > 86, "encrypted frame must exceed 86-byte aes128gcm header");
  const salt = frame.slice(0, 16);
  const rs = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(16, false);
  assert.equal(rs, 4096);
  const idlen = frame[20];
  assert.equal(idlen, 65);
  const asPublicRaw = frame.slice(21, 86);
  assert.equal(asPublicRaw[0], 0x04);
  const ciphertext = frame.slice(86);

  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeyPair.publicKey));
  const asPublicKey = await crypto.subtle.importKey(
    "raw",
    asPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asPublicKey }, uaKeyPair.privateKey, 256)
  );

  // Step 1: PRK_key = HMAC(auth, ecdhSecret), IKM = HMAC(PRK_key, "WebPush: info\0" || uaPub || asPub || 0x01)
  const prkKey = await hmacSha256(authBytes, ecdhSecret);
  const keyInfo = concatBytes(
    encoder.encode("WebPush: info\0"),
    uaPublicRaw,
    asPublicRaw,
    new Uint8Array([0x01])
  );
  const ikm = await hmacSha256(prkKey, keyInfo);

  // Step 2: PRK = HMAC(salt, IKM), CEK = HMAC(PRK, "Content-Encoding: aes128gcm\0" || 0x01)[0..16], Nonce = ...[0..12]
  const prk = await hmacSha256(salt, ikm);
  const cekBlock = await hmacSha256(
    prk,
    concatBytes(encoder.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([0x01]))
  );
  const cek = cekBlock.slice(0, 16);
  const nonceBlock = await hmacSha256(
    prk,
    concatBytes(encoder.encode("Content-Encoding: nonce\0"), new Uint8Array([0x01]))
  );
  const nonce = nonceBlock.slice(0, 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext)
  );
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0x00) {
    end -= 1;
  }
  assert.ok(end > 0, "padded plaintext must contain delimiter");
  assert.equal(padded[end - 1], 0x02, "final record delimiter must be 0x02");
  return decoder.decode(padded.slice(0, end - 1));
}

async function generateVapidTestKeys() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKey = toBase64Url(pubRaw);
  return {
    keyPair,
    vapid: {
      publicKey,
      privateJwk: JSON.stringify(jwk),
      subject: "mailto:admin@bobocai.win"
    }
  };
}

async function generateUaSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/test-sub") {
  const uaKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeyPair.publicKey));
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    uaKeyPair,
    authBytes,
    subscription: {
      endpoint,
      keys: {
        p256dh: toBase64Url(uaPubRaw),
        auth: toBase64Url(authBytes)
      }
    }
  };
}

test("RFC 8291 aes128gcm encryption round-trips against independent raw-HMAC decryptor and validates keys", async () => {
  const { uaKeyPair, authBytes, subscription } = await generateUaSubscription();
  const payload = {
    v: 1,
    kind: "native_event",
    id: "evt_01TESTROUNDTRIP",
    tag: "ahub-native-evt_01TESTROUNDTRIP",
    urgent: true,
    title: "[macmini · claude] 需要人工确认",
    body: "请确认迁移脚本：中文 + 🚀🎉 + quotes \"ok\"",
    target_url: "/?pane=native&session=macmini:claude:s1&event=evt_01TESTROUNDTRIP",
    ts: "2026-11-18T08:00:00.000Z"
  };

  const encoded = encodePushPayload(payload);
  const frame = await encryptWebPushPayload(encoded, subscription.keys);
  const plaintextJson = await independentDecryptAes128Gcm(frame, uaKeyPair, authBytes);
  assert.deepEqual(JSON.parse(plaintextJson), payload);

  // Key validation negatives
  assert.throws(() => validateSubscriptionKeys({ p256dh: "AAAA", auth: subscription.keys.auth }), /65-byte/);
  const wrongPrefix = new Uint8Array(65);
  wrongPrefix[0] = 0x02;
  assert.throws(
    () => validateSubscriptionKeys({ p256dh: toBase64Url(wrongPrefix), auth: subscription.keys.auth }),
    /65-byte/
  );
  assert.throws(
    () => validateSubscriptionKeys({ p256dh: subscription.keys.p256dh, auth: toBase64Url(new Uint8Array(12)) }),
    /16 bytes/
  );
  // Off-curve 65-byte point starting with 0x04 should fail WebCrypto importKey during encryption
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  offCurve.fill(0xff, 1);
  await assert.rejects(
    () => encryptWebPushPayload(encoded, { p256dh: toBase64Url(offCurve), auth: subscription.keys.auth })
  );
});

test("RFC 8292 VAPID ES256 Authorization header signs valid JWT and rejects mismatched keys or TTL > 12h", async () => {
  const { keyPair, vapid } = await generateVapidTestKeys();
  const nowMs = Date.UTC(2026, 10, 18, 8, 0, 0);
  const endpointUrl = new URL("https://web.push.apple.com/QB12345");
  const authHeader = await createVapidAuthorizationHeader(endpointUrl, vapid, {
    nowMs,
    ttlSeconds: 12 * 3600
  });

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
  assert.ok(match, "Authorization header must follow vapid t=<jwt>, k=<pub>");
  assert.equal(match[2], vapid.publicKey);

  const jwtParts = match[1].split(".");
  assert.equal(jwtParts.length, 3);
  const header = JSON.parse(decoder.decode(fromBase64Url(jwtParts[0])));
  const claims = JSON.parse(decoder.decode(fromBase64Url(jwtParts[1])));
  const sigBytes = fromBase64Url(jwtParts[2]);

  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "mailto:admin@bobocai.win");
  assert.equal(claims.exp - Math.floor(nowMs / 1000), 12 * 3600);
  assert.equal(sigBytes.length, 64);

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    sigBytes,
    encoder.encode(`${jwtParts[0]}.${jwtParts[1]}`)
  );
  assert.equal(verified, true);

  // Mismatched keypair rejected
  const other = await generateVapidTestKeys();
  await assert.rejects(
    () =>
      createVapidAuthorizationHeader(endpointUrl, {
        ...vapid,
        publicKey: other.vapid.publicKey
      }),
    /does not match/
  );

  // TTL > 12h rejected
  await assert.rejects(
    () => createVapidAuthorizationHeader(endpointUrl, vapid, { ttlSeconds: 12 * 3600 + 1 }),
    /ttlSeconds/
  );

  assert.deepEqual(getVapidConfig({}), { enabled: false, reason: "VAPID_NOT_CONFIGURED" });
  assert.equal(
    getVapidConfig({
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_JWK: vapid.privateJwk,
      VAPID_SUBJECT: vapid.subject
    }).enabled,
    true
  );
});

test("encodePushPayload enforces <= 3072 UTF-8 bytes without splitting CJK or emoji surrogate pairs", () => {
  const cases = [
    { name: "ascii", body: "a".repeat(5000), title: "Long ASCII" },
    { name: "cjk", body: "中".repeat(2000), title: "中文通知" },
    { name: "emoji", body: "🚀🎉🔥".repeat(400), title: "Emoji boundary 🚀" },
    { name: "escaped", body: 'line1\n"quote"\\slash '.repeat(400), title: 'Title "quote"\n' },
    { name: "giant-title", body: "short", title: "🔥标题".repeat(1500) }
  ];

  for (const c of cases) {
    const encoded = encodePushPayload({
      v: 1,
      kind: "run",
      id: "run_01CAPTEST",
      tag: "ahub-run-run_01CAPTEST",
      urgent: true,
      title: c.title,
      body: c.body,
      target_url: "/?run=run_01CAPTEST",
      ts: "2026-11-18T08:00:00.000Z"
    });
    assert.ok(encoded.length <= 3072, `${c.name} exceeded 3072 bytes (${encoded.length})`);
    const text = decoder.decode(encoded);
    const parsed = JSON.parse(text);
    assert.equal(parsed.body.isWellFormed() && !parsed.body.includes("\uFFFD"), true, `${c.name} body has lone surrogate`);
    assert.equal(parsed.title.isWellFormed() && !parsed.title.includes("\uFFFD"), true, `${c.name} title has lone surrogate`);
  }
});

test("validatePushEndpointUrl enforces vendor SSRF allowlist and explicit loopback test flag", () => {
  const allowedProd = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QB123",
    "https://api.sandbox.push.apple.com/3/device/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-bl2p.notify.windows.com/?token=abc"
  ];
  for (const url of allowedProd) {
    assert.equal(validatePushEndpointUrl(url, false).toString(), url);
  }

  const rejectedProd = [
    "",
    "http://127.0.0.1:8787/push",
    "http://localhost:8787/push",
    "https://127.0.0.1/push",
    "https://localhost/push",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://10.0.0.1/push",
    "https://169.254.169.254/latest",
    "https://[::1]/push",
    "https://fcm.googleapis.com.evil.com/fcm/send/abc",
    "https://push.apple.com/direct",
    "https://evilpush.apple.com/direct",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "javascript:alert(1)"
  ];
  for (const url of rejectedProd) {
    assert.throws(() => validatePushEndpointUrl(url, false), Error, `expected reject in prod for ${url}`);
  }

  assert.equal(
    validatePushEndpointUrl("http://127.0.0.1:41234/push", true).toString(),
    "http://127.0.0.1:41234/push"
  );
  assert.equal(
    validatePushEndpointUrl("http://localhost:41234/push", true).toString(),
    "http://localhost:41234/push"
  );
  for (const url of ["http://10.0.0.1/push", "https://evil.com/push", "http://localhost.evil.com/push"]) {
    assert.throws(() => validatePushEndpointUrl(url, true), Error, `expected reject even in loopback mode: ${url}`);
  }
});

test("sendWebPushNotification delivers encrypted frames over local HTTP gateway and classifies all HTTP outcomes", async (t) => {
  const { keyPair, vapid } = await generateVapidTestKeys();
  let mode = { status: 201, delayMs: 0, redirectTo: null };
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyBytes = new Uint8Array(Buffer.concat(chunks));
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyBytes
      });
      const sendReply = () => {
        if (mode.redirectTo) {
          res.writeHead(mode.status, { Location: mode.redirectTo });
          res.end("redirect");
          return;
        }
        res.writeHead(mode.status, { "Content-Type": "text/plain" });
        res.end(`status-${mode.status}`);
      };
      if (mode.delayMs > 0) {
        setTimeout(sendReply, mode.delayMs);
      } else {
        sendReply();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/push/sub-1`;
  const { uaKeyPair, authBytes, subscription } = await generateUaSubscription(endpoint);
  const payload = {
    v: 1,
    kind: "run",
    id: "run_01GATEWAY",
    tag: "ahub-run-run_01GATEWAY",
    urgent: true,
    title: "[macmini] 需要人工审批",
    body: "确认执行下一步",
    target_url: "/?run=run_01GATEWAY",
    ts: "2026-11-18T08:00:00.000Z"
  };

  // 201 Created -> sent + decryptable + valid VAPID JWT
  mode = { status: 201, delayMs: 0, redirectTo: null };
  const sentRes = await sendWebPushNotification({
    subscription,
    payload,
    vapid,
    allowLoopbackForTest: true
  });
  assert.equal(sentRes.ok, true);
  assert.equal(sentRes.outcome, "sent");
  assert.equal(sentRes.httpStatus, 201);
  assert.equal(sentRes.retryable, false);
  assert.equal(sentRes.revokeSubscription, false);

  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-encoding"], "aes128gcm");
  assert.equal(req.headers["content-type"], "application/octet-stream");
  assert.equal(req.headers.ttl, "86400");
  assert.equal(req.headers.urgency, "high");

  const vapidMatch = /^vapid t=([^,]+), k=(.+)$/.exec(String(req.headers.authorization));
  assert.ok(vapidMatch);
  assert.equal(vapidMatch[2], vapid.publicKey);
  const [h, p, s] = vapidMatch[1].split(".");
  assert.equal(JSON.parse(decoder.decode(fromBase64Url(p))).aud, `http://127.0.0.1:${port}`);
  const sigValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    fromBase64Url(s),
    encoder.encode(`${h}.${p}`)
  );
  assert.equal(sigValid, true);
  const decrypted = JSON.parse(await independentDecryptAes128Gcm(req.bodyBytes, uaKeyPair, authBytes));
  assert.deepEqual(decrypted, payload);

  // 404 / 410 -> expired + revokeSubscription + no retry
  for (const status of [404, 410]) {
    mode = { status, delayMs: 0, redirectTo: null };
    const res = await sendWebPushNotification({ subscription, payload, vapid, allowLoopbackForTest: true });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "expired");
    assert.equal(res.revokeSubscription, true);
    assert.equal(res.retryable, false);
    assert.equal(res.httpStatus, status);
    assert.equal(res.errorCode, "SUBSCRIPTION_EXPIRED");
  }

  // 400 / 401 / 403 / 413 -> rejected + no retry + no revoke
  for (const status of [400, 401, 403, 413]) {
    mode = { status, delayMs: 0, redirectTo: null };
    const res = await sendWebPushNotification({ subscription, payload, vapid, allowLoopbackForTest: true });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "rejected");
    assert.equal(res.revokeSubscription, false);
    assert.equal(res.retryable, false);
    assert.equal(res.httpStatus, status);
    assert.equal(res.errorCode, `PUSH_REJECTED_${status}`);
  }

  // 302 redirect -> NOT followed (redirect: "manual") and classified as rejected
  const beforeRedirectCount = requests.length;
  mode = { status: 302, delayMs: 0, redirectTo: `http://127.0.0.1:${port}/should-not-follow` };
  const redirectRes = await sendWebPushNotification({ subscription, payload, vapid, allowLoopbackForTest: true });
  assert.equal(redirectRes.ok, false);
  assert.equal(redirectRes.outcome, "rejected");
  assert.equal(redirectRes.retryable, false);
  assert.equal(redirectRes.httpStatus, 302);
  assert.equal(redirectRes.errorCode, "PUSH_REJECTED_302");
  assert.equal(requests.length, beforeRedirectCount + 1);

  // 429 / 500 / 503 -> retryable
  for (const status of [429, 500, 503]) {
    mode = { status, delayMs: 0, redirectTo: null };
    const res = await sendWebPushNotification({ subscription, payload, vapid, allowLoopbackForTest: true });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, "retry");
    assert.equal(res.retryable, true);
    assert.equal(res.revokeSubscription, false);
    assert.equal(res.httpStatus, status);
    assert.equal(res.errorCode, "PUSH_UPSTREAM_TIMEOUT");
  }

  // Request timeout -> retryable PUSH_UPSTREAM_TIMEOUT with httpStatus: null
  mode = { status: 201, delayMs: 150, redirectTo: null };
  const timeoutRes = await sendWebPushNotification({
    subscription,
    payload,
    vapid,
    allowLoopbackForTest: true,
    timeoutMs: 30
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.outcome, "retry");
  assert.equal(timeoutRes.retryable, true);
  assert.equal(timeoutRes.httpStatus, null);
  assert.equal(timeoutRes.errorCode, "PUSH_UPSTREAM_TIMEOUT");
});

test("validateVapidSubject rejects degenerate mailto addresses and encryptWebPushPayload rejects >4079B plaintext", async () => {
  const { vapid } = await generateVapidTestKeys();
  const uaKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits"
  ]);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeyPair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const keys = { p256dh: toBase64Url(uaPub), auth: toBase64Url(auth) };

  for (const badSub of ["mailto:@", "mailto:a@", "mailto:@b", "mailto:admin@bad space.com", "mailto:user@.dot.com"]) {
    await assert.rejects(
      () =>
        createVapidAuthorizationHeader(new URL("https://fcm.googleapis.com/fcm/send/sub1"), {
          publicKey: vapid.publicKey,
          privateJwk: vapid.privateJwk,
          subject: badSub
        }),
      /VAPID_SUBJECT/
    );
  }

  await assert.rejects(
    () => encryptWebPushPayload(new Uint8Array(4080), keys),
    /4079/
  );
  const okFrame = await encryptWebPushPayload(new Uint8Array(4079), keys);
  assert.ok(okFrame.length > 86);
});
