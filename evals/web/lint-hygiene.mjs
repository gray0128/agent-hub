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
  "daisyui",
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
  "@tabler/icons-react",
  "react-router",
  "react-router-dom",
  "@tanstack/react-router",
  "quill",
  "tiptap",
  "@tiptap/react"
]);

const bannedPrefixes = ["@mui/", "@chakra-ui/", "@mantine/", "@heroicons/"];

const allowedDeps = new Set([
  "@dnd-kit/core",
  "@dnd-kit/modifiers",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-tooltip",
  "@tailwindcss/vite",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "motion",
  "react",
  "react-dom",
  "react-markdown",
  "react-resizable-panels",
  "remark-gfm",
  "tailwind-merge",
  "tailwindcss",
  "zustand",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "typescript",
  "vite"
]);

for (const dep of Object.keys(allDeps)) {
  if (bannedExact.has(dep) || bannedPrefixes.some((p) => dep.startsWith(p))) {
    fail("dependency-allowlist", `禁止引入依赖: ${dep}`);
  } else if (!allowedDeps.has(dep)) {
    fail("dependency-allowlist", `未批准的第三方依赖（Slice 1a 零新增依赖约束）: ${dep}`);
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

const emojiRegex = /\p{Extended_Pictographic}/gu;
const nonEmojiSymbols = new Set(["©", "®", "™", "↗", "↘", "↔"]);
const neonRegex = /\b(from|via|to)-(purple|violet|fuchsia|indigo)-(400|500|600)\b/i;

function stripCommentsPreserveLines(src) {
  let out = "";
  let i = 0;
  let lastSig = "";
  let lastWord = "";
  const regexPrevTokens = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "{", "}", "~", "^", "+", "-", "*", "%", ">"]);
  const regexPrevWords = new Set(["return", "case", "throw", "typeof", "void", "delete", "in", "of", "else", "new", "await", "yield"]);

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // String literals
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        out += c;
        if (c === "\\" && i + 1 < src.length) {
          i += 1;
          out += src[i];
          i += 1;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      lastSig = quote;
      lastWord = "";
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    // Block comment (covers /* ... */ and {/* ... */})
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    // Regex literal heuristic to avoid misparsing quotes or // inside /.../
    if (ch === "/" && (regexPrevTokens.has(lastSig) || regexPrevWords.has(lastWord))) {
      out += ch;
      i += 1;
      let inClass = false;
      while (i < src.length) {
        const c = src[i];
        out += c;
        if (c === "\\" && i + 1 < src.length) {
          i += 1;
          out += src[i];
          i += 1;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          break;
        } else if (c === "\n") {
          i += 1;
          break;
        }
        i += 1;
      }
      lastSig = "/";
      lastWord = "";
      continue;
    }

    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      lastWord = /[A-Za-z0-9_$]/.test(lastSig) ? lastWord + ch : ch;
      lastSig = ch;
    } else if (!/\s/.test(ch)) {
      lastSig = ch;
      lastWord = "";
    }
    i += 1;
  }
  return out;
}

