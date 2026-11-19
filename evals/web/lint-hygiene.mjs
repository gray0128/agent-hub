#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(repoRoot, "apps", "web");
const pkgPath = path.join(webDir, "package.json");
const srcDir = path.join(webDir, "src");

const failures = [];

function fail(check, detail) {
  failures.push(`[${check}] ${detail}`);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const allDeps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {})
};

const bannedExact = new Set([
  "antd",
  "framer-motion",
  "gsap",
  "react-spring",
  "@formkit/auto-animate",
  "allotment",
  "react-split",
  "react-beautiful-dnd",
  "@hello-pangea/dnd",
  "react-dnd",
  "sortablejs",
  "redux",
  "@reduxjs/toolkit",
  "jotai",
  "recoil",
  "mobx",
  "valtio",
  "@radix-ui/react-icons",
  "react-icons",
  "@tabler/icons-react"
]);

const bannedPrefixes = ["@mui/", "@chakra-ui/", "@mantine/", "@heroicons/"];

for (const dep of Object.keys(allDeps)) {
  if (bannedExact.has(dep) || bannedPrefixes.some((p) => dep.startsWith(p))) {
    fail("dependency-allowlist", `禁止引入依赖: ${dep}`);
  }
}

for (const required of ["lucide-react", "motion", "react-resizable-panels", "@dnd-kit/core", "zustand"]) {
  if (!allDeps[required]) {
    fail("dependency-required", `缺少必需核心依赖: ${required}`);
  }
}

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const emojiRegex = /\p{Extended_Pictographic}/u;
const neonRegex = /\b(from|via|to)-(purple|violet|fuchsia|indigo)-(400|500|600)\b/i;

const sourceFiles = collectSourceFiles(srcDir);
for (const file of sourceFiles) {
  const rel = path.relative(repoRoot, file);
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/\btransition-all\b/.test(line) || /transition\s*:\s*all\b/i.test(line)) {
      fail("no-transition-all", `${rel}:${lineNo} 出现禁止的 transition-all`);
    }
    if (/from\s+["']framer-motion["']/.test(line)) {
      fail("motion-import", `${rel}:${lineNo} 必须从 motion/react 导入`);
    }
    if (emojiRegex.test(line) && !line.trim().startsWith("//")) {
      fail("no-decorative-emoji", `${rel}:${lineNo} 包含装饰性 emoji`);
    }
    if (neonRegex.test(line)) {
      fail("no-neon-gradient", `${rel}:${lineNo} 包含禁止的紫蓝霓虹渐变`);
    }
    if (/\bfetch\s*\(/.test(line) && rel !== "apps/web/src/lib/api-client.ts") {
      fail("single-api-client", `${rel}:${lineNo} 禁止绕过 api-client.ts 直接调用 fetch()`);
    }
  });

  if (/setInterval\s*\([\s\S]*?\/api\//.test(content)) {
    fail("no-api-polling", `${rel} 存在面向 /api/ 的 setInterval 轮询`);
  }

  if (/<Card[\s>]/.test(content) && /<Card[\s>][\s\S]*<Card[\s>]/.test(content)) {
    fail("no-card-in-card", `${rel} 疑似存在卡片嵌套卡片 (<Card> 嵌套)`);
  }
}

// Verify tabular-nums discipline across the main workbench panes and dialogs
for (const pane of [
  "apps/web/src/components/workbench/FleetThreadsPane.tsx",
  "apps/web/src/components/workbench/ConversationPane.tsx",
  "apps/web/src/components/workbench/InspectorPane.tsx",
  "apps/web/src/components/workbench/NativeActivityPane.tsx",
  "apps/web/src/components/workbench/BrowserNotifyDialog.tsx"
]) {
  const paneContent = fs.readFileSync(path.join(repoRoot, pane), "utf8");
  if (!paneContent.includes("tabular-nums")) {
    fail("tabular-nums", `${pane} 未对动态数字/时间戳启用 tabular-nums`);
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC) || buf.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

function assertPublicAssetRef(srcPath, checkName, expectedSizes) {
  if (typeof srcPath !== "string" || !srcPath.startsWith("/")) {
    fail(checkName, `图标引用必须以 / 开头: ${String(srcPath)}`);
    return;
  }
  const diskFile = path.join(webDir, "public", srcPath.slice(1));
  if (!fs.existsSync(diskFile) || fs.statSync(diskFile).size === 0) {
    fail(checkName, `缺少或空的静态图标文件: ${srcPath}`);
    return;
  }
  if (srcPath.endsWith(".png")) {
    const dims = readPngDimensions(diskFile);
    if (!dims) {
      fail(checkName, `无效的 PNG 文件头或缺少 IHDR: ${srcPath}`);
      return;
    }
    if (expectedSizes) {
      const m = /^(\d+)x(\d+)$/.exec(expectedSizes.trim());
      if (!m || dims.width !== Number(m[1]) || dims.height !== Number(m[2])) {
        fail(checkName, `${srcPath} 真实尺寸 ${dims.width}x${dims.height} 与声明 sizes="${expectedSizes}" 不符`);
      }
    }
  } else if (srcPath.endsWith(".ico")) {
    const buf = fs.readFileSync(diskFile);
    if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1 || buf.readUInt16LE(4) < 1) {
      fail(checkName, `无效的 ICO 文件结构: ${srcPath}`);
    }
  }
}

