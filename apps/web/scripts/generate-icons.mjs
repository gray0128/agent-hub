#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const webDir = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(webDir, "public");
const iconsDir = path.join(publicDir, "icons");

const chromeCandidates = [
  process.env.AHUB_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean);

const chromeBin = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chromeBin) {
  console.error("Chrome binary not found. Set AHUB_CHROME_BIN to a Chromium/Chrome executable.");
  process.exit(1);
}

const BRAND_PATHS = {
  arms: "M15.5 17.5L23 24M15.5 46.5L23 40M44 32H51",
  strokeWidth: 6,
  hubCx: 32,
  hubCy: 32,
  hubRadius: 6,
  bgColor: "#18181b",
  fgColor: "#f4f4f5",
  hubColor: "#22c55e"
};

function buildBrandInnerSvg(fgColor, hubColor, scale = 1) {
  const shapes = `
  <path d="${BRAND_PATHS.arms}" stroke="${fgColor}" stroke-width="${BRAND_PATHS.strokeWidth}" stroke-linecap="round" />
  <circle cx="${BRAND_PATHS.hubCx}" cy="${BRAND_PATHS.hubCy}" r="${BRAND_PATHS.hubRadius}" fill="${hubColor}" />`.trim();
  if (scale === 1) {
    return shapes;
  }
  const tx = Number((32 * (1 - scale)).toFixed(3));
  return `<g transform="translate(${tx} ${tx}) scale(${scale})">\n    ${shapes}\n  </g>`;
}

function buildAppIconSvg({ rounded = true, border = true, scale = 1, fgColor = BRAND_PATHS.fgColor, hubColor = BRAND_PATHS.hubColor, bg = BRAND_PATHS.bgColor } = {}) {
  const bgRect = rounded
    ? `  <rect width="64" height="64" rx="14" fill="${bg}" />`
    : `  <rect width="64" height="64" fill="${bg}" />`;
  const borderRect = border
    ? `\n  <rect x="1.5" y="1.5" width="61" height="61" rx="${rounded ? "12.5" : "0"}" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1.5" />`
    : "";
  const inner = buildBrandInnerSvg(fgColor, hubColor, scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n${bgRect}${borderRect}\n  ${inner}\n</svg>\n`;
}

function buildBadgeSvg() {
  const inner = buildBrandInnerSvg("#ffffff", "#ffffff", 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">\n  ${inner}\n</svg>\n`;
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killGroup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
    });
    this.ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  async connect() {
    await this.opened;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readPngMetrics(buf) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(magic)) {
    throw new Error("Invalid PNG magic header");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk: ${type}`);
    }
    const chunkData = buf.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`Expected 8-bit RGB/RGBA PNG, got bitDepth=${bitDepth}, colorType=${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const dstStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[dstStart + x - bpp] : 0;
      const b = y > 0 ? pixels[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0;
      let val = src[x];
      if (filter === 1) val = (val + a) & 0xff;
      else if (filter === 2) val = (val + b) & 0xff;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (val + paethPredictor(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[dstStart + x] = val;
    }
  }

  const pixelAt = (x, y) => {
    const idx = (y * width + x) * bpp;
    return colorType === 6
      ? [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]]
      : [pixels[idx], pixels[idx + 1], pixels[idx + 2], 255];
  };

  return { width, height, colorType, pixelAt };
}

function buildIcoFromPngs(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let dataOffset = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const entry of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(entry.png.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dirEntries.push(dir);
    dataOffset += entry.png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]);
}

async function renderSvgToPng(cdp, svgMarkup, size) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 }
  });

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}svg{display:block;width:${size}px;height:${size}px;}</style></head><body>${svgMarkup}</body></html>`
  )}`;
  await cdp.send("Page.navigate", { url: dataUrl });
  await sleep(120);

  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 }
  });
  return Buffer.from(result.data, "base64");
}

function assertCorners(metrics, expectedAlpha, label) {
  const { width, height, pixelAt } = metrics;
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1]
  ];
  for (const [x, y] of corners) {
    const [, , , a] = pixelAt(x, y);
    if (a !== expectedAlpha) {
      throw new Error(`${label}: expected corner (${x},${y}) alpha=${expectedAlpha}, got ${a}`);
    }
  }
}

