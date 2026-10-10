self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '🎾 CT Campeador';
  const options = {
    body: data.body || 'Hay novedades en la liga.',
    icon: data.icon || '/ct-campeador-liga/icon-192.png',
    badge: data.badge || '/ct-campeador-liga/icon-192.png',
    tag: data.tag || 'ct-campeador-disponibilidad',
    renotify: true,
    data: {
      url: data.url || 'https://ligasdetenis.github.io/ct-campeador-liga/'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url ||
    'https://ligasdetenis.github.io/ct-campeador-liga/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          try { client.navigate(url); } catch (_) {}
          return client.focus();
        }
      }
      return clients.openWindow ? clients.openWindow(url) : undefined;
    })
  );
});
