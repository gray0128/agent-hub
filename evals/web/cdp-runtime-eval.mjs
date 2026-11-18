#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workerDir = path.join(repoRoot, "apps", "hub-worker");
const ahubBin = path.join(repoRoot, "bin", "ahub");
const fakeAgentBin = path.join(repoRoot, "bin", "ahub-fakeagent");
const screenshotDir = path.join(repoRoot, "evals", "artifacts", "screenshots");

const chromeCandidates = [
  process.env.AHUB_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);

const chromeBin = chromeCandidates.find((p) => fs.existsSync(p));
if (!chromeBin) {
  console.error("Chrome binary not found for CDP runtime eval");
  process.exit(1);
}
if (!fs.existsSync(ahubBin) || !fs.existsSync(fakeAgentBin)) {
  console.error("Missing bin/ahub or bin/ahub-fakeagent (run make build-go build-fakeagent)");
  process.exit(1);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killGroup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function waitForHttp(url, headers = {}, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.eventHandlers.has(msg.method)) {
        for (const fn of this.eventHandlers.get(msg.method)) {
          fn(msg.params);
        }
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const type = msg.params?.type;
        if (type === "error") {
          const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
          this.consoleErrors.push(text);
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        const details = msg.params?.exceptionDetails;
        this.exceptions.push(details?.exception?.description ?? details?.text ?? "Unknown exception");
      }
    });
  }

  onEvent(method, handler) {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  async connect() {
    await this.opened;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJS(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "Eval error"
      );
    }
    return res.result?.value;
  }

  async getCenter(selector) {
    const box = await this.evalJS(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);
    if (!box) throw new Error(`Element not clickable or invisible: ${selector}`);
    return box;
  }

  async clickSelector(selector) {
    const { x, y } = await this.getCenter(selector);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      clickCount: 0
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1
    });
  }

  async dragBetween(fromSelector, toSelector) {
    const from = await this.getCenter(fromSelector);
    const to = await this.getCenter(toSelector);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
      button: "none"
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      clickCount: 1
    });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1
      });
      await sleep(25);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      clickCount: 1
    });
  }

  async fillInput(selector, text) {
    await this.clickSelector(selector);
    await this.evalJS(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await this.send("Input.insertText", { text });
    await sleep(100);
  }

  async typeAndPressEnter(selector, text) {
    await this.clickSelector(selector);
    await this.evalJS(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await this.send("Input.insertText", { text });
    await sleep(150);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  }

  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile
    });
  }

  async screenshot(outPath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(res.data, "base64"));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function apiJson(hubUrl, token, reqPath, init = {}) {
  const res = await fetch(`${hubUrl}${reqPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${reqPath} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

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
  const key = await crypto.webcrypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.webcrypto.subtle.sign("HMAC", key, dataBytes));
}

async function decryptAes128GcmFrame(frame, uaKeyPair, authBytes) {
  if (frame.length <= 86) {
    throw new Error(`Push frame too short: ${frame.length}`);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const salt = frame.slice(0, 16);
  const asPublicRaw = frame.slice(21, 86);
  const ciphertext = frame.slice(86);

  const uaPublicRaw = new Uint8Array(
    await crypto.webcrypto.subtle.exportKey("raw", uaKeyPair.publicKey)
  );
  const asPublicKey = await crypto.webcrypto.subtle.importKey(
    "raw",
    asPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.webcrypto.subtle.deriveBits(
      { name: "ECDH", public: asPublicKey },
      uaKeyPair.privateKey,
      256
    )
  );
  const prkKey = await hmacSha256(authBytes, ecdhSecret);
  const ikm = await hmacSha256(
    prkKey,
    concatBytes(encoder.encode("WebPush: info\0"), uaPublicRaw, asPublicRaw, new Uint8Array([0x01]))
  );
  const prk = await hmacSha256(salt, ikm);
  const cek = (
    await hmacSha256(
      prk,
      concatBytes(encoder.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([0x01]))
    )
  ).slice(0, 16);
  const nonce = (
    await hmacSha256(
      prk,
      concatBytes(encoder.encode("Content-Encoding: nonce\0"), new Uint8Array([0x01]))
    )
  ).slice(0, 12);

  const cekKey = await crypto.webcrypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const padded = new Uint8Array(
    await crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext)
  );
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0x00) {
    end -= 1;
  }
  if (end === 0 || padded[end - 1] !== 0x02) {
    throw new Error("Invalid RFC 8291 padding delimiter");
  }
  return JSON.parse(decoder.decode(padded.slice(0, end - 1)));
}

async function createVapidMaterial() {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = JSON.stringify(await crypto.webcrypto.subtle.exportKey("jwk", keyPair.privateKey));
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.webcrypto.subtle.exportKey("raw", keyPair.publicKey))
  );
  return {
    keyPair,
    publicKey,
    privateJwk,
    subject: "mailto:ops@bobocai.win"
  };
}

async function createUaSubscriptionMaterial() {
  const uaKeyPair = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const uaPubRaw = new Uint8Array(
    await crypto.webcrypto.subtle.exportKey("raw", uaKeyPair.publicKey)
  );
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    uaKeyPair,
    authBytes,
    p256dh: toBase64Url(uaPubRaw),
    auth: toBase64Url(authBytes)
  };
}

async function createMockPushGateway(vapidMaterial, uaMaterial) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests = [];
  const state = { statusOverride: 201 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const bodyBytes = new Uint8Array(Buffer.concat(chunks));
      const status = state.statusOverride;
      let vapidVerified = false;
      let payload = null;
      let error = null;

      try {
        const authHeader = String(req.headers.authorization || "");
        const match = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
        if (match && match[2] === vapidMaterial.publicKey) {
          const [h, p, s] = match[1].split(".");
          const claims = JSON.parse(Buffer.from(fromBase64Url(p)).toString("utf8"));
          if (claims.aud === baseUrl) {
            vapidVerified = await crypto.webcrypto.subtle.verify(
              { name: "ECDSA", hash: "SHA-256" },
              vapidMaterial.keyPair.publicKey,
              fromBase64Url(s),
              new TextEncoder().encode(`${h}.${p}`)
            );
          }
        }
        payload = await decryptAes128GcmFrame(
          bodyBytes,
          uaMaterial.uaKeyPair,
          uaMaterial.authBytes
        );
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      requests.push({
        method: req.method,
        url: req.url,
        status,
        vapidVerified,
        payload,
        error
      });

      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(`mock-push-${status}`);
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, baseUrl, port, requests, state };
}

function buildEvalInitScript(mockPushEndpoint, p256dh, auth) {
  return `
    window.__AHUB_CLS__ = 0;
    window.__AHUB_CLS_SOURCES__ = [];
    window.__AHUB_CAPTURED_NOTIFS__ = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__AHUB_CLS__ += entry.value;
          window.__AHUB_CLS_SOURCES__.push({
            value: entry.value,
            nodes: (entry.sources || []).map(s => s.node ? (s.node.tagName + '#' + s.node.id + '.' + (s.node.className || '')) : 'null')
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });

    (() => {
      const OrigNotif = window.Notification;
      if (typeof OrigNotif === "function") {
        const WrappedNotif = function(title, options) {
          window.__AHUB_CAPTURED_NOTIFS__.push({
            title: String(title || ""),
            body: String(options?.body || ""),
            tag: String(options?.tag || ""),
            ts: Date.now()
          });
          return new OrigNotif(title, options);
        };
        WrappedNotif.prototype = OrigNotif.prototype;
        Object.defineProperty(WrappedNotif, "permission", {
          get() { return OrigNotif.permission; }
        });
        WrappedNotif.requestPermission = (...args) => OrigNotif.requestPermission(...args);
        window.Notification = WrappedNotif;
      }

      const MOCK_KEY = "__ahub_eval_mock_push_active__";
      function makeMockSub() {
        const endpoint = ${JSON.stringify(mockPushEndpoint)};
        const p256dhB64 = ${JSON.stringify(p256dh)};
        const authB64 = ${JSON.stringify(auth)};
        function b64uToBuf(str) {
          const pad = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
          const bin = atob(pad);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
          return arr.buffer;
        }
        return {
          endpoint,
          expirationTime: null,
          getKey(name) {
            if (name === "p256dh") return b64uToBuf(p256dhB64);
            if (name === "auth") return b64uToBuf(authB64);
            return null;
          },
          toJSON() {
            return { endpoint, expirationTime: null, keys: { p256dh: p256dhB64, auth: authB64 } };
          },
          async unsubscribe() {
            localStorage.removeItem(MOCK_KEY);
            return true;
          }
        };
      }

      if (typeof window.PushManager === "function" && window.PushManager.prototype) {
        window.PushManager.prototype.getSubscription = async function() {
          return localStorage.getItem(MOCK_KEY) === "1" ? makeMockSub() : null;
        };
        window.PushManager.prototype.subscribe = async function() {
          localStorage.setItem(MOCK_KEY, "1");
          return makeMockSub();
        };
      }
    })();
  `;
}

async function createAccessTestServer(expectedAud) {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const pubJwk = await crypto.webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwksPayload = JSON.stringify({
    keys: [{ ...pubJwk, kid: "cdp-eval-kid-1", use: "sig", alg: "RS256" }]
  });
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jwksPayload);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const nowSec = Math.floor(Date.now() / 1000);
  const headerB64 = toBase64Url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "cdp-eval-kid-1" })
  );
  const payloadB64 = toBase64Url(
    JSON.stringify({
      aud: [expectedAud],
      exp: nowSec + 600,
      nbf: nowSec - 10,
      iss: `http://127.0.0.1:${port}`,
      sub: "cdp-eval-user"
    })
  );
  const signature = await crypto.webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  return {
    server,
    teamDomain: `http://127.0.0.1:${port}`,
    accessJwt: `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(signature))}`
  };
}

