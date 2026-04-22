const DEFAULT_ICON = '/favicon.svg';

self.addEventListener('push', event => {
  event.waitUntil(
    (async () => {
      let payload = {};

      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {};
      }

      await self.registration.showNotification(payload.title || 'QueueFlow', {
        body: payload.body || 'Your table is ready.',
        icon: payload.icon || DEFAULT_ICON,
        badge: payload.badge || DEFAULT_ICON,
        tag: payload.tag || 'queueflow-notification',
        renotify: true,
        requireInteraction: Boolean(payload.requireInteraction),
        silent: false,
        vibrate: Array.isArray(payload.vibrate) ? payload.vibrate : [200, 100, 200],
        timestamp: Date.now(),
        data:
          payload.data && typeof payload.data === 'object'
            ? payload.data
            : {},
      });
    })()
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl =
    typeof event.notification.data?.url === 'string' &&
    event.notification.data.url.length > 0
      ? event.notification.data.url
      : '/customer';

  event.waitUntil(
    (async () => {
      const resolvedUrl = new URL(targetUrl, self.location.origin).toString();
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of windowClients) {
        if ('focus' in client) {
          if (client.url === resolvedUrl) {
            return client.focus();
          }
        }
      }

      return self.clients.openWindow(resolvedUrl);
    })()
  );
});
