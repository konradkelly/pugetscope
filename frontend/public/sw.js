// Minimal service worker for anonymous push alerts. Plain JS, not part of
// the Vite/TS build — a service worker must be served from the origin root
// to control the whole app, and this is small enough not to need bundling.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // ignore malformed payloads
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "PugetScope alert", {
      body: data.body || "",
      icon: "/favicon.svg",
      data: { icao24: data.icao24 || null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const icao24 = event.notification.data && event.notification.data.icao24;
  const url = icao24 ? `/aircraft/${icao24}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
