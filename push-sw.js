self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "CT Campeador";
  const options = {
    body: data.body || "Tienes un nuevo aviso de la liga.",
    icon: data.icon || "apple-touch-icon.png",
    badge: data.badge || "apple-touch-icon.png",
    tag: data.tag || "ct-campeador",
    renotify: true,
    data: {
      url: data.url || "https://ligasdetenis.github.io/ct-campeador-liga/"
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification?.data?.url ||
    "https://ligasdetenis.github.io/ct-campeador-liga/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url && client.url.startsWith("https://ligasdetenis.github.io/ct-campeador-liga/")) {
          if ("navigate" in client) {
            try { client.navigate(target); } catch (_) {}
          }
          if ("focus" in client) return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(target) : undefined;
    })
  );
});
