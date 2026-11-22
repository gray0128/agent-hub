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

  async pressKey(key) {
    const codeMap = {
      j: { code: "KeyJ", vk: 74 },
      k: { code: "KeyK", vk: 75 },
      " ": { code: "Space", vk: 32 },
      Tab: { code: "Tab", vk: 9 },
      "1": { code: "Digit1", vk: 49 },
      "2": { code: "Digit2", vk: 50 },
      "3": { code: "Digit3", vk: 51 },
      "4": { code: "Digit4", vk: 52 },
      Enter: { code: "Enter", vk: 13 },
      Escape: { code: "Escape", vk: 27 }
    };
    const meta = codeMap[key] ?? { code: key, vk: key.charCodeAt(0) };
    const textPayload =
      key === "Enter"
        ? { text: "\r", unmodifiedText: "\r" }
        : key.length === 1
          ? { text: key, unmodifiedText: key }
          : {};
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: meta.code,
      windowsVirtualKeyCode: meta.vk,
      nativeVirtualKeyCode: meta.vk,
      ...textPayload
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: meta.code,
      windowsVirtualKeyCode: meta.vk,
      nativeVirtualKeyCode: meta.vk
    });
    await sleep(120);
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

function findD1SqliteFile(dir) {
  if (!fs.existsSync(dir)) return null;
  let fallback = null;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".sqlite")) {
        if (full.split(path.sep).includes("d1")) {
          return full;
        }
        if (!fallback) {
          fallback = full;
        }
      }
    }
  }
  return fallback;
}

function execD1(d1Dir, sql) {
  const dbFile = findD1SqliteFile(d1Dir);
  if (dbFile) {
    try {
      return execFileSync("sqlite3", ["-cmd", ".timeout 5000", dbFile, sql], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
    } catch {
      // Fallback to wrangler d1 execute below
    }
  }
  return execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      d1Dir,
      "--json",
      "--command",
      sql
    ],
    {
      cwd: workerDir,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  ).trim();
}

async function triggerScheduled(hubUrl) {
  const res = await fetch(`${hubUrl}/cdn-cgi/handler/scheduled`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`triggerScheduled failed: HTTP ${res.status} ${text}`);
  }
  return res.text();
}

