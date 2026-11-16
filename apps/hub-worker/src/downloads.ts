import skillMd from "../../../skills/ahub/SKILL.md";
import bootstrapMdTemplate from "./bootstrap.md";
import clientBootstrapMdTemplate from "./client-bootstrap.md";
import installShTemplate from "./install.sh";
import { type Env, HubError } from "./types";
import { nowIso } from "./ulid";

const DEFAULT_RELEASE_BASE = "https://github.com/gray0128/agent-hub/releases/latest/download";

function resolveHubUrl(request: Request, env: Env): string {
  const origin = new URL(request.url).origin;
  return (env.HUB_PUBLIC_URL?.trim() || origin || "https://ahub.bobocai.win").replace(/\/+$/, "");
}

function renderBootstrapMarkdown(request: Request, env: Env, template: string): Response {
  const hubUrl = resolveHubUrl(request, env);
  const body = template.replaceAll("__HUB_URL__", hubUrl);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function handleSkillMd(): Response {
  return new Response(skillMd, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60"
    }
  });
}

export function handleBootstrapMd(request: Request, env: Env): Response {
  return renderBootstrapMarkdown(request, env, bootstrapMdTemplate);
}

export function handleClientBootstrapMd(request: Request, env: Env): Response {
  return renderBootstrapMarkdown(request, env, clientBootstrapMdTemplate);
}

export function handleInstallSh(request: Request, env: Env): Response {
  const hubUrl = resolveHubUrl(request, env);
  const script = installShTemplate.replaceAll("__HUB_URL__", hubUrl);
  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/x-sh; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function handleVersionJson(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const baseUrl = (env.RELEASE_BASE_URL || "").replace(/\/+$/, "");

  if (baseUrl) {
    try {
      const resp = await fetch(`${baseUrl}/version.json`, {
        redirect: "follow",
        headers: { "User-Agent": "agent-hub-worker" }
      });
      if (resp.ok) {
        const body = await resp.text();
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    } catch {
      // fall through to synthesized manifest
    }
  }

  const assets = {
    darwin_arm64: { url: `${origin}/dl/ahub-darwin-arm64`, sha256: "" },
    darwin_amd64: { url: `${origin}/dl/ahub-darwin-amd64`, sha256: "" },
    linux_amd64: { url: `${origin}/dl/ahub-linux-amd64`, sha256: "" },
    linux_arm64: { url: `${origin}/dl/ahub-linux-arm64`, sha256: "" },
    windows_amd64: { url: `${origin}/dl/ahub-windows-amd64.exe`, sha256: "" }
  };

  return new Response(
    JSON.stringify({
      version: "v0.1.0",
      released_at: nowIso(),
      assets
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }
  );
}

export async function handleBinaryDownload(assetName: string, env: Env): Promise<Response> {
  if (!/^ahub-(darwin|linux|windows)-(arm64|amd64)(\.exe)?$/.test(assetName)) {
    throw new HubError(404, "NOT_FOUND", `Unknown download asset '${assetName}'.`);
  }
  const baseUrl = (env.RELEASE_BASE_URL || DEFAULT_RELEASE_BASE).replace(/\/+$/, "");
  const targetUrl = `${baseUrl}/${assetName}`;

  if (env.RELEASE_BASE_URL) {
    const upstream = await fetch(targetUrl, {
      redirect: "follow",
      headers: { "User-Agent": "agent-hub-worker" }
    });
    if (!upstream.ok) {
      throw new HubError(404, "NOT_FOUND", `Asset '${assetName}' not found upstream.`);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${assetName}"`
      }
    });
  }

  return Response.redirect(targetUrl, 302);
}
