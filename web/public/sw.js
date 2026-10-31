/* Sua web push service worker.
 *
 * Registered from `lib/push.ts` (`/sw.js`). It only handles push delivery and
 * notification clicks — the app itself stays online-first and has no offline
 * cache, so nothing here may serve stale HTML.
 */

self.addEventListener("install", () => {
  // A new worker is only ever code we just shipped; take over immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  if (!event.data) return null;
  try {
    const parsed = event.data.json();
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event) ?? {};
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Sua";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: typeof payload.icon === "string" ? payload.icon : "/icon-192.png",
    badge: typeof payload.badge === "string" ? payload.badge : "/icon-192.png",
    // Same tag + renotify replaces the previous copy instead of stacking a
    // second, identical reminder (the server sends one per day).
    tag: typeof payload.tag === "string" ? payload.tag : "sua",
    renotify: true,
    data: {
      url:
        typeof payload.url === "string" && payload.url.startsWith("/")
          ? payload.url
          : "/app/home",
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/app/home", self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