async function clickDomMatch(cdp, finderFnSource, label) {
  const box = await cdp.evalJS(`
    (() => {
      const el = (${finderFnSource})();
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
  if (!box) {
    throw new Error(`Element not clickable or invisible (${label})`);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y,
    button: "none",
    clickCount: 0
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1
  });
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
    window.__AHUB_STREAM_SOCKETS__ = [];
    window.__AHUB_EVAL_INJECT_WS__ = (frame) => {
      const openSockets = (window.__AHUB_STREAM_SOCKETS__ || []).filter((s) => s && s.readyState === 1);
      const target = openSockets[openSockets.length - 1];
      if (!target) {
        throw new Error("No open /ws/stream WebSocket available for injection");
      }
      const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
      target.dispatchEvent(new MessageEvent("message", { data: payload }));
      return true;
    };
    (() => {
      const OrigWebSocket = window.WebSocket;
      if (typeof OrigWebSocket === "function") {
        const WrappedWebSocket = function(url, protocols) {
          const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
          if (String(url || "").includes("/ws/stream")) {
            window.__AHUB_STREAM_SOCKETS__.push(ws);
          }
          return ws;
        };
        WrappedWebSocket.prototype = OrigWebSocket.prototype;
        Object.setPrototypeOf(WrappedWebSocket, OrigWebSocket);
        WrappedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
        WrappedWebSocket.OPEN = OrigWebSocket.OPEN;
        WrappedWebSocket.CLOSING = OrigWebSocket.CLOSING;
        WrappedWebSocket.CLOSED = OrigWebSocket.CLOSED;
        window.WebSocket = WrappedWebSocket;
      }
    })();
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
      "--test-scheduled",
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

  // Seed client board key + Slice 1a Board topics/messages before opening browser
  const clientBoardKey = await apiJson(hubUrl, adminToken, "/api/v1/keys", {
    method: "POST",
    body: JSON.stringify({
      name: "cdp-client-board",
      scope: "client",
      allowed_nodes: ["macmini"],
      allowed_board_prefixes: ["proj/demo"]
    })
  });

  const boardTop1Res = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "RFC-0001 跨机协同验收",
      external_ref: "cnb:org/demo#123",
      status: "todo",
      upsert: true
    })
  });
  const boardTop1 = boardTop1Res.topic;

  const boardHandoff1Res = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop1.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "handoff",
      actor_profile: "codex-reviewer",
      source_node: "mbp",
      text_md: "代码评审完成，请执行跨机验收。",
      data: {
        repo: "org/demo",
        branch: "feat/rfc-0001",
        commit_sha: "a1b2c3d",
        pr_url: "https://cnb.cool/org/demo/-/pulls/123",
        next_action: "请在 macmini 执行端到端验证"
      }
    })
  });
  const boardHandoff1 = boardHandoff1Res.message;

  const boardQ1Res = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop1.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "question",
      actor_profile: "agy-worker",
      source_node: "macmini",
      text_md: "检测到下游字段差异，是否按方案 A 合入？",
      question_options: ["按方案 A 推进", "保持兼容分支"]
    })
  });
  const boardQ1 = boardQ1Res.message;
  if (boardQ1Res.topic.status !== "blocked" || boardQ1Res.topic.previous_status !== "todo") {
    throw new Error(`Expected boardTop1 interlocked to blocked(todo), got ${JSON.stringify(boardQ1Res.topic)}`);
  }

  const boardTop2Res = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "ops/fleet",
      title: "机群基线巡检",
      status: "in_progress"
    })
  });
  const boardTop2 = boardTop2Res.topic;
  await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop2.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "note",
      actor_profile: "ops-bot",
      source_node: "macmini",
      text_md: "基线巡检正常。"
    })
  });

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
        if (
          !s ||
          s.nodes.length < 2 ||
          s.threads.length < 2 ||
          s.streamStatus !== "connected" ||
          !Array.isArray(s.boardTopics) ||
          s.boardTopics.length < 2
        ) {
          return null;
        }
        return s;
      })()
    `);
    if (state) break;
    await sleep(250);
  }
  if (!state) throw new Error("UI did not hydrate and connect WebSocket in time");

  // Phase 1 (1440x900): Default 协同板 (board) landing, channel tree, timeline, handoff snapshot & D1 parity
  const phase1Check = await cdpClient.evalJS(`
    (() => {
      const s = window.__AHUB_EVAL__.getState();
      const badge = document.querySelector('[data-testid="inbox-open-badge"]');
      const badgeStyle = badge ? getComputedStyle(badge) : null;
      return {
        workspaceMode: s.workspaceMode,
        hasBoardTab: Boolean(document.querySelector('[data-testid="workspace-tab-board"]')),
        hasInboxTab: Boolean(document.querySelector('[data-testid="workspace-tab-inbox"]')),
        hasRunsTab: Boolean(document.querySelector('[data-testid="workspace-tab-runs"]')),
        hasBoardWorkspace: Boolean(document.querySelector('[data-testid="board-workspace"]')),
        badgeText: badge?.textContent?.trim() ?? "",
        badgeTabular: Boolean(
          badge &&
          (badge.classList.contains("tabular-nums") || (badgeStyle?.fontVariantNumeric ?? "").includes("tabular-nums"))
        ),
        openBoardQuestionCount: s.openBoardQuestionCount,
        hasProjDemoChannel: Boolean(document.querySelector('[data-testid="board-channel-item-proj/demo"]')),
        hasOpsFleetChannel: Boolean(document.querySelector('[data-testid="board-channel-item-ops/fleet"]'))
      };
    })()
  `);
  if (
    phase1Check.workspaceMode !== "board" ||
    !phase1Check.hasBoardTab ||
    !phase1Check.hasInboxTab ||
    !phase1Check.hasRunsTab ||
    !phase1Check.hasBoardWorkspace ||
    phase1Check.badgeText !== "1" ||
    !phase1Check.badgeTabular ||
    phase1Check.openBoardQuestionCount !== 1 ||
    !phase1Check.hasProjDemoChannel ||
    !phase1Check.hasOpsFleetChannel
  ) {
    throw new Error(`Phase 1 default board landing check failed: ${JSON.stringify(phase1Check)}`);
  }

  await cdpClient.clickSelector('[data-testid="board-channel-item-proj/demo"]');
  await sleep(200);
  const channelFilterCheck = await cdpClient.evalJS(`({
    hasTop1: Boolean(document.querySelector('[data-testid="board-topic-item-${boardTop1.id}"]')),
    hasTop2: Boolean(document.querySelector('[data-testid="board-topic-item-${boardTop2.id}"]'))
  })`);
  if (!channelFilterCheck.hasTop1 || channelFilterCheck.hasTop2) {
    throw new Error(`Phase 1 channel tree filtering failed: ${JSON.stringify(channelFilterCheck)}`);
  }

  await cdpClient.clickSelector(`[data-testid="board-topic-item-${boardTop1.id}"]`);
  for (let i = 0; i < 25; i++) {
    const tlReady = await cdpClient.evalJS(`
      Boolean(document.querySelector('[data-testid="board-topic-timeline"]')) &&
      Boolean(document.querySelector('[data-testid="board-message-row-${boardHandoff1.id}"]')) &&
      Boolean(document.querySelector('[data-testid="board-open-question-banner-${boardQ1.id}"]'))
    `);
    if (tlReady) break;
    if (i === 24) throw new Error("Phase 1 topic timeline / handoff / pinned question did not render");
    await sleep(150);
  }
  const boardDetailCheck = await cdpClient.evalJS(`
    (() => {
      const tlText = document.querySelector('[data-testid="board-topic-timeline"]')?.textContent ?? "";
      const snapText = document.querySelector('[data-testid="board-latest-handoff"]')?.textContent ?? "";
      const inspText = document.querySelector('[data-testid="board-topic-inspector"]')?.textContent ?? "";
      return {
        hasReviewer: tlText.includes("codex-reviewer") && tlText.includes("mbp"),
        hasWorker: tlText.includes("agy-worker") && tlText.includes("macmini"),
        hasBranch: snapText.includes("feat/rfc-0001") && snapText.includes("a1b2c3d"),
        hasNextAction: snapText.includes("请在 macmini 执行端到端验证"),
        hasReadCmd: snapText.includes("ahub board read"),
        hasRef: inspText.includes("cnb:org/demo#123")
      };
    })()
  `);
  if (
    !boardDetailCheck.hasReviewer ||
    !boardDetailCheck.hasWorker ||
    !boardDetailCheck.hasBranch ||
    !boardDetailCheck.hasNextAction ||
    !boardDetailCheck.hasReadCmd ||
    !boardDetailCheck.hasRef
  ) {
    throw new Error(`Phase 1 board timeline / handoff snapshot check failed: ${JSON.stringify(boardDetailCheck)}`);
  }

  const d1BoardChannels = (await apiJson(hubUrl, adminToken, "/api/v1/board/channels")).channels;
  const d1BoardTopics = (await apiJson(hubUrl, adminToken, "/api/v1/board/topics")).topics;
  if (
    state.boardChannels.length !== d1BoardChannels.length ||
    state.boardTopics.length !== d1BoardTopics.length
  ) {
    throw new Error(
      `Phase 1 Board UI!=D1 parity mismatch: channels(${state.boardChannels.length}/${d1BoardChannels.length}) topics(${state.boardTopics.length}/${d1BoardTopics.length})`
    );
  }
  await assertViewportContainment(cdpClient, "desktop-1440x900-board");

  // Phase 2 (1440x900): Unified 待决收件箱 (inbox) cross-3-domain aggregation (3 -> 2 -> 1 -> 0)
  await cdpClient.evalJS(`window.__AHUB_CLS__ = 0; window.__AHUB_CLS_SOURCES__ = [];`);
  const inboxApprovalRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsBeta,
      agent: "agy",
      title: "收件箱待审批任务",
      prompt: JSON.stringify({
        summary: "等待收件箱审批",
        directives: [
          {
            op: "soft_approval",
            hold_ms: 15000,
            url: "https://claude.ai/code/session_inbox_approval",
            then: "resume"
          }
        ]
      })
    })
  });
  const inboxApprovalRunId = inboxApprovalRes.run.id;
  for (let i = 0; i < 40; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${inboxApprovalRunId}`);
    if (r.run.status === "needs_approval") break;
    if (i === 39) throw new Error("inboxApprovalRun did not reach needs_approval in time");
    await sleep(200);
  }

  const inboxNativeRes = await apiJson(hubUrl, macKey.token, "/api/v1/nodes/macmini/native-events", {
    method: "POST",
    body: JSON.stringify({
      event_id: "cdp-inbox-native-evt-1",
      agent: "claude",
      event_kind: "interaction_needed",
      native_session_id: "sess_inbox_1",
      workdir: wsAlpha,
      title: "收件箱原生确认",
      summary: "请确认是否继续本地原生操作。",
      source: "hook:Notification"
    })
  });
  const inboxNativeEvtId = inboxNativeRes.event.id;

  let badge3Ready = false;
  for (let i = 0; i < 35; i++) {
    const badgeVal = await cdpClient.evalJS(`document.querySelector('[data-testid="inbox-open-badge"]')?.textContent?.trim() ?? ""`);
    if (badgeVal === "3") {
      badge3Ready = true;
      break;
    }
    await sleep(150);
  }
  if (!badge3Ready) {
    throw new Error("Expected [data-testid='inbox-open-badge'] to reach 3 across board+run+native");
  }
  const inboxBadgeCls = await cdpClient.evalJS(`window.__AHUB_CLS__ ?? 0`);
  if (inboxBadgeCls > 0.001) {
    throw new Error(`Expected CLS <= 0.001 during inbox badge live updates, got ${inboxBadgeCls}`);
  }

  await cdpClient.clickSelector('[data-testid="workspace-tab-inbox"]');
  await sleep(250);
  const inboxPresence = await cdpClient.evalJS(`({
    mode: window.__AHUB_EVAL__.getState().workspaceMode,
    hasPane: Boolean(document.querySelector('[data-testid="pending-inbox"]')),
    hasBoardItem: Boolean(document.querySelector('[data-testid="inbox-item-board:${boardQ1.id}"]')),
    hasRunItem: Boolean(document.querySelector('[data-testid="inbox-item-run:${inboxApprovalRunId}"]')),
    hasNativeItem: Boolean(document.querySelector('[data-testid="inbox-item-native:${inboxNativeEvtId}"]'))
  })`);
  if (
    inboxPresence.mode !== "inbox" ||
    !inboxPresence.hasPane ||
    !inboxPresence.hasBoardItem ||
    !inboxPresence.hasRunItem ||
    !inboxPresence.hasNativeItem
  ) {
    throw new Error(`Phase 2 unified inbox failed to aggregate all 3 domains: ${JSON.stringify(inboxPresence)}`);
  }

  // 0) T6f regression: switching inbox-filter-* on desktop updates both list & inbox-detail-pane cleanly
  await cdpClient.clickSelector(`[data-testid="inbox-item-board:${boardQ1.id}"]`);
  await sleep(150);
  const beforeFilterCheck = await cdpClient.evalJS(`({
    hasOptionBtn: Boolean(document.querySelector('[data-testid="inbox-question-option-0"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
  })`);
  if (!beforeFilterCheck.hasOptionBtn || !beforeFilterCheck.detailText.includes("检测到下游字段差异，是否按方案 A 合入？")) {
    throw new Error(`Phase 2 inbox board selection failed before filter check: ${JSON.stringify(beforeFilterCheck)}`);
  }

  await cdpClient.clickSelector('[data-testid="inbox-filter-runs"]');
  await sleep(150);
  const runsFilterCheck = await cdpClient.evalJS(`({
    listItems: Array.from(document.querySelectorAll('[data-testid^="inbox-item-"]')).map((el) => el.getAttribute('data-testid')),
    hasResolveBtn: Boolean(document.querySelector('[data-testid="inbox-resolve-run-btn"]')),
    hasOptionBtn: Boolean(document.querySelector('[data-testid="inbox-question-option-0"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
  })`);
  if (
    runsFilterCheck.listItems.length !== 1 ||
    runsFilterCheck.listItems[0] !== `inbox-item-run:${inboxApprovalRunId}` ||
    !runsFilterCheck.hasResolveBtn ||
    runsFilterCheck.hasOptionBtn ||
    runsFilterCheck.detailText.includes("检测到下游字段差异，是否按方案 A 合入？") ||
    !runsFilterCheck.detailText.includes(inboxApprovalRunId)
  ) {
    throw new Error(`Phase 2 inbox-filter-runs leaked excluded board item or failed detail sync: ${JSON.stringify(runsFilterCheck)}`);
  }

  await cdpClient.clickSelector('[data-testid="inbox-filter-native"]');
  await sleep(150);
  const nativeFilterCheck = await cdpClient.evalJS(`({
    listItems: Array.from(document.querySelectorAll('[data-testid^="inbox-item-"]')).map((el) => el.getAttribute('data-testid')),
    hasAckBtn: Boolean(document.querySelector('[data-testid="inbox-ack-native-btn"]')),
    hasResolveBtn: Boolean(document.querySelector('[data-testid="inbox-resolve-run-btn"]')),
    hasOptionBtn: Boolean(document.querySelector('[data-testid="inbox-question-option-0"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
  })`);
  if (
    nativeFilterCheck.listItems.length !== 1 ||
    nativeFilterCheck.listItems[0] !== `inbox-item-native:${inboxNativeEvtId}` ||
    !nativeFilterCheck.hasAckBtn ||
    nativeFilterCheck.hasResolveBtn ||
    nativeFilterCheck.hasOptionBtn ||
    nativeFilterCheck.detailText.includes(inboxApprovalRunId) ||
    !nativeFilterCheck.detailText.includes("收件箱原生确认")
  ) {
    throw new Error(`Phase 2 inbox-filter-native failed detail sync: ${JSON.stringify(nativeFilterCheck)}`);
  }

  await cdpClient.clickSelector('[data-testid="inbox-filter-board"]');
  await sleep(150);
  const boardFilterCheck = await cdpClient.evalJS(`({
    listItems: Array.from(document.querySelectorAll('[data-testid^="inbox-item-"]')).map((el) => el.getAttribute('data-testid')),
    hasOptionBtn: Boolean(document.querySelector('[data-testid="inbox-question-option-0"]')),
    hasAckBtn: Boolean(document.querySelector('[data-testid="inbox-ack-native-btn"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
  })`);
  if (
    boardFilterCheck.listItems.length !== 1 ||
    boardFilterCheck.listItems[0] !== `inbox-item-board:${boardQ1.id}` ||
    !boardFilterCheck.hasOptionBtn ||
    boardFilterCheck.hasAckBtn ||
    !boardFilterCheck.detailText.includes("检测到下游字段差异，是否按方案 A 合入？")
  ) {
    throw new Error(`Phase 2 inbox-filter-board failed detail sync: ${JSON.stringify(boardFilterCheck)}`);
  }

  await cdpClient.clickSelector('[data-testid="inbox-filter-all"]');
  await sleep(150);

  // 1) Answer Board question via instant-submit option button inside Inbox -> badge 3 -> 2, Topic 1 restored to todo
  await cdpClient.clickSelector(`[data-testid="inbox-item-board:${boardQ1.id}"]`);
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="inbox-question-option-0"]');
  for (let i = 0; i < 30; i++) {
    const b = await cdpClient.evalJS(`document.querySelector('[data-testid="inbox-open-badge"]')?.textContent?.trim() ?? ""`);
    if (b === "2") break;
    if (i === 29) throw new Error(`Expected inbox badge 3->2 after answering board question, got ${JSON.stringify(b)}`);
    await sleep(150);
  }
  const top1AfterAnswer = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop1.id}/messages`)).topic;
  if (top1AfterAnswer.status !== "todo" || top1AfterAnswer.open_question_count !== 0) {
    throw new Error(`Expected boardTop1 restored to todo after Inbox answer, got ${JSON.stringify(top1AfterAnswer)}`);
  }

  // Empty-filter check: select run item, switch to inbox-filter-board (now 0 items), verify stale detail is hidden, then restore inbox-filter-all
  await cdpClient.clickSelector(`[data-testid="inbox-item-run:${inboxApprovalRunId}"]`);
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="inbox-filter-board"]');
  await sleep(150);
  const emptyBoardFilterCheck = await cdpClient.evalJS(`({
    hasEmptyList: Boolean(document.querySelector('[data-testid="inbox-empty-state"]')),
    hasResolveBtn: Boolean(document.querySelector('[data-testid="inbox-resolve-run-btn"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
  })`);
  if (
    !emptyBoardFilterCheck.hasEmptyList ||
    emptyBoardFilterCheck.hasResolveBtn ||
    emptyBoardFilterCheck.detailText.includes(inboxApprovalRunId) ||
    !emptyBoardFilterCheck.detailText.includes("当前没有待确认或待审批的阻塞事项。")
  ) {
    throw new Error(`Phase 2 empty inbox-filter-board leaked stale run detail: ${JSON.stringify(emptyBoardFilterCheck)}`);
  }
  await cdpClient.clickSelector('[data-testid="inbox-filter-all"]');
  await sleep(150);

  // 2) Resolve needs_approval Run inside Inbox -> badge 2 -> 1, Run -> done
  await cdpClient.clickSelector(`[data-testid="inbox-item-run:${inboxApprovalRunId}"]`);
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="inbox-resolve-run-btn"]');
  for (let i = 0; i < 30; i++) {
    const b = await cdpClient.evalJS(`document.querySelector('[data-testid="inbox-open-badge"]')?.textContent?.trim() ?? ""`);
    if (b === "1") break;
    if (i === 29) throw new Error(`Expected inbox badge 2->1 after resolving run, got ${JSON.stringify(b)}`);
    await sleep(150);
  }
  const resolvedRunD1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${inboxApprovalRunId}`)).run;
  if (resolvedRunD1.status !== "done") {
    throw new Error(`Expected inboxApprovalRun D1 status=done after resolve, got ${resolvedRunD1.status}`);
  }

  // 3) Ack native interaction inside Inbox -> badge 1 -> 0, empty state
  await cdpClient.clickSelector(`[data-testid="inbox-item-native:${inboxNativeEvtId}"]`);
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="inbox-ack-native-btn"]');
  for (let i = 0; i < 30; i++) {
    const emptyCheck = await cdpClient.evalJS(`({
      badge: document.querySelector('[data-testid="inbox-open-badge"]')?.textContent?.trim() ?? "",
      text: document.querySelector('[data-testid="pending-inbox"]')?.textContent ?? ""
    })`);
    if ((emptyCheck.badge === "" || emptyCheck.badge === "0") && emptyCheck.text.includes("当前没有待确认或待审批的阻塞事项。")) {
      break;
    }
    if (i === 29) throw new Error(`Expected inbox badge 1->0 & empty state after ack, got ${JSON.stringify(emptyCheck)}`);
    await sleep(150);
  }
  const ackedNativeD1 = (await apiJson(hubUrl, adminToken, `/api/v1/native-events/${inboxNativeEvtId}`)).event;
  if (!ackedNativeD1.ack_at) {
    throw new Error(`Expected inboxNativeEvt ack_at set in D1, got ${JSON.stringify(ackedNativeD1)}`);
  }

  // Verify answer + restored todo status in Board timeline
  await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
  await sleep(250);
  const boardAfterAnswerCheck = await cdpClient.evalJS(`({
    tlText: document.querySelector('[data-testid="board-topic-timeline"]')?.textContent ?? "",
    topicStatus: window.__AHUB_EVAL__.getState().boardTopics.find(t => t.id === ${JSON.stringify(boardTop1.id)})?.status
  })`);
  if (!boardAfterAnswerCheck.tlText.includes("按方案 A 推进") || boardAfterAnswerCheck.topicStatus !== "todo") {
    throw new Error(`Board timeline did not reflect answer / restored todo status: ${JSON.stringify(boardAfterAnswerCheck)}`);
  }

  // Phase 3: Switch to 执行台 (runs) and execute 100% of legacy regressions untouched
  await cdpClient.clickSelector('[data-testid="workspace-tab-runs"]');
  for (let i = 0; i < 20; i++) {
    if ((await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().workspaceMode`)) === "runs") break;
    if (i === 19) throw new Error("Failed to switch workspaceMode to runs");
    await sleep(100);
  }

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

  // Phase 4: Mobile (360x780 & 390x844) Board & Inbox sticky --safe-bottom Q&A containment + deep link
  const qMobileRes = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop1.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "question",
      actor_profile: "agy-worker",
      source_node: "macmini",
      text_md: "移动端吸底问答检查：请选择处理方式？",
      question_options: ["继续", "暂停"]
    })
  });
  const qMobile = qMobileRes.message;

  for (const [vw, vh] of [[360, 780], [390, 844]]) {
    await cdpClient.setViewport(vw, vh, true);
    await sleep(250);
    await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
    await sleep(250);

    const mobileHeaderTabs = await cdpClient.evalJS(`
      (() => {
        const els = Array.from(document.querySelectorAll('[data-testid="workspace-tab-board"], [data-testid="workspace-tab-inbox"], [data-testid="workspace-tab-runs"]'));
        return els.map((el) => {
          const r = el.getBoundingClientRect();
          return { testid: el.getAttribute("data-testid"), w: r.width, h: r.height };
        });
      })()
    `);
    if (mobileHeaderTabs.length !== 3 || mobileHeaderTabs.some((t) => t.w < 43.5 || t.h < 43.5)) {
      throw new Error(`Mobile ${vw}x${vh} topbar workspace switcher < 44px: ${JSON.stringify(mobileHeaderTabs)}`);
    }

    const hasBoardChannelTrigger = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="board-mobile-channels-trigger"]'))`);
    await cdpClient.clickSelector(hasBoardChannelTrigger ? '[data-testid="board-mobile-channels-trigger"]' : '[data-testid="mobile-left-trigger"]');
    await sleep(250);
    await cdpClient.clickSelector('[data-testid="board-channel-item-proj/demo"]');
    await sleep(200);
    await cdpClient.clickSelector(`[data-testid="board-topic-item-${boardTop1.id}"]`);
    await sleep(250);

    await assertViewportContainment(cdpClient, `mobile-${vw}x${vh}-board-qa`);
    const mobileBoardQA = await cdpClient.evalJS(`
      (() => {
        const bar = document.querySelector('[data-testid="board-mobile-qa-bar"]');
        const scroller = document.querySelector('[data-testid="board-messages-list"]');
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        const barRect = bar ? bar.getBoundingClientRect() : null;
        const backBtn = document.querySelector('[data-testid="board-mobile-back-btn"]');
        const backRect = backBtn ? backBtn.getBoundingClientRect() : null;
        const inputEl = document.querySelector('[data-testid="board-mobile-answer-input"]');
        const inputFont = inputEl ? parseFloat(getComputedStyle(inputEl).fontSize) : 0;
        const btns = bar ? Array.from(bar.querySelectorAll("button")) : [];
        const undersized = btns
          .map((b) => {
            const r = b.getBoundingClientRect();
            return { text: b.textContent?.trim(), w: r.width, h: r.height };
          })
          .filter((b) => b.w > 0 && b.h > 0 && (b.w < 43.5 || b.h < 43.5));
        return {
          hasQuestionRow: Boolean(document.querySelector('[data-testid="board-message-row-${qMobile.id}"]')),
          barRect: barRect ? { top: barRect.top, bottom: barRect.bottom, width: barRect.width, height: barRect.height } : null,
          backRect: backRect ? { w: backRect.width, h: backRect.height } : null,
          innerHeight: window.innerHeight,
          inputFont,
          undersized
        };
      })()
    `);
    if (
      !mobileBoardQA.hasQuestionRow ||
      !mobileBoardQA.barRect ||
      mobileBoardQA.barRect.height <= 0 ||
      mobileBoardQA.barRect.top < 0 ||
      mobileBoardQA.barRect.bottom > mobileBoardQA.innerHeight + 1 ||
      mobileBoardQA.barRect.bottom < mobileBoardQA.innerHeight - 24 ||
      !mobileBoardQA.backRect ||
      mobileBoardQA.backRect.w < 43.5 ||
      mobileBoardQA.backRect.h < 43.5 ||
      !(mobileBoardQA.inputFont >= 16) ||
      mobileBoardQA.undersized.length > 0
    ) {
      throw new Error(`Mobile ${vw}x${vh} Board sticky Q&A check failed: ${JSON.stringify(mobileBoardQA)}`);
    }

    await cdpClient.clickSelector('[data-testid="board-mobile-back-btn"]');
    await sleep(200);

    await cdpClient.clickSelector('[data-testid="workspace-tab-inbox"]');
    await sleep(250);
    await cdpClient.clickSelector(`[data-testid="inbox-item-board:${qMobile.id}"]`);
    await sleep(250);
    await assertViewportContainment(cdpClient, `mobile-${vw}x${vh}-inbox-qa`);
    const mobileInboxQA = await cdpClient.evalJS(`
      (() => {
        const detail = document.querySelector('[data-testid="inbox-detail-pane"]');
        const scroller = detail ? detail.querySelector('.overflow-y-auto') : null;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        const bar = document.querySelector('[data-testid="inbox-action-bar"]');
        const barRect = bar ? bar.getBoundingClientRect() : null;
        const backBtn = document.querySelector('[data-testid="inbox-mobile-back-btn"]');
        const backRect = backBtn ? backBtn.getBoundingClientRect() : null;
        const inputEl = document.querySelector('[data-testid="inbox-answer-input"]');
        const inputFont = inputEl ? parseFloat(getComputedStyle(inputEl).fontSize) : 0;
        const btns = bar ? Array.from(bar.querySelectorAll("button")) : [];
        const undersized = btns
          .map((b) => {
            const r = b.getBoundingClientRect();
            return { text: b.textContent?.trim(), w: r.width, h: r.height };
          })
          .filter((b) => b.w > 0 && b.h > 0 && (b.w < 43.5 || b.h < 43.5));
        return {
          hasDetail: Boolean(detail),
          barRect: barRect ? { top: barRect.top, bottom: barRect.bottom, width: barRect.width, height: barRect.height } : null,
          backRect: backRect ? { w: backRect.width, h: backRect.height } : null,
          innerHeight: window.innerHeight,
          inputFont,
          undersized
        };
      })()
    `);
    if (
      !mobileInboxQA.hasDetail ||
      !mobileInboxQA.barRect ||
      mobileInboxQA.barRect.height <= 0 ||
      mobileInboxQA.barRect.top < 0 ||
      mobileInboxQA.barRect.bottom > mobileInboxQA.innerHeight + 1 ||
      mobileInboxQA.barRect.bottom < mobileInboxQA.innerHeight - 24 ||
      !mobileInboxQA.backRect ||
      mobileInboxQA.backRect.w < 43.5 ||
      mobileInboxQA.backRect.h < 43.5 ||
      !(mobileInboxQA.inputFont >= 16) ||
      mobileInboxQA.undersized.length > 0
    ) {
      throw new Error(`Mobile ${vw}x${vh} Inbox sticky Q&A check failed: ${JSON.stringify(mobileInboxQA)}`);
    }
    await cdpClient.clickSelector('[data-testid="inbox-mobile-back-btn"]');
    await sleep(200);
  }

  // Deep link routing check: /?workspace=inbox&source=board&id=<msgId>
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.send("Page.navigate", { url: `${hubUrl}/?workspace=inbox&source=board&id=${qMobile.id}` });
  let deepLinkOK = false;
  for (let i = 0; i < 40; i++) {
    const dl = await cdpClient.evalJS(`({
      mode: window.__AHUB_EVAL__?.getState()?.workspaceMode,
      detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? ""
    })`);
    if (dl.mode === "inbox" && dl.detailText.includes("移动端吸底问答检查")) {
      deepLinkOK = true;
      break;
    }
    await sleep(200);
  }
  if (!deepLinkOK) {
    throw new Error(`Deep link /?workspace=inbox&source=board&id=${qMobile.id} did not route to inbox detail`);
  }

  // Text draft + explicit submit button check (on a separate question, preserving qMobile open for Phase 5)
  const qTextDraftRes = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${boardTop1.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "question",
      actor_profile: "agy-worker",
      source_node: "macmini",
      text_md: "自由文本答复输入框测试问题",
      question_options: []
    })
  });
  const qTextDraft = qTextDraftRes.message;
  for (let i = 0; i < 30; i++) {
    const hasDraftItem = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="inbox-item-board:${qTextDraft.id}"]'))`);
    if (hasDraftItem) break;
    if (i === 29) throw new Error("qTextDraft did not appear in Inbox in time");
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="inbox-item-board:${qTextDraft.id}"]`);
  await sleep(150);
  const submitDisabledInitially = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="inbox-answer-submit-btn"]')?.disabled)`);
  if (!submitDisabledInitially) {
    throw new Error("Expected inbox-answer-submit-btn to be disabled when draft is empty");
  }
  await cdpClient.fillInput('[data-testid="inbox-answer-input"]', "通过文本输入框提交的答复");
  await sleep(100);
  await cdpClient.clickSelector('[data-testid="inbox-answer-submit-btn"]');
  for (let i = 0; i < 30; i++) {
    const badgeVal = await cdpClient.evalJS(`document.querySelector('[data-testid="inbox-open-badge"]')?.textContent?.trim() ?? ""`);
    const stillInInbox = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="inbox-item-board:${qTextDraft.id}"]'))`);
    if (badgeVal === "1" && !stillInInbox) break;
    if (i === 29) throw new Error(`Text draft submit did not resolve qTextDraft (badge=${badgeVal}, stillInInbox=${stillInInbox})`);
    await sleep(150);
  }

  // Phase 4b: RFC-0001 Slice 1b — 3-view switcher, 4-col @dnd-kit Kanban, <768px pills, Recent Topics & J/K/1-4/Enter/Esc
  const kbTopicARes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 1b 看板任务 A",
      status: "todo"
    })
  });
  const kbTopicA = kbTopicARes.topic;

  const kbTopicBRes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 1b 看板任务 B",
      status: "todo"
    })
  });
  const kbTopicB = kbTopicBRes.topic;

  const kbPinnedTopicRes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 1b 看板置顶任务 P",
      status: "todo",
      pinned: true
    })
  });
  const kbPinnedTopic = kbPinnedTopicRes.topic;

  const kbRecentRes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "ops/fleet",
      title: "Slice 1b 近期动态跨频道任务",
      status: "in_progress"
    })
  });
  const kbRecentTopic = kbRecentRes.topic;

  const kbLongChannelRes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "org/long-channel-name-for-mobile-360px-button-clipping-check",
      title: "Slice 1b 超长频道名移动端按钮截断检查",
      status: "todo"
    })
  });
  const kbLongChannelTopic = kbLongChannelRes.topic;

  const kbQTopic1Res = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 1b 收件箱键盘作答主题",
      status: "todo"
    })
  });
  const kbQTopic1 = kbQTopic1Res.topic;
  const kbInboxQ1Res = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbQTopic1.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "question",
      actor_profile: "agy-worker",
      source_node: "macmini",
      text_md: "Slice 1b 收件箱快捷键作答测试问题？",
      question_options: ["选项甲", "选项乙"]
    })
  });
  const kbInboxQ1 = kbInboxQ1Res.message;

  const kbQTopic2Res = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 1b 协同板详情快捷键作答主题",
      status: "todo"
    })
  });
  const kbQTopic2 = kbQTopic2Res.topic;
  const kbBoardQ2Res = await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbQTopic2.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      kind: "question",
      actor_profile: "codex-worker",
      source_node: "macmini",
      text_md: "Slice 1b 协同板详情快捷键作答测试问题？",
      question_options: ["同意方案一", "保持现状"]
    })
  });
  const kbBoardQ2 = kbBoardQ2Res.message;

  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
  for (let i = 0; i < 30; i++) {
    const hydrated1b = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__?.getState();
        if (!s || s.workspaceMode !== "board") return false;
        const ids = new Set(s.boardTopics.map(t => t.id));
        return ids.has(${JSON.stringify(kbTopicA.id)}) &&
          ids.has(${JSON.stringify(kbTopicB.id)}) &&
          ids.has(${JSON.stringify(kbPinnedTopic.id)}) &&
          ids.has(${JSON.stringify(kbRecentTopic.id)}) &&
          ids.has(${JSON.stringify(kbLongChannelTopic.id)}) &&
          ids.has(${JSON.stringify(kbQTopic1.id)}) &&
          ids.has(${JSON.stringify(kbQTopic2.id)});
      })()
    `);
    if (hydrated1b) break;
    if (i === 29) throw new Error("Slice 1b seeded board topics did not hydrate via WebSocket in time");
    await sleep(150);
  }

  // 1) Central 3-view switcher: 话题流 | 列表 | 看板
  const switcherCheck = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    hasSwitcher: Boolean(document.querySelector('[data-testid="board-view-switcher"]')),
    hasTimelineTab: Boolean(document.querySelector('[data-testid="board-view-tab-timeline"]')),
    hasListTab: Boolean(document.querySelector('[data-testid="board-view-tab-list"]')),
    hasKanbanTab: Boolean(document.querySelector('[data-testid="board-view-tab-kanban"]'))
  })`);
  if (
    switcherCheck.viewMode !== "timeline" ||
    !switcherCheck.hasSwitcher ||
    !switcherCheck.hasTimelineTab ||
    !switcherCheck.hasListTab ||
    !switcherCheck.hasKanbanTab
  ) {
    throw new Error(`Slice 1b 3-view switcher check failed: ${JSON.stringify(switcherCheck)}`);
  }

  // Regression: focusing a <button> (board-new-topic-btn / board-view-tab-kanban) + Enter activates the button cleanly without shortcut hijack
  const focusedNewBtn = await cdpClient.evalJS(`(() => {
    const btn = document.querySelector('[data-testid="board-new-topic-btn"]');
    if (!(btn instanceof HTMLElement)) return false;
    btn.focus();
    return document.activeElement === btn;
  })()`);
  if (!focusedNewBtn) {
    throw new Error("Slice 1b failed to focus board-new-topic-btn");
  }
  await cdpClient.pressKey("Enter");
  await sleep(150);
  const newDialogOpenedByEnter = await cdpClient.evalJS(
    `Boolean(document.querySelector('[data-testid="board-new-topic-dialog"]'))`
  );
  if (!newDialogOpenedByEnter) {
    throw new Error("Slice 1b regression: Enter on focused board-new-topic-btn did not open dialog (hijacked)");
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);

  const focusedKanbanTab = await cdpClient.evalJS(`(() => {
    const btn = document.querySelector('[data-testid="board-view-tab-kanban"]');
    if (!(btn instanceof HTMLElement)) return false;
    btn.focus();
    return document.activeElement === btn;
  })()`);
  if (!focusedKanbanTab) {
    throw new Error("Slice 1b failed to focus board-view-tab-kanban");
  }
  await cdpClient.pressKey("Enter");
  await sleep(150);
  const kanbanTabActivatedByEnter = await cdpClient.evalJS(
    `window.__AHUB_EVAL__.getState().boardViewMode`
  );
  if (kanbanTabActivatedByEnter !== "kanban") {
    throw new Error(`Slice 1b regression: Enter on focused board-view-tab-kanban did not switch to kanban (got ${kanbanTabActivatedByEnter})`);
  }
  await cdpClient.clickSelector('[data-testid="board-view-tab-timeline"]');
  await sleep(150);

  await cdpClient.clickSelector('[data-testid="board-view-tab-list"]');
  await sleep(150);
  const listViewCheck = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    hasListView: Boolean(document.querySelector('[data-testid="board-list-view"]')),
    hasTopicA: Boolean(document.querySelector('[data-testid="board-list-item-${kbTopicA.id}"]'))
  })`);
  if (listViewCheck.viewMode !== "list" || !listViewCheck.hasListView || !listViewCheck.hasTopicA) {
    throw new Error(`Slice 1b list view check failed: ${JSON.stringify(listViewCheck)}`);
  }

  // 2) Unselected-channel Kanban guard + 1-click channel switch
  await cdpClient.clickSelector('[data-testid="board-filter-active"]');
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="board-view-tab-kanban"]');
  await sleep(200);
  const kanbanGuardCheck = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedChannel: window.__AHUB_EVAL__.getState().selectedBoardChannel,
    hasKanbanView: Boolean(document.querySelector('[data-testid="board-kanban-view"]')),
    hasChannelGuard: Boolean(document.querySelector('[data-testid="board-kanban-channel-guard"]')),
    hasSwitchBtn: Boolean(document.querySelector('[data-testid="board-kanban-switch-channel-proj/demo"]')),
    cols: ["todo", "in_progress", "blocked", "done"].filter(s => Boolean(document.querySelector('[data-testid="board-kanban-column-' + s + '"]'))),
    hasArchivedCol: Boolean(document.querySelector('[data-testid="board-kanban-column-archived"]'))
  })`);
  if (
    kanbanGuardCheck.viewMode !== "kanban" ||
    kanbanGuardCheck.selectedChannel !== null ||
    !kanbanGuardCheck.hasKanbanView ||
    !kanbanGuardCheck.hasChannelGuard ||
    !kanbanGuardCheck.hasSwitchBtn ||
    kanbanGuardCheck.cols.length !== 4 ||
    kanbanGuardCheck.hasArchivedCol
  ) {
    throw new Error(`Slice 1b Kanban unselected-channel guard check failed: ${JSON.stringify(kanbanGuardCheck)}`);
  }

  await cdpClient.clickSelector('[data-testid="board-kanban-switch-channel-proj/demo"]');
  await sleep(200);
  const kanbanChannelSwitched = await cdpClient.evalJS(`({
    selectedChannel: window.__AHUB_EVAL__.getState().selectedBoardChannel,
    hasChannelGuard: Boolean(document.querySelector('[data-testid="board-kanban-channel-guard"]')),
    todoCardIds: Array.from(document.querySelectorAll('[data-testid="board-kanban-column-todo"] [data-testid^="board-kanban-card-"]')).map(el => el.getAttribute("data-topic-id"))
  })`);
  if (
    kanbanChannelSwitched.selectedChannel !== "proj/demo" ||
    kanbanChannelSwitched.hasChannelGuard ||
    !kanbanChannelSwitched.todoCardIds.includes(kbTopicA.id) ||
    !kanbanChannelSwitched.todoCardIds.includes(kbTopicB.id)
  ) {
    throw new Error(`Slice 1b Kanban 1-click channel switch failed: ${JSON.stringify(kanbanChannelSwitched)}`);
  }

  // Regression: Kanban card selection button and drag-handle button must be siblings (zero nested interactive controls)
  const nestedInteractiveCheck = await cdpClient.evalJS(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid^="board-kanban-card-"]'));
    const handles = Array.from(document.querySelectorAll('[data-testid^="board-kanban-drag-handle-"]'));
    const cardViolations = cards
      .filter((card) => Boolean(card.querySelector('button, [role="button"], a[href]')))
      .map((card) => card.getAttribute('data-testid'));
    const handleViolations = handles
      .filter((handle) => Boolean(handle.parentElement?.closest('button, [role="button"], a[href]')))
      .map((handle) => handle.getAttribute('data-testid'));
    return {
      cardCount: cards.length,
      handleCount: handles.length,
      cardViolations,
      handleViolations
    };
  })()`);
  if (
    nestedInteractiveCheck.cardCount < 3 ||
    nestedInteractiveCheck.handleCount < 3 ||
    nestedInteractiveCheck.cardViolations.length > 0 ||
    nestedInteractiveCheck.handleViolations.length > 0
  ) {
    throw new Error(`Slice 1b Kanban nested interactive violation: ${JSON.stringify(nestedInteractiveCheck)}`);
  }

  // 3) Single-channel @dnd-kit Kanban intra-column reorder (respecting pinned/unpinned partition) + cross-column drag + D1 persistence
  const todoBefore = kanbanChannelSwitched.todoCardIds;
  if (todoBefore.length < 3 || todoBefore[0] !== kbPinnedTopic.id) {
    throw new Error(`Slice 1b expected pinned ${kbPinnedTopic.id} first + >= 2 unpinned cards in todo, got ${JSON.stringify(todoBefore)}`);
  }
  // Regression: dragging unpinned card onto pinned card in same column must NOT cause snapback or reorder above pinned
  await cdpClient.dragBetween(
    `[data-testid="board-kanban-card-${todoBefore[2]}"]`,
    `[data-testid="board-kanban-card-${kbPinnedTopic.id}"]`
  );
  await sleep(250);
  const todoAfterBoundary = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid="board-kanban-column-todo"] [data-testid^="board-kanban-card-"]')).map(el => el.getAttribute("data-topic-id"))`
  );
  const d1TodoAfterBoundary = (await apiJson(hubUrl, adminToken, "/api/v1/board/topics?channel=proj/demo&status=todo&sort=order")).topics;
  if (todoAfterBoundary[0] !== kbPinnedTopic.id || d1TodoAfterBoundary[0]?.id !== kbPinnedTopic.id) {
    throw new Error(`Slice 1b Kanban pinned boundary violation: UI=${JSON.stringify(todoAfterBoundary)} D1=${JSON.stringify(d1TodoAfterBoundary.map(t => t.id))}`);
  }

  const firstTodoId = todoBefore[1];
  const secondTodoId = todoBefore[2];
  await cdpClient.dragBetween(
    `[data-testid="board-kanban-card-${secondTodoId}"]`,
    `[data-testid="board-kanban-card-${firstTodoId}"]`
  );
  for (let i = 0; i < 25; i++) {
    const todoAfter = await cdpClient.evalJS(
      `Array.from(document.querySelectorAll('[data-testid="board-kanban-column-todo"] [data-testid^="board-kanban-card-"]')).map(el => el.getAttribute("data-topic-id"))`
    );
    if (todoAfter[0] === kbPinnedTopic.id && todoAfter[1] === secondTodoId && todoAfter[2] === firstTodoId) break;
    if (i === 24) throw new Error(`Slice 1b Kanban intra-column DnD reorder failed: expected [${kbPinnedTopic.id}, ${secondTodoId}, ${firstTodoId}], got ${JSON.stringify(todoAfter)}`);
    await sleep(150);
  }
  const d1TodoOrder = (await apiJson(hubUrl, adminToken, "/api/v1/board/topics?channel=proj/demo&status=todo&sort=order")).topics;
  if (d1TodoOrder[0]?.id !== kbPinnedTopic.id || d1TodoOrder[1]?.id !== secondTodoId || d1TodoOrder[2]?.id !== firstTodoId) {
    throw new Error(`Slice 1b Kanban intra-column reorder D1 mismatch: expected [${kbPinnedTopic.id}, ${secondTodoId}, ${firstTodoId}], got ${JSON.stringify(d1TodoOrder.map(t => ({ id: t.id, pinned: t.pinned, sort_order: t.sort_order })))}`);
  }

  // Cross-column drag: kbTopicA (todo) -> in_progress column
  await cdpClient.dragBetween(
    `[data-testid="board-kanban-card-${kbTopicA.id}"]`,
    `[data-testid="board-kanban-column-in_progress"]`
  );
  for (let i = 0; i < 25; i++) {
    const inProgIds = await cdpClient.evalJS(
      `Array.from(document.querySelectorAll('[data-testid="board-kanban-column-in_progress"] [data-testid^="board-kanban-card-"]')).map(el => el.getAttribute("data-topic-id"))`
    );
    if (inProgIds.includes(kbTopicA.id)) break;
    if (i === 24) throw new Error(`Slice 1b Kanban cross-column DnD failed: ${kbTopicA.id} did not move to in_progress`);
    await sleep(150);
  }
  const d1TopicAAfterDrag = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbTopicA.id}/messages`)).topic;
  if (d1TopicAAfterDrag.status !== "in_progress") {
    throw new Error(`Slice 1b Kanban cross-column D1 persistence failed: expected in_progress, got ${d1TopicAAfterDrag.status}`);
  }

  // 4) < 768px (360x780 & 390x844) Kanban mobile degradation (segmented pills + single list + 0 overflow)
  for (const [vw, vh] of [[360, 780], [390, 844]]) {
    await cdpClient.setViewport(vw, vh, true);
    await sleep(250);
    await assertViewportContainment(cdpClient, `mobile-${vw}x${vh}-board-kanban`);
    const mobileKanbanCheck = await cdpClient.evalJS(`
      (() => {
        const hasDesktopCols = Boolean(document.querySelector('[data-testid="board-kanban-column-todo"]'));
        const hasPills = Boolean(document.querySelector('[data-testid="board-kanban-mobile-pills"]'));
        const hasList = Boolean(document.querySelector('[data-testid="board-kanban-mobile-list"]'));
        const pills = ["todo", "in_progress", "blocked", "done"].map((st) => {
          const el = document.querySelector('[data-testid="board-kanban-mobile-pill-' + st + '"]');
          const r = el ? el.getBoundingClientRect() : null;
          return { st, w: r?.width ?? 0, h: r?.height ?? 0, text: el?.textContent?.trim() ?? "" };
        });
        const viewTabs = ["timeline", "list", "kanban"].map((vm) => {
          const el = document.querySelector('[data-testid="board-view-tab-' + vm + '"]');
          const r = el ? el.getBoundingClientRect() : null;
          return { vm, w: r?.width ?? 0, h: r?.height ?? 0 };
        });
        return { hasDesktopCols, hasPills, hasList, pills, viewTabs };
      })()
    `);
    if (
      mobileKanbanCheck.hasDesktopCols ||
      !mobileKanbanCheck.hasPills ||
      !mobileKanbanCheck.hasList ||
      mobileKanbanCheck.pills.some((p) => p.w < 43.5 || p.h < 43.5) ||
      mobileKanbanCheck.viewTabs.some((t) => t.w < 43.5 || t.h < 43.5)
    ) {
      throw new Error(`Slice 1b Mobile ${vw}x${vh} Kanban degradation failed: ${JSON.stringify(mobileKanbanCheck)}`);
    }

    await cdpClient.clickSelector('[data-testid="board-kanban-mobile-pill-in_progress"]');
    await sleep(150);
    const mobileInProgHasA = await cdpClient.evalJS(
      `Boolean(document.querySelector('[data-testid="board-kanban-mobile-list"] [data-testid="board-kanban-card-${kbTopicA.id}"]'))`
    );
    if (!mobileInProgHasA) {
      throw new Error(`Slice 1b Mobile ${vw}x${vh} Kanban pill in_progress missing ${kbTopicA.id}`);
    }
    await assertViewportContainment(cdpClient, `mobile-${vw}x${vh}-board-kanban-in-progress`);
    if (vw === 360) {
      const hasBoardChannelTrigger = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="board-mobile-channels-trigger"]'))`);
      await cdpClient.clickSelector(hasBoardChannelTrigger ? '[data-testid="board-mobile-channels-trigger"]' : '[data-testid="mobile-left-trigger"]');
      await sleep(250);
      await cdpClient.clickSelector('[data-testid="board-filter-active"]');
      await sleep(200);
      const longBtnClip = await cdpClient.evalJS(`(() => {
        const btns = Array.from(document.querySelectorAll('[data-testid^="board-kanban-switch-channel-"]'));
        return btns.map(b => {
          const r = b.getBoundingClientRect();
          return { id: b.getAttribute("data-testid"), left: r.left, right: r.right, width: r.width, vw: window.innerWidth };
        });
      })()`);
      if (longBtnClip.length === 0 || longBtnClip.some((b) => b.right > 360 + 1 || b.left < -1)) {
        throw new Error(`Slice 1b Mobile 360px channel switch button clipped/overflowed: ${JSON.stringify(longBtnClip)}`);
      }
      await assertViewportContainment(cdpClient, "mobile-360x780-board-kanban-channel-guard");
      await cdpClient.clickSelector('[data-testid="board-kanban-switch-channel-proj/demo"]');
      await sleep(200);
    }
  }

  // 5) Single-channel desktop Kanban card Enter & J+Enter regression (must open detail, not trigger @dnd-kit KeyboardSensor drag)
  await cdpClient.setViewport(1440, 900, false);
  await sleep(200);
  const kanbanDesktopCards = await cdpClient.evalJS(`
    ["todo", "in_progress", "blocked", "done"].flatMap((st) =>
      Array.from(document.querySelectorAll('[data-testid="board-kanban-column-' + st + '"] [data-testid^="board-kanban-card-"]'))
        .map((el) => el.getAttribute("data-topic-id"))
        .filter(Boolean)
    )
  `);
  if (kanbanDesktopCards.length < 2) {
    throw new Error(`Slice 1b Kanban Enter regression expected >= 2 cards, got ${JSON.stringify(kanbanDesktopCards)}`);
  }
  const kanbanCard1 = kanbanDesktopCards[0];
  const kanbanCard2 = kanbanDesktopCards[1];

  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterKanbanCardEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterKanbanCardEnter.viewMode !== "timeline" || afterKanbanCardEnter.selectedTopicId !== kanbanCard1) {
    throw new Error(`Slice 1b regression: click Kanban card + Enter failed to open detail (expected timeline/${kanbanCard1}, got ${JSON.stringify(afterKanbanCardEnter)})`);
  }

  await cdpClient.pressKey("Escape");
  await sleep(150);
  const backToKanban = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().boardViewMode`);
  if (backToKanban !== "kanban") {
    throw new Error(`Slice 1b regression: Escape from Kanban detail did not return to kanban (got ${backToKanban})`);
  }

  // Space on focused board-kanban-card-* must also activate the card and enter detail
  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  await cdpClient.pressKey(" ");
  await sleep(200);
  const afterKanbanCardSpace = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterKanbanCardSpace.viewMode !== "timeline" || afterKanbanCardSpace.selectedTopicId !== kanbanCard1) {
    throw new Error(`Slice 1b regression: Space on focused Kanban card failed to open detail (expected timeline/${kanbanCard1}, got ${JSON.stringify(afterKanbanCardSpace)})`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);
  const backToKanbanAfterSpace = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().boardViewMode`);
  if (backToKanbanAfterSpace !== "kanban") {
    throw new Error(`Slice 1b regression: Escape after Space detail did not return to kanban (got ${backToKanbanAfterSpace})`);
  }

  // Focus drag handle -> J -> Enter blurs handle, moves focus to next card button, and opens detail
  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  const focusedHandle = await cdpClient.evalJS(`(() => {
    const h = document.querySelector('[data-testid="board-kanban-drag-handle-${kanbanCard1}"]');
    if (!(h instanceof HTMLElement)) return false;
    h.focus();
    return document.activeElement === h;
  })()`);
  if (!focusedHandle) {
    throw new Error(`Slice 1b failed to focus board-kanban-drag-handle-${kanbanCard1}`);
  }
  await cdpClient.pressKey("j");
  await sleep(150);
  const afterHandleJ = await cdpClient.evalJS(`({
    focusedTopicId: window.__AHUB_EVAL__.getState().focusedBoardTopicId,
    activeTestId: document.activeElement?.getAttribute("data-testid") ?? null
  })`);
  if (
    afterHandleJ.focusedTopicId !== kanbanCard2 ||
    afterHandleJ.activeTestId !== `board-kanban-card-${kanbanCard2}`
  ) {
    throw new Error(`Slice 1b regression: J from Kanban drag handle did not move DOM focus to ${kanbanCard2}: ${JSON.stringify(afterHandleJ)}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterHandleJEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterHandleJEnter.viewMode !== "timeline" || afterHandleJEnter.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: focus drag handle + J + Enter failed to open ${kanbanCard2}: ${JSON.stringify(afterHandleJEnter)}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);

  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  await cdpClient.pressKey("j");
  await sleep(150);
  const afterKanbanCardJ = await cdpClient.evalJS(`({
    focusedTopicId: window.__AHUB_EVAL__.getState().focusedBoardTopicId,
    activeTestId: document.activeElement?.getAttribute("data-testid") ?? null
  })`);
  if (
    afterKanbanCardJ.focusedTopicId !== kanbanCard2 ||
    afterKanbanCardJ.activeTestId !== `board-kanban-card-${kanbanCard2}`
  ) {
    throw new Error(`Slice 1b regression: J from Kanban card did not move DOM focus to next card ${kanbanCard2}: ${JSON.stringify(afterKanbanCardJ)}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterKanbanCardJEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterKanbanCardJEnter.viewMode !== "timeline" || afterKanbanCardJEnter.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: click Kanban card + J + Enter failed to open next topic ${kanbanCard2}: ${JSON.stringify(afterKanbanCardJEnter)}`);
  }

  // Exit detail back to kanban for Tab+Space / Tab+Enter / rapid synchronous J+Enter checks
  await cdpClient.pressKey("Escape");
  await sleep(150);

  // Tab twice from kanbanCard1 onto kanbanCard2 + Space must open kanbanCard2 (not stale kanbanCard1)
  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  const preTabKanbanFocus = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`);
  if (preTabKanbanFocus !== kanbanCard1) {
    throw new Error(`Slice 1b Tab+Space setup expected focusedBoardTopicId=${kanbanCard1}, got ${preTabKanbanFocus}`);
  }
  await cdpClient.pressKey("Tab");
  await cdpClient.pressKey("Tab");
  const tabSpaceTargetEl = await cdpClient.evalJS(
    `document.activeElement?.getAttribute("data-testid") ?? null`
  );
  if (tabSpaceTargetEl !== `board-kanban-card-${kanbanCard2}`) {
    throw new Error(`Slice 1b Tab twice from ${kanbanCard1} expected activeElement board-kanban-card-${kanbanCard2}, got ${tabSpaceTargetEl}`);
  }
  await cdpClient.pressKey(" ");
  await sleep(200);
  const afterTabSpace = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterTabSpace.viewMode !== "timeline" || afterTabSpace.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: Tab+Space on board-kanban-card-${kanbanCard2} opened ${JSON.stringify(afterTabSpace)}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);

  // Tab twice from kanbanCard1 onto kanbanCard2 + Enter must also open kanbanCard2
  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  await cdpClient.pressKey("Tab");
  await cdpClient.pressKey("Tab");
  const tabEnterTargetEl = await cdpClient.evalJS(
    `document.activeElement?.getAttribute("data-testid") ?? null`
  );
  if (tabEnterTargetEl !== `board-kanban-card-${kanbanCard2}`) {
    throw new Error(`Slice 1b Tab+Enter expected activeElement board-kanban-card-${kanbanCard2}, got ${tabEnterTargetEl}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterTabEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterTabEnter.viewMode !== "timeline" || afterTabEnter.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: Tab+Enter on board-kanban-card-${kanbanCard2} opened ${JSON.stringify(afterTabEnter)}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);

  // Rapid synchronous J + Enter (before rAF/re-render) must move DOM focus synchronously and open kanbanCard2
  await cdpClient.clickSelector(`[data-testid="board-kanban-card-${kanbanCard1}"]`);
  await sleep(120);
  await cdpClient.evalJS(`(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  })()`);
  await sleep(200);
  const afterSyncJEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterSyncJEnter.viewMode !== "timeline" || afterSyncJEnter.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: rapid synchronous J+Enter opened ${JSON.stringify(afterSyncJEnter)} instead of ${kanbanCard2}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);

  // List view Tab onto board-list-item-${kanbanCard2} + Enter must open kanbanCard2
  await cdpClient.clickSelector('[data-testid="board-view-tab-list"]');
  await sleep(150);
  const listOrderForTab = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="board-list-item-"]')).map(el => el.getAttribute("data-topic-id")).filter(Boolean)`
  );
  const card2ListIdx = listOrderForTab.indexOf(kanbanCard2);
  if (card2ListIdx < 1) {
    throw new Error(`Slice 1b list Tab+Enter expected ${kanbanCard2} at index >= 1, got ${JSON.stringify(listOrderForTab)}`);
  }
  const listPrevId = listOrderForTab[card2ListIdx - 1];
  await cdpClient.clickSelector(`[data-testid="board-list-item-${listPrevId}"]`);
  await sleep(150);
  await cdpClient.pressKey("Escape");
  await sleep(150);
  const focusedListPrev = await cdpClient.evalJS(`(() => {
    const el = document.querySelector('[data-testid="board-list-item-${listPrevId}"]');
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!focusedListPrev) {
    throw new Error(`Slice 1b failed to focus board-list-item-${listPrevId}`);
  }
  await cdpClient.pressKey("Tab");
  const listTabTargetEl = await cdpClient.evalJS(
    `document.activeElement?.getAttribute("data-testid") ?? null`
  );
  if (listTabTargetEl !== `board-list-item-${kanbanCard2}`) {
    throw new Error(`Slice 1b list Tab expected activeElement board-list-item-${kanbanCard2}, got ${listTabTargetEl}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterListTabEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterListTabEnter.viewMode !== "timeline" || afterListTabEnter.selectedTopicId !== kanbanCard2) {
    throw new Error(`Slice 1b regression: list Tab+Enter on board-list-item-${kanbanCard2} opened ${JSON.stringify(afterListTabEnter)}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);
  await cdpClient.pressKey("Escape");
  await sleep(150);

  // 6) Cross-channel 近期动态 (Recent Topics)
  await cdpClient.clickSelector('[data-testid="board-filter-recent"]');
  await sleep(250);
  const recentCheck = await cdpClient.evalJS(`(() => {
    const s = window.__AHUB_EVAL__.getState();
    const byId = new Map(s.boardTopics.map(t => [t.id, t]));
    const listIds = Array.from(document.querySelectorAll('[data-testid^="board-list-item-"]')).map(el => el.getAttribute("data-topic-id"));
    let isUpdatedDesc = true;
    for (let i = 1; i < listIds.length; i++) {
      const prev = byId.get(listIds[i - 1]);
      const cur = byId.get(listIds[i]);
      if (!prev || !cur || prev.updated_at < cur.updated_at) {
        isUpdatedDesc = false;
        break;
      }
    }
    return {
      topicFilter: s.boardTopicFilter,
      selectedChannel: s.selectedBoardChannel,
      listIds,
      isUpdatedDesc,
      hasOpsRecent: Boolean(document.querySelector('[data-testid="board-list-item-${kbRecentTopic.id}"]')),
      hasProjDemoA: Boolean(document.querySelector('[data-testid="board-list-item-${kbTopicA.id}"]'))
    };
  })()`);
  const topicAIdx = recentCheck.listIds.indexOf(kbTopicA.id);
  const pinnedIdx = recentCheck.listIds.indexOf(kbPinnedTopic.id);
  if (
    recentCheck.topicFilter !== "recent" ||
    recentCheck.selectedChannel !== null ||
    !recentCheck.hasOpsRecent ||
    !recentCheck.hasProjDemoA ||
    !recentCheck.isUpdatedDesc ||
    topicAIdx < 0 ||
    pinnedIdx < 0 ||
    topicAIdx >= pinnedIdx
  ) {
    throw new Error(`Slice 1b Recent Topics check failed: ${JSON.stringify(recentCheck)}`);
  }

  // 6) Input guard + Board & Inbox J/K/1-4/Enter/Esc keyboard shortcut flow
  await cdpClient.clickSelector('[data-testid="board-search-input"]');
  await cdpClient.pressKey("j");
  await cdpClient.pressKey("k");
  await cdpClient.pressKey("1");
  const inputGuardCheck = await cdpClient.evalJS(`({
    inputVal: document.querySelector('[data-testid="board-search-input"]')?.value ?? "",
    focusedTopicId: window.__AHUB_EVAL__.getState().focusedBoardTopicId
  })`);
  if (inputGuardCheck.inputVal !== "jk1" || inputGuardCheck.focusedTopicId !== null) {
    throw new Error(`Slice 1b input focus guard failed: ${JSON.stringify(inputGuardCheck)}`);
  }
  await cdpClient.evalJS(`
    (() => {
      const inp = document.querySelector('[data-testid="board-search-input"]');
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(inp, "");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.blur();
      }
    })()
  `);
  await sleep(150);

  // Board list J / K / Enter / Esc + 1-4 status shortcut
  await cdpClient.pressKey("j");
  const firstFocus = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`);
  await cdpClient.pressKey("j");
  const secondFocus = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`);
  await cdpClient.pressKey("k");
  const backFocus = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`);
  if (!firstFocus || !secondFocus || firstFocus === secondFocus || backFocus !== firstFocus) {
    throw new Error(`Slice 1b Board J/K focus check failed: first=${firstFocus}, second=${secondFocus}, back=${backFocus}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(200);
  const afterBoardEnter = await cdpClient.evalJS(`({
    viewMode: window.__AHUB_EVAL__.getState().boardViewMode,
    selectedTopicId: window.__AHUB_EVAL__.getState().selectedBoardTopicId
  })`);
  if (afterBoardEnter.viewMode !== "timeline" || afterBoardEnter.selectedTopicId !== firstFocus) {
    throw new Error(`Slice 1b Board Enter into topic detail failed: ${JSON.stringify(afterBoardEnter)}`);
  }
  await cdpClient.pressKey("Escape");
  await sleep(150);
  const afterBoardEsc = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().boardViewMode`);
  if (afterBoardEsc !== "list") {
    throw new Error(`Slice 1b Board Esc return to list failed: expected list, got ${afterBoardEsc}`);
  }

  // Regression: switching channel via left rail clears returnViewModeRef so Esc does not yank back to list
  await cdpClient.pressKey("Enter");
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="board-channel-item-proj/demo"]');
  await sleep(150);
  await cdpClient.pressKey("Escape");
  await sleep(150);
  const afterChannelSwitchEsc = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().boardViewMode`);
  if (afterChannelSwitchEsc !== "timeline") {
    throw new Error(`Slice 1b regression: stale returnViewModeRef yanked viewMode to ${afterChannelSwitchEsc} after channel switch`);
  }
  await cdpClient.clickSelector('[data-testid="board-filter-recent"]');
  await sleep(200);
  await cdpClient.clickSelector('[data-testid="board-view-tab-list"]');
  await sleep(150);

  // Navigate to kbTopicB in list and press "4" to set status -> done
  const listOrderNow = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="board-list-item-"]')).map(el => el.getAttribute("data-topic-id"))`
  );
  const targetBIdx = listOrderNow.indexOf(kbTopicB.id);
  if (targetBIdx < 0) throw new Error("kbTopicB missing from board list for keyboard status test");
  const curFocusIdx = listOrderNow.indexOf(await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`));
  for (let s = curFocusIdx; s < targetBIdx; s++) {
    await cdpClient.pressKey("j");
  }
  for (let s = curFocusIdx; s > targetBIdx; s--) {
    await cdpClient.pressKey("k");
  }
  await cdpClient.pressKey("4");
  for (let i = 0; i < 20; i++) {
    const tB = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbTopicB.id}/messages`)).topic;
    if (tB.status === "done") break;
    if (i === 19) throw new Error(`Slice 1b Board shortcut '4' failed to update ${kbTopicB.id} to done in D1 (got ${tB.status})`);
    await sleep(150);
  }

  // Board detail 1-4 + Enter open question answering on kbQTopic2 / kbBoardQ2
  await cdpClient.clickSelector('[data-testid="board-view-tab-timeline"]');
  await sleep(150);
  const tlOrderNow = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="board-topic-item-"]')).map(el => el.getAttribute("data-testid")?.replace("board-topic-item-", ""))`
  );
  const q2Idx = tlOrderNow.indexOf(kbQTopic2.id);
  if (q2Idx < 0) throw new Error("kbQTopic2 missing from timeline list for keyboard answer test");
  await cdpClient.pressKey("Escape");
  await sleep(100);
  // Reset focus from start with J
  const curTlFocus = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`);
  if (!curTlFocus) {
    await cdpClient.pressKey("j");
  }
  const curTlIdx = tlOrderNow.indexOf(await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().focusedBoardTopicId`));
  for (let s = curTlIdx; s < q2Idx; s++) await cdpClient.pressKey("j");
  for (let s = curTlIdx; s > q2Idx; s--) await cdpClient.pressKey("k");
  await cdpClient.pressKey("Enter");
  await sleep(250);
  // Regression: in Board detail with a <4-option open question, pressing '4' must NOT fall through and mutate topic status to done
  await cdpClient.pressKey("4");
  await sleep(150);
  const q2AfterKey4 = await cdpClient.evalJS(`({
    uiStatus: window.__AHUB_EVAL__.getState().boardTopics.find(t => t.id === ${JSON.stringify(kbQTopic2.id)})?.status ?? null,
    opt0Selected: document.querySelector('[data-testid="board-question-option-${kbBoardQ2.id}-0"]')?.getAttribute("data-selected") ?? null
  })`);
  const q2D1AfterKey4 = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbQTopic2.id}/messages`)).topic;
  if (
    q2AfterKey4.uiStatus !== "blocked" ||
    q2D1AfterKey4.status !== "blocked" ||
    q2AfterKey4.opt0Selected === "true"
  ) {
    throw new Error(`Slice 1b regression: pressing '4' on 2-option open question mutated status or staged invalid option: ui=${JSON.stringify(q2AfterKey4)}, d1Status=${q2D1AfterKey4.status}`);
  }
  await cdpClient.pressKey("1");
  await sleep(100);
  const boardStagedAttr = await cdpClient.evalJS(
    `document.querySelector('[data-testid="board-question-option-${kbBoardQ2.id}-0"]')?.getAttribute("data-selected")`
  );
  if (boardStagedAttr !== "true") {
    throw new Error(`Slice 1b Board detail '1' did not stage option 0: data-selected=${boardStagedAttr}`);
  }
  await cdpClient.pressKey("Enter");
  for (let i = 0; i < 25; i++) {
    const q2D1 = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbQTopic2.id}/messages`)).messages.find(m => m.id === kbBoardQ2.id);
    if (q2D1?.question_state === "answered") break;
    if (i === 24) throw new Error(`Slice 1b Board detail Enter failed to submit answer for ${kbBoardQ2.id}`);
    await sleep(150);
  }

  // Inbox J / K / 1-4 / Enter / Esc keyboard flow
  await cdpClient.clickSelector('[data-testid="workspace-tab-inbox"]');
  await sleep(250);

  // Regression: focusing inbox-filter-board + Enter switches filter natively without hijacking/resolving items
  const focusedInboxFilter = await cdpClient.evalJS(`(() => {
    const btn = document.querySelector('[data-testid="inbox-filter-board"]');
    if (!(btn instanceof HTMLElement)) return false;
    btn.focus();
    return document.activeElement === btn;
  })()`);
  if (!focusedInboxFilter) {
    throw new Error("Slice 1b failed to focus inbox-filter-board");
  }
  await cdpClient.pressKey("Enter");
  await sleep(150);
  const inboxFilterBoardPressed = await cdpClient.evalJS(
    `document.querySelector('[data-testid="inbox-filter-board"]')?.getAttribute("aria-pressed")`
  );
  if (inboxFilterBoardPressed !== "true") {
    throw new Error(`Slice 1b regression: Enter on focused inbox-filter-board did not activate filter (aria-pressed=${inboxFilterBoardPressed})`);
  }
  await cdpClient.clickSelector('[data-testid="inbox-filter-all"]');
  await sleep(150);
  const inboxOrderBefore = await cdpClient.evalJS(
    `Array.from(document.querySelectorAll('[data-testid^="inbox-item-"]')).map(el => el.getAttribute("data-testid")?.replace("inbox-item-", ""))`
  );
  const targetInboxKey = `board:${kbInboxQ1.id}`;
  const targetInboxIdx = inboxOrderBefore.indexOf(targetInboxKey);
  if (targetInboxIdx < 0 || inboxOrderBefore.length < 2) {
    throw new Error(`Slice 1b Inbox expected >= 2 items including ${targetInboxKey}, got ${JSON.stringify(inboxOrderBefore)}`);
  }
  // Tab from inbox item 0 to item 1 + Enter must select item 1 (not execute action on stale item 0)
  await cdpClient.clickSelector(`[data-testid="inbox-item-${inboxOrderBefore[0]}"]`);
  await sleep(120);
  await cdpClient.pressKey("Tab");
  const inboxTabActive = await cdpClient.evalJS(
    `document.activeElement?.getAttribute("data-testid") ?? null`
  );
  if (inboxTabActive !== `inbox-item-${inboxOrderBefore[1]}`) {
    throw new Error(`Slice 1b Inbox Tab expected activeElement inbox-item-${inboxOrderBefore[1]}, got ${inboxTabActive}`);
  }
  await cdpClient.pressKey("Enter");
  await sleep(150);
  const inboxAfterTabEnter = await cdpClient.evalJS(`({
    focusedKey: document.querySelector('[data-testid^="inbox-item-"][data-focused="true"]')?.getAttribute("data-testid")?.replace("inbox-item-", "") ?? null,
    item0Present: Boolean(document.querySelector('[data-testid="inbox-item-${inboxOrderBefore[0]}"]'))
  })`);
  if (inboxAfterTabEnter.focusedKey !== inboxOrderBefore[1] || !inboxAfterTabEnter.item0Present) {
    throw new Error(`Slice 1b regression: Inbox Tab+Enter acted on stale item 0 or failed to select item 1: ${JSON.stringify(inboxAfterTabEnter)}`);
  }
  await cdpClient.clickSelector(`[data-testid="inbox-item-${inboxOrderBefore[0]}"]`);
  await sleep(120);
  await cdpClient.pressKey("j");
  const afterInboxJ = await cdpClient.evalJS(`
    document.querySelector('[data-testid^="inbox-item-"][data-focused="true"]')?.getAttribute("data-testid")?.replace("inbox-item-", "") ?? null
  `);
  await cdpClient.pressKey("k");
  const afterInboxK = await cdpClient.evalJS(`
    document.querySelector('[data-testid^="inbox-item-"][data-focused="true"]')?.getAttribute("data-testid")?.replace("inbox-item-", "") ?? null
  `);
  if (afterInboxJ !== inboxOrderBefore[1] || afterInboxK !== inboxOrderBefore[0]) {
    throw new Error(`Slice 1b Inbox J/K navigation failed: order=${JSON.stringify(inboxOrderBefore)} j=${afterInboxJ} k=${afterInboxK}`);
  }
  for (let s = 0; s < targetInboxIdx; s++) {
    await cdpClient.pressKey("j");
  }
  await cdpClient.pressKey("1");
  const inboxStaged1 = await cdpClient.evalJS(
    `document.querySelector('[data-testid="inbox-question-option-0"]')?.getAttribute("data-selected")`
  );
  if (inboxStaged1 !== "true") {
    throw new Error(`Slice 1b Inbox '1' did not stage option 0: data-selected=${inboxStaged1}`);
  }
  await cdpClient.pressKey("Escape");
  const inboxCleared = await cdpClient.evalJS(
    `document.querySelector('[data-testid="inbox-question-option-0"]')?.getAttribute("data-selected")`
  );
  if (inboxCleared === "true") {
    throw new Error("Slice 1b Inbox Esc did not clear staged option");
  }
  await cdpClient.pressKey("2");
  const inboxStaged2 = await cdpClient.evalJS(
    `document.querySelector('[data-testid="inbox-question-option-1"]')?.getAttribute("data-selected")`
  );
  if (inboxStaged2 !== "true") {
    throw new Error(`Slice 1b Inbox '2' did not stage option 1: data-selected=${inboxStaged2}`);
  }
  await cdpClient.pressKey("Enter");
  for (let i = 0; i < 25; i++) {
    const q1D1 = (await apiJson(hubUrl, adminToken, `/api/v1/board/topics/${kbQTopic1.id}/messages`)).messages.find(m => m.id === kbInboxQ1.id);
    if (q1D1?.question_state === "answered") break;
    if (i === 24) throw new Error(`Slice 1b Inbox Enter failed to submit staged answer for ${kbInboxQ1.id}`);
    await sleep(150);
  }
  // Esc in Inbox detail returns cleanly to list view (clears active detail)
  await cdpClient.pressKey("Escape");
  await sleep(150);
  const inboxAfterEsc = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="inbox-question-option-0"]'))`);
  if (inboxAfterEsc) {
    throw new Error("Slice 1b Inbox Esc did not dismiss detail view on desktop");
  }

  // Phase 4c: RFC-0001 Slice 2 — waiting badge, runStatusRank, DAG lineage, Retry, cascade cancel, Cron wake, [run] jump & BoardTopicInspector
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.evalJS(`window.__AHUB_CLS__ = 0; window.__AHUB_CLS_SOURCES__ = [];`);

  const s2TopicRes = await apiJson(hubUrl, adminToken, "/api/v1/board/topics", {
    method: "POST",
    body: JSON.stringify({
      channel: "proj/demo",
      title: "Slice 2 DAG 协同回写验收",
      status: "in_progress"
    })
  });
  const s2Topic = s2TopicRes.topic;

  const s2PlanRes = await apiJson(hubUrl, adminToken, "/api/v1/plans", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: "cdp-slice2-dag-plan-001",
      board_topic_id: s2Topic.id,
      actor_profile: "codex-orchestrator",
      nodes: [
        {
          key: "s2a",
          node_id: "macmini",
          workdir: wsAlpha,
          agent: "agy",
          title: "Slice 2 上游失败任务 s2a",
          prompt: JSON.stringify({
            summary: "s2a 模拟失败以验证阻塞与重试",
            response: "s2a failed intentionally",
            directives: [{ op: "exit", code: 1, message: "s2a intentional failure" }]
          })
        },
        {
          key: "s2b",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          depends_on: ["s2a"],
          title: "Slice 2 下游等待任务 s2b",
          prompt: JSON.stringify({
            summary: "s2b 下游依赖任务",
            response: "s2b downstream ok",
            directives: [{ op: "sleep", ms: 5 }]
          })
        }
      ]
    })
  });
  const s2aSeed = s2PlanRes.runs.find((r) => r.plan_key === "s2a");
  const s2bSeed = s2PlanRes.runs.find((r) => r.plan_key === "s2b");
  if (!s2aSeed || !s2bSeed) {
    throw new Error(`Slice 2 plan missing s2a/s2b: ${JSON.stringify(s2PlanRes)}`);
  }

  let s2a = null;
  for (let i = 0; i < 40; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2aSeed.id}`);
    if (r.run.status === "failed") {
      s2a = r.run;
      break;
    }
    if (r.run.status === "done" || r.run.status === "cancelled") {
      throw new Error(`Expected s2a to fail, got ${JSON.stringify(r.run)}`);
    }
    await sleep(200);
  }
  if (!s2a) {
    throw new Error(`s2a (${s2aSeed.id}) did not reach failed in time`);
  }

  const s2bD1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2bSeed.id}`)).run;
  if (
    s2bD1.status !== "waiting" ||
    s2bD1.blocked_reason !== "UPSTREAM_FAILED" ||
    !Array.isArray(s2bD1.depends_on_run_ids) ||
    !s2bD1.depends_on_run_ids.includes(s2a.id)
  ) {
    throw new Error(`Expected s2b waiting with UPSTREAM_FAILED depending on ${s2a.id}, got ${JSON.stringify(s2bD1)}`);
  }

  const s2SchedPlanRes = await apiJson(hubUrl, adminToken, "/api/v1/plans", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: "cdp-slice2-sched-plan-001",
      board_topic_id: s2Topic.id,
      actor_profile: "codex-orchestrator",
      nodes: [
        {
          key: "s2sched",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          in_sec: 120,
          title: "Slice 2 定时唤醒任务 s2Sched",
          prompt: JSON.stringify({
            summary: "s2Sched 定时唤醒完成",
            response: "s2Sched cron wake ok",
            directives: [{ op: "sleep", ms: 5 }]
          })
        }
      ]
    })
  });
  const s2Sched = s2SchedPlanRes.runs[0];
  if (!s2Sched || s2Sched.status !== "waiting" || s2Sched.blocked_reason !== "SCHEDULED" || !s2Sched.scheduled_at) {
    throw new Error(`Expected s2Sched waiting with SCHEDULED, got ${JSON.stringify(s2SchedPlanRes)}`);
  }

  const s2cPlanRes = await apiJson(hubUrl, adminToken, "/api/v1/plans", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: "cdp-slice2-cancel-chain-001",
      nodes: [
        {
          key: "s2c1",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          in_sec: 300,
          title: "Slice 2 取消链上游 s2c1",
          prompt: JSON.stringify({ summary: "s2c1 ok", directives: [{ op: "sleep", ms: 5 }] })
        },
        {
          key: "s2c2",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          depends_on: ["s2c1"],
          title: "Slice 2 取消链下游 s2c2",
          prompt: JSON.stringify({ summary: "s2c2 ok", directives: [{ op: "sleep", ms: 5 }] })
        }
      ]
    })
  });
  const s2c1 = s2cPlanRes.runs.find((r) => r.plan_key === "s2c1");
  const s2c2 = s2cPlanRes.runs.find((r) => r.plan_key === "s2c2");
  if (!s2c1 || !s2c2 || s2c1.status !== "waiting" || s2c2.status !== "waiting") {
    throw new Error(`Expected s2c1 & s2c2 waiting, got ${JSON.stringify(s2cPlanRes)}`);
  }

  const s2dPlanRes = await apiJson(hubUrl, adminToken, "/api/v1/plans", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: "cdp-slice2-cascade-pair-001",
      nodes: [
        {
          key: "s2d1",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          in_sec: 300,
          title: "Slice 2 级联取消上游 s2d1",
          prompt: JSON.stringify({ summary: "s2d1 ok", directives: [{ op: "sleep", ms: 5 }] })
        },
        {
          key: "s2d2",
          node_id: "mbp",
          workdir: wsMbp,
          agent: "pi",
          depends_on: ["s2d1"],
          title: "Slice 2 级联取消下游 s2d2",
          prompt: JSON.stringify({ summary: "s2d2 ok", directives: [{ op: "sleep", ms: 5 }] })
        }
      ]
    })
  });
  const s2d1 = s2dPlanRes.runs.find((r) => r.plan_key === "s2d1");
  const s2d2 = s2dPlanRes.runs.find((r) => r.plan_key === "s2d2");
  if (!s2d1 || !s2d2 || s2d1.status !== "waiting" || s2d2.status !== "waiting") {
    throw new Error(`Expected s2d1 & s2d2 waiting, got ${JSON.stringify(s2dPlanRes)}`);
  }

  // Open Board -> s2Topic -> verify terminal s2a auto-handoff + BoardTopicInspector linked runs + [run] jump
  await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
  await sleep(250);
  const hasTimelineTab = await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="board-view-tab-timeline"]'))`);
  if (hasTimelineTab) {
    await cdpClient.clickSelector('[data-testid="board-view-tab-timeline"]');
    await sleep(150);
  }
  await cdpClient.clickSelector('[data-testid="board-channel-item-proj/demo"]');
  for (let i = 0; i < 30; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="board-topic-item-${s2Topic.id}"]'))`)) {
      break;
    }
    if (i === 29) throw new Error(`s2Topic ${s2Topic.id} did not appear in board topic list`);
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="board-topic-item-${s2Topic.id}"]`);

  let s2BoardHydrated = null;
  for (let i = 0; i < 40; i++) {
    s2BoardHydrated = await cdpClient.evalJS(`
      (() => {
        const msgList = document.querySelector('[data-testid="board-messages-list"]');
        const insp = document.querySelector('[data-testid="board-topic-inspector"]');
        const rows = msgList ? Array.from(msgList.querySelectorAll('[data-message-kind="handoff"]')) : [];
        const s2aRow = rows.find((el) => (el.textContent || "").includes(${JSON.stringify(s2a.id)}));
        const runLink =
          document.querySelector('[data-testid="board-handoff-run-link-${s2a.id}"]') ||
          document.querySelector('[data-testid="board-run-link-${s2a.id}"]') ||
          (s2aRow
            ? Array.from(s2aRow.querySelectorAll("button, a")).find((el) => {
                const t = (el.textContent || "").trim();
                const rid = el.getAttribute("data-run-id") || "";
                return rid === ${JSON.stringify(s2a.id)} || t.includes("[run]") || t.includes(${JSON.stringify(s2a.id)}) || t.includes("查看任务");
              })
            : null);
        const inspText = insp?.textContent ?? "";
        return {
          hasHandoffRow: Boolean(s2aRow),
          hasRunLink: Boolean(runLink),
          inspHasS2a: inspText.includes(${JSON.stringify(s2a.id)}),
          inspHasS2b: inspText.includes(${JSON.stringify(s2bSeed.id)})
        };
      })()
    `);
    if (
      s2BoardHydrated.hasHandoffRow &&
      s2BoardHydrated.hasRunLink &&
      s2BoardHydrated.inspHasS2a &&
      s2BoardHydrated.inspHasS2b
    ) {
      break;
    }
    if (i === 39) {
      throw new Error(`Slice 2 Board timeline handoff / BoardTopicInspector linked runs check failed: ${JSON.stringify(s2BoardHydrated)}`);
    }
    await sleep(150);
  }

  // Click [run] link in BoardTopicTimeline -> must switch to runs workspace and select s2a
  await clickDomMatch(
    cdpClient,
    `() => {
      const direct =
        document.querySelector('[data-testid="board-handoff-run-link-${s2a.id}"]') ||
        document.querySelector('[data-testid="board-run-link-${s2a.id}"]');
      if (direct) return direct;
      const rows = Array.from(document.querySelectorAll('[data-testid="board-messages-list"] [data-message-kind="handoff"]'));
      const s2aRow = rows.find((el) => (el.textContent || "").includes(${JSON.stringify(s2a.id)}));
      if (!s2aRow) return null;
      return Array.from(s2aRow.querySelectorAll("button, a")).find((el) => {
        const t = (el.textContent || "").trim();
        const rid = el.getAttribute("data-run-id") || "";
        return rid === ${JSON.stringify(s2a.id)} || t.includes("[run]") || t.includes(${JSON.stringify(s2a.id)}) || t.includes("查看任务");
      }) || null;
    }`,
    `BoardTopicTimeline [run] link for ${s2a.id}`
  );

  let jumpedToS2a = null;
  for (let i = 0; i < 30; i++) {
    jumpedToS2a = await cdpClient.evalJS(`({
      workspaceMode: window.__AHUB_EVAL__?.getState()?.workspaceMode,
      selectedRunId: window.__AHUB_EVAL__?.getState()?.selectedRunId,
      selectedThreadId: window.__AHUB_EVAL__?.getState()?.selectedThreadId,
      rowStatus: document.querySelector('[data-testid="run-row-${s2a.id}"] [data-run-status]')?.getAttribute("data-run-status") ?? null
    })`);
    if (
      jumpedToS2a.workspaceMode === "runs" &&
      jumpedToS2a.selectedRunId === s2a.id &&
      jumpedToS2a.selectedThreadId === s2a.thread_id &&
      jumpedToS2a.rowStatus === "failed"
    ) {
      break;
    }
    if (i === 29) {
      throw new Error(`Clicking [run] link for ${s2a.id} did not navigate to runs & select s2a: ${JSON.stringify(jumpedToS2a)}`);
    }
    await sleep(150);
  }

  // Switch to s2b thread -> verify waiting StatusBadge, exact docs/05 UPSTREAM_FAILED copy & Inspector 5-Tab DOM order + Tab 3 lineage
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2bSeed.thread_id}"] button:nth-of-type(2)`);
  let s2bRowCheck = null;
  for (let i = 0; i < 25; i++) {
    s2bRowCheck = await cdpClient.evalJS(`({
      waitingBadge: Boolean(document.querySelector('[data-testid="run-row-${s2bSeed.id}"] [data-run-status="waiting"]')),
      rowText: document.querySelector('[data-testid="run-row-${s2bSeed.id}"]')?.textContent ?? ""
    })`);
    if (
      s2bRowCheck.waitingBadge &&
      s2bRowCheck.rowText.includes("上游依赖任务已失败，当前任务保持等待。可对失败任务点击重试或取消后续任务。")
    ) {
      break;
    }
    if (i === 24) {
      throw new Error(`Expected s2b waiting badge and exact UPSTREAM_FAILED copy, got ${JSON.stringify(s2bRowCheck)}`);
    }
    await sleep(150);
  }

  const inspectorTabOrder = await cdpClient.evalJS(`
    Array.from(document.querySelectorAll('[data-testid="inspector-pane"] [role="tab"]')).map((el) => ({
      text: (el.textContent || "").trim(),
      testid: el.getAttribute("data-testid") || null
    }))
  `);
  if (
    inspectorTabOrder.length !== 5 ||
    !inspectorTabOrder[0].text.includes("过程事件") ||
    !inspectorTabOrder[1].text.includes("待跑队列") ||
    !inspectorTabOrder[2].text.includes("委派拓扑") ||
    !inspectorTabOrder[3].text.includes("节点控制") ||
    !inspectorTabOrder[4].text.includes("投递明细") ||
    inspectorTabOrder[4].testid !== "inspector-tab-deliveries"
  ) {
    throw new Error(`InspectorPane 5-Tab DOM order :nth-of-type(1..5) violated: ${JSON.stringify(inspectorTabOrder)}`);
  }

  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(3)');
  await sleep(200);
  const lineageCheck = await cdpClient.evalJS(`({
    activeTab: window.__AHUB_EVAL__?.getState()?.activeTab,
    text: document.querySelector('[data-testid="inspector-pane"]')?.textContent ?? ""
  })`);
  if (
    lineageCheck.activeTab !== "lineage" ||
    !lineageCheck.text.includes(s2a.id) ||
    !lineageCheck.text.includes(s2bSeed.id) ||
    (!lineageCheck.text.includes("UPSTREAM_FAILED") && !lineageCheck.text.includes("上游依赖任务已失败"))
  ) {
    throw new Error(`InspectorPane Tab 3 (lineage) DAG/blocked_reason check failed: ${JSON.stringify(lineageCheck)}`);
  }

  // Verify s2Sched waiting badge, SCHEDULED copy, and scheduled_at tabular-nums in both row and InspectorPane Tab 3 (lineage)
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2Sched.thread_id}"] button:nth-of-type(2)`);
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="run-row-${s2Sched.id}"]`);
  await sleep(150);
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(3)');
  await sleep(150);
  let s2SchedUiCheck = null;
  for (let i = 0; i < 25; i++) {
    s2SchedUiCheck = await cdpClient.evalJS(`
      (() => {
        const row = document.querySelector('[data-testid="run-row-${s2Sched.id}"]');
        const insp = document.querySelector('[data-testid="inspector-pane"]');
        if (!row || !insp) return null;
        const waitingBadge = Boolean(row.querySelector('[data-run-status="waiting"]'));
        const rowText = row.textContent ?? "";
        const tabularEls = Array.from(row.querySelectorAll("*")).filter((el) => {
          const cs = getComputedStyle(el);
          return el.classList.contains("tabular-nums") || (cs.fontVariantNumeric || "").includes("tabular-nums");
        });
        const activeTab = window.__AHUB_EVAL__?.getState()?.activeTab ?? null;
        const inspSchedEl = Array.from(insp.querySelectorAll("*")).find(
          (el) => (el.textContent || "").includes(${JSON.stringify(s2Sched.scheduled_at)}) &&
            (el.classList.contains("tabular-nums") || (getComputedStyle(el).fontVariantNumeric || "").includes("tabular-nums"))
        );
        const inspText = insp.textContent ?? "";
        return {
          waitingBadge,
          hasScheduledCopy: rowText.includes("等待定时时间到达后自动唤醒。"),
          tabularCount: tabularEls.length,
          activeTab,
          inspHasScheduledLabel: inspText.includes("定时唤醒"),
          inspHasScheduledAtTabular: Boolean(inspSchedEl)
        };
      })()
    `);
    if (
      s2SchedUiCheck?.waitingBadge &&
      s2SchedUiCheck.hasScheduledCopy &&
      s2SchedUiCheck.tabularCount > 0 &&
      s2SchedUiCheck.activeTab === "lineage" &&
      s2SchedUiCheck.inspHasScheduledLabel &&
      s2SchedUiCheck.inspHasScheduledAtTabular
    ) {
      break;
    }
    if (i === 24) {
      throw new Error(`Expected s2Sched waiting badge, SCHEDULED copy, and tabular-nums scheduled_at in row + lineage, got ${JSON.stringify(s2SchedUiCheck)}`);
    }
    await sleep(150);
  }

  // Trigger Retry on s2a in UI -> verify POST /api/v1/runs/:id/retry creates s2a2, s2a stays failed, s2b rebinds to s2a2
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2a.thread_id}"] button:nth-of-type(2)`);
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="run-row-${s2a.id}"]`);
  await sleep(150);
  await clickDomMatch(
    cdpClient,
    `() => {
      const byTestId =
        document.querySelector('[data-testid="retry-run-btn-${s2a.id}"]') ||
        document.querySelector('[data-testid="run-row-${s2a.id}"] [data-testid="retry-run-btn"]') ||
        document.querySelector('[data-testid="inspector-pane"] [data-testid="retry-run-btn"]') ||
        document.querySelector('[data-testid="retry-run-btn"]');
      if (byTestId) return byTestId;
      const row = document.querySelector('[data-testid="run-row-${s2a.id}"]');
      const inRow = row
        ? Array.from(row.querySelectorAll("button")).find((b) => /重试|Retry/i.test((b.textContent || "").trim()))
        : null;
      if (inRow) return inRow;
      const insp = document.querySelector('[data-testid="inspector-pane"]');
      return insp
        ? Array.from(insp.querySelectorAll("button")).find((b) => /重试|Retry/i.test((b.textContent || "").trim())) || null
        : null;
    }`,
    `Retry button for ${s2a.id}`
  );

  let s2a2 = null;
  for (let i = 0; i < 40; i++) {
    const threadRuns = (await apiJson(hubUrl, adminToken, `/api/v1/runs?thread_id=${s2a.thread_id}`)).runs;
    const foundD1 = threadRuns.find((r) => r.retry_of_run_id === s2a.id);
    const foundUi = await cdpClient.evalJS(`
      window.__AHUB_EVAL__.getState().runs.find((r) => r.retry_of_run_id === ${JSON.stringify(s2a.id)}) ?? null
    `);
    if (foundD1 && foundUi) {
      s2a2 = foundD1;
      break;
    }
    if (i === 39) {
      throw new Error(`Retry on ${s2a.id} did not create s2a2 in D1 & UI in time`);
    }
    await sleep(200);
  }

  const s2aImmutableD1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2a.id}`)).run;
  const s2aDomStatus = await cdpClient.evalJS(
    `document.querySelector('[data-testid="run-row-${s2a.id}"] [data-run-status]')?.getAttribute("data-run-status") ?? null`
  );
  const s2bAfterRetryD1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2bSeed.id}`)).run;
  const s2bAfterRetryUi = await cdpClient.evalJS(
    `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2bSeed.id)}) ?? null`
  );
  if (
    s2aImmutableD1.status !== "failed" ||
    s2aDomStatus !== "failed" ||
    !Array.isArray(s2bAfterRetryD1.depends_on_run_ids) ||
    !s2bAfterRetryD1.depends_on_run_ids.includes(s2a2.id) ||
    s2bAfterRetryD1.depends_on_run_ids.includes(s2a.id) ||
    !Array.isArray(s2bAfterRetryUi?.depends_on_run_ids) ||
    !s2bAfterRetryUi.depends_on_run_ids.includes(s2a2.id)
  ) {
    throw new Error(
      `Retry immutability / rebind parity failed: s2aD1=${s2aImmutableD1.status}, s2aDom=${s2aDomStatus}, s2bD1=${JSON.stringify(s2bAfterRetryD1.depends_on_run_ids)}, s2bUi=${JSON.stringify(s2bAfterRetryUi?.depends_on_run_ids)}`
    );
  }
  for (let i = 0; i < 40; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2a2.id}`);
    if (r.run.status === "failed" || r.run.status === "done" || r.run.status === "cancelled") break;
    await sleep(200);
  }

  // Verify single waiting cancel (s2c1 -> s2c2 UPSTREAM_CANCELLED copy) AND UI cascade cancel (s2d1 -> s2d2)
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2c1.thread_id}"] button:nth-of-type(2)`);
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="run-row-${s2c1.id}"]`);
  await sleep(150);
  await clickDomMatch(
    cdpClient,
    `() => {
      return (
        document.querySelector('[data-testid="cancel-run-${s2c1.id}"]') ||
        document.querySelector('[data-testid="lineage-cancel-run-${s2c1.id}"]') ||
        Array.from(
          document.querySelectorAll('[data-testid="run-row-${s2c1.id}"] button, [data-testid="inspector-pane"] button')
        ).find((b) => /^(取消任务|取消等待|取消)$/.test((b.textContent || "").trim())) ||
        null
      );
    }`,
    `Single cancel button for waiting run ${s2c1.id}`
  );
  await sleep(200);
  const hasSingleCancelConfirmModal = await cdpClient.evalJS(`
    Boolean(Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((b) => /确认|继续|确定/.test((b.textContent || "").trim())))
  `);
  if (hasSingleCancelConfirmModal) {
    await clickDomMatch(
      cdpClient,
      `() => Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((b) => /确认|继续|确定/.test((b.textContent || "").trim())) || null`,
      "Confirm single cancel dialog button"
    );
  }
  for (let i = 0; i < 30; i++) {
    const c1D1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2c1.id}`)).run;
    const c1Ui = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2c1.id)})?.status ?? null`
    );
    if (c1D1.status === "cancelled" && c1Ui === "cancelled") break;
    if (i === 29) throw new Error(`Waiting run ${s2c1.id} did not cancel in time: d1=${c1D1.status} ui=${c1Ui}`);
    await sleep(150);
  }

  // Verify s2c2 remains waiting with UPSTREAM_CANCELLED in D1 and exact docs/05 §6 copy in UI
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2c2.thread_id}"] button:nth-of-type(2)`);
  let s2c2Check = null;
  for (let i = 0; i < 30; i++) {
    s2c2Check = await cdpClient.evalJS(`({
      waitingBadge: Boolean(document.querySelector('[data-testid="run-row-${s2c2.id}"] [data-run-status="waiting"]')),
      rowText: document.querySelector('[data-testid="run-row-${s2c2.id}"]')?.textContent ?? ""
    })`);
    if (
      s2c2Check.waitingBadge &&
      s2c2Check.rowText.includes("上游依赖任务已取消，当前任务保持等待。可对前置任务重试或级联取消当前任务。")
    ) {
      break;
    }
    if (i === 29) {
      throw new Error(`Expected exact UPSTREAM_CANCELLED copy & waiting badge on ${s2c2.id}, got ${JSON.stringify(s2c2Check)}`);
    }
    await sleep(150);
  }
  const s2c2D1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2c2.id}`)).run;
  if (s2c2D1.status !== "waiting" || s2c2D1.blocked_reason !== "UPSTREAM_CANCELLED") {
    throw new Error(`Expected ${s2c2.id} to stay waiting with UPSTREAM_CANCELLED in D1, got ${JSON.stringify(s2c2D1)}`);
  }

  // Now verify UI cascade cancel on s2d1 -> s2d2
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2d1.thread_id}"] button:nth-of-type(2)`);
  await sleep(150);
  await cdpClient.clickSelector(`[data-testid="run-row-${s2d1.id}"]`);
  await sleep(150);
  await clickDomMatch(
    cdpClient,
    `() => {
      return (
        document.querySelector('[data-testid="cascade-cancel-run-${s2d1.id}"]') ||
        document.querySelector('[data-testid="lineage-cascade-cancel-${s2d1.id}"]') ||
        document.querySelector('[data-testid="cascade-cancel-btn"]') ||
        document.querySelector('[data-testid="cascade-cancel-${s2d1.id}"]') ||
        Array.from(
          document.querySelectorAll('[data-testid="run-row-${s2d1.id}"] button, [data-testid="inspector-pane"] button')
        ).find((b) => /^级联取消$/.test((b.textContent || "").trim())) ||
        null
      );
    }`,
    `Cascade cancel button for waiting run ${s2d1.id}`
  );
  await sleep(200);
  const hasCascadeConfirmModal = await cdpClient.evalJS(`
    Boolean(Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((b) => /确认|继续|确定/.test((b.textContent || "").trim())))
  `);
  if (hasCascadeConfirmModal) {
    await clickDomMatch(
      cdpClient,
      `() => Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((b) => /确认|继续|确定/.test((b.textContent || "").trim())) || null`,
      "Confirm cascade cancel dialog button"
    );
  }
  for (let i = 0; i < 30; i++) {
    const d1D1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2d1.id}`)).run;
    const d2D1 = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2d2.id}`)).run;
    const d1Ui = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2d1.id)})?.status ?? null`
    );
    const d2Ui = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2d2.id)})?.status ?? null`
    );
    if (
      d1D1.status === "cancelled" &&
      d2D1.status === "cancelled" &&
      d1Ui === "cancelled" &&
      d2Ui === "cancelled"
    ) {
      break;
    }
    if (i === 29) {
      throw new Error(
        `Cascade cancel convergence failed for ${s2d1.id}->${s2d2.id}: d1=(${d1D1.status},${d2D1.status}) ui=(${d1Ui},${d2Ui})`
      );
    }
    await sleep(150);
  }

  // Backdate s2Sched via execD1 + triggerScheduled(hubUrl) -> verify UI + D1 waiting -> queued -> done & runStatusRank monotonicity
  if (!/^run_[A-Za-z0-9]+$/.test(s2Sched.id)) {
    throw new Error(`Unexpected s2Sched id format: ${s2Sched.id}`);
  }
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2Sched.thread_id}"] button:nth-of-type(2)`);
  await sleep(150);

  // Pre-triggerScheduled runs-workspace Slice 2 CLS gate (<= 0.001) covering [run] jump, waiting badge, lineage tab, Retry, single & cascade cancel
  const runsSlice2Cls = await cdpClient.evalJS(`window.__AHUB_CLS__ ?? 0`);
  const runsSlice2ClsSources = await cdpClient.evalJS(`window.__AHUB_CLS_SOURCES__ ?? []`);
  if (runsSlice2Cls > 0.001) {
    throw new Error(
      `Expected zero CLS in Slice 2 runs workspace before triggerScheduled, got ${runsSlice2Cls}; sources=${JSON.stringify(runsSlice2ClsSources)}`
    );
  }

  execD1(d1Dir, `UPDATE runs SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '${s2Sched.id}';`);
  await triggerScheduled(hubUrl);

  const slice2RankMap = {
    waiting: 0,
    queued: 1,
    claimed: 2,
    running: 3,
    needs_approval: 3,
    done: 4,
    failed: 4,
    cancelled: 4
  };
  const observedSchedStatuses = [];
  let maxObservedSchedRank = -1;
  let schedDone = false;
  for (let i = 0; i < 80; i++) {
    const uiStatus = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2Sched.id)})?.status ?? null`
    );
    if (uiStatus) {
      if (observedSchedStatuses[observedSchedStatuses.length - 1] !== uiStatus) {
        observedSchedStatuses.push(uiStatus);
      }
      const rank = slice2RankMap[uiStatus];
      if (typeof rank !== "number") {
        throw new Error(`Unknown run status observed for s2Sched: ${uiStatus}`);
      }
      if (rank < maxObservedSchedRank) {
        throw new Error(`runStatusRank regression on s2Sched: ${JSON.stringify(observedSchedStatuses)}`);
      }
      maxObservedSchedRank = rank;
      if (uiStatus === "done") {
        const domDone = await cdpClient.evalJS(
          `Boolean(document.querySelector('[data-testid="run-row-${s2Sched.id}"] [data-run-status="done"]'))`
        );
        const d1Sched = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${s2Sched.id}`)).run;
        if (domDone && d1Sched.status === "done") {
          schedDone = true;
          break;
        }
      }
    }
    await sleep(125);
  }
  if (!schedDone) {
    throw new Error(`s2Sched did not converge waiting -> queued -> done after Cron wake; observed=${JSON.stringify(observedSchedStatuses)}`);
  }

  // P-10 / F8 Tier 2 #1 / MG-7 (runStatusRank): inject out-of-order waiting/queued WS frames while a Slice 2 run is actively "running" (NOT terminal "done"), then verify WS reconnect parity against D1
  const s2RankSeedRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      board_topic_id: s2Topic.id,
      actor_profile: "codex-orchestrator",
      title: "Slice 2 runStatusRank 保序校验任务",
      prompt: JSON.stringify({
        summary: "runStatusRank out-of-order guard ok",
        response: "rank guard done",
        directives: [{ op: "sleep", ms: 4000 }]
      })
    })
  });
  const s2RankSeed = s2RankSeedRes.run;
  for (let i = 0; i < 40; i++) {
    const hasThreadItem = await cdpClient.evalJS(
      `Boolean(document.querySelector('[data-testid="thread-item-${s2RankSeed.thread_id}"] button:nth-of-type(2)'))`
    );
    if (hasThreadItem) break;
    if (i === 39) throw new Error(`s2RankSeed thread ${s2RankSeed.thread_id} did not appear in UI`);
    await sleep(100);
  }
  await cdpClient.clickSelector(`[data-testid="thread-item-${s2RankSeed.thread_id}"] button:nth-of-type(2)`);
  let liveRunningRun = null;
  for (let i = 0; i < 120; i++) {
    const probe = await cdpClient.evalJS(`({
      run: window.__AHUB_EVAL__?.getState()?.runs?.find((r) => r.id === ${JSON.stringify(s2RankSeed.id)}) ?? null,
      domStatus: document.querySelector('[data-testid="run-row-${s2RankSeed.id}"] [data-run-status]')?.getAttribute("data-run-status") ?? null
    })`);
    if (probe.run?.status === "running" && probe.domStatus === "running") {
      liveRunningRun = probe.run;
      break;
    }
    if (probe.run?.status === "done" || probe.run?.status === "failed" || probe.run?.status === "cancelled") {
      throw new Error(`s2RankSeed reached terminal state ${probe.run.status} before active running check`);
    }
    await sleep(50);
  }
  if (!liveRunningRun) {
    throw new Error(`s2RankSeed (${s2RankSeed.id}) did not reach active running state in UI`);
  }

  for (const staleStatus of ["waiting", "queued"]) {
    const injectedRes = await cdpClient.evalJS(`
      (() => {
        const current = window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2RankSeed.id)});
        if (!current || current.status !== "running") {
          return { error: "expected active running state before injection, got " + (current && current.status) };
        }
        window.__AHUB_EVAL_INJECT_WS__({
          type: "run.updated",
          run: {
            ...current,
            status: ${JSON.stringify(staleStatus)},
            blocked_reason: ${staleStatus === "waiting" ? '"SCHEDULED"' : "null"}
          }
        });
        const afterStore = window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(s2RankSeed.id)})?.status ?? null;
        const afterDom = document.querySelector('[data-testid="run-row-${s2RankSeed.id}"] [data-run-status]')?.getAttribute("data-run-status") ?? null;
        return { afterStore, afterDom };
      })()
    `);
    if (injectedRes?.error || injectedRes?.afterStore !== "running" || injectedRes?.afterDom !== "running") {
      throw new Error(
        `MG-7 runStatusRank regression on out-of-order ${staleStatus} WS frame (same updated_at): ${JSON.stringify(injectedRes)}`
      );
    }
  }

  await waitForSeedRunDone(s2RankSeed.id, "P-10 runStatusRank run");

  // Force /ws/stream reconnect and verify UI parity against D1
  const socketCountBeforeReconnect = await cdpClient.evalJS(`
    (() => {
      const open = (window.__AHUB_STREAM_SOCKETS__ || []).filter((s) => s && s.readyState === 1);
      if (open.length === 0) throw new Error("No open /ws/stream socket to reconnect");
      const beforeCount = window.__AHUB_STREAM_SOCKETS__.length;
      const target = open[open.length - 1];
      target.close(4000, "eval-reconnect");
      return beforeCount;
    })()
  `);
  await sleep(250);
  await cdpClient.evalJS(`
    (() => {
      const target = (window.__AHUB_STREAM_SOCKETS__ || [])[${socketCountBeforeReconnect} - 1];
      if (target && target.readyState === 2) {
        target.dispatchEvent(new CloseEvent("close", { code: 4000, reason: "eval-reconnect", wasClean: false }));
      }
    })()
  `);
  let reconnected = false;
  let lastConnState = null;
  for (let i = 0; i < 60; i++) {
    lastConnState = await cdpClient.evalJS(`({
      streamStatus: window.__AHUB_EVAL__?.getState()?.streamStatus ?? null,
      socketCount: (window.__AHUB_STREAM_SOCKETS__ || []).length,
      readyStates: (window.__AHUB_STREAM_SOCKETS__ || []).map((s) => s.readyState)
    })`);
    if (lastConnState.streamStatus === "connected" && lastConnState.socketCount > socketCountBeforeReconnect) {
      reconnected = true;
      break;
    }
    await sleep(150);
  }
  if (!reconnected) {
    throw new Error(`HubStreamClient did not reconnect /ws/stream in time during P-10 check: ${JSON.stringify({ socketCountBeforeReconnect, lastConnState })}`);
  }
  await sleep(300);

  for (const rid of [s2RankSeed.id, s2a.id, s2bSeed.id, s2c1.id, s2d1.id, s2d2.id]) {
    const d1Run = (await apiJson(hubUrl, adminToken, `/api/v1/runs/${rid}`)).run;
    const uiStatus = await cdpClient.evalJS(
      `window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(rid)})?.status ?? null`
    );
    if (uiStatus !== d1Run.status) {
      throw new Error(`P-10 WS reconnect parity mismatch for ${rid}: ui=${uiStatus} d1=${d1Run.status}`);
    }
  }

  // BoardTopicInspector quick dispatch -> verify linked run created in UI & D1, plus 1440x900 & 390x844 containment + CLS==0
  await cdpClient.evalJS(`window.__AHUB_CLS__ = 0; window.__AHUB_CLS_SOURCES__ = [];`);
  await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
  await sleep(200);
  await cdpClient.clickSelector(`[data-testid="board-topic-item-${s2Topic.id}"]`);
  await sleep(250);

  const beforeQuickDispatchIds = (
    await apiJson(hubUrl, adminToken, `/api/v1/runs?board_topic_id=${s2Topic.id}`)
  ).runs.map((r) => r.id);

  await clickDomMatch(
    cdpClient,
    `() => {
      const insp = document.querySelector('[data-testid="board-topic-inspector"]');
      if (!insp) return null;
      return (
        insp.querySelector('[data-testid="board-quick-dispatch-toggle"]') ||
        insp.querySelector('[data-testid="board-quick-dispatch-btn"]') ||
        insp.querySelector('[data-testid="board-topic-quick-dispatch-btn"]') ||
        insp.querySelector('[data-testid="board-topic-dispatch-btn"]') ||
        Array.from(insp.querySelectorAll("button")).find((b) => /^(快捷派发|派发任务|新建任务)$/.test((b.textContent || "").trim())) ||
        null
      );
    }`,
    "BoardTopicInspector quick dispatch trigger"
  );
  await sleep(250);

  const quickDispatchCtx = await cdpClient.evalJS(`({
    workspaceMode: window.__AHUB_EVAL__?.getState()?.workspaceMode,
    hasQuickForm: Boolean(document.querySelector('[data-testid="board-quick-dispatch-form"]')),
    hasInlineInput: Boolean(
      document.querySelector('[data-testid="board-quick-dispatch-prompt"]') ||
      document.querySelector('[data-testid="board-topic-inspector"] textarea') ||
      document.querySelector('[data-testid="board-topic-inspector"] input[type="text"]') ||
      document.querySelector('[role="dialog"] textarea') ||
      document.querySelector('[role="dialog"] input[type="text"]')
    )
  })`);

  const quickPromptText = JSON.stringify({
    summary: "BoardTopicInspector 快捷派发完成",
    response: "quick dispatch ok",
    directives: [{ op: "sleep", ms: 5 }]
  });

  if (!quickDispatchCtx.hasInlineInput || quickDispatchCtx.workspaceMode !== "board") {
    throw new Error(
      `BoardTopicInspector quick dispatch did not open inline form in board workspace: ${JSON.stringify(quickDispatchCtx)}`
    );
  }
  const inputSel = await cdpClient.evalJS(`
    document.querySelector('[data-testid="board-quick-dispatch-prompt"]')
      ? '[data-testid="board-quick-dispatch-prompt"]'
      : document.querySelector('[data-testid="board-topic-inspector"] textarea')
        ? '[data-testid="board-topic-inspector"] textarea'
        : document.querySelector('[data-testid="board-topic-inspector"] input[type="text"]')
          ? '[data-testid="board-topic-inspector"] input[type="text"]'
          : document.querySelector('[role="dialog"] textarea')
            ? '[role="dialog"] textarea'
            : '[role="dialog"] input[type="text"]'
  `);
  await cdpClient.fillInput(inputSel, quickPromptText);
  await sleep(100);
  await clickDomMatch(
    cdpClient,
    `() => {
      const direct =
        document.querySelector('[data-testid="board-quick-dispatch-submit"]') ||
        document.querySelector('[data-testid="board-topic-dispatch-submit"]');
      if (direct && !direct.disabled) return direct;
      const container =
        document.querySelector('[role="dialog"]') ||
        document.querySelector('[data-testid="board-topic-inspector"]');
      return container
        ? Array.from(container.querySelectorAll("button")).find((b) => /^(提交|发送|确认派发|创建并派发|提交受控任务)$/.test((b.textContent || "").trim()) && !b.disabled) || null
        : null;
    }`,
    "BoardTopicInspector quick dispatch submit"
  );

  let quickRun = null;
  for (let i = 0; i < 40; i++) {
    const linked = (await apiJson(hubUrl, adminToken, `/api/v1/runs?board_topic_id=${s2Topic.id}`)).runs;
    const candidate = linked.find((r) => !beforeQuickDispatchIds.includes(r.id));
    const inUi = candidate
      ? await cdpClient.evalJS(`Boolean(window.__AHUB_EVAL__.getState().runs.find((r) => r.id === ${JSON.stringify(candidate.id)}))`)
      : false;
    if (candidate && inUi && candidate.status === "done") {
      quickRun = candidate;
      break;
    }
    if (i === 39) {
      throw new Error(`BoardTopicInspector quick dispatch run did not appear/finish in UI & D1: candidate=${JSON.stringify(candidate)} inUi=${inUi}`);
    }
    await sleep(200);
  }
  if (quickRun.board_topic_id !== s2Topic.id) {
    throw new Error(`Expected quickRun.board_topic_id=${s2Topic.id}, got ${JSON.stringify(quickRun)}`);
  }

  // T5-05: BoardTopicInspector 1-minute preset ("60") includes 2s client clock-skew buffer (>= +61.5s)
  await clickDomMatch(
    cdpClient,
    `() => document.querySelector('[data-testid="board-quick-dispatch-toggle"]')`,
    "Reopen BoardTopicInspector quick dispatch for T5-05"
  );
  await sleep(150);
  await clickDomMatch(
    cdpClient,
    `() => document.querySelector('[data-testid="board-quick-dispatch-delay"]')`,
    "BoardTopicInspector delay select trigger"
  );
  await sleep(150);
  await clickDomMatch(
    cdpClient,
    `() => Array.from(document.querySelectorAll('[role="option"]')).find((el) => (el.textContent || "").includes("1 分钟后唤醒")) || null`,
    "Select 1 minute delay option"
  );
  await sleep(100);
  await cdpClient.fillInput(
    '[data-testid="board-quick-dispatch-prompt"]',
    JSON.stringify({ summary: "T5-05 1m skew buffer check", directives: [{ op: "sleep", ms: 5 }] })
  );
  await sleep(100);
  const t505SubmitMs = Date.now();
  await clickDomMatch(
    cdpClient,
    `() => {
      const btn = document.querySelector('[data-testid="board-quick-dispatch-submit"]');
      return btn && !btn.disabled ? btn : null;
    }`,
    "Submit T5-05 1-minute quick dispatch"
  );
  let t505Run = null;
  for (let i = 0; i < 30; i++) {
    const linked = (await apiJson(hubUrl, adminToken, `/api/v1/runs?board_topic_id=${s2Topic.id}`)).runs;
    const candidate = linked.find(
      (r) => r.id !== quickRun.id && !beforeQuickDispatchIds.includes(r.id)
    );
    if (candidate) {
      t505Run = candidate;
      break;
    }
    if (i === 29) {
      throw new Error("T5-05 1-minute quick dispatch run was not created in D1");
    }
    await sleep(150);
  }
  const t505ScheduledMs = Date.parse(t505Run.scheduled_at ?? "");
  if (
    t505Run.status !== "waiting" ||
    t505Run.blocked_reason !== "SCHEDULED" ||
    !Number.isFinite(t505ScheduledMs) ||
    t505ScheduledMs - t505SubmitMs < 61_500
  ) {
    throw new Error(
      `T5-05 clock-skew buffer missing: deltaMs=${t505ScheduledMs - t505SubmitMs}, run=${JSON.stringify(t505Run)}`
    );
  }
  await apiJson(hubUrl, adminToken, `/api/v1/runs/${t505Run.id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ cascade: false, reason: "cleanup T5-05" })
  });

  const s2ModeAfterDispatch = await cdpClient.evalJS(`window.__AHUB_EVAL__.getState().workspaceMode`);
  if (s2ModeAfterDispatch !== "board") {
    await cdpClient.clickSelector('[data-testid="workspace-tab-board"]');
    await sleep(200);
    await cdpClient.clickSelector(`[data-testid="board-topic-item-${s2Topic.id}"]`);
    await sleep(200);
  }
  await assertViewportContainment(cdpClient, "desktop-1440x900-slice2");
  const slice2Cls = await cdpClient.evalJS(`window.__AHUB_CLS__ ?? 0`);
  const slice2ClsSources = await cdpClient.evalJS(`window.__AHUB_CLS_SOURCES__ ?? []`);
  if (slice2Cls > 0.001) {
    throw new Error(`Expected zero CLS in Slice 2 Phase 4c, got ${slice2Cls}; sources=${JSON.stringify(slice2ClsSources)}`);
  }

  // Mobile 390x844 Slice 2 containment check (board & runs)
  await cdpClient.setViewport(390, 844, true);
  await sleep(250);
  await assertViewportContainment(cdpClient, "mobile-390x844-slice2-board");
  await cdpClient.clickSelector('[data-testid="workspace-tab-runs"]');
  await sleep(250);
  await assertViewportContainment(cdpClient, "mobile-390x844-slice2-runs");
  await cdpClient.setViewport(1440, 900, false);
  await sleep(200);

  // Phase 4d: RFC-0001 Slice 3 — Run labels chips, ?label=k=v filter parity with D1, structured result JSON viewer + redaction, RESULT_SCHEMA_MISMATCH preserving output_md
  const s3ResultSchema = {
    type: "object",
    required: ["ok", "count"],
    properties: {
      ok: { type: "boolean" },
      count: { type: "integer" },
      note: { type: "string" }
    },
    additionalProperties: false
  };
  const s3OkSecret = "sk-proj-CdpResultSecret1234567890abcdef";
  const s3OkLabels = { env: "eval", suite: "slice3-ok", "team/area": "web" };
  const s3MismatchLabels = { env: "eval", suite: "slice3-mismatch" };

  const s3OkSeedRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      title: "Slice 3 结构化产物通过验收",
      labels: s3OkLabels,
      result_schema: s3ResultSchema,
      prompt: JSON.stringify({
        summary: "Slice 3 结构化产物校验通过",
        response: "SLICE3_OK_OUTPUT_MD",
        directives: [
          {
            op: "write_result_file",
            result: { ok: true, count: 7, note: s3OkSecret }
          }
        ]
      })
    })
  });
  const s3OkRun = await waitForSeedRunDone(s3OkSeedRes.run.id, "Slice 3 s3OkRun");
  if (
    !s3OkRun.result ||
    s3OkRun.result.ok !== true ||
    s3OkRun.result.count !== 7 ||
    !String(s3OkRun.result.note ?? "").includes("[REDACTED]") ||
    JSON.stringify(s3OkRun.result).includes(s3OkSecret)
  ) {
    throw new Error(`Expected s3OkRun redacted result in D1, got ${JSON.stringify(s3OkRun)}`);
  }

  const s3MismatchSeedRes = await apiJson(hubUrl, adminToken, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "mbp",
      workdir: wsMbp,
      agent: "pi",
      title: "Slice 3 结构化产物校验失败保留输出",
      labels: s3MismatchLabels,
      result_schema: s3ResultSchema,
      prompt: JSON.stringify({
        summary: "Slice 3 产物不匹配但保留输出",
        response: "MISMATCH_OUTPUT_KEPT_E2E",
        directives: [
          {
            op: "write_result_file",
            result: { ok: "wrong" }
          }
        ]
      })
    })
  });
  let s3MismatchRun = null;
  for (let i = 0; i < 40; i++) {
    const r = await apiJson(hubUrl, adminToken, `/api/v1/runs/${s3MismatchSeedRes.run.id}`);
    if (r.run.status === "failed") {
      s3MismatchRun = r.run;
      break;
    }
    if (r.run.status === "done" || r.run.status === "cancelled") {
      throw new Error(`Expected s3MismatchRun to fail with RESULT_SCHEMA_MISMATCH, got ${JSON.stringify(r.run)}`);
    }
    await sleep(200);
  }
  if (!s3MismatchRun || s3MismatchRun.error_code !== "RESULT_SCHEMA_MISMATCH") {
    throw new Error(`Expected s3MismatchRun failed with RESULT_SCHEMA_MISMATCH in D1, got ${JSON.stringify(s3MismatchRun)}`);
  }
  if (
    !(s3MismatchRun.output_md ?? s3MismatchRun.output_preview ?? "").includes("MISMATCH_OUTPUT_KEPT_E2E") ||
    s3MismatchRun.result != null
  ) {
    throw new Error(`Expected s3MismatchRun to preserve MISMATCH_OUTPUT_KEPT_E2E and keep result=null in D1, got ${JSON.stringify(s3MismatchRun)}`);
  }

  async function inspectSlice3RunRow(cdp, runId, expectedLabels, expectedResultCheck) {
    return cdp.evalJS(`
      (() => {
        const row = document.querySelector('[data-testid="run-row-' + ${JSON.stringify(runId)} + '"]');
        if (!row) return { foundRow: false };
        const nonEmoji = new Set(["©", "®", "™", "↗", "↘", "↔"]);
        const emojiMatches = (row.textContent || "").match(/\\p{Extended_Pictographic}/gu) || [];
        const decorativeEmojis = emojiMatches.filter((ch) => !nonEmoji.has(ch));

        const cmdPreview = row.querySelector('[data-testid="run-cmd-preview-' + ${JSON.stringify(runId)} + '"]');
        const isOutsidePromptAndCmd = (el) => {
          if (cmdPreview && cmdPreview.contains(el)) return false;
          const md = el.closest(".ahub-markdown");
          if (md) return false;
          const promptBox = el.closest(".bg-muted\\\\/30");
          if (promptBox && (promptBox.textContent || "").includes("任务指令")) return false;
          return true;
        };

        const hasActiveTransitionAll = (el) => {
          const s = getComputedStyle(el);
          const props = (s.transitionProperty || "").split(",").map((x) => x.trim());
          const durs = (s.transitionDuration || "").split(",").map((x) => parseFloat(x) || 0);
          const hasDurAll = props.some(
            (p, idx) => p === "all" && (durs[idx % Math.max(durs.length, 1)] || 0) > 0
          );
          return el.classList.contains("transition-all") || hasDurAll;
        };

        const labels = ${JSON.stringify(expectedLabels)};
        const chipResults = {};
        for (const [k, v] of Object.entries(labels)) {
          const kvText = k + "=" + v;
          const colonText = k + ": " + v;
          const direct =
            row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(runId)} + '-' + k + '"]') ||
            row.querySelector('[data-testid="run-label-chip-' + k + '"]') ||
            row.querySelector('[data-testid^="run-label-chip-"][data-label-key="' + k + '"]');
          const labelsContainer =
            row.querySelector('[data-testid="run-labels-' + ${JSON.stringify(runId)} + '"]') ||
            row.querySelector('[data-testid^="run-labels-"]');
          const searchScope = labelsContainer || row;
          const candidates = Array.from(searchScope.querySelectorAll("button, span, a, div")).filter((el) => {
            if (!isOutsidePromptAndCmd(el)) return false;
            const txt = (el.textContent || "").trim();
            if (txt !== kvText && txt !== colonText) return false;
            return !Array.from(el.children).some((c) => {
              const ct = (c.textContent || "").trim();
              return ct === kvText || ct === colonText;
            });
          });
          const chip = direct || candidates[0] || null;
          if (!chip) {
            chipResults[k] = { found: false };
            continue;
          }
          const rect = chip.getBoundingClientRect();
          const cs = getComputedStyle(chip);
          const isMono =
            chip.classList.contains("font-mono") ||
            /mono|consolas|menlo|courier|sfmono/i.test(cs.fontFamily || "");
          const hasTransitionAll = hasActiveTransitionAll(chip);
          chipResults[k] = {
            found: rect.width > 0 && rect.height > 0,
            text: (chip.textContent || "").trim(),
            isMono,
            hasTransitionAll,
            clickable: chip.tagName === "BUTTON" || chip.getAttribute("role") === "button"
          };
        }

        const expectedRes = ${JSON.stringify(expectedResultCheck)};
        let resultInfo = null;
        if (expectedRes) {
          const directViewer =
            row.querySelector('[data-testid="run-result-viewer-' + ${JSON.stringify(runId)} + '"]') ||
            row.querySelector('[data-testid="run-result-' + ${JSON.stringify(runId)} + '"]') ||
            row.querySelector('[data-testid^="run-result-viewer"]') ||
            row.querySelector('[data-testid*="result-viewer"]');
          const fallbackPre = Array.from(row.querySelectorAll("pre")).find((pre) => {
            if (!isOutsidePromptAndCmd(pre)) return false;
            const t = pre.textContent || "";
            return t.includes(expectedRes.preSnippet);
          });
          const viewer = directViewer || (fallbackPre ? (fallbackPre.closest('[data-testid*="result"]') || fallbackPre.parentElement) : null);
          if (!viewer) {
            resultInfo = { found: false };
          } else {
            const vRect = viewer.getBoundingClientRect();
            const preEl = viewer.querySelector("pre") || fallbackPre || viewer;
            const preText = (preEl.textContent || "").trim();
            const viewerText = viewer.textContent || "";
            let parsedJson = null;
            try {
              parsedJson = JSON.parse(preText);
            } catch {
              parsedJson = null;
            }
            const allViewerEls = [viewer, ...Array.from(viewer.querySelectorAll("*"))];
            const hasTabular = allViewerEls.some((el) => {
              const cs = getComputedStyle(el);
              return el.classList.contains("tabular-nums") || (cs.fontVariantNumeric || "").includes("tabular-nums");
            });
            const hasTransitionAll = allViewerEls.some((el) => hasActiveTransitionAll(el));
            resultInfo = {
              found: vRect.width > 0 && vRect.height > 0,
              preText,
              viewerText,
              parsedOk: parsedJson ? parsedJson.ok === expectedRes.ok && parsedJson.count === expectedRes.count : null,
              hasCountSnippet: new RegExp('"count"\\\\s*:\\\\s*' + expectedRes.count).test(preText),
              hasTabular,
              hasTransitionAll
            };
          }
        }
        return {
          foundRow: true,
          decorativeEmojis,
          chipResults,
          resultInfo
        };
      })()
    `);
  }

  async function applySlice3LabelFilter(cdp, runId, key, value) {
    const filterExpr = `${key}=${value}`;
    const beforeCount = await cdp.evalJS(
      `document.querySelectorAll('[data-testid="fleet-threads-pane"] [data-testid^="thread-item-"]').length`
    );
    const chipClickable = await cdp.evalJS(`
      (() => {
        const row = document.querySelector('[data-testid="run-row-' + ${JSON.stringify(runId)} + '"]');
        if (!row) return false;
        const direct =
          row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(runId)} + '-' + ${JSON.stringify(key)} + '"]') ||
          row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(key)} + '"]') ||
          row.querySelector('[data-testid^="run-label-chip-"][data-label-key="' + ${JSON.stringify(key)} + '"]');
        if (direct && (direct.tagName === "BUTTON" || direct.getAttribute("role") === "button")) return true;
        const kvText = ${JSON.stringify(filterExpr)};
        const colonText = ${JSON.stringify(key + ": " + value)};
        return Array.from(row.querySelectorAll('button, [role="button"]')).some((el) => {
          const t = (el.textContent || "").trim();
          return t === kvText || t === colonText;
        });
      })()
    `);

    let filteredByChip = false;
    if (chipClickable) {
      await clickDomMatch(
        cdp,
        `() => {
          const row = document.querySelector('[data-testid="run-row-' + ${JSON.stringify(runId)} + '"]');
          if (!row) return null;
          const direct =
            row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(runId)} + '-' + ${JSON.stringify(key)} + '"]') ||
            row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(key)} + '"]') ||
            row.querySelector('[data-testid^="run-label-chip-"][data-label-key="' + ${JSON.stringify(key)} + '"]');
          if (direct && (direct.tagName === "BUTTON" || direct.getAttribute("role") === "button")) return direct;
          const kvText = ${JSON.stringify(filterExpr)};
          const colonText = ${JSON.stringify(key + ": " + value)};
          return Array.from(row.querySelectorAll('button, [role="button"]')).find((el) => {
            const t = (el.textContent || "").trim();
            return t === kvText || t === colonText;
          }) || null;
        }`,
        `Slice 3 label chip ${filterExpr} on ${runId}`
      );
      await sleep(350);
      const chipEffect = await cdp.evalJS(`
        (() => {
          const pane = document.querySelector('[data-testid="fleet-threads-pane"]');
          const afterCount = pane ? pane.querySelectorAll('[data-testid^="thread-item-"]').length : 0;
          const inputs = pane ? Array.from(pane.querySelectorAll("input")) : [];
          const hasInputVal = inputs.some((inp) => (inp.value || "").includes(${JSON.stringify(filterExpr)}));
          const paneText = pane?.textContent ?? "";
          return { afterCount, hasInputVal, showsExprInPane: paneText.includes(${JSON.stringify(filterExpr)}) };
        })()
      `);
      filteredByChip = chipEffect.afterCount < beforeCount || chipEffect.hasInputVal || chipEffect.showsExprInPane;
    }

    if (!filteredByChip) {
      const filled = await cdp.evalJS(`
        (() => {
          const pane = document.querySelector('[data-testid="fleet-threads-pane"]');
          if (!pane) return false;
          const inp =
            pane.querySelector('[data-testid="run-label-filter"]') ||
            pane.querySelector('[data-testid="thread-label-filter-input"]') ||
            pane.querySelector('[data-testid="label-filter-input"]') ||
            pane.querySelector('[data-testid="fleet-label-filter-input"]') ||
            Array.from(pane.querySelectorAll("input")).find((el) => {
              const tid = el.getAttribute("data-testid") || "";
              if (tid === "thread-search-input" || tid === "native-search-input") return false;
              const meta = [
                el.getAttribute("placeholder") || "",
                el.getAttribute("aria-label") || "",
                el.getAttribute("name") || "",
                tid
              ].join(" ");
              return /label|标签|k=v|key=value/i.test(meta);
            });
          if (!inp) return false;
          inp.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(inp, ${JSON.stringify(filterExpr)});
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()
      `);
      if (!filled) {
        throw new Error(`Slice 3 label filter control not found for ${filterExpr}`);
      }
      await cdp.pressKey("Enter");
      await sleep(300);
    }
  }

  async function clearSlice3LabelFilter(cdp, runId, key, value) {
    const filterExpr = `${key}=${value}`;
    const findClearBtnSrc = `() => {
      const pane = document.querySelector('[data-testid="fleet-threads-pane"]');
      if (!pane) return null;
      const direct =
        pane.querySelector('[data-testid="active-label-filter-' + ${JSON.stringify(filterExpr)} + '"]') ||
        pane.querySelector('[data-testid="run-label-filter-clear"]') ||
        pane.querySelector('[data-testid="thread-label-filter-clear"]') ||
        pane.querySelector('[data-testid="clear-label-filter-btn"]') ||
        pane.querySelector('[data-testid="label-filter-clear"]');
      if (direct) return direct;
      const byTextOrLabel = Array.from(pane.querySelectorAll("button")).find((b) => {
        const t = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")).trim();
        return /清除.*标签|清除筛选|清空标签|移除.*标签|取消.*标签|Clear.*label|Reset.*label/i.test(t);
      });
      if (byTextOrLabel) return byTextOrLabel;
      const inp =
        pane.querySelector('[data-testid="run-label-filter"]') ||
        pane.querySelector('[data-testid="thread-label-filter-input"]') ||
        pane.querySelector('[data-testid="label-filter-input"]') ||
        pane.querySelector('[data-testid="fleet-label-filter-input"]') ||
        Array.from(pane.querySelectorAll("input")).find((el) => {
          const tid = el.getAttribute("data-testid") || "";
          if (tid === "thread-search-input" || tid === "native-search-input") return false;
          const meta = [
            el.getAttribute("placeholder") || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("name") || "",
            tid
          ].join(" ");
          return /label|标签|k=v|key=value/i.test(meta);
        });
      const wrap = inp?.parentElement;
      if (wrap) {
        const inlineClear = Array.from(wrap.querySelectorAll("button")).find((b) => {
          const t = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")).trim();
          return /清除|清空|取消|重置|移除|clear|reset|remove/i.test(t) || Boolean(b.querySelector("svg"));
        });
        if (inlineClear) return inlineClear;
      }
      return null;
    }`;
    const hasClearBtn = await cdp.evalJS(`Boolean((${findClearBtnSrc})())`);
    if (hasClearBtn) {
      await clickDomMatch(cdp, findClearBtnSrc, "Clear Slice 3 label filter button");
      await sleep(250);
    }

    const clearedInput = await cdp.evalJS(`
      (() => {
        const pane = document.querySelector('[data-testid="fleet-threads-pane"]');
        if (!pane) return false;
        const inp =
          pane.querySelector('[data-testid="run-label-filter"]') ||
          pane.querySelector('[data-testid="thread-label-filter-input"]') ||
          pane.querySelector('[data-testid="label-filter-input"]') ||
          pane.querySelector('[data-testid="fleet-label-filter-input"]') ||
          Array.from(pane.querySelectorAll("input")).find((el) => {
            const tid = el.getAttribute("data-testid") || "";
            if (tid === "thread-search-input" || tid === "native-search-input") return false;
            const meta = [
              el.getAttribute("placeholder") || "",
              el.getAttribute("aria-label") || "",
              el.getAttribute("name") || "",
              tid
            ].join(" ");
            return /label|标签|k=v|key=value/i.test(meta);
          });
        if (!inp || !inp.value) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(inp, "");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.blur();
        return true;
      })()
    `);
    if (clearedInput) {
      await cdp.pressKey("Enter");
      await sleep(250);
    }

    const activeChipToToggle = await cdp.evalJS(`
      (() => {
        const row = document.querySelector('[data-testid="run-row-' + ${JSON.stringify(runId)} + '"]');
        if (!row) return false;
        const direct =
          row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(runId)} + '-' + ${JSON.stringify(key)} + '"]') ||
          row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(key)} + '"]') ||
          row.querySelector('[data-testid^="run-label-chip-"][data-label-key="' + ${JSON.stringify(key)} + '"]');
        const chip = direct || Array.from(row.querySelectorAll('button, [role="button"]')).find((el) => {
          const t = (el.textContent || "").trim();
          return t === ${JSON.stringify(filterExpr)} || t === ${JSON.stringify(key + ": " + value)};
        });
        return Boolean(chip && (chip.getAttribute("aria-pressed") === "true" || chip.getAttribute("data-active") === "true"));
      })()
    `);
    if (activeChipToToggle) {
      await clickDomMatch(
        cdp,
        `() => {
          const row = document.querySelector('[data-testid="run-row-' + ${JSON.stringify(runId)} + '"]');
          if (!row) return null;
          return (
            row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(runId)} + '-' + ${JSON.stringify(key)} + '"]') ||
            row.querySelector('[data-testid="run-label-chip-' + ${JSON.stringify(key)} + '"]') ||
            row.querySelector('[data-testid^="run-label-chip-"][data-label-key="' + ${JSON.stringify(key)} + '"]') ||
            Array.from(row.querySelectorAll('button, [role="button"]')).find((el) => {
              const t = (el.textContent || "").trim();
              return t === ${JSON.stringify(filterExpr)} || t === ${JSON.stringify(key + ": " + value)};
            }) ||
            null
          );
        }`,
        `Toggle off Slice 3 label chip ${filterExpr}`
      );
      await sleep(250);
    }
  }

  // Ensure runs workspace & threads tab at 1440x900
  if ((await cdpClient.evalJS(`window.__AHUB_EVAL__?.getState()?.workspaceMode`)) !== "runs") {
    await cdpClient.clickSelector('[data-testid="workspace-tab-runs"]');
    await sleep(200);
  }
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(150);

  for (let i = 0; i < 40; i++) {
    const bothThreadsReady = await cdpClient.evalJS(`
      Boolean(document.querySelector('[data-testid="thread-item-${s3OkRun.thread_id}"] button:nth-of-type(2)')) &&
      Boolean(document.querySelector('[data-testid="thread-item-${s3MismatchRun.thread_id}"] button:nth-of-type(2)'))
    `);
    if (bothThreadsReady) break;
    if (i === 39) {
      throw new Error(`Slice 3 threads did not hydrate in UI (${s3OkRun.thread_id}, ${s3MismatchRun.thread_id})`);
    }
    await sleep(150);
  }

  // Reset CLS at start of Phase 4d steady checks
  await cdpClient.evalJS(`window.__AHUB_CLS__ = 0; window.__AHUB_CLS_SOURCES__ = [];`);

  // Select s3OkRun thread & run -> verify label chips + structured result viewer + secret redaction + tabular-nums + zero transition-all/emoji
  await cdpClient.clickSelector(`[data-testid="thread-item-${s3OkRun.thread_id}"] button:nth-of-type(2)`);
  for (let i = 0; i < 30; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="run-row-${s3OkRun.id}"]'))`)) break;
    if (i === 29) throw new Error(`s3OkRun row ${s3OkRun.id} did not render in ConversationPane`);
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="run-row-${s3OkRun.id}"]`);

  let s3OkUi = null;
  for (let i = 0; i < 30; i++) {
    s3OkUi = await inspectSlice3RunRow(cdpClient, s3OkRun.id, s3OkLabels, {
      preSnippet: '"count"',
      ok: true,
      count: 7
    });
    const chipsOk = Object.keys(s3OkLabels).every((k) => s3OkUi?.chipResults?.[k]?.found);
    if (s3OkUi?.foundRow && chipsOk && s3OkUi?.resultInfo?.found) break;
    await sleep(150);
  }
  for (const [k, v] of Object.entries(s3OkLabels)) {
    const chip = s3OkUi?.chipResults?.[k];
    if (!chip?.found || !chip.isMono || chip.hasTransitionAll) {
      throw new Error(`Slice 3 label chip check failed for ${k}=${v} on ${s3OkRun.id}: ${JSON.stringify(s3OkUi)}`);
    }
  }
  if ((s3OkUi?.decorativeEmojis?.length ?? 0) > 0) {
    throw new Error(`Slice 3 run row ${s3OkRun.id} contains prohibited decorative emoji: ${JSON.stringify(s3OkUi.decorativeEmojis)}`);
  }
  if (
    !s3OkUi?.resultInfo?.found ||
    (!s3OkUi.resultInfo.parsedOk && !s3OkUi.resultInfo.hasCountSnippet) ||
    !s3OkUi.resultInfo.viewerText.includes("[REDACTED]") ||
    s3OkUi.resultInfo.viewerText.includes(s3OkSecret) ||
    !s3OkUi.resultInfo.hasTabular ||
    s3OkUi.resultInfo.hasTransitionAll
  ) {
    throw new Error(`Slice 3 structured result viewer check failed on ${s3OkRun.id}: ${JSON.stringify(s3OkUi)}`);
  }

  // Trigger ?label=suite=slice3-ok filter -> verify UI matches GET /api/v1/runs?label=suite=slice3-ok -> clear filter
  const d1Slice3Filtered = (
    await apiJson(hubUrl, adminToken, `/api/v1/runs?label=${encodeURIComponent("suite=slice3-ok")}`)
  ).runs;
  if (
    !d1Slice3Filtered.some((r) => r.id === s3OkRun.id) ||
    d1Slice3Filtered.some((r) => r.id === s3MismatchRun.id)
  ) {
    throw new Error(`D1 ?label=suite=slice3-ok parity check invalid: ${JSON.stringify(d1Slice3Filtered.map((r) => r.id))}`);
  }
  const expectedFilteredThreadIds = [...new Set(d1Slice3Filtered.map((r) => r.thread_id))];

  await applySlice3LabelFilter(cdpClient, s3OkRun.id, "suite", "slice3-ok");
  let filterParityOk = false;
  let lastFilterDbg = null;
  for (let i = 0; i < 30; i++) {
    const visibleThreadIds = await cdpClient.evalJS(`
      Array.from(document.querySelectorAll('[data-testid="fleet-threads-pane"] [data-testid^="thread-item-"]'))
        .map((el) => (el.getAttribute("data-testid") || "").replace(/^thread-item-/, ""))
        .filter(Boolean)
    `);
    const hasOk = visibleThreadIds.includes(s3OkRun.thread_id);
    const hasMismatch = visibleThreadIds.includes(s3MismatchRun.thread_id);
    const matchesD1 =
      expectedFilteredThreadIds.every((tid) => visibleThreadIds.includes(tid)) &&
      visibleThreadIds.every((tid) => expectedFilteredThreadIds.includes(tid));
    lastFilterDbg = { visibleThreadIds, expectedFilteredThreadIds };
    if (hasOk && !hasMismatch && matchesD1) {
      filterParityOk = true;
      break;
    }
    await sleep(150);
  }
  if (!filterParityOk) {
    throw new Error(`Slice 3 ?label=suite=slice3-ok UI!=D1 filter parity failed: ${JSON.stringify(lastFilterDbg)}`);
  }

  await clearSlice3LabelFilter(cdpClient, s3OkRun.id, "suite", "slice3-ok");
  for (let i = 0; i < 30; i++) {
    const mismatchReappeared = await cdpClient.evalJS(
      `Boolean(document.querySelector('[data-testid="fleet-threads-pane"] [data-testid="thread-item-${s3MismatchRun.thread_id}"]'))`
    );
    if (mismatchReappeared) break;
    if (i === 29) {
      throw new Error(`s3MismatchRun thread ${s3MismatchRun.thread_id} did not reappear after clearing label filter`);
    }
    await sleep(150);
  }

  // Select s3MismatchRun -> verify RESULT_SCHEMA_MISMATCH banner AND MISMATCH_OUTPUT_KEPT_E2E output_md visibly rendered below
  await cdpClient.clickSelector(`[data-testid="thread-item-${s3MismatchRun.thread_id}"] button:nth-of-type(2)`);
  for (let i = 0; i < 30; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="run-row-${s3MismatchRun.id}"]'))`)) break;
    if (i === 29) throw new Error(`s3MismatchRun row ${s3MismatchRun.id} did not render`);
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="run-row-${s3MismatchRun.id}"]`);

  let s3MismatchUi = null;
  for (let i = 0; i < 30; i++) {
    s3MismatchUi = await cdpClient.evalJS(`
      (() => {
        const row = document.querySelector('[data-testid="run-row-${s3MismatchRun.id}"]');
        if (!row) return { foundRow: false };
        const failedBadge = Boolean(row.querySelector('[data-run-status="failed"]'));
        const cmdPreview = row.querySelector('[data-testid="run-cmd-preview-${s3MismatchRun.id}"]');
        const isOutsidePromptAndCmd = (el) => {
          if (cmdPreview && cmdPreview.contains(el)) return false;
          const promptBox = el.closest(".bg-muted\\\\/30");
          if (promptBox && (promptBox.textContent || "").includes("任务指令")) return false;
          return true;
        };
        const directBanner =
          row.querySelector('[data-testid="run-schema-mismatch-banner-${s3MismatchRun.id}"]') ||
          row.querySelector('[data-testid="result-schema-mismatch-${s3MismatchRun.id}"]') ||
          row.querySelector('[data-testid="result-schema-mismatch-banner-${s3MismatchRun.id}"]') ||
          row.querySelector('[data-testid^="result-schema-mismatch"]') ||
          row.querySelector('[data-error-code="RESULT_SCHEMA_MISMATCH"]');
        const fallbackBanner = Array.from(row.querySelectorAll("div, p, span, section")).find((el) => {
          if (!isOutsidePromptAndCmd(el) || el.closest(".ahub-markdown")) return false;
          if (!(el.textContent || "").includes("RESULT_SCHEMA_MISMATCH")) return false;
          return !Array.from(el.children).some((c) => (c.textContent || "").includes("RESULT_SCHEMA_MISMATCH"));
        });
        const bannerEl = directBanner || (fallbackBanner ? (fallbackBanner.closest('[data-testid], div') || fallbackBanner) : null);
        const outputEl =
          Array.from(row.querySelectorAll(".ahub-markdown")).find((el) =>
            (el.textContent || "").includes("MISMATCH_OUTPUT_KEPT_E2E")
          ) ||
          Array.from(row.querySelectorAll("div, p, pre")).find((el) => {
            if (!isOutsidePromptAndCmd(el)) return false;
            return (el.textContent || "").includes("MISMATCH_OUTPUT_KEPT_E2E");
          });
        const hasUnexpectedResultViewer = Boolean(
          row.querySelector(
            '[data-testid="run-result-viewer-${s3MismatchRun.id}"], [data-testid="run-result-${s3MismatchRun.id}"], [data-testid^="run-result-viewer"]'
          )
        );
        const bannerRect = bannerEl ? bannerEl.getBoundingClientRect() : null;
        const outputRect = outputEl ? outputEl.getBoundingClientRect() : null;
        return {
          foundRow: true,
          failedBadge,
          hasBanner: Boolean(bannerEl && bannerEl.offsetHeight > 0),
          hasOutput: Boolean(outputEl && outputEl.offsetHeight > 0),
          outputBelowBanner: Boolean(bannerRect && outputRect && outputRect.top >= bannerRect.top),
          hasUnexpectedResultViewer
        };
      })()
    `);
    if (
      s3MismatchUi?.foundRow &&
      s3MismatchUi.failedBadge &&
      s3MismatchUi.hasBanner &&
      s3MismatchUi.hasOutput &&
      s3MismatchUi.outputBelowBanner
    ) {
      break;
    }
    await sleep(150);
  }
  if (
    !s3MismatchUi?.foundRow ||
    !s3MismatchUi.failedBadge ||
    !s3MismatchUi.hasBanner ||
    !s3MismatchUi.hasOutput ||
    !s3MismatchUi.outputBelowBanner ||
    s3MismatchUi.hasUnexpectedResultViewer
  ) {
    throw new Error(`Slice 3 RESULT_SCHEMA_MISMATCH + preserved output_md check failed: ${JSON.stringify(s3MismatchUi)}`);
  }

  // Verify CLS <= 0.001 & viewport containment at 1440x900 and 390x844 mobile
  const slice3Cls = await cdpClient.evalJS(`window.__AHUB_CLS__ ?? 0`);
  const slice3ClsSources = await cdpClient.evalJS(`window.__AHUB_CLS_SOURCES__ ?? []`);
  if (slice3Cls > 0.001) {
    throw new Error(`Expected zero CLS in Slice 3 Phase 4d, got ${slice3Cls}; sources=${JSON.stringify(slice3ClsSources)}`);
  }
  await assertViewportContainment(cdpClient, "desktop-1440x900-slice3");

  await cdpClient.setViewport(390, 844, true);
  await sleep(250);
  await assertViewportContainment(cdpClient, "mobile-390x844-slice3-mismatch");
  await cdpClient.clickSelector('[data-testid="mobile-left-trigger"]');
  await sleep(250);
  await cdpClient.clickSelector(`[data-testid="thread-item-${s3OkRun.thread_id}"] button:nth-of-type(2)`);
  await sleep(250);
  await assertViewportContainment(cdpClient, "mobile-390x844-slice3-ok");
  await cdpClient.setViewport(1440, 900, false);
  await sleep(200);

  // Phase 5: Verify client-scope Board + Runs isolation (prefix-scoped AND empty-prefix) with zero 403/console errors
  const forbiddenResponses = [];
  await cdpClient.send("Network.enable");
  cdpClient.onEvent("Network.responseReceived", (params) => {
    const st = params?.response?.status;
    const url = params?.response?.url ?? "";
    if (st === 403 && url.startsWith(hubUrl)) {
      forbiddenResponses.push({ status: st, url });
    }
  });
  cdpClient.consoleErrors.length = 0;

  // Seed a clientBoardKey-owned linked run on s2Topic so Phase 5 can verify linked runs & [run] jump under client scope with 0 403s
  const clientS2RunRes = await apiJson(hubUrl, clientBoardKey.token, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      board_topic_id: s2Topic.id,
      actor_profile: "client-bot",
      title: "Phase 5 client 协同回写任务",
      prompt: JSON.stringify({
        summary: "client scope 协同回写完成",
        response: "client board handoff ok",
        directives: [{ op: "sleep", ms: 5 }]
      })
    })
  });
  const clientS2Run = await waitForSeedRunDone(clientS2RunRes.run.id, "Phase 5 clientBoardKey Slice 2 run");

  const clientS3Labels = { env: "client-eval", owner: "client-board" };
  const clientS3RunRes = await apiJson(hubUrl, clientBoardKey.token, "/api/v1/runs?wait_ms=0", {
    method: "POST",
    body: JSON.stringify({
      node_id: "macmini",
      workdir: wsAlpha,
      agent: "agy",
      labels: clientS3Labels,
      result_schema: s3ResultSchema,
      title: "Phase 5 client Slice 3 标签与结果校验任务",
      prompt: JSON.stringify({
        summary: "client scope Slice 3 完成",
        response: "client slice3 result ok",
        directives: [
          {
            op: "write_result_file",
            result: { ok: true, count: 3, note: "client scope ok" }
          }
        ]
      })
    })
  });
  const clientS3Run = await waitForSeedRunDone(clientS3RunRes.run.id, "Phase 5 clientBoardKey Slice 3 run");

  // Test A: clientBoardKey with allowed_board_prefixes: ["proj/demo"]
  await cdpClient.setViewport(1440, 900, false);
  await cdpClient.send("Page.navigate", { url: `${hubUrl}/?token=${clientBoardKey.token}` });
  let clientBoardState = null;
  for (let i = 0; i < 40; i++) {
    clientBoardState = await cdpClient.evalJS(`
      (() => {
        const s = window.__AHUB_EVAL__?.getState();
        if (
          !s ||
          s.authStatus !== "authenticated" ||
          s.authScope !== "client" ||
          s.workspaceMode !== "board" ||
          s.boardTopics.length < 1 ||
          s.streamStatus !== "connected"
        ) {
          return null;
        }
        return s;
      })()
    `);
    if (clientBoardState) break;
    await sleep(200);
  }
  if (
    !clientBoardState ||
    clientBoardState.workspaceMode !== "board" ||
    clientBoardState.boardPermissionDenied !== false ||
    !clientBoardState.selectedBoardTopicId ||
    clientBoardState.streamStatus !== "connected"
  ) {
    const latest = clientBoardState ?? (await cdpClient.evalJS(`window.__AHUB_EVAL__?.getState() ?? null`));
    throw new Error(`clientBoardKey login state invalid: ${JSON.stringify(latest)}`);
  }
  if (
    !clientBoardState.boardTopics.some((t) => t.channel === "proj/demo") ||
    clientBoardState.boardTopics.some((t) => t.channel === "ops/fleet") ||
    clientBoardState.boardChannels.some((c) => c.channel === "ops/fleet")
  ) {
    throw new Error(`clientBoardKey leaked unauthorized channel: ${JSON.stringify(clientBoardState)}`);
  }

  await cdpClient.clickSelector(`[data-testid="board-topic-item-${boardTop1.id}"]`);
  let clientBoardReadOnly = null;
  for (let i = 0; i < 30; i++) {
    clientBoardReadOnly = await cdpClient.evalJS(`({
      text: document.querySelector('[data-testid="board-topic-timeline"]')?.textContent ?? "",
      hasReadonlyBanner: Boolean(document.querySelector('[data-testid="board-client-readonly-banner"]')),
      hasAnswerSubmit: Boolean(document.querySelector('[data-testid^="board-answer-submit-btn-"]:not([disabled]), [data-testid="board-mobile-answer-submit-btn"]:not([disabled])'))
    })`);
    if (
      clientBoardReadOnly.hasReadonlyBanner &&
      clientBoardReadOnly.text.includes("仅管理员可答复协同板阻塞提问")
    ) {
      break;
    }
    await sleep(100);
  }
  if (
    !clientBoardReadOnly.text.includes("仅管理员可答复协同板阻塞提问") ||
    !clientBoardReadOnly.hasReadonlyBanner ||
    clientBoardReadOnly.hasAnswerSubmit
  ) {
    throw new Error(`Expected client scope Board question to render read-only notice without answer submit, got ${JSON.stringify(clientBoardReadOnly)}`);
  }

  // Verify viewing s2Topic with linked runs & clicking [run] jump in client scope produces 0 403s & 0 consoleErrors
  await cdpClient.clickSelector(`[data-testid="board-topic-item-${s2Topic.id}"]`);
  for (let i = 0; i < 30; i++) {
    const clientS2Ready = await cdpClient.evalJS(`
      (() => {
        const inspText = document.querySelector('[data-testid="board-topic-inspector"]')?.textContent ?? "";
        const direct =
          document.querySelector('[data-testid="board-handoff-run-link-${clientS2Run.id}"]') ||
          document.querySelector('[data-testid="board-run-link-${clientS2Run.id}"]');
        const rows = Array.from(document.querySelectorAll('[data-testid="board-messages-list"] [data-message-kind="handoff"]'));
        const row = rows.find((el) => (el.textContent || "").includes(${JSON.stringify(clientS2Run.id)}));
        const link = direct || (row
          ? Array.from(row.querySelectorAll("button, a")).find((el) => {
              const t = (el.textContent || "").trim();
              const rid = el.getAttribute("data-run-id") || "";
              return rid === ${JSON.stringify(clientS2Run.id)} || t.includes("[run]") || t.includes(${JSON.stringify(clientS2Run.id)}) || t.includes("查看任务");
            })
          : null);
        return Boolean(link && inspText.includes(${JSON.stringify(clientS2Run.id)}));
      })()
    `);
    if (clientS2Ready) break;
    if (i === 29) {
      throw new Error(`clientBoardKey s2Topic linked run / [run] link (${clientS2Run.id}) did not render in time`);
    }
    await sleep(150);
  }
  await clickDomMatch(
    cdpClient,
    `() => {
      const direct =
        document.querySelector('[data-testid="board-handoff-run-link-${clientS2Run.id}"]') ||
        document.querySelector('[data-testid="board-run-link-${clientS2Run.id}"]');
      if (direct) return direct;
      const rows = Array.from(document.querySelectorAll('[data-testid="board-messages-list"] [data-message-kind="handoff"]'));
      const row = rows.find((el) => (el.textContent || "").includes(${JSON.stringify(clientS2Run.id)}));
      if (!row) return null;
      return Array.from(row.querySelectorAll("button, a")).find((el) => {
        const t = (el.textContent || "").trim();
        const rid = el.getAttribute("data-run-id") || "";
        return rid === ${JSON.stringify(clientS2Run.id)} || t.includes("[run]") || t.includes(${JSON.stringify(clientS2Run.id)}) || t.includes("查看任务");
      }) || null;
    }`,
    `client scope [run] link for ${clientS2Run.id}`
  );
  for (let i = 0; i < 25; i++) {
    const clientJumped = await cdpClient.evalJS(`({
      workspaceMode: window.__AHUB_EVAL__?.getState()?.workspaceMode,
      selectedRunId: window.__AHUB_EVAL__?.getState()?.selectedRunId
    })`);
    if (clientJumped.workspaceMode === "runs" && clientJumped.selectedRunId === clientS2Run.id) break;
    if (i === 24) {
      throw new Error(`client scope [run] jump failed for ${clientS2Run.id}: ${JSON.stringify(clientJumped)}`);
    }
    await sleep(150);
  }

  await cdpClient.clickSelector('[data-testid="workspace-tab-inbox"]');
  await sleep(200);
  const clientInboxListCheck = await cdpClient.evalJS(`({
    hasBoardQ: Boolean(document.querySelector('[data-testid="inbox-item-board:${qMobile.id}"]')),
    nativeItemsCount: document.querySelectorAll('[data-testid^="inbox-item-native:"]').length
  })`);
  if (!clientInboxListCheck.hasBoardQ || clientInboxListCheck.nativeItemsCount !== 0) {
    throw new Error(`clientBoardKey inbox check failed: ${JSON.stringify(clientInboxListCheck)}`);
  }
  await cdpClient.clickSelector(`[data-testid="inbox-item-board:${qMobile.id}"]`);
  await sleep(200);
  const clientInboxReadOnly = await cdpClient.evalJS(`({
    hasReadonlyBanner: Boolean(document.querySelector('[data-testid="inbox-client-readonly-banner"]')),
    detailText: document.querySelector('[data-testid="inbox-detail-pane"]')?.textContent ?? "",
    hasEnabledAnswerSubmit: Boolean(document.querySelector('[data-testid="inbox-answer-submit-btn"]:not([disabled])')),
    hasEnabledOptionBtn: Boolean(document.querySelector('[data-testid^="inbox-question-option-"]:not([disabled])'))
  })`);
  if (
    !clientInboxReadOnly.hasReadonlyBanner ||
    !clientInboxReadOnly.detailText.includes("仅管理员可答复协同板阻塞提问") ||
    clientInboxReadOnly.hasEnabledAnswerSubmit ||
    clientInboxReadOnly.hasEnabledOptionBtn
  ) {
    throw new Error(`Expected client scope Inbox question to render read-only without enabled answer controls, got ${JSON.stringify(clientInboxReadOnly)}`);
  }
  // Pressing 1 + Enter in client-scope Inbox must never emit 403 /answer requests
  await cdpClient.pressKey("1");
  await cdpClient.pressKey("Enter");
  await sleep(150);

  await cdpClient.clickSelector('[data-testid="workspace-tab-runs"]');
  let runsState = null;
  for (let i = 0; i < 20; i++) {
    runsState = await cdpClient.evalJS(`window.__AHUB_EVAL__?.getState() ?? null`);
    if (runsState && runsState.workspaceMode === "runs" && runsState.streamStatus === "disconnected") break;
    await sleep(100);
  }
  if (!runsState || runsState.workspaceMode !== "runs" || runsState.streamStatus !== "disconnected") {
    throw new Error(`Expected clientBoardKey runs workspace to disconnect topic stream, got ${JSON.stringify(runsState)}`);
  }
  await cdpClient.clickSelector('[data-testid="inspector-pane"] [role="tab"]:nth-of-type(4)');
  await sleep(200);
  const clientBoardInspectorCheck = await cdpClient.evalJS(`({
    hasNotifySelect: Boolean(document.querySelector('[data-testid="node-default-notify-select"]')),
    hasFleetNativeTab: Boolean(document.querySelector('[data-testid="fleet-tab-native"]')),
    hasBrowserNotifyBtn: Boolean(document.querySelector('[data-testid="open-browser-notify-btn"]')),
    hasInteractionsPill: Boolean(document.querySelector('[data-testid="open-interactions-pill"]')),
    hasDeliveriesTab: Boolean(document.querySelector('[data-testid="inspector-tab-deliveries"]'))
  })`);
  if (
    clientBoardInspectorCheck.hasNotifySelect ||
    clientBoardInspectorCheck.hasFleetNativeTab ||
    clientBoardInspectorCheck.hasBrowserNotifyBtn ||
    clientBoardInspectorCheck.hasInteractionsPill ||
    clientBoardInspectorCheck.hasDeliveriesTab
  ) {
    throw new Error(`clientBoardKey leaked admin controls in runs workspace: ${JSON.stringify(clientBoardInspectorCheck)}`);
  }

  // Verify clientBoardKey-owned Slice 3 labeled run & ?label= filter in runs workspace produce 0 403s & 0 consoleErrors
  await cdpClient.clickSelector('[data-testid="fleet-tab-threads"]');
  await sleep(150);
  for (let i = 0; i < 30; i++) {
    const clientS3ThreadReady = await cdpClient.evalJS(
      `Boolean(document.querySelector('[data-testid="thread-item-${clientS3Run.thread_id}"] button:nth-of-type(2)'))`
    );
    if (clientS3ThreadReady) break;
    if (i === 29) {
      throw new Error(`clientBoardKey Slice 3 thread ${clientS3Run.thread_id} did not appear in FleetThreadsPane`);
    }
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="thread-item-${clientS3Run.thread_id}"] button:nth-of-type(2)`);
  for (let i = 0; i < 30; i++) {
    if (await cdpClient.evalJS(`Boolean(document.querySelector('[data-testid="run-row-${clientS3Run.id}"]'))`)) break;
    if (i === 29) throw new Error(`clientBoardKey Slice 3 run row ${clientS3Run.id} did not render`);
    await sleep(150);
  }
  await cdpClient.clickSelector(`[data-testid="run-row-${clientS3Run.id}"]`);
  let clientS3Ui = null;
  for (let i = 0; i < 30; i++) {
    clientS3Ui = await inspectSlice3RunRow(cdpClient, clientS3Run.id, clientS3Labels, {
      preSnippet: '"count"',
      ok: true,
      count: 3
    });
    const chipsOk = Object.keys(clientS3Labels).every((k) => clientS3Ui?.chipResults?.[k]?.found);
    if (clientS3Ui?.foundRow && chipsOk && clientS3Ui?.resultInfo?.found) break;
    await sleep(150);
  }
  if (
    !clientS3Ui?.foundRow ||
    !Object.keys(clientS3Labels).every((k) => clientS3Ui?.chipResults?.[k]?.found) ||
    !clientS3Ui?.resultInfo?.found ||
    (!clientS3Ui.resultInfo.parsedOk && !clientS3Ui.resultInfo.hasCountSnippet)
  ) {
    throw new Error(`clientBoardKey Slice 3 label/result rendering check failed: ${JSON.stringify(clientS3Ui)}`);
  }

  const clientD1Labeled = (
    await apiJson(hubUrl, clientBoardKey.token, `/api/v1/runs?label=${encodeURIComponent("owner=client-board")}`)
  ).runs;
  if (
    !clientD1Labeled.some((r) => r.id === clientS3Run.id) ||
    clientD1Labeled.some((r) => r.id === s3OkRun.id) ||
    clientD1Labeled.some((r) => r.id === clientS2Run.id)
  ) {
    throw new Error(`clientBoardKey ?label=owner=client-board D1 isolation failed: ${JSON.stringify(clientD1Labeled.map((r) => r.id))}`);
  }
  await applySlice3LabelFilter(cdpClient, clientS3Run.id, "owner", "client-board");
  let clientFilterOk = false;
  let lastClientFilterDbg = null;
  for (let i = 0; i < 30; i++) {
    const visibleIds = await cdpClient.evalJS(`
      Array.from(document.querySelectorAll('[data-testid="fleet-threads-pane"] [data-testid^="thread-item-"]'))
        .map((el) => (el.getAttribute("data-testid") || "").replace(/^thread-item-/, ""))
        .filter(Boolean)
    `);
    lastClientFilterDbg = visibleIds;
    if (
      visibleIds.includes(clientS3Run.thread_id) &&
      !visibleIds.includes(clientS2Run.thread_id) &&
      !visibleIds.includes(s3OkRun.thread_id)
    ) {
      clientFilterOk = true;
      break;
    }
    await sleep(150);
  }
  if (!clientFilterOk) {
    throw new Error(`clientBoardKey ?label=owner=client-board UI filter parity failed: ${JSON.stringify(lastClientFilterDbg)}`);
  }
  await clearSlice3LabelFilter(cdpClient, clientS3Run.id, "owner", "client-board");
  for (let i = 0; i < 30; i++) {
    const restored = await cdpClient.evalJS(`({
      hasClientS2: Boolean(document.querySelector('[data-testid="fleet-threads-pane"] [data-testid="thread-item-${clientS2Run.thread_id}"]')),
      hasAdminS3: Boolean(document.querySelector('[data-testid="fleet-threads-pane"] [data-testid="thread-item-${s3OkRun.thread_id}"]'))
    })`);
    if (restored.hasClientS2 && !restored.hasAdminS3) break;
    if (i === 29) {
      throw new Error(`clientBoardKey label filter clear / isolation failed: ${JSON.stringify(restored)}`);
    }
    await sleep(150);
  }

  // Test B: clientScopeKey with default allowed_board_prefixes: []
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
        if (!s || s.authStatus !== "authenticated" || s.authScope !== "client" || s.nodes.length < 2 || !s.boardPermissionDenied) return null;
        return s;
      })()
    `);
    if (clientState) break;
    await sleep(200);
  }
  if (!clientState || clientState.boardPermissionDenied !== true || clientState.streamStatus !== "disconnected") {
    const latest = clientState ?? (await cdpClient.evalJS(`window.__AHUB_EVAL__?.getState() ?? null`));
    throw new Error(`Client-scoped token login did not hydrate cleanly with boardPermissionDenied & disconnected global stream: ${JSON.stringify(latest)}`);
  }
  const emptyPrefixText = await cdpClient.evalJS(`document.querySelector('[data-testid="board-workspace"]')?.textContent ?? ""`);
  if (!emptyPrefixText.includes("当前凭证尚未分配协同板频道前缀权限")) {
    throw new Error(`Expected empty-prefix board guidance for clientScopeKey, got: ${emptyPrefixText.slice(0, 200)}`);
  }
  await cdpClient.clickSelector('[data-testid="workspace-tab-runs"]');
  await sleep(200);
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

  // Phase 6: Zero-token Cloudflare Access cookie login verification in real Chromium (defaults to board)
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
  if (
    !cookieState ||
    cookieState.storedToken !== null ||
    cookieState.nodes.length < 2 ||
    cookieState.workspaceMode !== "board" ||
    cookieState.boardTopics.length < 2
  ) {
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
    `L2 CDP Runtime Eval PASSED: UI==D1 parity ok, flood ring-buffer=${floodCount}, stream CLS=${floodCls}, DnD priority_order persisted, Slice 3 labels/result ok, mobile overflow=0, zero-token CF Access cookie ok, 5 screenshots written to ${screenshotDir}`
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
