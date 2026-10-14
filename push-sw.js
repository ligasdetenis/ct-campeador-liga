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
  const appBase = "https://ligasdetenis.github.io/ct-campeador-liga/";
  let target = event.notification?.data?.url || appBase;
  try {
    const u = new URL(target, appBase);
    if (u.origin !== new URL(appBase).origin || !u.pathname.startsWith("/ct-campeador-liga/")) target = appBase;
    else target = u.toString();
  } catch (_) {
    target = appBase;
  }

  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if (!client.url || !client.url.startsWith(appBase)) continue;
      try {
        if ("navigate" in client) await client.navigate(target);
        else client.postMessage({ type:"PUSH_DEEP_LINK", url:target });
      } catch (_) {
        try { client.postMessage({ type:"PUSH_DEEP_LINK", url:target }); } catch (_) {}
      }
      if ("focus" in client) await client.focus();
      return;
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
