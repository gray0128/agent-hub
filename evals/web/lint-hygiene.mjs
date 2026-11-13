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

// Verify tabular-nums discipline across the three main workbench panes
for (const pane of [
  "apps/web/src/components/workbench/FleetThreadsPane.tsx",
  "apps/web/src/components/workbench/ConversationPane.tsx",
  "apps/web/src/components/workbench/InspectorPane.tsx"
]) {
  const paneContent = fs.readFileSync(path.join(repoRoot, pane), "utf8");
  if (!paneContent.includes("tabular-nums")) {
    fail("tabular-nums", `${pane} 未对动态数字/时间戳启用 tabular-nums`);
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