async function main() {
  fs.mkdirSync(iconsDir, { recursive: true });

  const iconSvg = buildAppIconSvg({ rounded: true, border: true, scale: 1 });
  const maskableSvg = buildAppIconSvg({ rounded: false, border: false, scale: 0.8 });
  const appleTouchSvg = buildAppIconSvg({ rounded: false, border: false, scale: 0.92 });
  const badgeSvg = buildBadgeSvg();

  fs.writeFileSync(path.join(iconsDir, "icon.svg"), iconSvg, "utf8");

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "ahub-gen-icons-"));
  let chromeProc;
  let cdp;

  try {
    const port = await getFreePort();
    chromeProc = spawn(
      chromeBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${tmpProfile}`,
        `--remote-debugging-port=${port}`,
        "--window-size=512,512",
        "about:blank"
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] }
    );

    await waitForHttp(`http://127.0.0.1:${port}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    const png16 = await renderSvgToPng(cdp, iconSvg, 16);
    const png32 = await renderSvgToPng(cdp, iconSvg, 32);
    const png192 = await renderSvgToPng(cdp, iconSvg, 192);
    const png512 = await renderSvgToPng(cdp, iconSvg, 512);
    const pngMaskable512 = await renderSvgToPng(cdp, maskableSvg, 512);
    const pngApple180 = await renderSvgToPng(cdp, appleTouchSvg, 180);
    const pngBadge96 = await renderSvgToPng(cdp, badgeSvg, 96);

    const m16 = readPngMetrics(png16);
    const m32 = readPngMetrics(png32);
    const m192 = readPngMetrics(png192);
    const m512 = readPngMetrics(png512);
    const mMaskable = readPngMetrics(pngMaskable512);
    const mApple = readPngMetrics(pngApple180);
    const mBadge = readPngMetrics(pngBadge96);

    if (m16.width !== 16 || m16.height !== 16) throw new Error(`favicon 16 size mismatch: ${m16.width}x${m16.height}`);
    if (m32.width !== 32 || m32.height !== 32) throw new Error(`favicon 32 size mismatch: ${m32.width}x${m32.height}`);
    if (m192.width !== 192 || m192.height !== 192) throw new Error(`icon-192 size mismatch: ${m192.width}x${m192.height}`);
    if (m512.width !== 512 || m512.height !== 512) throw new Error(`icon-512 size mismatch: ${m512.width}x${m512.height}`);
    if (mMaskable.width !== 512 || mMaskable.height !== 512) throw new Error(`icon-maskable-512 size mismatch: ${mMaskable.width}x${mMaskable.height}`);
    if (mApple.width !== 180 || mApple.height !== 180) throw new Error(`apple-touch-icon size mismatch: ${mApple.width}x${mApple.height}`);
    if (mBadge.width !== 96 || mBadge.height !== 96) throw new Error(`badge-96 size mismatch: ${mBadge.width}x${mBadge.height}`);

    assertCorners(m192, 0, "icon-192.png");
    assertCorners(m512, 0, "icon-512.png");
    assertCorners(mMaskable, 255, "icon-maskable-512.png");
    assertCorners(mApple, 255, "apple-touch-icon.png");
    assertCorners(mBadge, 0, "badge-96.png");

    // Verify center hub dot in icon-192 is green and badge-96 center is opaque white
    const [hubR, hubG, hubB, hubA] = m192.pixelAt(96, 96);
    if (hubA !== 255 || hubG <= hubR || hubG <= hubB) {
      throw new Error(`icon-192.png center hub pixel unexpected RGBA(${hubR},${hubG},${hubB},${hubA})`);
    }
    const [bR, bG, bB, bA] = mBadge.pixelAt(48, 48);
    if (bA !== 255 || bR !== 255 || bG !== 255 || bB !== 255) {
      throw new Error(`badge-96.png center pixel unexpected RGBA(${bR},${bG},${bB},${bA})`);
    }

    const faviconIco = buildIcoFromPngs([
      { size: 16, png: png16 },
      { size: 32, png: png32 }
    ]);
    if (faviconIco.readUInt16LE(2) !== 1 || faviconIco.readUInt16LE(4) !== 2) {
      throw new Error("favicon.ico header validation failed");
    }

    fs.writeFileSync(path.join(iconsDir, "icon-192.png"), png192);
    fs.writeFileSync(path.join(iconsDir, "icon-512.png"), png512);
    fs.writeFileSync(path.join(iconsDir, "icon-maskable-512.png"), pngMaskable512);
    fs.writeFileSync(path.join(iconsDir, "apple-touch-icon.png"), pngApple180);
    fs.writeFileSync(path.join(iconsDir, "badge-96.png"), pngBadge96);
    fs.writeFileSync(path.join(publicDir, "favicon.ico"), faviconIco);

    console.log("Generated and verified all agent-hub icons:");
    console.log("  - apps/web/public/icons/icon.svg (64x64 viewBox)");
    console.log("  - apps/web/public/icons/icon-192.png (192x192 rounded transparent)");
    console.log("  - apps/web/public/icons/icon-512.png (512x512 rounded transparent)");
    console.log("  - apps/web/public/icons/icon-maskable-512.png (512x512 opaque 80% safe zone)");
    console.log("  - apps/web/public/icons/apple-touch-icon.png (180x180 opaque)");
    console.log("  - apps/web/public/icons/badge-96.png (96x96 monochrome white silhouette)");
    console.log("  - apps/web/public/favicon.ico (16x16 + 32x32 PNG-in-ICO)");
  } finally {
    if (cdp) cdp.close();
    killGroup(chromeProc);
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }
}

await main();
