import webpush from 'web-push';

function parseEndpointHost(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    return '(missing-endpoint)';
  }

  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

function buildQueueCalledPayload({ storeId, storeName, customer, table, customerPortalUrl }) {
  const title = `${storeName}: your table is ready`;
  const tableName = table?.name?.trim() || 'your table';
  const body = table
    ? `${tableName} is ready for queue #${customer.queueNumber}. Tap to confirm your arrival.`
    : `Your queue number #${customer.queueNumber} is ready. Tap to confirm your arrival.`;

  return {
    title,
    body,
    tag: `queueflow-called-${storeId}-${customer.id}`,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 300],
    data: {
      url: customerPortalUrl,
      storeId,
      customerId: customer.id,
      queueNumber: customer.queueNumber,
      tableId: table?.id ?? null,
      tableName: table?.name ?? null,
    },
  };
}

export function createPushNotificationService({
  vapidPublicKey,
  vapidPrivateKey,
  subject,
  createLog,
  updateLog,
}) {
  const normalizedPublicKey =
    typeof vapidPublicKey === 'string' ? vapidPublicKey.trim() : '';
  const normalizedPrivateKey =
    typeof vapidPrivateKey === 'string' ? vapidPrivateKey.trim() : '';
  const normalizedSubject =
    typeof subject === 'string' && subject.trim().length > 0
      ? subject.trim()
      : 'https://queueflow.local';
  const isConfigured =
    normalizedPublicKey.length > 0 && normalizedPrivateKey.length > 0;

  if (isConfigured) {
    webpush.setVapidDetails(
      normalizedSubject,
      normalizedPublicKey,
      normalizedPrivateKey
    );
  }

  async function sendPush({
    storeId,
    customerId,
    subscription,
    eventType,
    title,
    body,
    payload,
    metadata = {},
  }) {
    const endpoint =
      typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : '';
    const recipient = parseEndpointHost(endpoint);
    const logId = await createLog({
      storeId,
      customerId,
      channel: 'push',
      recipient,
      eventType,
      subject: title,
      body,
      status: 'pending',
      provider: 'web-push',
      createdAt: new Date().toISOString(),
      metadata: {
        ...metadata,
        endpoint,
      },
    });

    if (!endpoint || typeof subscription !== 'object') {
      await updateLog(logId, {
        status: 'skipped',
        errorMessage: 'Customer push subscription is missing or invalid.',
      });
      return { ok: false, invalidSubscription: false, endpoint };
    }

    if (!isConfigured) {
      await updateLog(logId, {
        status: 'skipped',
        errorMessage: 'Web push is not configured on the backend.',
      });
      return { ok: false, invalidSubscription: false, endpoint };
    }

    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 60,
        timeout: 2500,
      });
      await updateLog(logId, {
        status: 'sent',
        sentAt: new Date().toISOString(),
      });
      return { ok: true, invalidSubscription: false, endpoint };
    } catch (error) {
      const statusCode =
        typeof error?.statusCode === 'number' ? error.statusCode : null;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown web push send failure';

      await updateLog(logId, {
        status: 'failed',
        errorMessage,
        metadata: {
          ...metadata,
          endpoint,
          statusCode,
        },
      });

      return {
        ok: false,
        invalidSubscription: statusCode === 404 || statusCode === 410,
        endpoint,
      };
    }
  }

  async function sendQueueCalledNotifications({
    storeId,
    storeName,
    customer,
    table,
    subscriptions,
    customerPortalUrl,
  }) {
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      return {
        sentCount: 0,
        invalidEndpoints: [],
      };
    }

    const payload = buildQueueCalledPayload({
      storeId,
      storeName,
      customer,
      table,
      customerPortalUrl,
    });

    const results = await Promise.all(
      subscriptions.map(subscriptionRecord =>
        sendPush({
          storeId,
          customerId: customer.id,
          subscription: subscriptionRecord.subscription,
          eventType: 'customer_called',
          title: payload.title,
          body: payload.body,
          payload,
          metadata: {
            queueNumber: customer.queueNumber,
            tableName: table?.name ?? '',
            subscriptionId: subscriptionRecord.id,
          },
        })
      )
    );

    return {
      sentCount: results.filter(result => result.ok).length,
      invalidEndpoints: results
        .filter(result => result.invalidSubscription && result.endpoint)
        .map(result => result.endpoint),
    };
  }

  return {
    isConfigured,
    sendQueueCalledNotifications,
  };
}