function hasApiPollingInSetInterval(stripped) {
  const re = /\bsetInterval\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < stripped.length && depth > 0) {
      const ch = stripped[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i += 1;
        while (i < stripped.length) {
          if (stripped[i] === "\\") {
            i += 2;
            continue;
          }
          if (stripped[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    const callBody = stripped.slice(start, Math.max(start, i - 1));
    if (/(?:\/api\/|\bapiClient\.)/.test(callBody)) {
      return true;
    }
  }
  return false;
}

function hasNestedCardTag(stripped) {
  let depth = 0;
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < stripped.length) {
        if (stripped[i] === "\\") {
          i += 2;
          continue;
        }
        if (stripped[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (stripped.startsWith("</Card", i) && /^[\s>]/.test(stripped[i + 6] ?? "")) {
      depth = Math.max(0, depth - 1);
      i += 6;
      continue;
    }
    if (stripped.startsWith("<Card", i) && /^[\s>/]/.test(stripped[i + 5] ?? "")) {
      if (depth >= 1) {
        return true;
      }
      // Advance to closing '>' of <Card ...> respecting strings and {...}
      let j = i + 5;
      let braceDepth = 0;
      let selfClosing = false;
      let lastNonWs = "";
      while (j < stripped.length) {
        const c = stripped[j];
        if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          j += 1;
          while (j < stripped.length) {
            if (stripped[j] === "\\") {
              j += 2;
              continue;
            }
            if (stripped[j] === quote) {
              j += 1;
              break;
            }
            j += 1;
          }
          lastNonWs = quote;
          continue;
        }
        if (c === "{") {
          braceDepth += 1;
        } else if (c === "}") {
          braceDepth = Math.max(0, braceDepth - 1);
        } else if (c === ">" && braceDepth === 0) {
          selfClosing = lastNonWs === "/";
          j += 1;
          break;
        }
        if (!/\s/.test(c)) {
          lastNonWs = c;
        }
        j += 1;
      }
      if (!selfClosing) {
        depth += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return false;
}

const sourceFiles = collectSourceFiles(srcDir);
for (const file of sourceFiles) {
  const rel = path.relative(repoRoot, file);
  const content = fs.readFileSync(file, "utf8");
  const stripped = stripCommentsPreserveLines(content);
  const lines = content.split("\n");
  const strippedLines = stripped.split("\n");

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const strippedLine = strippedLines[idx] ?? "";
    if (/\btransition-all\b/.test(line) || /transition\s*:\s*all\b/i.test(line)) {
      fail("no-transition-all", `${rel}:${lineNo} 出现禁止的 transition-all`);
    }
    if (/from\s+["']framer-motion["']/.test(line)) {
      fail("motion-import", `${rel}:${lineNo} 必须从 motion/react 导入`);
    }
    const emojiMatches = strippedLine.match(emojiRegex) ?? [];
    if (emojiMatches.some((ch) => !nonEmojiSymbols.has(ch))) {
      fail("no-decorative-emoji", `${rel}:${lineNo} 包含装饰性 emoji`);
    }
    if (neonRegex.test(line)) {
      fail("no-neon-gradient", `${rel}:${lineNo} 包含禁止的紫蓝霓虹渐变`);
    }
    if (/(?<![.\w$])fetch\s*\(/.test(strippedLine) && rel !== "apps/web/src/lib/api-client.ts") {
      fail("single-api-client", `${rel}:${lineNo} 禁止绕过 api-client.ts 直接调用 fetch()`);
    }
  });

  if (rel !== "apps/web/src/lib/ws-client.ts" && hasApiPollingInSetInterval(stripped)) {
    fail("no-api-polling", `${rel} 存在面向 /api/ 或 apiClient 的 setInterval 轮询`);
  }

  if (hasNestedCardTag(stripped)) {
    fail("no-card-in-card", `${rel} 疑似存在卡片嵌套卡片 (<Card> 嵌套)`);
  }
}

// Verify Slice 1a board-store.ts (zustand) and --safe-bottom CSS token
const boardStorePath = path.join(srcDir, "stores", "board-store.ts");
if (!fs.existsSync(boardStorePath)) {
  fail("board-store", "缺少 apps/web/src/stores/board-store.ts");
} else {
  const boardStoreContent = fs.readFileSync(boardStorePath, "utf8");
  if (!/from\s+["']zustand["']/.test(boardStoreContent)) {
    fail("board-store", "apps/web/src/stores/board-store.ts 必须使用 zustand");
  }
}

const indexCssPath = path.join(srcDir, "index.css");
if (!fs.existsSync(indexCssPath) || !fs.readFileSync(indexCssPath, "utf8").includes("--safe-bottom")) {
  fail("safe-area-css", "apps/web/src/index.css 必须定义 --safe-bottom 安全区变量");
}

function findFilesByBasename(dir, targetNames) {
  const found = new Map();
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (targetNames.has(entry.name)) {
        found.set(entry.name, full);
      }
    }
  }
  return found;
}

// Verify tabular-nums discipline across the main workbench panes, topbar, board, and inbox
for (const pane of [
  "apps/web/src/App.tsx",
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

const slice1aTabularTargets = new Set([
  "BoardWorkspace.tsx",
  "BoardTopicTimeline.tsx",
  "PendingInbox.tsx"
]);
const foundSlice1aFiles = findFilesByBasename(path.join(srcDir, "components"), slice1aTabularTargets);
for (const fileName of slice1aTabularTargets) {
  const resolved = foundSlice1aFiles.get(fileName);
  if (!resolved) {
    fail("tabular-nums-missing-file", `缺少 Slice 1a 组件文件: apps/web/src/components/**/${fileName}`);
  } else {
    const rel = path.relative(repoRoot, resolved);
    if (!fs.readFileSync(resolved, "utf8").includes("tabular-nums")) {
      fail("tabular-nums", `${rel} 未对动态数字/计数/游标启用 tabular-nums`);
    }
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