async function assertViewportContainment(cdp, label) {
  const metrics = await cdp.evalJS(`
    (() => {
      const de = document.documentElement;
      const b = document.body;
      const root = document.getElementById("root");
      const vOverflow = de.scrollHeight - de.clientHeight;
      const hOverflow = de.scrollWidth - de.clientWidth;
      const bodyVOverflow = b.scrollHeight - b.clientHeight;
      const escaped = [];
      if (root) {
        for (const el of root.querySelectorAll("*")) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.getClientRects().length === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.position !== "absolute") continue;
          const op = el.offsetParent;
          if (!op || !root.contains(op)) {
            escaped.push({
              tag: el.tagName,
              cls: el.className,
              role: el.getAttribute("role"),
              offsetParent: op ? op.tagName : null
            });
          }
        }
      }
      return { vOverflow, hOverflow, bodyVOverflow, escaped };
    })()
  `);
  if (
    metrics.vOverflow > 0 ||
    metrics.hOverflow > 0 ||
    metrics.bodyVOverflow > 0 ||
    metrics.escaped.length > 0
  ) {
    throw new Error(
      `Viewport containment failed (${label}): vOverflow=${metrics.vOverflow}px hOverflow=${metrics.hOverflow}px bodyVOverflow=${metrics.bodyVOverflow}px escaped=${JSON.stringify(metrics.escaped.slice(0, 5))}`
    );
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahub-cdp-eval-"));
const children = [];
let cdpClient = null;
let cdpTab2 = null;
let jwksServer = null;
let mockPushGateway = null;

try {
  fs.mkdirSync(screenshotDir, { recursive: true });
  // Remove any legacy 01-*..05-* filenames so screenshot dir matches spec cleanly
  for (const name of fs.readdirSync(screenshotDir)) {
    if (/^0\d-.*\.png$/.test(name)) {
      fs.unlinkSync(path.join(screenshotDir, name));
    }
  }

  const d1Dir = path.join(tmpDir, "d1");
  const cfgDir = path.join(tmpDir, "ahub-cfg");
  const chromeProfileDir = path.join(tmpDir, "chrome-profile");
  const wsAlpha = path.join(tmpDir, "workspaces", "repo-alpha");
  const wsBeta = path.join(tmpDir, "workspaces", "repo-beta");
  const wsMbp = path.join(tmpDir, "workspaces-mbp", "repo-web");
  for (const dir of [d1Dir, cfgDir, chromeProfileDir, wsAlpha, wsBeta, wsMbp]) {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    if (dir.includes("workspaces")) {
      fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
  }

  const adminToken = "ahub_adm_cdp_eval_bootstrap_token_9988";
  const adminSha = crypto.createHash("sha256").update(adminToken).digest("hex");

  execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", d1Dir],
    { cwd: workerDir, env: { ...process.env, CI: "1" }, stdio: "pipe" }
  );

  const hubPort = await getFreePort();
  const cdpPort = await getFreePort();
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const accessAud = "cdp-eval-access-aud";
  const accessMaterial = await createAccessTestServer(accessAud);
  jwksServer = accessMaterial.server;
  const vapidMaterial = await createVapidMaterial();
  const uaMaterial = await createUaSubscriptionMaterial();
  mockPushGateway = await createMockPushGateway(vapidMaterial, uaMaterial);
  const mockPushEndpoint = `${mockPushGateway.baseUrl}/push/cdp-device-1`;

  const wranglerProc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(hubPort),
      "--inspector-port",
      "0",
      "--persist-to",
      d1Dir,
      "--show-interactive-dev-session=false",
      "--var",
      `BOOTSTRAP_ADMIN_TOKEN_SHA256:${adminSha}`,
      "--var",
      `HUB_PUBLIC_URL:${hubUrl}`,
      "--var",
      `CF_ACCESS_TEAM_DOMAIN:${accessMaterial.teamDomain}`,
      "--var",
      `CF_ACCESS_AUD:${accessAud}`,
      "--var",
      "LEASE_TTL_SECONDS:30",
      "--var",
      "WEBHOOK_ENCRYPTION_KEY:cdp-eval-master-secret-32bytes!!",
      "--var",
      `VAPID_PUBLIC_KEY:${vapidMaterial.publicKey}`,
      "--var",
      `VAPID_PRIVATE_JWK:${vapidMaterial.privateJwk}`,
      "--var",
      `VAPID_SUBJECT:${vapidMaterial.subject}`,
      "--var",
      "ALLOW_LOOPBACK_PUSH_FOR_TEST:true"
    ],
    {
      cwd: workerDir,
      env: { ...process.env, CI: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  children.push(wranglerProc);

  await waitForHttp(`${hubUrl}/api/v1/nodes`, { Authorization: `Bearer ${adminToken}` }, 25000);

  const macKey = await apiJson(hubUrl, adminToken, "/api/v1/keys", {
    method: "POST",
    body: JSON.stringify({ name: "node-macmini", scope: "node", bound_node_id: "macmini" })
  });
  const mbpKey = await apiJson(hubUrl, adminToken, "/api/v1/keys", {
    method: "POST",
    body: JSON.stringify({ name: "node-mbp", scope: "node", bound_node_id: "mbp" })
  });

  const tmpCodexHome = path.join(tmpDir, "codex-home");
  fs.mkdirSync(tmpCodexHome, { recursive: true });
  fs.writeFileSync(
    path.join(tmpCodexHome, "config.toml"),
    'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n'
  );
  fs.writeFileSync(
    path.join(tmpCodexHome, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
            { effort: "max" },
            { effort: "ultra" }
          ]
        },
        {
          slug: "codex-internal-hidden",
          display_name: "Hidden Model",
          visibility: "hide",
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }]
        }
      ]
    })
  );

  function startNodeDaemon(nodeId, token, rootPath, maxConcurrency, agents, extraEnv = {}) {
    const cfgPath = path.join(tmpDir, `node-${nodeId}.json`);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        node_id: nodeId,
        display_name: nodeId,
        hub_url: hubUrl,
        token,
        max_concurrency: maxConcurrency,
        heartbeat_interval_sec: 1,
        project_roots: [rootPath],
        skip_dirs: ["node_modules", ".git"],
        agents
      })
    );
    const proc = spawn(ahubBin, ["node", "serve", "--config", cfgPath], {
      env: { ...process.env, AHUB_CONFIG_DIR: cfgDir, ...extraEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(proc);
  }

  startNodeDaemon(
    "macmini",
    macKey.token,
    path.join(tmpDir, "workspaces"),
    1,
    {
      agy: { enabled: true, command: fakeAgentBin },
      codex: { enabled: true, command: fakeAgentBin }
    },
    { CODEX_HOME: tmpCodexHome }
  );
  startNodeDaemon("mbp", mbpKey.token, path.join(tmpDir, "workspaces-mbp"), 2, {
    pi: { enabled: true, command: fakeAgentBin },
    omp: { enabled: true, command: fakeAgentBin }
  });

  for (let i = 0; i < 40; i++) {
    const res = await apiJson(hubUrl, adminToken, "/api/v1/nodes");
    const byId = Object.fromEntries(res.nodes.map((n) => [n.id, n]));
    const macReady =
      byId.macmini?.status === "online" &&
      byId.macmini?.capabilities?.agents?.agy?.catalog_status === "ready" &&
      byId.macmini?.capabilities?.agents?.codex?.catalog_status === "ready";
    const mbpReady =
      byId.mbp?.status === "online" &&
      byId.mbp?.capabilities?.agents?.pi?.catalog_status === "ready" &&
      byId.mbp?.capabilities?.agents?.omp?.catalog_status === "ready";
    if (macReady && mbpReady) break;
    if (i === 39) throw new Error(`Nodes failed to come online with ready catalogs: ${JSON.stringify(res.nodes)}`);
    await sleep(250);
  }

  async function waitForSeedRunDone(runId, label) {
    for (let i = 0; i < 40; i++) {
      const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${runId}`);
      if (r.run.status === "done") return r.run;
      if (r.run.status === "failed" || r.run.status === "cancelled") {
        throw new Error(`${label} terminated unexpectedly: ${JSON.stringify(r.run)}`);
      }
      await sleep(200);
    }
    throw new Error(`${label} did not finish in time`);
  }

  // Seed thread 1 on macmini (events + Markdown output)
  const doneRunRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      title: "D1 与 WebSocket 压测线程",
      prompt: JSON.stringify({
        summary: "已完成 40 条基线事件与契约校验",
        response:
          "## 巡检结论\n\n" +
          "- 工作区索引与分支状态一致\n" +
          "- 环形事件缓冲限制生效 (`<= 500`)\n" +
          "- REST 补水与流式增量同步完整\n\n" +
          "| 节点 ID | 目标目录 | 运行状态 | 平均延迟 | 产物字节 | 校验结果 |\n" +
          "| --- | --- | --- | --- | --- | --- |\n" +
          "| macmini | /workspace/repo-alpha | online | 18ms | 4096 B | PASS |\n" +
          "| mbp | /workspace/repo-web | online | 24ms | 2048 B | PASS |",
        directives: [{ op: "emit_ndjson", count: 40, kind: "tool_use" }]
      })
    })
  });
  const doneRunId = doneRunRes.run.id;
  await waitForSeedRunDone(doneRunId, "Seeded done run");

  // Seed thread 2 on mbp
  const thread2Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      title: "前端视觉与主题基准",
      prompt: JSON.stringify({
        summary: "完成 radix-nova 浅色/深色 Token 校验",
        response: "前端构建产物已就绪，WebSocket 实时流在线。",
        directives: [{ op: "emit_ndjson", count: 3, kind: "status" }]
      })
    })
  });
  await waitForSeedRunDone(thread2Res.run.id, "Seed thread 2");

  // Seed thread 3 on mbp: 4-turn regression thread (>16KB multi-turn hydration, long-output collapse, >128KB explicit truncation)
  const h1Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      title: "多轮长报告水合回归线程",
      prompt: JSON.stringify({
        summary: "1. 第一轮末尾总结行",
        response:
          "## 第一轮核心结论\n\n" +
          "- 链路延迟基线稳定 (`120ms`)\n".repeat(650) +
          "\n1. 第一轮末尾总结行",
        directives: [{ op: "sleep", ms: 5 }]
      })
    })
  });
  const h1Done = await waitForSeedRunDone(h1Res.run.id, "Hydration turn 1");
  const hydrationThreadId = h1Done.thread_id;

  const h2Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      thread_id: hydrationThreadId,
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      prompt: JSON.stringify({
        summary: "2. 第二轮末尾总结行",
        response:
          "## 第二轮核心结论\n\n" +
          "- 双跳对照采样数据完整\n".repeat(600) +
          "\n2. 第二轮末尾总结行",
        directives: [{ op: "sleep", ms: 5 }]
      })
    })
  });
  const h2Done = await waitForSeedRunDone(h2Res.run.id, "Hydration turn 2");

  const h3Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      thread_id: hydrationThreadId,
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      prompt: JSON.stringify({
        summary: "3. 第三轮末尾总结行",
        response:
          "## 第三轮核心结论\n\n" +
          "- 晚高峰基线对照组验证通过\n".repeat(180) +
          "\n3. 第三轮末尾总结行",
        directives: [{ op: "sleep", ms: 5 }]
      })
    })
  });
  const h3Done = await waitForSeedRunDone(h3Res.run.id, "Hydration turn 3");

  const h4Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      thread_id: hydrationThreadId,
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      prompt: JSON.stringify({
        summary: "4. 超大产物末行摘要",
        directives: [{ op: "big_output", bytes: 140000 }]
      })
    })
  });
  const h4Done = await waitForSeedRunDone(h4Res.run.id, "Hydration turn 4");

  const chromeProc = spawn(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${chromeProfileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      "--window-size=1440,900",
      "about:blank"
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(chromeProc);

  await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, {}, 15000);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === "page") ?? targets[0];
  cdpClient = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdpClient.connect();
  await cdpClient.setViewport(1440, 900, false);

  let swRegistrationId = null;
  cdpClient.onEvent("ServiceWorker.workerRegistrationUpdated", (params) => {
    for (const reg of params?.registrations ?? []) {
      if (!reg.isDeleted && typeof reg.scopeURL === "string" && reg.scopeURL.startsWith(hubUrl)) {
        swRegistrationId = reg.registrationId;
      }
    }
  });
  await cdpClient.send("ServiceWorker.enable");
  await cdpClient.send("Browser.grantPermissions", {
    origin: hubUrl,
    permissions: ["notifications"]
  });

  const evalInitScript = buildEvalInitScript(
    mockPushEndpoint,
    uaMaterial.p256dh,
    uaMaterial.auth
  );
  await cdpClient.send("Page.addScriptToEvaluateOnNewDocument", {
    source: evalInitScript
  });

  await cdpClient.send("Page.navigate", { url: `${hubUrl}/?token=${adminToken}` });

  let state = null;
  for (let i = 0; i < 40; i++) {
    state = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__?.getState();
        if (!s || s.nodes.length < 2 || s.threads.length < 2 || s.streamStatus !== "connected") return null;
        return s;
      })()
    `);
    if (state) break;
    await sleep(250);
  }
  if (!state) throw new Error("UI did not hydrate and connect WebSocket in time");

  // Verify 4-turn regression thread: multi-turn >16KB full hydration without self-cancellation, long-output fold/expand, and >128KB explicit truncation
  if (state.selectedThreadId !== hydrationThreadId) {
    await cdpClient.clickSelector(`[data-testid="thread-item-${hydrationThreadId}"] button:nth-of-type(2)`);
    await sleep(200);
  }
  const expectedFullHydration = [
    { id: h1Done.id, bytes: h1Done.output_bytes, heading: "第一轮核心结论" },
    { id: h2Done.id, bytes: h2Done.output_bytes, heading: "第二轮核心结论" },
    { id: h3Done.id, bytes: h3Done.output_bytes, heading: "第三轮核心结论" }
  ];
  let hydrationReady = false;
  let lastHydrationDbg = null;
  for (let i = 0; i < 30; i++) {
    const check = await cdpClient.evalJS(`
      (() => {
        const enc = new TextEncoder();
        const runs = window.__AHUB_EVAL__.getState().runs;
        const expected = ${JSON.stringify(expectedFullHydration)};
        const fullChecks = expected.map((item) => {
          const r = runs.find((x) => x.id === item.id);
          const md = r?.output_md ?? "";
          const mdBytes = enc.encode(md).length;
          const domText = document.querySelector('[data-testid="run-row-' + item.id + '"] .ahub-markdown')?.textContent ?? "";
          return {
            id: item.id,
            expectedBytes: item.bytes,
            mdBytes,
            hasHeading: domText.includes(item.heading),
            domHead: domText.slice(0, 60)
          };
        });
        const h4 = runs.find((x) => x.id === ${JSON.stringify(h4Done.id)});
        const h4PreviewBytes = enc.encode(h4?.output_preview ?? "").length;
        const hasTruncNotice = Boolean(document.querySelector('[data-testid="run-truncated-notice-${h4Done.id}"]'));
        const hasLoadBtn = Boolean(document.querySelector('[data-testid="load-full-output-${h4Done.id}"]'));
        const ok =
          fullChecks.every((c) => c.mdBytes === c.expectedBytes && c.hasHeading) &&
          h4?.truncated === true &&
          !h4?.output_md &&
          h4PreviewBytes === 16384 &&
          hasTruncNotice &&
          hasLoadBtn;
        return { ok, fullChecks, h4Status: { truncated: h4?.truncated, previewBytes: h4PreviewBytes, hasMd: Boolean(h4?.output_md), hasTruncNotice, hasLoadBtn } };
      })()
    `);
    lastHydrationDbg = check;
    if (check.ok) {
      hydrationReady = true;
      break;
    }
    await sleep(200);
  }
  if (!hydrationReady) {
    throw new Error(`Multi-turn hydration regression check failed: ${JSON.stringify(lastHydrationDbg)}`);
  }

  const toggleBtnSel = `[data-testid="toggle-output-${h1Done.id}"]`;
  const toggleBefore = await cdpClient.evalJS(`document.querySelector(${JSON.stringify(toggleBtnSel)})?.textContent?.trim() ?? ""`);
  if (!toggleBefore.includes("展开全文")) {
    throw new Error(`Expected collapsed long-output toggle button for ${h1Done.id}, got ${JSON.stringify(toggleBefore)}`);
  }
  await cdpClient.clickSelector(toggleBtnSel);
  await sleep(150);
  const toggleAfter = await cdpClient.evalJS(`document.querySelector(${JSON.stringify(toggleBtnSel)})?.textContent?.trim() ?? ""`);
  if (!toggleAfter.includes("收起长输出")) {
    throw new Error(`Expected expanded toggle label '收起长输出' after click, got ${JSON.stringify(toggleAfter)}`);
  }

  await cdpClient.clickSelector(`[data-testid="load-full-output-${h4Done.id}"]`);
  let h4FullLoaded = false;
  for (let i = 0; i < 25; i++) {
    const h4FullCheck = await cdpClient.evalJS(`
      (() => {
        const enc = new TextEncoder();
        const r = window.__AHUB_EVAL__.getState().runs.find((x) => x.id === ${JSON.stringify(h4Done.id)});
        const mdBytes = enc.encode(r?.output_md ?? "").length;
        const noticeGone = !document.querySelector('[data-testid="run-truncated-notice-${h4Done.id}"]');
        return { mdBytes, truncated: r?.truncated, noticeGone };
      })()
    `);
    if (h4FullCheck.mdBytes === h4Done.output_bytes && h4FullCheck.truncated === false && h4FullCheck.noticeGone) {
      h4FullLoaded = true;
      break;
    }
    await sleep(200);
  }
  if (!h4FullLoaded) {
    throw new Error(`Expected clicking load-full-output on >128KB run ${h4Done.id} to hydrate full ${h4Done.output_bytes}B output`);
  }

  // Select doneRunRes thread via real user mouse click
  await cdpClient.clickSelector(`[data-testid="thread-item-${doneRunRes.run.thread_id}"] button:nth-of-type(2)`);
  await sleep(300);

  // Also test real Composer Enter submit with natural Chinese prompt
  await cdpClient.typeAndPressEnter(
    'textarea[placeholder*="输入任务指令"]',
    "请核查 macmini repo-alpha 最近构建记录"
  );
  for (let i = 0; i < 40; i++) {
    const runsNow = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().runs`);
    const latestForThread = runsNow.find((r) => r.thread_id === doneRunRes.run.thread_id && r.id !== doneRunId);
    if (latestForThread && latestForThread.status === "done") {
      break;
    }
    if (i === 39) {
      const dbg = await cdpClient.evalJS(`({ s: window.__AHUB_EVAL__.getState().selectedThreadId, v: document.querySelector('textarea')?.value })`);
      throw new Error(`Composer Enter-submitted run did not complete via WS: dbg=${JSON.stringify(dbg)} runs=${JSON.stringify(runsNow.map(r => [r.id, r.thread_id, r.status]))}`);
    }
    await sleep(200);
  }
  await sleep(250);

  // Verify UI == D1 parity
  state = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState()`);
  const d1Nodes = (await apiJson(hubUrl, adminToken, "/api/v1/nodes")).nodes;
  const d1Threads = (await apiJson(hubUrl, adminToken, "/api/v1/threads")).threads;
  const d1Runs = (await apiJson(hubUrl, adminToken, "/api/v1/runs?limit=200")).runs;
  if (
    state.nodes.length !== d1Nodes.length ||
    state.threads.length !== d1Threads.length ||
    state.runs.length !== d1Runs.length
  ) {
    throw new Error(
      `UI!=D1 parity mismatch: nodes(${state.nodes.length}/${d1Nodes.length}) threads(${state.threads.length}/${d1Threads.length}) runs(${state.runs.length}/${d1Runs.length})`
    );
  }

  // Screenshot 1: desktop-dark-active.png
  await cdpClient.screenshot(path.join(screenshotDir, "desktop-dark-active.png"));
  await assertViewportContainment(cdpClient, "desktop-1440x900-active");

  // Verify /dl/bootstrap.md and /dl/client-bootstrap.md endpoints and OnboardingDialog Agent/Bot prompts
  const bootstrapResp = await fetch(`${hubUrl}/dl/bootstrap.md`);
  if (bootstrapResp.status !== 200) {
    throw new Error(`Expected GET /dl/bootstrap.md 200, got ${bootstrapResp.status}`);
  }
  const bootstrapText = await bootstrapResp.text();
  if (!bootstrapText.includes(`${hubUrl}/dl/install.sh`) || bootstrapText.includes("__HUB_URL__")) {
    throw new Error("/dl/bootstrap.md failed hub URL substitution check");
  }

  const clientBootstrapResp = await fetch(`${hubUrl}/dl/client-bootstrap.md`);
  if (clientBootstrapResp.status !== 200) {
    throw new Error(`Expected GET /dl/client-bootstrap.md 200, got ${clientBootstrapResp.status}`);
  }
  const clientBootstrapText = await clientBootstrapResp.text();
  if (
    !clientBootstrapText.includes(`${hubUrl}/dl/install.sh`) ||
    clientBootstrapText.includes("__HUB_URL__") ||
    !clientBootstrapText.includes("AHUB_CONFIG_DIR") ||
    !clientBootstrapText.includes("update --no-restart")
  ) {
    throw new Error("/dl/client-bootstrap.md failed hub URL substitution or client isolation check");
  }

  await cdpClient.clickSelector('[data-testid="open-onboarding-btn"]');
  await sleep(250);
  const agentPromptText = await cdpClient.evalJS(
    `document.querySelector('[data-testid="onboarding-agent-prompt"]')?.textContent ?? ""`
  );
  if (!agentPromptText.includes(`${hubUrl}/dl/bootstrap.md`)) {
    throw new Error(`OnboardingDialog Agent prompt missing bootstrap URL: ${agentPromptText}`);
  }
  await cdpClient.clickSelector('[data-testid="onboarding-tab-skill"]');
  await sleep(200);
  const clientPromptText = await cdpClient.evalJS(
    `document.querySelector('[data-testid="onboarding-client-prompt"]')?.textContent ?? ""`
  );
  const onboardingRoutineText = await cdpClient.evalJS(
    `document.querySelector('[data-testid="onboarding-routine-prompt"]')?.textContent ?? ""`
  );
  if (
    !clientPromptText.includes(`${hubUrl}/dl/client-bootstrap.md`) ||
    !onboardingRoutineText.includes("ahub_run_completed") ||
    !onboardingRoutineText.includes("ahub_native_event") ||
    !onboardingRoutineText.includes("prompt_preview") ||
    onboardingRoutineText.includes("读取 `prompt`")
  ) {
    throw new Error(
      `OnboardingDialog client/routine prompt check failed: client=${clientPromptText} routine=${onboardingRoutineText}`
    );
  }
  await cdpClient.clickSelector('[data-testid="onboarding-dialog"] button[aria-label="关闭"]');
  await sleep(250);
  const dialogStillOpen = await cdpClient.evalJS(
    `Boolean(document.querySelector('[data-testid="onboarding-dialog"]'))`
  );
  if (dialogStillOpen) {
    throw new Error("Expected OnboardingDialog to close cleanly");
  }

  // Test KeysDialog multi-bot node binding + encrypted webhook host rendering & close
  await cdpClient.clickSelector('[data-testid="open-keys-btn"]');
  for (let i = 0; i < 30; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="keys-dialog"]'))`)) {
      break;
    }
    if (i === 29) {
      throw new Error("KeysDialog did not open");
    }
    await sleep(150);
  }
  await cdpClient.fillInput('[data-testid="key-name-input"]', "ui-multi-bot");
  await cdpClient.fillInput('[data-testid="key-allowed-nodes-input"]', "macmini");
  await cdpClient.fillInput('[data-testid="key-webhook-url-input"]', "https://hooks.x.ai/bot-ui-secret-path");
  await cdpClient.fillInput('[data-testid="key-webhook-key-input"]', "wh_ui_secret_key_99");
  await cdpClient.clickSelector('[data-testid="create-key-btn"]');
  for (let i = 0; i < 40; i++) {
    const found = await cdpClient.evalJS(
      `Array.from(document.querySelectorAll('[data-testid^="key-webhook-badge-"]')).some((el) => el.textContent?.includes("Webhook: hooks.x.ai"))`
    );
    if (found) break;
    if (i === 39) {
      throw new Error("Created client key did not display Webhook: hooks.x.ai badge in KeysDialog");
    }
    await sleep(150);
  }
  const keysDialogText = await cdpClient.evalJS(
    `document.querySelector('[data-testid="keys-dialog"]')?.textContent ?? ""`
  );
  if (keysDialogText.includes("wh_ui_secret_key_99") || keysDialogText.includes("bot-ui-secret-path")) {
    throw new Error("KeysDialog leaked plaintext webhook secret or full webhook path into DOM");
  }
  const freshEnvPrompt = await cdpClient.evalJS(
    `document.querySelector('[data-testid="fresh-client-bootstrap-env"]')?.textContent ?? ""`
  );
  const freshTokenPrompt = await cdpClient.evalJS(
    `document.querySelector('[data-testid="fresh-client-bootstrap-token"]')?.textContent ?? ""`
  );
  const freshRoutinePrompt = await cdpClient.evalJS(
    `document.querySelector('[data-testid="fresh-client-routine-prompt"]')?.textContent ?? ""`
  );
  if (
    !freshEnvPrompt.includes(`${hubUrl}/dl/client-bootstrap.md`) ||
    !freshTokenPrompt.includes("AHUB_CONFIG_DIR") ||
    !freshRoutinePrompt.includes("ahub_run_completed") ||
    !freshRoutinePrompt.includes("ahub_native_event") ||
    !freshRoutinePrompt.includes("prompt_preview") ||
    freshRoutinePrompt.includes("读取 `prompt`")
  ) {
    throw new Error(
      `KeysDialog client bootstrap/routine prompt check failed: env=${freshEnvPrompt} token=${freshTokenPrompt} routine=${freshRoutinePrompt}`
    );
  }
  const keysApi = await apiJson(hubUrl, adminToken, "/api/v1/keys");
  const uiCreatedKey = keysApi.keys.find((k) => k.name === "ui-multi-bot");
  if (
    !uiCreatedKey ||
    !uiCreatedKey.has_webhook ||
    uiCreatedKey.notify_webhook_host !== "hooks.x.ai" ||
    JSON.stringify(uiCreatedKey.allowed_nodes) !== JSON.stringify(["macmini"])
  ) {
    throw new Error(`Keys API parity mismatch for ui-multi-bot: ${JSON.stringify(uiCreatedKey)}`);
  }
  await cdpClient.clickSelector('[data-testid="keys-dialog"] button[aria-label="关闭"]');
  await sleep(250);
  const keysDialogStillOpen = await cdpClient.evalJS(
    `Boolean(document.querySelector('[data-testid="keys-dialog"]'))`
  );
  if (keysDialogStillOpen) {
    throw new Error("Expected KeysDialog to close cleanly");
  }

  // Test InspectorPane node-bound default Bot channel bind -> revoke badge -> unbind lifecycle
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(4)');
  for (let i = 0; i < 25; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="node-default-notify-select"]'))`)) {
      break;
    }
    if (i === 24) {
      throw new Error("Expected [data-testid='node-default-notify-select'] to appear for admin node control");
    }
    await sleep(150);
  }
  await cdpClient.clickSelector('[data-testid="node-default-notify-select"]');
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="node-notify-option-${uiCreatedKey.id}"]`);
  for (let i = 0; i < 25; i++) {
    const boundState = await cdpClient.evalJS(`({
      badge: document.querySelector('[data-testid="node-notify-valid-badge"]')?.textContent?.trim() ?? ""
    })`);
    if (boundState.badge.includes("hooks.x.ai")) break;
    if (i === 24) {
      throw new Error(`Expected node-notify-valid-badge with hooks.x.ai after binding, got ${JSON.stringify(boundState)}`);
    }
    await sleep(150);
  }
  const macAfterBind = (await apiJson(hubUrl, adminToken, "/api/v1/nodes")).nodes.find((n) => n.id === "macmini");
  if (macAfterBind?.default_notify_key_id !== uiCreatedKey.id || macAfterBind?.default_notify_valid !== true) {
    throw new Error(`Expected macmini default_notify_key_id=${uiCreatedKey.id} & valid=true, got ${JSON.stringify(macAfterBind)}`);
  }

  // Revoke bound key -> backend broadcasts updated node.status in real time and invalid/revoked badge renders
  await apiJson(hubUrl, adminToken, `/api/v1/keys/${uiCreatedKey.id}`, { method: "DELETE" });
  for (let i = 0; i < 25; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="node-notify-invalid-badge"]'))`)) {
      break;
    }
    if (i === 24) {
      const dbgApi = await apiJson(hubUrl, adminToken, "/api/v1/nodes");
      const dbgUi = await cdpClient.evalJS(`({
        authScope: window.__AHUB_EVAL__?.getState()?.authScope,
        mac: window.__AHUB_EVAL__?.getState()?.nodes?.find(n => n.id === "macmini")
      })`);
      throw new Error("Expected [data-testid='node-notify-invalid-badge'] after revoking bound key; ui=" + JSON.stringify(dbgUi) + " apiMac=" + JSON.stringify(dbgApi.nodes.find(n => n.id === "macmini")));
    }
    await sleep(150);
  }

  // Cleanly unbind macmini default Bot channel and verify D1 & DOM state
  await cdpClient.clickSelector('[data-testid="node-default-notify-select"]');
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="node-notify-option-unbound"]');
  for (let i = 0; i < 25; i++) {
    const badgesCleared = await cdpClient.evalJS(
      `!document.querySelector('[data-testid="node-notify-valid-badge"]') && !document.querySelector('[data-testid="node-notify-invalid-badge"]')`
    );
    if (badgesCleared) break;
    if (i === 24) {
      throw new Error("Expected node notify badges to clear after unbinding");
    }
    await sleep(150);
  }
  const macAfterUnbind = (await apiJson(hubUrl, adminToken, "/api/v1/nodes")).nodes.find((n) => n.id === "macmini");
  if (macAfterUnbind?.default_notify_key_id !== null) {
    throw new Error(`Expected macmini default_notify_key_id=null after unbind, got ${JSON.stringify(macAfterUnbind)}`);
  }

  // Return Inspector to 过程事件 tab before 2000-event streaming flood check
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(1)');
  await sleep(200);

  // Flood 2000 events and measure streaming CLS (must equal 0) + ring buffer cap (== 500)
  await cdpClient.evalJS(`window.__AHUB_CLS__ = 0; window.__AHUB_CLS_SOURCES__ = [];`);
  const floodRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      thread_id: doneRunRes.run.thread_id,
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      prompt: JSON.stringify({
        summary: "2000 条流式事件压测完成",
        response: "2000 条实时事件已推送并由前端环形缓冲截断保留最新 500 条。",
        directives: [{ op: "emit_ndjson", count: 2000, kind: "tool_use" }]
      })
    })
  });
  const floodRunId = floodRes.run.id;

  let floodCount = 0;
  for (let i = 0; i < 60; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${floodRunId}`);
    if (r.run.status === "done") {
      await sleep(350);
      floodCount = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().eventsByRunId["${floodRunId}"]?.length ?? 0`);
      break;
    }
    await sleep(250);
  }
  if (floodCount !== 500) {
    throw new Error(`Expected ring buffer capped strictly at 500 after 2000 events, got ${floodCount}`);
  }
  const domEventRows = await cdpClient.evalJS(`document.querySelectorAll('[data-testid="event-row"]').length`);
  if (domEventRows > 500 || domEventRows === 0) {
    throw new Error(`Unexpected rendered event-row DOM count: ${domEventRows}`);
  }
  const floodCls = await cdpClient.evalJS(`window.__AHUB_CLS__ ?? 0`);
  const floodSources = await cdpClient.evalJS(`window.__AHUB_CLS_SOURCES__ ?? []`);
  if (floodCls > 0.001) {
    throw new Error(`Expected zero CLS during 2000-event stream & counter updates, got ${floodCls}; sources=${JSON.stringify(floodSources)}`);
  }

  // Screenshot 2: desktop-light-active.png (via real user click on theme toggle)
  await cdpClient.clickSelector('[data-testid="theme-toggle-btn"]');
  await sleep(250);
  await cdpClient.screenshot(path.join(screenshotDir, "desktop-light-active.png"));

  // Switch back to Dark theme for approval + DnD queue screenshots
  await cdpClient.clickSelector('[data-testid="theme-toggle-btn"]');
  await sleep(200);

  // Verify 4-level node -> agent -> model -> effort Composer cascade + codex ultra dispatch
  await cdpClient.clickSelector('[data-testid="switch-to-new-thread-btn"]');
  await sleep(200);

  await cdpClient.clickSelector("#composer-agent");
  await sleep(150);
  const macAgents = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="composer-agent-option-"]')).map(el => el.getAttribute("data-testid"))`
  );
  if (JSON.stringify(macAgents) !== JSON.stringify(["composer-agent-option-agy", "composer-agent-option-codex"])) {
    throw new Error(`Expected macmini agent options [agy, codex], got ${JSON.stringify(macAgents)}`);
  }
  await cdpClient.clickSelector('[data-testid="composer-agent-option-agy"]');
  await sleep(150);
  const agyDefaultState = await cdpClient.evalJS(`({
    model: window.__AHUB_EVAL__.getState().composer.model,
    effort: window.__AHUB_EVAL__.getState().composer.effort,
    modelText: document.querySelector('#composer-model')?.textContent?.trim() ?? "",
    effortText: document.querySelector('#composer-effort')?.textContent?.trim() ?? ""
  })`);
  if (
    agyDefaultState.model !== "" ||
    agyDefaultState.effort !== "" ||
    agyDefaultState.modelText !== "跟随默认 (gemini-4-hydrogen)" ||
    agyDefaultState.effortText !== "跟随默认 (high)"
  ) {
    throw new Error(
      `Expected follow-default agy state (gemini-4-hydrogen / high), got ${JSON.stringify(agyDefaultState)}`
    );
  }

  await cdpClient.clickSelector("#composer-model");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="composer-model-option-gemini-pro-orchestrator"]');
  await sleep(150);
  const orchEffortState = await cdpClient.evalJS(`({
    disabled: Boolean(document.querySelector('#composer-effort')?.disabled),
    effort: window.__AHUB_EVAL__.getState().composer.effort
  })`);
  if (!orchEffortState.disabled || orchEffortState.effort !== "") {
    throw new Error(
      `Expected #composer-effort disabled and empty for gemini-pro-orchestrator, got ${JSON.stringify(orchEffortState)}`
    );
  }

  await cdpClient.clickSelector("#composer-node");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="composer-node-option-mbp"]');
  await sleep(200);
  await cdpClient.clickSelector("#composer-agent");
  await sleep(150);
  const mbpAgents = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="composer-agent-option-"]')).map(el => el.getAttribute("data-testid"))`
  );
  if (JSON.stringify(mbpAgents) !== JSON.stringify(["composer-agent-option-pi", "composer-agent-option-omp"])) {
    throw new Error(`Expected mbp agent options [pi, omp], got ${JSON.stringify(mbpAgents)}`);
  }
  await cdpClient.clickSelector('[data-testid="composer-agent-option-omp"]');
  await sleep(150);
  await cdpClient.clickSelector("#composer-model");
  await sleep(150);
  const hasOmpSonnet = await cdpClient.evalJS(
    `Boolean(document.querySelector('[data-testid="composer-model-option-anthropic/claude-sonnet-4-5"]'))`
  );
  if (!hasOmpSonnet) {
    throw new Error("Expected omp model option anthropic/claude-sonnet-4-5 on mbp");
  }
  await cdpClient.clickSelector('[data-testid="composer-model-option-anthropic/claude-sonnet-4-5"]');
  await sleep(150);

  await cdpClient.clickSelector("#composer-node");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="composer-node-option-macmini"]');
  await sleep(200);
  const switchedAgyState = await cdpClient.evalJS(`({
    agent: window.__AHUB_EVAL__.getState().composer.agent,
    model: window.__AHUB_EVAL__.getState().composer.model,
    effort: window.__AHUB_EVAL__.getState().composer.effort
  })`);
  if (
    switchedAgyState.agent !== "agy" ||
    switchedAgyState.model !== "gemini-4-hydrogen" ||
    switchedAgyState.effort !== "high"
  ) {
    throw new Error(
      `Expected macmini switch to select agy gemini-4-hydrogen high, got ${JSON.stringify(switchedAgyState)}`
    );
  }
  await cdpClient.clickSelector("#composer-agent");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="composer-agent-option-codex"]');
  await sleep(150);

  await cdpClient.clickSelector("#composer-model");
  await sleep(150);
  const hasHiddenCodexModel = await cdpClient.evalJS(
    `Boolean(document.querySelector('[data-testid="composer-model-option-codex-internal-hidden"]'))`
  );
  if (hasHiddenCodexModel) {
    throw new Error("Hidden codex model (visibility=hide) unexpectedly rendered in model options");
  }
  await cdpClient.clickSelector('[data-testid="composer-model-option-gpt-5.6-sol"]');
  await sleep(150);

  const codexEffortDisabled = await cdpClient.evalJS(
    `Boolean(document.querySelector('#composer-effort')?.disabled)`
  );
  if (codexEffortDisabled) {
    throw new Error("Expected #composer-effort enabled for codex gpt-5.6-sol");
  }
  await cdpClient.clickSelector("#composer-effort");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="composer-effort-option-ultra"]');
  await sleep(150);

  const beforeCodexIds = await cdpClient.evalJS(
    `window.__AHUB_EVAL__.getState().runs.map(r => r.id)`
  );
  await cdpClient.typeAndPressEnter(
    'textarea[placeholder*="输入任务指令"]',
    "验证 codex ultra 调度"
  );
  let createdCodexRun = null;
  for (let i = 0; i < 40; i++) {
    const runsNow = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().runs`);
    createdCodexRun = runsNow.find(
      (r) => !beforeCodexIds.includes(r.id) && r.agent === "codex" && r.status === "done"
    );
    if (createdCodexRun) break;
    if (i === 39) {
      throw new Error(`Codex ultra run did not complete: ${JSON.stringify(runsNow.slice(0, 5))}`);
    }
    await sleep(200);
  }
  const apiCodexRun = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${createdCodexRun.id}`)).run;
  if (
    apiCodexRun.agent !== "codex" ||
    apiCodexRun.model !== "gpt-5.6-sol" ||
    apiCodexRun.effort !== "ultra"
  ) {
    throw new Error(`D1 parity mismatch for codex ultra run: ${JSON.stringify(apiCodexRun)}`);
  }

  // Verify FleetThreadsPane dual-tab (会话 | 节点) and per-node collapsible workspace list
  const initialFleetTab = await cdpClient.evalJS(`({
    threadsActive: document.querySelector('[data-testid="fleet-tab-threads"]')?.getAttribute("data-state") === "active",
    nodesRenderedOnThreadsTab: Boolean(document.querySelector('[data-testid="node-row-macmini"]'))
  })`);
  if (!initialFleetTab.threadsActive || initialFleetTab.nodesRenderedOnThreadsTab) {
    throw new Error(`Expected initial left pane on 会话 tab without nodes DOM, got ${JSON.stringify(initialFleetTab)}`);
  }

  await cdpClient.clickSelector('[data-testid="fleet-tab-nodes"]');
  await sleep(200);
  const nodesTabOpen = await cdpClient.evalJS(`({
    nodesActive: document.querySelector('[data-testid="fleet-tab-nodes"]')?.getAttribute("data-state") === "active",
    hasMacRow: Boolean(document.querySelector('[data-testid="node-row-macmini"]')),
    hasMacAlpha: Boolean(document.querySelector('[data-testid="workspace-chip-macmini-repo-alpha"]')),
    hasMbpWeb: Boolean(document.querySelector('[data-testid="workspace-chip-mbp-repo-web"]')),
    macExpanded: document.querySelector('[data-testid="toggle-ws-macmini"]')?.getAttribute("aria-expanded")
  })`);
  if (
    !nodesTabOpen.nodesActive ||
    !nodesTabOpen.hasMacRow ||
    !nodesTabOpen.hasMacAlpha ||
    !nodesTabOpen.hasMbpWeb ||
    nodesTabOpen.macExpanded !== "true"
  ) {
    throw new Error(`Nodes tab failed to display expanded per-node workspaces: ${JSON.stringify(nodesTabOpen)}`);
  }

  // Collapse macmini workspaces independently while keeping mbp expanded
  await cdpClient.clickSelector('[data-testid="toggle-ws-macmini"]');
  await sleep(150);
  const macCollapsedState = await cdpClient.evalJS(`({
    macExpanded: document.querySelector('[data-testid="toggle-ws-macmini"]')?.getAttribute("aria-expanded"),
    hasMacAlpha: Boolean(document.querySelector('[data-testid="workspace-chip-macmini-repo-alpha"]')),
    hasMbpWeb: Boolean(document.querySelector('[data-testid="workspace-chip-mbp-repo-web"]'))
  })`);
  if (macCollapsedState.macExpanded !== "false" || macCollapsedState.hasMacAlpha || !macCollapsedState.hasMbpWeb) {
    throw new Error(`Per-node workspace collapse check failed: ${JSON.stringify(macCollapsedState)}`);
  }

  // Expand macmini again individually
  await cdpClient.clickSelector('[data-testid="toggle-ws-macmini"]');
  await sleep(150);
  const macReexpandedState = await cdpClient.evalJS(`({
    macExpanded: document.querySelector('[data-testid="toggle-ws-macmini"]')?.getAttribute("aria-expanded"),
    hasMacAlpha: Boolean(document.querySelector('[data-testid="workspace-chip-macmini-repo-alpha"]'))
  })`);
  if (macReexpandedState.macExpanded !== "true" || !macReexpandedState.hasMacAlpha) {
    throw new Error(`Per-node workspace re-expand check failed: ${JSON.stringify(macReexpandedState)}`);
  }

  // Collapse all then expand all via global toggle
  await cdpClient.clickSelector('[data-testid="toggle-all-node-ws"]');
  await sleep(150);
  const allCollapsed = await cdpClient.evalJS(`({
    hasMacAlpha: Boolean(document.querySelector('[data-testid="workspace-chip-macmini-repo-alpha"]')),
    hasMbpWeb: Boolean(document.querySelector('[data-testid="workspace-chip-mbp-repo-web"]'))
  })`);
  if (allCollapsed.hasMacAlpha || allCollapsed.hasMbpWeb) {
    throw new Error(`Expected toggle-all-node-ws to collapse all workspaces, got ${JSON.stringify(allCollapsed)}`);
  }
  await cdpClient.clickSelector('[data-testid="toggle-all-node-ws"]');
  await sleep(150);
  const allReexpanded = await cdpClient.evalJS(`({
    hasMacAlpha: Boolean(document.querySelector('[data-testid="workspace-chip-macmini-repo-alpha"]')),
    hasMbpWeb: Boolean(document.querySelector('[data-testid="workspace-chip-mbp-repo-web"]'))
  })`);
  if (!allReexpanded.hasMacAlpha || !allReexpanded.hasMbpWeb) {
    throw new Error(`Expected toggle-all-node-ws to re-expand all workspaces, got ${JSON.stringify(allReexpanded)}`);
  }

  // Clicking a workspace chip selects node+workdir in new mode
  await cdpClient.clickSelector('[data-testid="workspace-chip-mbp-repo-web"]');
  await sleep(150);
  const afterPickWs = await cdpClient.evalJS(`({
    nodeId: window.__AHUB_EVAL__.getState().composer.nodeId,
    mode: window.__AHUB_EVAL__.getState().composer.mode
  })`);
  if (afterPickWs.nodeId !== "mbp" || afterPickWs.mode !== "new") {
    throw new Error(`Expected clicking workspace chip to set nodeId=mbp & mode=new, got ${JSON.stringify(afterPickWs)}`);
  }

  // Switch back to 会话 tab so subsequent thread row selections operate cleanly
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(200);
  const backToThreads = await cdpClient.evalJS(
    `document.querySelector('[data-testid="fleet-tab-threads"]')?.getAttribute("data-state") === "active"`
  );
  if (!backToThreads) {
    throw new Error("Failed to switch back to fleet-tab-threads");
  }

  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(4)');
  await sleep(200);
  await cdpClient.setViewport(1440, 420, false);
  await sleep(200);
  await assertViewportContainment(cdpClient, "desktop-1440x420-overflowing-panes");
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(1)');
  await sleep(200);

  // Seed blocking soft_approval run + 2 queued runs for approval & DnD reorder tests
  const approvalRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsBeta,
      agent: "agy",
      title: "生产配置人工审批验证",
      prompt: JSON.stringify({
        summary: "等待网页审批",
        directives: [
          {
            op: "soft_approval",
            hold_ms: 12000,
            url: "https://claude.ai/code/session_eval_approval",
            then: "resume"
          }
        ]
      })
    })
  });
  const approvalRunId = approvalRes.run.id;

  const q1Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      title: "排队任务 Alpha",
      prompt: "echo queued alpha"
    })
  });
  const q2Res = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      title: "排队任务 Beta",
      prompt: "echo queued beta"
    })
  });

  for (let i = 0; i < 40; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${approvalRunId}`);
    if (r.run.status === "needs_approval") break;
    await sleep(200);
  }
  await sleep(250);
  await cdpClient.clickSelector(`[data-testid="thread-item-${approvalRes.run.thread_id}"] button:nth-of-type(2)`);
  await sleep(300);

  const hasBanner = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="needs-approval-banner"]'))`);
  if (!hasBanner) {
    throw new Error("Expected [data-testid='needs-approval-banner'] to be visible for needs_approval run");
  }

  // Screenshot 3: approval-banner-state.png
  await cdpClient.screenshot(path.join(screenshotDir, "approval-banner-state.png"));

  // Switch Inspector tab to 待跑队列 -> perform real CDP mouse drag-reorder of queued items!
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(2)');
  await sleep(300);

  const beforeOrder = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="queued-item-"]')).map(el => el.getAttribute("data-testid"))`
  );
  if (beforeOrder.length < 2) {
    throw new Error(`Expected >= 2 queued items in queue tab, got ${JSON.stringify(beforeOrder)}`);
  }

  // Drag second queued item above first queued item using CDP pointer steps
  await cdpClient.dragBetween(
    `[data-testid="queued-item-${q2Res.run.id}"] button[aria-label="拖拽调整队列优先级"]`,
    `[data-testid="queued-item-${q1Res.run.id}"] button[aria-label="拖拽调整队列优先级"]`
  );
  await sleep(450);

  const afterOrder = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="queued-item-"]')).map(el => el.getAttribute("data-testid"))`
  );
  if (afterOrder[0] !== `queued-item-${q2Res.run.id}`) {
    throw new Error(`Expected DnD reorder to place ${q2Res.run.id} first, got ${JSON.stringify(afterOrder)}`);
  }

  // Verify priority_order persisted in D1 API as well!
  const apiQ1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${q1Res.run.id}`)).run;
  const apiQ2 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${q2Res.run.id}`)).run;
  if (!(apiQ2.priority_order < apiQ1.priority_order)) {
    throw new Error(`D1 priority_order mismatch after DnD: q2=${apiQ2.priority_order} q1=${apiQ1.priority_order}`);
  }

  // Screenshot 4: dnd-queue-reorder.png
  await cdpClient.screenshot(path.join(screenshotDir, "dnd-queue-reorder.png"));

  // Cancel seeded approval + queued runs cleanly
  for (const rid of [q1Res.run.id, q2Res.run.id, approvalRunId]) {
    await apiJson(hubUrl, adminToken, `/api/v1/runs/${rid}/cancel`, {
      method: "POST",
      body: JSON.stringify({ cascade: false, reason: "eval done" })
    });
  }

  // M4 Step A: 2-tab in-page notification dedup via navigator.locks + BroadcastChannel
  const tab2Target = await cdpClient.send("Target.createTarget", { url: "about:blank" });
  const tab2Info = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(
    (t) => t.id === tab2Target.targetId
  );
  if (!tab2Info) {
    throw new Error("Failed to locate CDP target for Tab 2");
  }
  cdpTab2 = new CDPClient(tab2Info.webSocketDebuggerUrl);
  await cdpTab2.connect();
  await cdpTab2.send("Page.addScriptToEvaluateOnNewDocument", { source: evalInitScript });
  await cdpTab2.send("Page.navigate", { url: `${hubUrl}/?token=${adminToken}` });
  for (let i = 0; i < 40; i++) {
    const ok2 = await cdpTab2.evalJS(`window.__AHUB_EVAL__?.getState()?.streamStatus === "connected"`);
    if (ok2) break;
    if (i === 39) throw new Error("Tab 2 failed to connect /ws/stream in time");
    await sleep(200);
  }
  await cdpClient.evalJS(`window.__AHUB_CAPTURED_NOTIFS__ = []`);
  await cdpTab2.evalJS(`window.__AHUB_CAPTURED_NOTIFS__ = []`);

  const e1Res = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-native-evt-1",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_cdp_1",
      workdir: wsAlpha,
      title: "确认执行数据库迁移",
      summary: "检测到 schema 变更，请确认是否继续迁移。",
      source: "hook:Notification"
    })
  });
  const e1Id = e1Res.event.id;

  for (let i = 0; i < 30; i++) {
    const c1 = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().nativeEvents.some(e => e.id === ${JSON.stringify(e1Id)})`
    );
    const c2 = await cdpTab2.evalJS(
      `window.__AHUB_EVAL__.getState().nativeEvents.some(e => e.id === ${JSON.stringify(e1Id)})`
    );
    if (c1 && c2) break;
    if (i === 29) throw new Error("E1 did not propagate to both tabs over /ws/stream");
    await sleep(150);
  }
  await sleep(350);
  const tab1NotifsA = await cdpClient.evalJS(`window.__AHUB_CAPTURED_NOTIFS__`);
  const tab2NotifsA = await cdpTab2.evalJS(`window.__AHUB_CAPTURED_NOTIFS__`);
  if (tab1NotifsA.length + tab2NotifsA.length !== 1) {
    throw new Error(
      `Expected exactly 1 in-page notification across 2 tabs via navigator.locks + BroadcastChannel, got tab1=${tab1NotifsA.length} tab2=${tab2NotifsA.length}`
    );
  }

  // M4 Step B: Web Push subscription, test notification, active-push in-page suppression, and sw.js delivery
  await cdpClient.clickSelector('[data-testid="open-browser-notify-btn"]');
  for (let i = 0; i < 20; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="browser-notify-dialog"]'))`)) {
      break;
    }
    await sleep(100);
  }
  await cdpClient.clickSelector('[data-testid="enable-browser-push-btn"]');
  let createdSub = null;
  for (let i = 0; i < 30; i++) {
    createdSub = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__.getState();
        const health = document.querySelector('[data-testid="browser-notify-health"]')?.getAttribute("data-health-status");
        if (s.pushSubscriptions.length === 1 && health === "active") {
          return s.pushSubscriptions[0];
        }
        return null;
      })()
    `);
    if (createdSub) break;
    if (i === 29) throw new Error("Web Push subscription did not reach active state");
    await sleep(150);
  }
  if (!createdSub.endpoint_host.startsWith("127.0.0.1:")) {
    throw new Error(`Expected mock push endpoint_host, got ${createdSub.endpoint_host}`);
  }

  mockPushGateway.requests.length = 0;
  await cdpClient.clickSelector(`[data-testid="test-push-sub-${createdSub.id}"]`);
  for (let i = 0; i < 25; i++) {
    const testText = await cdpClient.evalJS(
      `document.querySelector('[data-testid="test-push-result-${createdSub.id}"]')?.textContent ?? ""`
    );
    if (testText.includes("201") && mockPushGateway.requests.length === 1) break;
    if (i === 24) throw new Error(`Test push notification failed: text=${testText} reqs=${JSON.stringify(mockPushGateway.requests)}`);
    await sleep(150);
  }
  if (!mockPushGateway.requests[0].vapidVerified || mockPushGateway.requests[0].payload?.kind !== "test") {
    throw new Error(`Test push payload/VAPID invalid: ${JSON.stringify(mockPushGateway.requests[0])}`);
  }

  await cdpClient.clickSelector('[data-testid="browser-notify-dialog"] button[aria-label="关闭"]');
  await sleep(200);
  mockPushGateway.requests.length = 0;
  await cdpClient.evalJS(`window.__AHUB_CAPTURED_NOTIFS__ = []`);
  await cdpTab2.evalJS(`window.__AHUB_CAPTURED_NOTIFS__ = []`);

  // Sync subscription state into Tab 2 before E2 arrives so Tab 2 knows Web Push is active on this browser origin too
  await cdpTab2.evalJS(`localStorage.setItem("__ahub_eval_mock_push_active__", "1")`);
  await cdpTab2.send("Page.reload");
  for (let i = 0; i < 40; i++) {
    const ready2 = await cdpTab2.evalJS(
      `window.__AHUB_EVAL__?.getState()?.streamStatus === "connected" && window.__AHUB_EVAL__?.getState()?.pushSubscriptions?.length === 1`
    );
    if (ready2) break;
    if (i === 39) throw new Error("Tab 2 timed out waiting for streamStatus === connected after Page.reload");
    await sleep(200);
  }

  const e2Res = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-native-evt-2",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_cdp_2",
      workdir: wsBeta,
      title: "确认生产回滚指令",
      summary: "等待管理员确认是否回滚发布。",
      source: "hook:Notification"
    })
  });
  const e2Id = e2Res.event.id;

  for (let i = 0; i < 60; i++) {
    if (mockPushGateway.requests.length >= 1) break;
    if (i === 59) throw new Error("Timed out waiting for Web Push delivery of E2 on mock Push gateway");
    await sleep(200);
  }
  const e2Push = mockPushGateway.requests[0];
  if (!e2Push.vapidVerified || e2Push.payload?.kind !== "native_event" || e2Push.payload?.id !== e2Id) {
    throw new Error(`Unexpected Web Push payload for E2: ${JSON.stringify(e2Push)}`);
  }
  await sleep(300);
  const tab1NotifsB = await cdpClient.evalJS(`window.__AHUB_CAPTURED_NOTIFS__`);
  const tab2NotifsB = await cdpTab2.evalJS(`window.__AHUB_CAPTURED_NOTIFS__`);
  if (tab1NotifsB.length + tab2NotifsB.length !== 0) {
    throw new Error(
      `Expected active Web Push to suppress in-page Notification, got tab1=${tab1NotifsB.length} tab2=${tab2NotifsB.length}`
    );
  }

  // Deliver encrypted-decrypted payload to Chromium's real sw.js and verify reg.getNotifications()
  if (!swRegistrationId) {
    throw new Error("Missing ServiceWorker registrationId for sw.js push verification");
  }
  await cdpClient.send("ServiceWorker.deliverPushMessage", {
    origin: `${hubUrl}/`,
    registrationId: swRegistrationId,
    data: JSON.stringify(e2Push.payload)
  });
  let swShown = false;
  for (let i = 0; i < 20; i++) {
    swShown = await cdpClient.evalJS(`
      (async () => {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const notifs = reg ? await reg.getNotifications() : [];
        return notifs.some(n => n.tag === ${JSON.stringify(e2Push.payload.tag)} && n.title === ${JSON.stringify(e2Push.payload.title)});
      })()
    `);
    if (swShown) break;
    await sleep(150);
  }
  if (!swShown) {
    throw new Error("Real sw.js push handler did not call showNotification for E2 payload");
  }

  cdpTab2.close();
  cdpTab2 = null;
  await cdpClient.send("Target.closeTarget", { targetId: tab2Target.targetId });

  // M4 Step C: NativeActivityPane read-only UI, same-session superseded convergence, ack, & grok takeover
  await cdpClient.clickSelector('[data-testid="fleet-tab-native"]');
  await sleep(200);
  const nativePaneCheck = await cdpClient.evalJS(`({
    hasPane: Boolean(document.querySelector('[data-testid="native-activity-pane"]')),
    fakeInputs: document.querySelectorAll('[data-testid="native-activity-pane"] textarea, [data-testid="native-activity-pane"] form').length,
    openCount: window.__AHUB_EVAL__.getState().openInteractionCount,
    resumeCmd: document.querySelector('[data-testid="native-resume-cmd-preview"]')?.textContent ?? ""
  })`);
  if (
    !nativePaneCheck.hasPane ||
    nativePaneCheck.fakeInputs !== 0 ||
    nativePaneCheck.openCount !== 2 ||
    !nativePaneCheck.resumeCmd.includes("claude --resume")
  ) {
    throw new Error(`NativeActivityPane check failed: ${JSON.stringify(nativePaneCheck)}`);
  }

  await sleep(25);
  const e3Res = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-native-evt-3",
      agent: "claude",
      event_kind: "turn_summary",
      native_session_id: "sess_cdp_1",
      workdir: wsAlpha,
      title: "完成 schema 预检",
      summary: "已自动跳过无关表并完成迁移检查。",
      source: "hook:Stop"
    })
  });
  const e3Id = e3Res.event.id;
  for (let i = 0; i < 30; i++) {
    const conv = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__.getState();
        const e1 = s.nativeEvents.find(e => e.id === ${JSON.stringify(e1Id)});
        const e3 = s.nativeEvents.find(e => e.id === ${JSON.stringify(e3Id)});
        return { e1State: e1?.attention_state, hasE3: Boolean(e3), openCount: s.openInteractionCount };
      })()
    `);
    if (conv.hasE3 && conv.e1State === "superseded" && conv.openCount === 1) break;
    if (i === 29) throw new Error(`Expected E1 to converge to superseded & openCount=1, got ${JSON.stringify(conv)}`);
    await sleep(150);
  }

  await cdpClient.clickSelector('[data-testid="native-session-item-macmini:claude:sess_cdp_2"]');
  await sleep(200);
  await cdpClient.clickSelector(`[data-testid="ack-native-event-${e2Id}"]`);
  for (let i = 0; i < 25; i++) {
    const acked = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__.getState();
        const e2 = s.nativeEvents.find(e => e.id === ${JSON.stringify(e2Id)});
        const rowAttr = document.querySelector('[data-testid="native-event-row-${e2Id}"]')?.getAttribute("data-attention-state");
        return { state: e2?.attention_state, rowAttr, openCount: s.openInteractionCount };
      })()
    `);
    if (acked.state === "acked" && acked.rowAttr === "acked" && acked.openCount === 0) break;
    if (i === 24) throw new Error(`Ack convergence failed for E2: ${JSON.stringify(acked)}`);
    await sleep(150);
  }

  // Test grok native event takeover fallback notice
  const grokRes = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-native-evt-grok",
      agent: "grok",
      event_kind: "turn_summary",
      native_session_id: "",
      workdir: wsAlpha,
      title: "Grok 本地排查结论",
      summary: "定位到编译参数缺失。",
      source: "hook:Stop"
    })
  });
  const grokSessionKey = `macmini:grok:${wsAlpha}`;
  for (let i = 0; i < 25; i++) {
    if (
      await cdpClient.evalJS(
        `Boolean(document.querySelector('[data-testid="native-session-item-${grokSessionKey}"]'))`
      )
    ) {
      break;
    }
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="native-session-item-${grokSessionKey}"]`);
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="native-to-controlled-btn"]');
  await sleep(250);
  const takeoverState = await cdpClient.evalJS(`({
    centerMode: window.__AHUB_EVAL__.getState().centerMode,
    composer: window.__AHUB_EVAL__.getState().composer,
    notice: document.querySelector('[data-testid="composer-notice"]')?.textContent ?? ""
  })`);
  if (
    takeoverState.centerMode !== "controlled" ||
    takeoverState.composer.mode !== "new" ||
    takeoverState.composer.nodeId !== "macmini" ||
    takeoverState.composer.agent === "grok" ||
    !takeoverState.composer.prompt.includes("定位到编译参数缺失") ||
    !takeoverState.notice.includes("grok")
  ) {
    throw new Error(`Grok takeover fallback check failed: ${JSON.stringify(takeoverState)}`);
  }

  // M4 Step D: InspectorPane Tab 5 投递明细 & single-channel 403 -> 201 redeliver UI==D1 parity
  mockPushGateway.state.statusOverride = 403;
  const e4Res = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-native-evt-4",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_cdp_4",
      workdir: wsAlpha,
      title: "验证单通道失败重推",
      summary: "模拟推送网关返回 403 后人工重推。",
      source: "hook:Notification"
    })
  });
  const e4Id = e4Res.event.id;
  let failedDelivery = null;
  for (let i = 0; i < 60; i++) {
    const detail = await apiJson(hubUrl, adminToken, `/api/v1/native-events/${e4Id}`);
    failedDelivery = detail.deliveries.find(
      (d) => d.channel_kind === "web_push" && d.status === "failed"
    );
    if (failedDelivery) break;
    if (i === 59) throw new Error(`Expected E4 web_push delivery to fail with 403, got ${JSON.stringify(detail)}`);
    await sleep(200);
  }
  if (failedDelivery.http_status !== 403 || failedDelivery.error_code !== "PUSH_REJECTED_403") {
    throw new Error(`Unexpected failed delivery metadata: ${JSON.stringify(failedDelivery)}`);
  }

  await cdpClient.send("Network.enable");
  const e4DetailRequests = [];
  cdpClient.onEvent("Network.requestWillBeSent", (params) => {
    const req = params?.request;
    if (req?.method === "GET" && req?.url === `${hubUrl}/api/v1/native-events/${e4Id}`) {
      e4DetailRequests.push(req.url);
    }
  });

  await cdpClient.clickSelector('[data-testid="fleet-tab-native"]');
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="native-session-item-macmini:claude:sess_cdp_4"]');
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(5)');
  for (let i = 0; i < 25; i++) {
    const dlvDom = await cdpClient.evalJS(`({
      status: document.querySelector('[data-testid="delivery-row-${failedDelivery.id}"]')?.getAttribute("data-delivery-status"),
      text: document.querySelector('[data-testid="delivery-row-${failedDelivery.id}"]')?.textContent ?? "",
      hasRedeliver: Boolean(document.querySelector('[data-testid="redeliver-btn-${failedDelivery.id}"]'))
    })`);
    if (dlvDom.status === "failed" && dlvDom.text.includes("403") && dlvDom.hasRedeliver) break;
    if (i === 24) throw new Error(`InspectorPane Tab 5 did not render failed 403 delivery: ${JSON.stringify(dlvDom)}`);
    await sleep(150);
  }
  await sleep(1000);
  if (e4DetailRequests.length === 0 || e4DetailRequests.length > 3) {
    throw new Error(
      `Expected bounded GET /api/v1/native-events/${e4Id} requests while Tab 5 is open (1..3), got ${e4DetailRequests.length}`
    );
  }

  mockPushGateway.state.statusOverride = 201;
  mockPushGateway.requests.length = 0;
  await cdpClient.clickSelector(`[data-testid="redeliver-btn-${failedDelivery.id}"]`);
  for (let i = 0; i < 60; i++) {
    const domStatus = await cdpClient.evalJS(
      `document.querySelector('[data-testid="delivery-row-${failedDelivery.id}"]')?.getAttribute("data-delivery-status")`
    );
    const domText = await cdpClient.evalJS(
      `document.querySelector('[data-testid="delivery-row-${failedDelivery.id}"]')?.textContent ?? ""`
    );
    if (domStatus === "sent" && domText.includes("201")) break;
    if (i === 59) throw new Error(`Single-channel redeliver did not converge to sent/201 in DOM: status=${domStatus} text=${domText}`);
    await sleep(200);
  }
  const apiE4After = await apiJson(hubUrl, adminToken, `/api/v1/native-events/${e4Id}`);
  const apiDlvAfter = apiE4After.deliveries.find((d) => d.id === failedDelivery.id);
  if (apiDlvAfter?.status !== "sent" || apiDlvAfter?.http_status !== 201 || mockPushGateway.requests.length !== 1) {
    throw new Error(`UI!=D1 parity mismatch after redeliver: ${JSON.stringify({ apiDlvAfter, reqCount: mockPushGateway.requests.length })}`);
  }

  await cdpClient.clickSelector(`[data-testid="ack-native-event-${e4Id}"]`);
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="thread-item-${doneRunRes.run.thread_id}"] button:nth-of-type(2)`);
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(1)');
  await sleep(250);

  const extraScreenshotDir = process.env.AHUB_EVAL_EXTRA_SCREENSHOT_DIR;

  await cdpClient.setViewport(360, 780, true);
  await sleep(300);
  await assertViewportContainment(cdpClient, "mobile-360x780");
  const narrowTableCheck = await cdpClient.evalJS(`
    (() => {
      const region = document.querySelector('[data-testid="run-row-${doneRunId}"] .ahub-table-scroll[role="region"][tabindex="0"]');
      return Boolean(region && region.querySelector("table"));
    })()
  `);
  if (!narrowTableCheck) {
    throw new Error("Expected Markdown wide table to render inside .ahub-table-scroll[role='region'][tabindex='0']");
  }

  await cdpClient.clickSelector('[data-testid="mobile-more-menu-btn"]');
  await sleep(200);
  const mobileMenuMetrics = await cdpClient.evalJS(`
    (() => {
      const items = Array.from(document.querySelectorAll('[data-testid="mobile-menu-onboarding"], [data-testid="mobile-menu-keys"], [data-testid="mobile-menu-theme"]'));
      return items.map((el) => {
        const r = el.getBoundingClientRect();
        return { testid: el.getAttribute("data-testid"), w: r.width, h: r.height };
      });
    })()
  `);
  if (mobileMenuMetrics.length !== 3 || mobileMenuMetrics.some((m) => m.w < 43.5 || m.h < 43.5)) {
    throw new Error(`Expected mobile more-menu items >= 44px, got ${JSON.stringify(mobileMenuMetrics)}`);
  }
  await cdpClient.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await cdpClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(150);

  await cdpClient.setViewport(390, 844, true);
  await sleep(300);
  await assertViewportContainment(cdpClient, "mobile-390x844");
  const mobileMetrics = await cdpClient.evalJS(`
    (() => {
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const headerBtns = Array.from(document.querySelectorAll("header button"));
      const undersized = [];
      for (const el of headerBtns) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 43.5 || rect.height < 43.5) {
          undersized.push({ label: el.getAttribute("aria-label") || el.textContent?.trim(), w: rect.width, h: rect.height });
        }
      }
      const promptEl = document.querySelector("#prompt-input");
      const promptFontSize = promptEl ? parseFloat(getComputedStyle(promptEl).fontSize) : 0;
      return { overflow, undersized, promptFontSize };
    })()
  `);
  if (mobileMetrics.overflow > 0) {
    throw new Error(`Mobile 390x844 horizontal overflow detected: ${mobileMetrics.overflow}px`);
  }
  if (mobileMetrics.undersized.length > 0) {
    throw new Error(`Mobile tap targets < 44x44px: ${JSON.stringify(mobileMetrics.undersized)}`);
  }
  if (!(mobileMetrics.promptFontSize >= 16)) {
    throw new Error(`Mobile #prompt-input font-size < 16px (causes iOS auto-zoom): ${mobileMetrics.promptFontSize}px`);
  }

  if (extraScreenshotDir) {
    fs.mkdirSync(extraScreenshotDir, { recursive: true });
    await cdpClient.screenshot(path.join(extraScreenshotDir, "mobile-conversation.png"));
  }

  await cdpClient.clickSelector('[data-testid="toggle-mobile-composer"]');
  await sleep(150);
  const composerCollapsed = await cdpClient.evalJS(`
    (() => {
      const ta = document.querySelector("#prompt-input");
      const btn = document.querySelector('[data-testid="toggle-mobile-composer"]');
      return {
        textareaHidden: !ta || ta.getBoundingClientRect().height === 0,
        expandedAttr: btn?.getAttribute("aria-expanded")
      };
    })()
  `);
  if (!composerCollapsed.textareaHidden || composerCollapsed.expandedAttr !== "false") {
    throw new Error(`Expected toggle-mobile-composer to collapse composer, got ${JSON.stringify(composerCollapsed)}`);
  }
  await cdpClient.clickSelector('[data-testid="toggle-mobile-composer"]');
  await sleep(150);
  const composerExpanded = await cdpClient.evalJS(`
    (() => {
      const ta = document.querySelector("#prompt-input");
      const btn = document.querySelector('[data-testid="toggle-mobile-composer"]');
      return {
        textareaVisible: Boolean(ta && ta.getBoundingClientRect().height >= 40),
        expandedAttr: btn?.getAttribute("aria-expanded")
      };
    })()
  `);
  if (!composerExpanded.textareaVisible || composerExpanded.expandedAttr !== "true") {
    throw new Error(`Expected toggle-mobile-composer to re-expand composer, got ${JSON.stringify(composerExpanded)}`);
  }

  await cdpClient.clickSelector(`[data-testid="open-run-events-${doneRunId}"]`);
  await sleep(300);
  const rightDrawerCheck = await cdpClient.evalJS(`
    (() => {
      const pane = document.querySelector('[data-testid="inspector-pane"]');
      const tabs = pane ? Array.from(pane.querySelectorAll('[role="tab"]')) : [];
      const tabMetrics = tabs.map((t) => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent?.trim(), w: r.width, h: r.height };
      });
      return {
        open: Boolean(pane),
        activeTab: window.__AHUB_EVAL__.getState().activeTab,
        tabMetrics
      };
    })()
  `);
  if (
    !rightDrawerCheck.open ||
    rightDrawerCheck.activeTab !== "events" ||
    rightDrawerCheck.tabMetrics.length !== 5 ||
    rightDrawerCheck.tabMetrics.some((t) => t.h < 43.5 || t.w < 68)
  ) {
    throw new Error(`Mobile right drawer 5-tab check failed: ${JSON.stringify(rightDrawerCheck)}`);
  }
  await assertViewportContainment(cdpClient, "mobile-390x844-right-drawer");
  await cdpClient.clickSelector('[data-testid="inspector-tab-deliveries"]');
  await sleep(250);
  const rightTab5Active = await cdpClient.evalJS(`
    (() => ({
      activeTab: window.__AHUB_EVAL__.getState().activeTab,
      tabRightVisible: (() => {
        const el = document.querySelector('[data-testid="inspector-tab-deliveries"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth + 1;
      })()
    }))()
  `);
  if (rightTab5Active.activeTab !== "deliveries" || !rightTab5Active.tabRightVisible) {
    throw new Error(`Mobile right drawer 5th tab did not scroll cleanly into view: ${JSON.stringify(rightTab5Active)}`);
  }
  if (extraScreenshotDir) {
    fs.mkdirSync(extraScreenshotDir, { recursive: true });
    await cdpClient.screenshot(path.join(extraScreenshotDir, "mobile-right-drawer.png"));
  }
  await cdpClient.clickSelector('button[aria-label="关闭抽屉"]');
  await sleep(250);

  await cdpClient.clickSelector('[data-testid="mobile-left-trigger"]');
  await sleep(300);
  const leftDrawerMetrics = await cdpClient.evalJS(`
    (() => {
      const pane = document.querySelector('[data-testid="fleet-threads-pane"]');
      const searchEl = document.querySelector('[data-testid="thread-search-input"]');
      const newBtn = document.querySelector('[data-testid="new-thread-btn"]');
      const tabs = pane ? Array.from(pane.querySelectorAll('[role="tab"]')) : [];
      return {
        searchFontSize: searchEl ? parseFloat(getComputedStyle(searchEl).fontSize) : 0,
        newBtnHeight: newBtn ? newBtn.getBoundingClientRect().height : 0,
        tabHeights: tabs.map((t) => ({ text: t.textContent?.trim(), h: t.getBoundingClientRect().height }))
      };
    })()
  `);
  if (
    !(leftDrawerMetrics.searchFontSize >= 16) ||
    leftDrawerMetrics.newBtnHeight < 43.5 ||
    leftDrawerMetrics.tabHeights.length < 3 ||
    leftDrawerMetrics.tabHeights.some((t) => t.h < 43.5)
  ) {
    throw new Error(`Mobile left drawer metrics check failed: ${JSON.stringify(leftDrawerMetrics)}`);
  }

  // Screenshot 5: mobile-drawer-open.png
  await cdpClient.screenshot(path.join(screenshotDir, "mobile-drawer-open.png"));

  // Also verify NativeActivityPane mobile 390x844 has 0px horizontal overflow
  await cdpClient.clickSelector('[data-testid="fleet-tab-native"]');
  await sleep(200);
  await cdpClient.clickSelector(`[data-testid="native-session-item-macmini:claude:sess_cdp_4"]`);
  await sleep(250);
  await assertViewportContainment(cdpClient, "mobile-390x844-native-pane");

  await cdpClient.clickSelector('[data-testid="mobile-left-trigger"]');
  await sleep(250);
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(200);
  await cdpClient.clickSelector(`[data-testid="thread-item-${thread2Res.run.thread_id}"] button[aria-label="分叉会话"]`);
  let forkClosedDrawer = false;
  for (let i = 0; i < 30; i++) {
    const forkState = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__.getState();
        return {
          drawerOpen: Boolean(document.querySelector('[data-testid="fleet-threads-pane"]')),
          selectedThreadId: s.selectedThreadId,
          centerMode: s.centerMode
        };
      })()
    `);
    if (
      !forkState.drawerOpen &&
      forkState.selectedThreadId &&
      forkState.selectedThreadId !== thread2Res.run.thread_id &&
      forkState.selectedThreadId !== doneRunRes.run.thread_id &&
      forkState.centerMode === "controlled"
    ) {
      forkClosedDrawer = true;
      break;
    }
    await sleep(200);
  }
  if (!forkClosedDrawer) {
    throw new Error("Expected forking thread in mobile left drawer to switch to forked thread and close drawer");
  }
  const forkedThreadId = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().selectedThreadId`);
  const forkedRunInD1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs?thread_id=${forkedThreadId}`)).runs?.[0];
  if (forkedRunInD1) {
    await waitForSeedRunDone(forkedRunInD1.id, "Mobile forked thread seed run");
  }

  // Verify client-scope UI login omits admin-only default Bot notify, Native Activity, and Push controls with zero console/403 errors
  const forbiddenResponses = [];
  await cdpClient.send("Network.enable");
  cdpClient.onEvent("Network.responseReceived", (params) => {
    const st = params?.response?.status;
    const url = params?.response?.url ?? "";
    if (st === 403 && url.startsWith(hubUrl)) {
      forbiddenResponses.push({ status: st, url });
    }
  });

  const clientScopeKey = await apiJson(hubUrl, adminToken, "/api/v1/keys", {
    method: "POST",
    body: JSON.stringify({ name: "cdp-client-scope", scope: "client", allowed_nodes: [] })
  });
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.send("Page.navigate", { url: `${hubUrl}/?token=${clientScopeKey.token}` });
  let clientState = null;
  for (let i = 0; i < 40; i++) {
    clientState = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__?.getState();
        if (!s || s.authStatus !== "authenticated" || s.authScope !== "client" || s.nodes.length < 2) return null;
        return s;
      })()
    `);
    if (clientState) break;
    await sleep(200);
  }
  if (!clientState || clientState.streamStatus !== "disconnected") {
    throw new Error(`Client-scoped token login did not hydrate cleanly with disconnected global stream: ${JSON.stringify(clientState)}`);
  }
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(4)');
  await sleep(200);
  const clientInspectorCheck = await cdpClient.evalJS(`({
    hasNotifySelect: Boolean(document.querySelector('[data-testid="node-default-notify-select"]')),
    hasNotifyBadge: Boolean(document.querySelector('[data-testid="node-notify-valid-badge"]') || document.querySelector('[data-testid="node-notify-invalid-badge"]')),
    hasFleetNativeTab: Boolean(document.querySelector('[data-testid="fleet-tab-native"]')),
    hasBrowserNotifyBtn: Boolean(document.querySelector('[data-testid="open-browser-notify-btn"]')),
    hasInteractionsPill: Boolean(document.querySelector('[data-testid="open-interactions-pill"]')),
    hasDeliveriesTab: Boolean(document.querySelector('[data-testid="inspector-tab-deliveries"]'))
  })`);
  if (
    clientInspectorCheck.hasNotifySelect ||
    clientInspectorCheck.hasNotifyBadge ||
    clientInspectorCheck.hasFleetNativeTab ||
    clientInspectorCheck.hasBrowserNotifyBtn ||
    clientInspectorCheck.hasInteractionsPill ||
    clientInspectorCheck.hasDeliveriesTab
  ) {
    throw new Error(`Expected client scope to hide all admin-only controls, got ${JSON.stringify(clientInspectorCheck)}`);
  }
  if (forbiddenResponses.length > 0) {
    throw new Error(`Expected zero 403 network responses in client scope, got ${JSON.stringify(forbiddenResponses)}`);
  }
  if (cdpClient.consoleErrors.length > 0) {
    throw new Error(`Expected zero console errors in client-scoped UI, got ${JSON.stringify(cdpClient.consoleErrors)}`);
  }

  // Zero-token Cloudflare Access cookie login verification in real Chromium
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.evalJS(`localStorage.removeItem("ahub-token")`);
  await cdpClient.send("Network.enable");
  const cookieRes = await cdpClient.send("Network.setCookie", {
    name: "CF_Authorization",
    value: accessMaterial.accessJwt,
    url: hubUrl,
    path: "/",
    httpOnly: true,
    sameSite: "Lax"
  });
  if (!cookieRes?.success) {
    throw new Error(`Failed to set CF_Authorization cookie in Chromium: ${JSON.stringify(cookieRes)}`);
  }
  await cdpClient.send("Page.navigate", { url: `${hubUrl}/` });

  let cookieState = null;
  for (let i = 0; i < 40; i++) {
    cookieState = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__?.getState();
        const storedToken = localStorage.getItem("ahub-token");
        if (!s || s.streamStatus !== "connected" || s.authKind !== "access_jwt") return null;
        return { ...s, storedToken };
      })()
    `);
    if (cookieState) break;
    await sleep(250);
  }
  if (!cookieState || cookieState.storedToken !== null || cookieState.nodes.length < 2) {
    throw new Error(`Zero-token Cloudflare Access cookie flow failed: ${JSON.stringify(cookieState)}`);
  }

  await cdpClient.clickSelector('[data-testid="open-keys-btn"]');
  await sleep(350);
  const keysDialogInfo = await cdpClient.evalJS(`
    (() => {
      const dialog = document.querySelector('[data-testid="keys-dialog"]');
      const errText = dialog?.querySelector('div[class*="status-failed"]')?.textContent ?? "";
      const hasMacKey = Boolean(dialog?.textContent?.includes("node-macmini"));
      return { open: Boolean(dialog), errText, hasMacKey };
    })()
  `);
  if (!keysDialogInfo.open || keysDialogInfo.errText || !keysDialogInfo.hasMacKey) {
    throw new Error(`KeysDialog failed under Access cookie auth: ${JSON.stringify(keysDialogInfo)}`);
  }

  if (cdpClient.consoleErrors.length > 0 || cdpClient.exceptions.length > 0) {
    throw new Error(
      `Browser runtime errors detected: console=${JSON.stringify(cdpClient.consoleErrors)} exceptions=${JSON.stringify(cdpClient.exceptions)}`
    );
  }

  console.log(
    `L2 CDP Runtime Eval PASSED: UI==D1 parity ok, flood ring-buffer=${floodCount}, stream CLS=${floodCls}, DnD priority_order persisted, mobile overflow=0, zero-token CF Access cookie ok, 5 screenshots written to ${screenshotDir}`
  );
} finally {
  if (cdpTab2) cdpTab2.close();
  if (cdpClient) cdpClient.close();
  if (mockPushGateway) {
    await new Promise((resolve) => mockPushGateway.server.close(() => resolve()));
  }
  if (jwksServer) {
    await new Promise((resolve) => jwksServer.close(() => resolve()));
  }
  for (const proc of children) {
    killGroup(proc);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
