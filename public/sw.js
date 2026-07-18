// SmartPantry Service Worker
// Handles: PWA installability + receiving push notifications

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No offline caching yet — just pass requests through normally.
self.addEventListener("fetch", () => {});

// Handle incoming push notifications from the server
self.addEventListener("push", (event) => {
  let data = { title: "SmartPantry", body: "You have a new alert." };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Focus/open the app when a notification is tapped
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientsArr) => {
        const existing = clientsArr.find((c) =>
          c.url.includes(self.location.origin),
        );
        if (existing) return existing.focus();
        return self.clients.openWindow(targetUrl);
      }),
  );
});
