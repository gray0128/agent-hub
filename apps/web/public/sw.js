self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePushPayload(event) {
  if (!event.data) {
    return {};
  }
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    try {
      const txt = event.data.text();
      return txt ? { body: txt } : {};
    } catch {
      return {};
    }
  }
}

function sanitizeTargetUrl(raw) {
  if (typeof raw !== "string") {
    return "/";
  }
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return "/";
  }
  try {
    const parsed = new URL(trimmed, self.location.origin);
    if (parsed.origin !== self.location.origin) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  const data = parsePushPayload(event);
  const title =
    typeof data.title === "string" && data.title.trim() ? data.title.trim() : "agent-hub 通知";
  const body = typeof data.body === "string" ? data.body : "";
  const id = typeof data.id === "string" ? data.id : "";
  const tag =
    typeof data.tag === "string" && data.tag ? data.tag : id ? `ahub-${id}` : "ahub-notify";
  const targetUrl = sanitizeTargetUrl(data.target_url);
  const urgent = Boolean(data.urgent);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      requireInteraction: urgent,
      data: {
        target_url: targetUrl,
        kind: typeof data.kind === "string" ? data.kind : "",
        id
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawTarget = event.notification.data && event.notification.data.target_url;
  const targetUrl = sanitizeTargetUrl(rawTarget);

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });
      const origin = self.location.origin;
      const existing = allClients.find((client) => {
        if (typeof client.url !== "string" || !client.url) {
          return false;
        }
        try {
          return new URL(client.url).origin === origin;
        } catch {
          return false;
        }
      });
      if (existing) {
        if (typeof existing.focus === "function") {
          await existing.focus();
        }
        existing.postMessage({ type: "ahub:navigate", target_url: targetUrl });
        return;
      }
      if (typeof self.clients.openWindow === "function") {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