// Verify zero-backhaul Service Worker (no fetch(), no /api/, unconditional showNotification)
const swPath = path.join(webDir, "public", "sw.js");
if (!fs.existsSync(swPath)) {
  fail("sw-exists", "缺少 apps/web/public/sw.js");
} else {
  const swContent = fs.readFileSync(swPath, "utf8");
  const stripped = swContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (/\bfetch\s*\(/.test(stripped) || /\/api\//.test(stripped)) {
    fail("sw-no-api-fetch", "apps/web/public/sw.js 严禁调用 fetch() 或请求 /api/（必须保持零回源）");
  }
  if (!/self\.registration\.showNotification\s*\(/.test(stripped)) {
    fail("sw-show-notification", "apps/web/public/sw.js 必须在 push 中调用 self.registration.showNotification()");
  }
  const iconMatch = /\bicon\s*:\s*["']([^"']+)["']/.exec(stripped);
  const badgeMatch = /\bbadge\s*:\s*["']([^"']+)["']/.exec(stripped);
  assertPublicAssetRef(iconMatch?.[1], "sw-notification-icon", "192x192");
  assertPublicAssetRef(badgeMatch?.[1], "sw-notification-badge", "96x96");
}

// Verify PWA manifest and index.html credentials link
const manifestPath = path.join(webDir, "public", "manifest.webmanifest");
if (!fs.existsSync(manifestPath)) {
  fail("pwa-manifest", "缺少 apps/web/public/manifest.webmanifest");
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.display !== "standalone" || manifest.start_url !== "/") {
      fail("pwa-manifest", "manifest.webmanifest 必须声明 display=standalone 且 start_url=/");
    }
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    if (icons.length === 0) {
      fail("pwa-manifest", "manifest.webmanifest 必须包含至少一个图标");
    }
    let hasMaskable = false;
    for (const icon of icons) {
      assertPublicAssetRef(icon?.src, "pwa-manifest", icon?.sizes);
      if (typeof icon?.purpose === "string" && icon.purpose.split(/\s+/).includes("maskable")) {
        hasMaskable = true;
      }
    }
    if (!hasMaskable) {
      fail("pwa-manifest-maskable", "manifest.webmanifest 必须包含至少一个 purpose=maskable 图标");
    }
  } catch (err) {
    fail("pwa-manifest", `manifest.webmanifest JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const indexHtmlPath = path.join(webDir, "index.html");
const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
if (!indexHtml.includes("manifest.webmanifest") || !indexHtml.includes('crossorigin="use-credentials"')) {
  fail("pwa-index-html", 'apps/web/index.html 必须包含 <link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
}
if (!/<meta[^>]*name=["']viewport["'][^>]*viewport-fit=cover/i.test(indexHtml)) {
  fail("mobile-viewport-fit", 'apps/web/index.html 的 viewport meta 必须声明 viewport-fit=cover');
}
const iconLinkMatches = [...indexHtml.matchAll(/<link\b([^>]*\brel=["'](?:icon|apple-touch-icon)["'][^>]*)>/gi)];
if (iconLinkMatches.length === 0) {
  fail("index-html-icons", "apps/web/index.html 必须声明至少一个 icon 或 apple-touch-icon");
} else {
  for (const m of iconLinkMatches) {
    const attrs = m[1];
    const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(attrs);
    const sizesMatch = /\bsizes=["']([^"']+)["']/i.exec(attrs);
    const expectedSize = hrefMatch?.[1]?.endsWith(".png") ? sizesMatch?.[1] : undefined;
    assertPublicAssetRef(hrefMatch?.[1], "index-html-icons", expectedSize);
  }
}

if (failures.length > 0) {
  console.error("L1 Frontend Hygiene Check FAILED:");
  for (const item of failures) {
    console.error("  -", item);
  }
  process.exit(1);
}

console.log(`L1 Frontend Hygiene Check PASSED (${sourceFiles.length} source files checked)`);
