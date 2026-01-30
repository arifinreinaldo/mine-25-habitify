// Push notification handler for Habitify
// This file is imported by the main service worker

self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);

  let data = {
    title: 'Habitify',
    body: 'You have a habit reminder!',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      // Fallback: try as text
      try {
        data.body = event.data.text() || data.body;
      } catch (_) {
        // ignore
      }
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/pwa-192x192.png',
    badge: data.badge || '/pwa-192x192.png',
    vibrate: [200, 100, 200],
    data: data.data || {},
    actions: [
      { action: 'complete', title: 'Mark Complete' },
      { action: 'snooze', title: 'Remind Later' },
    ],
    requireInteraction: true,
    renotify: true,
    tag: data.data?.habitId || 'habit-reminder',
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action);

  event.notification.close();

  const action = event.action;
  const habitId = event.notification.data?.habitId;
  const url = event.notification.data?.url || '/';

  if (action === 'complete' && habitId) {
    event.waitUntil(
      self.clients.openWindow(`${url}?complete=${habitId}`)
    );
  } else if (action === 'snooze') {
    // Re-show notification after 10 minutes
    event.waitUntil(
      new Promise((resolve) => {
        setTimeout(() => {
          self.registration.showNotification(event.notification.title || 'Habitify', {
            body: event.notification.body || 'Reminder!',
            icon: '/pwa-192x192.png',
            badge: '/pwa-192x192.png',
            vibrate: [200, 100, 200],
            data: event.notification.data,
            tag: 'habit-snooze-' + (habitId || Date.now()),
          }).then(resolve);
        }, 10 * 60 * 1000);
      })
    );
  } else {
    // Default: focus existing window or open new one
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
    );
  }
});

self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed');
});
