import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../scripts/load-project-env.mjs';
import {
  addTable,
  applyQueueAutomation,
  buildVersionConflictPayload,
  callCustomer,
  callHoldMs,
  clearQueue,
  configureTables,
  confirmArrival,
  createInitialQueueState,
  expiredCustomerRetentionMs,
  expireCustomer,
  isValidEmail,
  isValidOpaqueId,
  isValidStoreId,
  joinQueue,
  normalizeConfiguredTables,
  normalizeQueueState,
  requeueCustomer,
  releaseTable,
  removeCustomerFromQueueState,
  sanitizePublicQueueState,
  seatCustomer,
  setAutoMode,
} from './queue-domain.mjs';

await loadProjectEnv();

const {
  createMerchantStore,
  createSession,
  createNotificationLog,
  dbFilePath,
  deleteCustomerTokensForCustomer,
  deleteCustomerPushSubscription,
  deleteSession,
  getCustomerToken,
  getMerchantBilling,
  getMerchantProfile,
  getSession,
  getStore,
  hashPassword,
  legacyJsonPath,
  listCustomerPushSubscriptions,
  listNotificationLogs,
  listQueueEvents,
  listStores,
  pruneExpiredSessions,
  runTransaction,
  storageEngine,
  storageProductionReady,
  storageProvider,
  storageRecommendation,
  issueCustomerEntrySession,
  touchCustomerToken,
  upsertCustomerPushSubscription,
  updateMerchantBilling,
  updateMerchantProfile,
  updateNotificationLog,
  verifyStorePassword,
} = await import('./store.mjs');
const { createNotificationService } = await import('./notification-service.mjs');
const { createPushNotificationService } = await import('./push-notification-service.mjs');
const { createBillingService } = await import('./billing-service.mjs');

const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const defaultStoreId = (process.env.DEFAULT_STORE_ID ?? 'RESTO-001').toUpperCase();
const defaultStorePassword = process.env.DEFAULT_STORE_PASSWORD ?? 'admin123';
const sessionTtlMs = 1000 * 60 * 60 * 12;
const customerEntrySessionTtlMs = 1000 * 60 * 5;
const customerSessionMaxAgeMs = 1000 * 60 * 60 * 24;
const customerSessionIdleTtlMs = 1000 * 60 * 60 * 6;
const healthToken = (process.env.QUEUEFLOW_HEALTH_TOKEN ?? '').trim();
const maxJsonBodyBytes = parsePositiveInteger(
  process.env.QUEUEFLOW_MAX_JSON_BODY_BYTES,
  64 * 1024
);
const maxWebhookBodyBytes = parsePositiveInteger(
  process.env.QUEUEFLOW_MAX_WEBHOOK_BODY_BYTES,
  512 * 1024
);
const expiredRetentionMs = Number.parseInt(
  process.env.QUEUE_EXPIRED_RETENTION_MS ?? `${expiredCustomerRetentionMs}`,
  10
);
const allowedOrigins = (process.env.QUEUEFLOW_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const notificationService = createNotificationService({
  smtpHost: process.env.QUEUE_SMTP_HOST ?? '',
  smtpPort: process.env.QUEUE_SMTP_PORT ?? '',
  smtpSecure: process.env.QUEUE_SMTP_SECURE ?? '',
  smtpUser: process.env.QUEUE_SMTP_USER ?? '',
  smtpPassword: process.env.QUEUE_SMTP_PASSWORD ?? '',
  gmailUser: process.env.QUEUE_GMAIL_USER ?? '',
  gmailAppPassword: process.env.QUEUE_GMAIL_APP_PASSWORD ?? '',
  fromAddress: process.env.QUEUE_EMAIL_FROM ?? process.env.QUEUE_GMAIL_USER ?? '',
  createLog: log => createNotificationLog(defaultStoreId, defaultStorePassword, log),
  updateLog: (id, patch) => updateNotificationLog(defaultStoreId, defaultStorePassword, id, patch),
});
const pushNotificationService = createPushNotificationService({
  vapidPublicKey: process.env.QUEUE_WEB_PUSH_VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.QUEUE_WEB_PUSH_VAPID_PRIVATE_KEY ?? '',
  subject:
    process.env.QUEUE_WEB_PUSH_SUBJECT ?? process.env.VITE_PUBLIC_APP_URL ?? 'https://queueflow.local',
  createLog: log => createNotificationLog(defaultStoreId, defaultStorePassword, log),
  updateLog: (id, patch) => updateNotificationLog(defaultStoreId, defaultStorePassword, id, patch),
});
const billingService = createBillingService();

const expiryTimers = new Map();
const reconcileTimestamps = new Map();
const rateLimitBuckets = new Map();
const supportedPlanCodes = new Set(['starter', 'growth', 'scale']);
const reconcileThrottleMs = 5000;
function parseRateLimit(name, fallbackLimit, fallbackWindowMs) {
  return {
    limit: parsePositiveInteger(process.env[`QUEUEFLOW_RATE_LIMIT_${name}_LIMIT`], fallbackLimit),
    windowMs: parsePositiveInteger(
      process.env[`QUEUEFLOW_RATE_LIMIT_${name}_WINDOW_MS`],
      fallbackWindowMs
    ),
  };
}

const rateLimits = {
  global: parseRateLimit('GLOBAL', 360, 60_000),
  login: parseRateLimit('LOGIN', 10, 5 * 60_000),
  register: parseRateLimit('REGISTER', 4, 60 * 60_000),
  password: parseRateLimit('PASSWORD', 8, 10 * 60_000),
  customerEntry: parseRateLimit('CUSTOMER_ENTRY', 30, 60_000),
  customerJoin: parseRateLimit('CUSTOMER_JOIN', 20, 60_000),
};
const parsedRequestBodySymbol = Symbol('queueflowParsedRequestBody');
const requestIdSymbol = Symbol('queueflowRequestId');
const requestStartMsSymbol = Symbol('queueflowRequestStartMs');

class HttpRequestError extends Error {
  constructor(statusCode, message, type = 'request-error') {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
    this.type = type;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isCustomerSessionVisibleStatus(status) {
  return (
    status === 'waiting' ||
    status === 'called' ||
    status === 'confirmed' ||
    status === 'expired' ||
    status === 'seated'
  );
}

function isCustomerSessionTokenExpired(record, nowMs = Date.now()) {
  const createdAtMs = Date.parse(record.created_at);
  const lastSeenAtMs = Date.parse(record.last_seen_at ?? record.created_at);

  if (!Number.isFinite(createdAtMs) || !Number.isFinite(lastSeenAtMs)) {
    return true;
  }

  return (
    nowMs - createdAtMs > customerSessionMaxAgeMs ||
    nowMs - lastSeenAtMs > customerSessionIdleTtlMs
  );
}

function isCustomerEntrySessionExpired(record, nowMs = Date.now()) {
  const expiresAtMs = Date.parse(record.expires_at);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function normalizePlanCode(value) {
  if (typeof value !== 'string') {
    return 'growth';
  }

  const normalized = value.trim().toLowerCase();
  return supportedPlanCodes.has(normalized) ? normalized : 'growth';
}

function generateStoreIdFromName(storeName) {
  const words = storeName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const base =
    words.length === 0
      ? 'STORE'
      : words.length === 1
        ? words[0].slice(0, 6)
        : words
            .slice(0, 3)
            .map(word => word.slice(0, 2))
            .join('')
            .slice(0, 6);
  const suffix = randomBytes(3).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  return `${base || 'STORE'}-${suffix}`;
}

async function allocateUniqueStoreId(storeName) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generateStoreIdFromName(storeName);
    if (!isValidStoreId(candidate)) {
      continue;
    }

    const existingStore = await getStore(defaultStoreId, defaultStorePassword, candidate);
    if (!existingStore) {
      return candidate;
    }
  }

  return `STORE-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`;
}

function generateMerchantPassword() {
  return randomBytes(9)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 12);
}

function resolveCorsOrigin(requestOrigin) {
  if (allowedOrigins.length === 0) {
    return '*';
  }

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0];
}

function isCorsOriginAllowed(requestOrigin) {
  if (allowedOrigins.length === 0 || !requestOrigin) {
    return true;
  }

  return allowedOrigins.includes(requestOrigin);
}

function rejectDisallowedCorsOrigin(response) {
  sendJson(response, 403, { error: 'Origin is not allowed for this API.' });
}

function getRequestId(request) {
  if (!request) {
    return randomBytes(12).toString('hex');
  }

  if (request[requestIdSymbol]) {
    return request[requestIdSymbol];
  }

  const providedRequestId = request.headers?.['x-request-id'];
  const normalizedRequestId =
    typeof providedRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(providedRequestId)
      ? providedRequestId
      : randomBytes(12).toString('hex');

  request[requestIdSymbol] = normalizedRequestId;
  return normalizedRequestId;
}

function getRequestDurationMs(request) {
  const startedAt = request?.[requestStartMsSymbol];
  return Number.isFinite(startedAt) ? Date.now() - startedAt : null;
}

function logStructured(level, event, fields = {}) {
  const entry = {
    level,
    event,
    at: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

function logResponse(request, statusCode, payload) {
  if (!request) {
    return;
  }

  const isMutation = request.method === 'POST';
  const isError = statusCode >= 400;
  if (!isMutation && !isError) {
    return;
  }

  logStructured(isError ? 'error' : 'info', 'http_response', {
    requestId: getRequestId(request),
    method: request.method,
    path: request.url
      ? normalizeRequestPath(new URL(request.url, 'http://queueflow.local').pathname)
      : undefined,
    statusCode,
    durationMs: getRequestDurationMs(request),
    error: typeof payload?.error === 'string' ? payload.error : undefined,
  });
}

function getSecurityHeaders(request) {
  const forwardedProto = request?.headers?.['x-forwarded-proto'];
  const isHttps =
    forwardedProto === 'https' ||
    (typeof request?.headers?.host === 'string' && request.headers.host.endsWith('.vercel.app'));

  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(isHttps ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function sendJson(response, statusCode, payload) {
  const requestOrigin =
    typeof response.req?.headers.origin === 'string' ? response.req.headers.origin : null;
  const durationMs = getRequestDurationMs(response.req);

  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': resolveCorsOrigin(requestOrigin),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Request-Id, X-Queue-Customer-Token, X-Queue-Entry-Token',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Request-Id': getRequestId(response.req),
    ...(durationMs !== null ? { 'X-Response-Time-Ms': String(durationMs) } : {}),
    Vary: 'Origin',
    ...getSecurityHeaders(response.req),
  });
  logResponse(response.req, statusCode, payload);
  response.end(JSON.stringify(payload));
}

function sendRateLimited(response, retryAfterSeconds) {
  const requestOrigin =
    typeof response.req?.headers.origin === 'string' ? response.req.headers.origin : null;

  response.writeHead(429, {
    'Access-Control-Allow-Origin': resolveCorsOrigin(requestOrigin),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Request-Id, X-Queue-Customer-Token, X-Queue-Entry-Token',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': String(retryAfterSeconds),
    'X-Request-Id': getRequestId(response.req),
    Vary: 'Origin',
    ...getSecurityHeaders(response.req),
  });
  response.end(JSON.stringify({ error: 'Too many requests. Please try again shortly.' }));
}

function sendRequestError(response, error) {
  if (error instanceof HttpRequestError) {
    sendJson(response, error.statusCode, {
      error: error.message,
      type: error.type,
    });
    return;
  }

  sendJson(response, 400, {
    error: 'Invalid JSON request body.',
    type: 'invalid-json',
  });
}

function sendUnhandledError(response, error) {
  logStructured('error', 'unhandled_error', {
    requestId: getRequestId(response.req),
    method: response.req?.method,
    path: response.req?.url ? normalizeRequestPath(new URL(response.req.url, 'http://queueflow.local').pathname) : undefined,
    durationMs: getRequestDurationMs(response.req),
    errorName: error?.name,
    errorCode: error?.code,
    message: error instanceof Error ? error.message : String(error),
  });

  if (response.headersSent || response.writableEnded) {
    response.end();
    return;
  }

  sendJson(response, 500, { error: 'Internal server error' });
}

function getClientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }

  const realIp = request.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim();
  }

  return request.socket?.remoteAddress ?? 'unknown';
}

function checkRateLimit(bucketKey, config, nowMs = Date.now()) {
  const existingBucket = rateLimitBuckets.get(bucketKey);
  if (!existingBucket || existingBucket.resetAt <= nowMs) {
    rateLimitBuckets.set(bucketKey, {
      count: 1,
      resetAt: nowMs + config.windowMs,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existingBucket.count >= config.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existingBucket.resetAt - nowMs) / 1000)),
    };
  }

  existingBucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function pruneRateLimitBuckets(nowMs = Date.now()) {
  if (rateLimitBuckets.size < 1000) {
    return;
  }

  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= nowMs) {
      rateLimitBuckets.delete(key);
    }
  }
}

function enforceRateLimit(request, response, name, keyParts = []) {
  const config = rateLimits[name];
  if (!config) {
    return true;
  }

  pruneRateLimitBuckets();
  const clientIp = getClientIp(request);
  const key = [name, clientIp, ...keyParts.map(part => String(part).toUpperCase())].join(':');
  const result = checkRateLimit(key, config);

  if (result.allowed) {
    return true;
  }

  sendRateLimited(response, result.retryAfterSeconds);
  return false;
}

function isAuthorizedHealthRequest(request, url) {
  if (!healthToken) {
    return false;
  }

  const headerToken = request.headers['x-queue-health-token'];
  const providedToken =
    typeof headerToken === 'string' && headerToken.length > 0
      ? headerToken
      : url.searchParams.get('token') ?? '';

  return secureCompare(providedToken, healthToken);
}

function secureCompare(provided, expected) {
  const providedBuffer = Buffer.from(String(provided ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));

  if (providedBuffer.length !== expectedBuffer.length) {
    const comparisonLength = Math.max(providedBuffer.length, expectedBuffer.length, 1);
    timingSafeEqual(Buffer.alloc(comparisonLength), Buffer.alloc(comparisonLength));
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function isJsonContentType(request) {
  const contentType = request.headers['content-type'];
  const value = Array.isArray(contentType) ? contentType.join(',') : contentType ?? '';
  const normalized = value.toLowerCase();
  return normalized.includes('application/json') || normalized.includes('+json');
}

function readRequestBody(request, { maxBytes = maxJsonBodyBytes } = {}) {
  if (Object.prototype.hasOwnProperty.call(request, parsedRequestBodySymbol)) {
    return Promise.resolve(request[parsedRequestBodySymbol]);
  }

  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let byteLength = 0;
    let tooLarge = false;

    request.on('data', chunk => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > maxBytes) {
        tooLarge = true;
        return;
      }

      body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        rejectBody(
          new HttpRequestError(
            413,
            `Request body is too large. Limit is ${maxBytes} bytes.`,
            'body-too-large'
          )
        );
        return;
      }

      if (body.length === 0) {
        resolveBody(null);
        return;
      }

      if (!isJsonContentType(request)) {
        rejectBody(
          new HttpRequestError(
            415,
            'Request body must use application/json.',
            'unsupported-media-type'
          )
        );
        return;
      }

      try {
        resolveBody(JSON.parse(body));
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on('error', rejectBody);
  });
}

async function cacheJsonRequestBody(request, response) {
  try {
    request[parsedRequestBodySymbol] = await readRequestBody(request);
    return true;
  } catch (error) {
    sendRequestError(response, error);
    return false;
  }
}

function readRawRequestBody(request, { maxBytes = maxWebhookBodyBytes } = {}) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let byteLength = 0;
    let tooLarge = false;

    request.on('data', chunk => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > maxBytes) {
        tooLarge = true;
        return;
      }

      body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        rejectBody(
          new HttpRequestError(
            413,
            `Request body is too large. Limit is ${maxBytes} bytes.`,
            'body-too-large'
          )
        );
        return;
      }

      resolveBody(body);
    });
    request.on('error', rejectBody);
  });
}

function buildBillingSummary(billingRecord) {
  const config = billingService.getPublicConfig();

  return {
    provider: config.provider,
    checkoutEnabled: config.checkoutEnabled,
    portalEnabled: config.portalEnabled && Boolean(billingRecord?.stripeCustomerId),
    customerId: billingRecord?.stripeCustomerId ?? null,
    subscriptionId: billingRecord?.stripeSubscriptionId ?? null,
    priceId: billingRecord?.stripePriceId ?? null,
    currentPeriodEnd: billingRecord?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: Boolean(billingRecord?.cancelAtPeriodEnd),
    lastInvoiceStatus: billingRecord?.lastInvoiceStatus ?? null,
    lastCheckoutAt: billingRecord?.lastCheckoutAt ?? null,
    plans: config.plans,
    config: config.config,
  };
}

function buildNotificationSummary() {
  const config = notificationService.getPublicConfig();

  return {
    provider: config.provider,
    deliveryEnabled: config.deliveryEnabled,
    fromAddress: config.fromAddress,
    config: config.config,
  };
}

async function buildMerchantProfilePayload(storeId) {
  const [profile, billingRecord] = await Promise.all([
    getMerchantProfile(defaultStoreId, defaultStorePassword, storeId),
    getMerchantBilling(defaultStoreId, defaultStorePassword, storeId),
  ]);

  if (!profile) {
    return null;
  }

  return {
    ...profile,
    billing: buildBillingSummary(billingRecord),
    notifications: buildNotificationSummary(),
  };
}

function buildPublicQueueStatePayload(storeRecord) {
  return sanitizePublicQueueState(
    normalizeQueueState({
      ...storeRecord.queueState,
      auth: {
        storeId: storeRecord.storeId,
        storeName: storeRecord.storeName,
        isLoggedIn: false,
      },
    })
  );
}

function parseExpectedVersion(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function buildCustomerJoinRequestHash({ phone, email, partySize }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        phone,
        email: email ?? '',
        partySize,
      })
    )
    .digest('hex');
}

function buildCustomerJoinReplayResponse({ customer, customerToken, recovered, publicStateStore, state }) {
  return {
    customer,
    customerToken,
    recovered,
    state: buildPublicQueueStatePayload({
      ...publicStateStore,
      queueState: state,
    }),
  };
}

async function runLockedStoreMutation(storeId, expectedVersion, mutate) {
  return runTransaction(defaultStoreId, defaultStorePassword, async tx => {
    const store = await tx.getStore(storeId);
    if (!store) {
      return { type: 'not-found' };
    }

    const currentState = normalizeQueueState(store.queueState);
    if (Number.isInteger(expectedVersion) && currentState.version !== expectedVersion) {
      return {
        type: 'version-conflict',
        state: currentState,
      };
    }

    return mutate({
      tx,
      store,
      currentState,
    });
  });
}

function sendStoreMutationError(response, result, scope = 'merchant') {
  if (result?.type === 'not-found') {
    sendJson(response, 404, { error: 'Store not found' });
    return true;
  }

  if (result?.type === 'version-conflict') {
    sendJson(response, 409, buildVersionConflictPayload(result.state, scope));
    return true;
  }

  return false;
}

function resolveRequestOrigin(request) {
  if (typeof request.headers.origin === 'string' && request.headers.origin.length > 0) {
    return request.headers.origin;
  }

  const forwardedProto =
    typeof request.headers['x-forwarded-proto'] === 'string'
      ? request.headers['x-forwarded-proto']
      : null;
  const protocol =
    forwardedProto ?? (process.env.VERCEL === '1' ? 'https' : 'http');
  const hostHeader =
    typeof request.headers.host === 'string' && request.headers.host.length > 0
      ? request.headers.host
      : 'localhost:5173';

  return `${protocol}://${hostHeader}`;
}

function resolveMerchantAppUrl(request, extraParams = {}) {
  const configuredAppUrl = process.env.VITE_PUBLIC_APP_URL;
  const requestOrigin = resolveRequestOrigin(request);
  const url = configuredAppUrl
    ? new URL(configuredAppUrl, requestOrigin)
    : new URL('/merchant', requestOrigin);

  url.pathname = '/merchant';
  url.search = '';
  url.hash = '';

  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function resolveCustomerPortalUrl(request, storeId, extraParams = {}) {
  const configuredAppUrl = process.env.VITE_PUBLIC_APP_URL;
  const requestOrigin = resolveRequestOrigin(request);
  const url = configuredAppUrl
    ? new URL(configuredAppUrl, requestOrigin)
    : new URL('/customer', requestOrigin);

  url.pathname = '/customer';
  url.search = '';
  url.hash = '';
  url.searchParams.set('store', storeId.toUpperCase());

  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function syncStripeBillingSnapshot({
  subscriptionId,
  customerId,
  fallbackStoreId,
  lastInvoiceStatus,
  lastCheckoutAt,
}) {
  if (!billingService.isConfigured) {
    return null;
  }

  const snapshot = await billingService.resolveSubscriptionSnapshot({
    subscriptionId,
    customerId,
    fallbackStoreId,
  });

  if (!snapshot.storeId) {
    return null;
  }

  await updateMerchantBilling(defaultStoreId, defaultStorePassword, snapshot.storeId, {
    ...snapshot.billingRecord,
    lastInvoiceStatus: lastInvoiceStatus ?? snapshot.billingRecord.lastInvoiceStatus,
    lastCheckoutAt: lastCheckoutAt ?? undefined,
  });

  await updateMerchantProfile(defaultStoreId, defaultStorePassword, snapshot.storeId, {
    ...(snapshot.planCode ? { planCode: snapshot.planCode } : {}),
    subscriptionStatus: snapshot.subscriptionStatus,
    billingCycle: snapshot.billingCycle,
    trialEndsAt: snapshot.trialEndsAt,
  });

  return snapshot.storeId;
}

async function handleStripeWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') {
        return;
      }

      await syncStripeBillingSnapshot({
        subscriptionId:
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
        customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        fallbackStoreId: session.metadata?.storeId ?? session.client_reference_id ?? undefined,
        lastCheckoutAt: new Date().toISOString(),
      });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      await syncStripeBillingSnapshot({
        subscriptionId: subscription.id,
        customerId:
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id,
        fallbackStoreId: subscription.metadata?.storeId ?? undefined,
      });
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      await syncStripeBillingSnapshot({
        subscriptionId:
          typeof invoice.subscription === 'string'
            ? invoice.subscription
            : invoice.subscription?.id,
        customerId,
        fallbackStoreId: invoice.metadata?.storeId ?? undefined,
        lastInvoiceStatus: event.type === 'invoice.paid' ? 'paid' : 'payment_failed',
      });
      return;
    }
    default:
      return;
  }
}

function matchStoreRoute(pathname) {
  const patterns = [
    [/^\/stores\/([^/]+)\/public-queue-state$/, 'public-queue-state'],
    [/^\/stores\/([^/]+)\/queue-state$/, 'queue-state'],
    [/^\/stores\/([^/]+)\/profile$/, 'profile'],
    [/^\/stores\/([^/]+)\/password$/, 'password'],
    [/^\/stores\/([^/]+)\/billing\/checkout$/, 'billing-checkout'],
    [/^\/stores\/([^/]+)\/billing\/portal$/, 'billing-portal'],
    [/^\/stores\/([^/]+)\/notification-logs$/, 'notification-logs'],
    [/^\/stores\/([^/]+)\/notifications\/test-email$/, 'notifications-test-email'],
    [/^\/stores\/([^/]+)\/queue-events$/, 'queue-events'],
    [/^\/stores\/([^/]+)\/auto-mode$/, 'auto-mode'],
    [/^\/stores\/([^/]+)\/tables\/add$/, 'add-table'],
    [/^\/stores\/([^/]+)\/tables\/configure$/, 'configure-tables'],
    [/^\/stores\/([^/]+)\/clear-queue$/, 'clear-queue'],
    [/^\/stores\/([^/]+)\/reset$/, 'reset'],
  ];

  for (const [pattern, type] of patterns) {
    const match = pathname.match(pattern);
    if (match) {
      return { type, storeId: decodeURIComponent(match[1]) };
    }
  }

  const releaseTableMatch = pathname.match(/^\/stores\/([^/]+)\/tables\/([^/]+)\/release$/);
  if (releaseTableMatch) {
    return {
      type: 'release-table',
      storeId: decodeURIComponent(releaseTableMatch[1]),
      tableId: decodeURIComponent(releaseTableMatch[2]),
    };
  }

  const joinCustomerMatch = pathname.match(/^\/stores\/([^/]+)\/customers\/join$/);
  if (joinCustomerMatch) {
    return { type: 'join-customer', storeId: decodeURIComponent(joinCustomerMatch[1]) };
  }

  const walkInCustomerMatch = pathname.match(/^\/stores\/([^/]+)\/customers\/walk-in$/);
  if (walkInCustomerMatch) {
    return { type: 'walk-in-customer', storeId: decodeURIComponent(walkInCustomerMatch[1]) };
  }

  const merchantCustomerMatch = pathname.match(/^\/stores\/([^/]+)\/customers\/manual$/);
  if (merchantCustomerMatch) {
    return { type: 'merchant-customer', storeId: decodeURIComponent(merchantCustomerMatch[1]) };
  }

  const customerEntrySessionMatch = pathname.match(/^\/stores\/([^/]+)\/customer-entry-session$/);
  if (customerEntrySessionMatch) {
    return {
      type: 'customer-entry-session',
      storeId: decodeURIComponent(customerEntrySessionMatch[1]),
    };
  }

  const pushSubscriptionMatch = pathname.match(
    /^\/stores\/([^/]+)\/customers\/([^/]+)\/push-subscriptions$/
  );
  if (pushSubscriptionMatch) {
    return {
      type: 'push-subscriptions',
      storeId: decodeURIComponent(pushSubscriptionMatch[1]),
      customerId: decodeURIComponent(pushSubscriptionMatch[2]),
    };
  }

  const customerSessionMatch = pathname.match(/^\/stores\/([^/]+)\/customers\/([^/]+)\/session$/);
  if (customerSessionMatch) {
    return {
      type: 'customer-session',
      storeId: decodeURIComponent(customerSessionMatch[1]),
      customerId: decodeURIComponent(customerSessionMatch[2]),
    };
  }

  const customerActionMatch = pathname.match(
    /^\/stores\/([^/]+)\/customers\/([^/]+)\/(call|confirm|seat|expire|leave|remove|requeue)$/
  );
  if (customerActionMatch) {
    return {
      type: `${customerActionMatch[3]}-customer`,
      storeId: decodeURIComponent(customerActionMatch[1]),
      customerId: decodeURIComponent(customerActionMatch[2]),
    };
  }

  return null;
}

function validateMatchedStoreRoute(route) {
  if (!route) {
    return null;
  }

  if (!isValidStoreId(String(route.storeId ?? '').toUpperCase())) {
    return 'Invalid store id';
  }

  if (route.tableId && !isValidOpaqueId(route.tableId)) {
    return 'Invalid table id';
  }

  if (route.customerId && !isValidOpaqueId(route.customerId)) {
    return 'Invalid customer id';
  }

  return null;
}

function getAuthToken(request) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
}

function getCustomerTokenHeader(request) {
  const header = request.headers['x-queue-customer-token'];
  return typeof header === 'string' && header.length > 0 ? header.trim() : null;
}

function getCustomerEntryTokenHeader(request) {
  const header = request.headers['x-queue-entry-token'];
  return typeof header === 'string' && header.length > 0 ? header.trim() : null;
}

function findCustomerById(queueState, customerId) {
  return queueState.customers.find(customer => customer.id === customerId) ?? null;
}

function findRecoverableCustomerByPhone(queueState, phone) {
  return (
    queueState.customers.find(
      customer =>
        customer.phone === phone &&
        (customer.status === 'waiting' ||
          customer.status === 'called' ||
          customer.status === 'confirmed')
    ) ?? null
  );
}

function toMerchantAuth(store) {
  return {
    storeId: store.storeId,
    storeName: store.storeName,
    isLoggedIn: true,
  };
}

function buildQueueEvent(storeId, eventType, customer = null, options = {}) {
  return {
    storeId,
    customerId: customer?.id,
    queueNumber: typeof customer?.queueNumber === 'number' ? customer.queueNumber : null,
    partySize: typeof customer?.partySize === 'number' ? customer.partySize : null,
    eventType,
    waitMs: typeof options.waitMs === 'number' ? options.waitMs : null,
    metadata: options.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}

function buildMissingCustomerError() {
  return 'This customer is no longer in the active queue. Refresh and try again.';
}

function buildInvalidCustomerSessionError() {
  return 'Your queue session is no longer valid. Reopen the latest queue page to continue.';
}

function getResolvedExpiredRetentionMs() {
  return Number.isFinite(expiredRetentionMs) && expiredRetentionMs > 0
    ? expiredRetentionMs
    : expiredCustomerRetentionMs;
}

function timerKey(storeId, customerId) {
  return `${storeId.toUpperCase()}:${customerId}`;
}

function shouldReconcileOverdueCalls(storeId) {
  const normalizedStoreId = storeId.toUpperCase();
  const now = Date.now();
  const lastRunAt = reconcileTimestamps.get(normalizedStoreId) ?? 0;

  if (now - lastRunAt < reconcileThrottleMs) {
    return false;
  }

  reconcileTimestamps.set(normalizedStoreId, now);
  return true;
}

function clearExpiryTimer(storeId, customerId) {
  const key = timerKey(storeId, customerId);
  const timer = expiryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(key);
  }
}

async function expireCustomerFromTimer(storeId, customerId) {
  clearExpiryTimer(storeId, customerId);

  const result = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
    const store = await tx.getStore(storeId);
    if (!store) {
      return null;
    }

    const currentState = normalizeQueueState(store.queueState);
    const timedOutCustomer = currentState.customers.find(customer => customer.id === customerId);
    const expiredState = expireCustomer(currentState, customerId);
    if (expiredState === currentState || !timedOutCustomer) {
      return null;
    }

    const automation = applyQueueAutomation(expiredState, {
      expiredRetentionMs: getResolvedExpiredRetentionMs(),
    });

    await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
    const updatedStore =
      automation.state !== currentState
        ? await tx.writeStore(store.storeId, store, automation.state)
        : store;

    await tx.createQueueEvent(
      buildQueueEvent(store.storeId, 'expired', timedOutCustomer, {
        waitMs: Number.isFinite(Date.parse(timedOutCustomer.joinTime))
          ? Date.now() - Date.parse(timedOutCustomer.joinTime)
          : null,
        metadata: {
          reason: 'call_timeout',
        },
      })
    );

    return {
      automation,
      expiredCustomer: automation.state.customers.find(customer => customer.id === customerId) ?? null,
      store: updatedStore,
    };
  });

  if (!result?.store) {
    return;
  }

  if (result.expiredCustomer?.status === 'expired' && result.expiredCustomer.expiredAt) {
    scheduleExpiredCleanup(storeId, customerId, result.expiredCustomer.expiredAt);
  }

  syncAutomationTimers(storeId, result.automation);
}

function scheduleCallExpiry(storeId, customerId, callTime) {
  clearExpiryTimer(storeId, customerId);
  const delay = Math.max(0, callHoldMs - (Date.now() - Date.parse(callTime)));
  const timer = setTimeout(() => {
    void expireCustomerFromTimer(storeId, customerId);
  }, delay);
  expiryTimers.set(timerKey(storeId, customerId), timer);
}

function scheduleExpiredCleanup(storeId, customerId, expiredAt) {
  clearExpiryTimer(storeId, customerId);
  const delay = Math.max(
    0,
    getResolvedExpiredRetentionMs() - (Date.now() - Date.parse(expiredAt))
  );
  const timer = setTimeout(() => {
    void removeExpiredCustomerFromTimer(storeId, customerId);
  }, delay);
  expiryTimers.set(timerKey(storeId, customerId), timer);
}

async function removeExpiredCustomerFromTimer(storeId, customerId) {
  clearExpiryTimer(storeId, customerId);

  await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
    const store = await tx.getStore(storeId);
    if (!store) {
      return;
    }

    const currentState = normalizeQueueState(store.queueState);
    const customer = currentState.customers.find(entry => entry.id === customerId);
    if (!customer || customer.status !== 'expired') {
      return;
    }

    await tx.deleteCustomerTokensForCustomer(store.storeId, customerId);
    await tx.deleteCustomerPushSubscriptionsForCustomer(store.storeId, customerId);
    const nextState = removeCustomerFromQueueState(currentState, customerId);
    if (nextState !== currentState) {
      await tx.writeStore(store.storeId, store, nextState);
    }
  });
}

async function requireSession(request, response, expectedStoreId) {
  const token = getAuthToken(request);
  if (!token) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return null;
  }

  const session = await getSession(defaultStoreId, defaultStorePassword, token);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) {
      await deleteSession(defaultStoreId, defaultStorePassword, token);
    }
    sendJson(response, 401, { error: 'Unauthorized' });
    return null;
  }

  if (expectedStoreId && session.storeId !== expectedStoreId.toUpperCase()) {
    sendJson(response, 403, { error: 'Forbidden for this store' });
    return null;
  }

  const store = await getStore(defaultStoreId, defaultStorePassword, session.storeId);
  if (!store) {
    await deleteSession(defaultStoreId, defaultStorePassword, token);
    sendJson(response, 401, { error: 'Unauthorized' });
    return null;
  }

  return { token, session, store };
}

async function getMerchantSessionForStore(token, expectedStoreId) {
  if (!token) {
    return null;
  }

  const session = await getSession(defaultStoreId, defaultStorePassword, token);
  if (
    !session ||
    Date.parse(session.expiresAt) <= Date.now() ||
    session.storeId !== expectedStoreId.toUpperCase()
  ) {
    return null;
  }

  return session;
}

async function requireCustomerToken(request, response, expectedStoreId, expectedCustomerId) {
  const token = getCustomerTokenHeader(request);
  if (!token) {
    sendJson(response, 401, { error: buildInvalidCustomerSessionError() });
    return null;
  }

  const record = await getCustomerToken(defaultStoreId, defaultStorePassword, token);
  if (
    !record ||
    record.store_id !== expectedStoreId.toUpperCase() ||
    record.customer_id !== expectedCustomerId
  ) {
    sendJson(response, 403, { error: buildInvalidCustomerSessionError() });
    return null;
  }

  const store = await getStore(defaultStoreId, defaultStorePassword, record.store_id);
  if (!store) {
    await deleteCustomerTokensForCustomer(
      defaultStoreId,
      defaultStorePassword,
      record.store_id,
      record.customer_id
    );
    sendJson(response, 410, { error: buildInvalidCustomerSessionError() });
    return null;
  }

  const queueState = normalizeQueueState(store.queueState);
  const customer = findCustomerById(queueState, record.customer_id);
  if (!customer || !isCustomerSessionVisibleStatus(customer.status)) {
    await deleteCustomerTokensForCustomer(
      defaultStoreId,
      defaultStorePassword,
      record.store_id,
      record.customer_id
    );
    sendJson(response, 410, { error: buildInvalidCustomerSessionError() });
    return null;
  }

  if (isCustomerSessionTokenExpired(record)) {
    await deleteCustomerTokensForCustomer(
      defaultStoreId,
      defaultStorePassword,
      record.store_id,
      record.customer_id
    );
    sendJson(response, 410, { error: buildInvalidCustomerSessionError() });
    return null;
  }

  await touchCustomerToken(defaultStoreId, defaultStorePassword, token, new Date().toISOString());
  return {
    ...record,
    store,
    queueState,
    customer,
  };
}

async function scheduleStoredExpiries() {
  const stores = await listStores(defaultStoreId, defaultStorePassword);
  for (const storeSummary of stores) {
    const store = await getStore(defaultStoreId, defaultStorePassword, storeSummary.storeId);
    if (!store) {
      continue;
    }

    const queueState = normalizeQueueState(store.queueState);
    for (const customer of queueState.customers) {
      if (customer.status === 'called' && customer.callTime) {
        scheduleCallExpiry(store.storeId, customer.id, customer.callTime);
      } else if (customer.status === 'expired' && customer.expiredAt) {
        scheduleExpiredCleanup(store.storeId, customer.id, customer.expiredAt);
      }
    }
  }
}

async function sendCallNotification(request, savedStore, updatedCustomer, reservedTable) {
  if (!updatedCustomer || !reservedTable) {
    return;
  }

  const [pushSubscriptions] = await Promise.all([
    listCustomerPushSubscriptions(
      defaultStoreId,
      defaultStorePassword,
      savedStore.storeId,
      updatedCustomer.id
    ).catch(() => []),
    notificationService.sendQueueCalledEmail({
      storeId: savedStore.storeId,
      storeName: savedStore.storeName,
      customer: updatedCustomer,
      table: reservedTable,
    }),
  ]);

  if (pushSubscriptions.length === 0) {
    return;
  }

  const result = await pushNotificationService.sendQueueCalledNotifications({
    storeId: savedStore.storeId,
    storeName: savedStore.storeName,
    customer: updatedCustomer,
    table: reservedTable,
    subscriptions: pushSubscriptions,
    customerPortalUrl: resolveCustomerPortalUrl(request, savedStore.storeId),
  });

  if (result.invalidEndpoints.length === 0) {
    return;
  }

  await Promise.allSettled(
    result.invalidEndpoints.map(endpoint =>
      deleteCustomerPushSubscription(
        defaultStoreId,
        defaultStorePassword,
        savedStore.storeId,
        endpoint
      )
    )
  );
}

async function notifyAutoCalledCustomers(request, savedStore, autoCalled) {
  if (!savedStore || !Array.isArray(autoCalled) || autoCalled.length === 0) {
    return;
  }

  await Promise.allSettled(
    autoCalled.map(({ customer, table }) =>
      sendCallNotification(request, savedStore, customer, table).catch(() => undefined)
    )
  );
}

function applyAutomationToQueueState(queueState) {
  return applyQueueAutomation(queueState, {
    expiredRetentionMs: getResolvedExpiredRetentionMs(),
  });
}

async function recordAutomatedQueueSideEffects(tx, storeId, automation) {
  for (const removedCustomer of automation.removedExpiredCustomers ?? []) {
    await tx.deleteCustomerTokensForCustomer(storeId, removedCustomer.id);
    await tx.deleteCustomerPushSubscriptionsForCustomer(storeId, removedCustomer.id);
  }

  for (const entry of automation.autoCalled ?? []) {
    await tx.createQueueEvent(
      buildQueueEvent(storeId, 'called', entry.customer, {
        metadata: {
          autoMode: true,
          tableId: entry.table?.id ?? '',
          tableName: entry.table?.name ?? '',
        },
      })
    );
  }
}

function syncAutomationTimers(storeId, automation) {
  for (const removedCustomer of automation.removedExpiredCustomers ?? []) {
    clearExpiryTimer(storeId, removedCustomer.id);
  }

  for (const entry of automation.autoCalled ?? []) {
    if (entry.customer?.callTime) {
      scheduleCallExpiry(storeId, entry.customer.id, entry.customer.callTime);
    }
  }
}

function normalizeRequestPath(pathname) {
  if (pathname === '/api') {
    return '/';
  }

  return pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
}

function findTimedOutCalledCustomers(queueState) {
  return queueState.customers.filter(customer => {
    if (customer.status !== 'called' || !customer.callTime) {
      return false;
    }

    const callTime = Date.parse(customer.callTime);
    return Number.isFinite(callTime) && Date.now() - callTime >= callHoldMs;
  });
}

async function reconcileOverdueCallsForStore(storeId) {
  const store = await getStore(defaultStoreId, defaultStorePassword, storeId);
  if (!store) {
    return null;
  }

  const queueState = normalizeQueueState(store.queueState);
  const timedOutCustomers = findTimedOutCalledCustomers(queueState);
  if (timedOutCustomers.length === 0) {
    const automation = applyAutomationToQueueState(queueState);
    if (automation.state === queueState) {
      return store;
    }

    const savedStore = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
      const latestStore = await tx.getStore(storeId);
      if (!latestStore) {
        return null;
      }

      const latestQueueState = normalizeQueueState(latestStore.queueState);
      const latestAutomation = applyAutomationToQueueState(latestQueueState);
      if (latestAutomation.state === latestQueueState) {
        return {
          autoCalled: [],
          removedExpiredCustomers: [],
          store: latestStore,
        };
      }

      await recordAutomatedQueueSideEffects(tx, latestStore.storeId, latestAutomation);

      return {
        autoCalled: latestAutomation.autoCalled,
        removedExpiredCustomers: latestAutomation.removedExpiredCustomers,
        store: await tx.writeStore(latestStore.storeId, latestStore, latestAutomation.state),
      };
    });

    if (savedStore?.store) {
      syncAutomationTimers(storeId, savedStore);
    }

    return savedStore?.store ?? store;
  }

  const savedStore = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
    const latestStore = await tx.getStore(storeId);
    if (!latestStore) {
      return null;
    }

    const latestQueueState = normalizeQueueState(latestStore.queueState);
    const latestTimedOutCustomers = findTimedOutCalledCustomers(latestQueueState);
    if (latestTimedOutCustomers.length === 0) {
      return latestStore;
    }

    let nextState = latestQueueState;
    for (const customer of latestTimedOutCustomers) {
      nextState = expireCustomer(nextState, customer.id);
    }

    const automation = applyAutomationToQueueState(nextState);
    await recordAutomatedQueueSideEffects(tx, latestStore.storeId, automation);
    const updatedStore = await tx.writeStore(latestStore.storeId, latestStore, automation.state);
    for (const customer of latestTimedOutCustomers) {
      await tx.createQueueEvent(
        buildQueueEvent(latestStore.storeId, 'expired', customer, {
          waitMs: Number.isFinite(Date.parse(customer.joinTime))
            ? Date.now() - Date.parse(customer.joinTime)
            : null,
          metadata: {
            reason: 'call_timeout',
          },
        })
      );
    }

    return {
      autoCalled: automation.autoCalled,
      removedExpiredCustomers: automation.removedExpiredCustomers,
      store: updatedStore,
    };
  });

  for (const customer of timedOutCustomers) {
    clearExpiryTimer(storeId, customer.id);
  }

  if (savedStore?.store) {
    for (const customer of timedOutCustomers) {
      const expiredCustomer = savedStore.store.queueState.customers.find(
        entry => entry.id === customer.id
      );
      if (expiredCustomer?.status === 'expired' && expiredCustomer.expiredAt) {
        scheduleExpiredCleanup(storeId, customer.id, expiredCustomer.expiredAt);
      }
    }

    syncAutomationTimers(storeId, savedStore);
  }

  return savedStore?.store ?? store;
}

let runtimeInitializedPromise = null;
let runtimeExpiryTimersScheduled = false;

export async function initializeQueueRuntime({ scheduleExpiryTimers = false } = {}) {
  if (!runtimeInitializedPromise) {
    runtimeInitializedPromise = pruneExpiredSessions(
      defaultStoreId,
      defaultStorePassword,
      new Date().toISOString()
    );
  }

  await runtimeInitializedPromise;

  if (scheduleExpiryTimers && !runtimeExpiryTimersScheduled) {
    runtimeExpiryTimersScheduled = true;
    await scheduleStoredExpiries();
  }
}

async function handleRequestInternal(request, response) {
  await initializeQueueRuntime();
  request[requestStartMsSymbol] = Date.now();
  getRequestId(request);

  if (!request.url || !request.method) {
    sendJson(response, 400, { error: 'Invalid request' });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);
  const pathname = normalizeRequestPath(url.pathname);
  const matchedStoreRoute = matchStoreRoute(pathname);
  const requestOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : null;

  if (request.method === 'OPTIONS') {
    if (!isCorsOriginAllowed(requestOrigin)) {
      response.writeHead(403, {
        'Access-Control-Allow-Origin': resolveCorsOrigin(requestOrigin),
        'X-Request-Id': getRequestId(request),
        Vary: 'Origin',
        ...getSecurityHeaders(request),
      });
      response.end();
      return;
    }

    response.writeHead(204, {
      'Access-Control-Allow-Origin': resolveCorsOrigin(requestOrigin),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Request-Id, X-Queue-Customer-Token, X-Queue-Entry-Token',
      'X-Request-Id': getRequestId(request),
      Vary: 'Origin',
      ...getSecurityHeaders(request),
    });
    response.end();
    return;
  }

  if (!isCorsOriginAllowed(requestOrigin)) {
    rejectDisallowedCorsOrigin(response);
    return;
  }

  if (!enforceRateLimit(request, response, 'global')) {
    return;
  }

  const routeValidationError = validateMatchedStoreRoute(matchedStoreRoute);
  if (routeValidationError) {
    sendJson(response, 400, { error: routeValidationError });
    return;
  }

  if (request.method === 'POST' && pathname !== '/stripe/webhook') {
    const bodyCached = await cacheJsonRequestBody(request, response);
    if (!bodyCached) {
      return;
    }
  }

  if (request.method === 'GET' && pathname === '/health') {
    await pruneExpiredSessions(defaultStoreId, defaultStorePassword, new Date().toISOString());
    const notificationConfig = notificationService.getPublicConfig();
    const billingConfig = billingService.getPublicConfig();
    const isInternalHealth = isAuthorizedHealthRequest(request, url);
    const internalHealthPayload = isInternalHealth
      ? {
          dbFilePath,
          legacyJsonPath,
          stores: (await listStores(defaultStoreId, defaultStorePassword)).map(store => store.storeId),
          notificationMissingEnv: notificationConfig.config.missingEnv,
          billingMissingEnv: billingConfig.config.missingEnv,
        }
      : {};

    sendJson(response, 200, {
      ok: true,
      mode: `${storageProvider}-remote`,
      storageProvider,
      storageEngine,
      storageProductionReady,
      storageRecommendation,
      notificationProvider: notificationService.provider,
      notificationConfigured: notificationService.isConfigured,
      billingProvider: billingService.provider,
      billingConfigured: billingService.isConfigured,
      ...internalHealthPayload,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/stripe/webhook') {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      sendJson(response, 400, { error: 'Missing Stripe signature' });
      return;
    }

    let rawBody;
    try {
      rawBody = await readRawRequestBody(request);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        sendRequestError(response, error);
      } else {
        sendJson(response, 400, { error: 'Unable to read Stripe payload' });
      }
      return;
    }

    try {
      const event = billingService.constructWebhookEvent(rawBody, signature);
      await handleStripeWebhookEvent(event);
      sendJson(response, 200, { received: true });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Unable to process Stripe webhook',
      });
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/auth/login') {
    const body = await readRequestBody(request).catch(() => null);
    const requestedStoreId =
      body && typeof body.storeId === 'string' ? body.storeId.toUpperCase() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';

    if (!enforceRateLimit(request, response, 'login', [requestedStoreId || 'unknown'])) {
      return;
    }

    if (!isValidStoreId(requestedStoreId) || password.length === 0) {
      sendJson(response, 400, { error: 'storeId and password are required' });
      return;
    }

    const verified = await verifyStorePassword(
      defaultStoreId,
      defaultStorePassword,
      requestedStoreId,
      password
    );
    if (!verified.ok || !verified.store) {
      sendJson(response, 401, { error: 'Invalid credentials' });
      return;
    }

    const store = verified.store;
    const session = {
      token: randomBytes(32).toString('hex'),
      storeId: requestedStoreId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
    };
    await createSession(defaultStoreId, defaultStorePassword, session);

    sendJson(response, 200, {
      token: session.token,
      auth: toMerchantAuth(store),
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/merchant/register') {
    if (!enforceRateLimit(request, response, 'register')) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const storeName = typeof body?.storeName === 'string' ? body.storeName.trim() : '';
    const ownerName = typeof body?.ownerName === 'string' ? body.ownerName.trim() : '';
    const ownerEmail = typeof body?.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
    const contactPhone = typeof body?.contactPhone === 'string' ? body.contactPhone.trim() : '';
    const requestedPassword = typeof body?.password === 'string' ? body.password : '';
    const planCode = normalizePlanCode(body?.planCode);
    const billingCycle =
      typeof body?.billingCycle === 'string' && body.billingCycle.trim().length > 0
        ? body.billingCycle.trim().toLowerCase()
        : 'monthly';

    if (storeName.length < 2 || storeName.length > 64) {
      sendJson(response, 400, { error: 'Store name must be between 2 and 64 characters.' });
      return;
    }
    if (ownerName.length < 2 || ownerName.length > 64) {
      sendJson(response, 400, { error: 'Owner name must be between 2 and 64 characters.' });
      return;
    }
    if (!isValidEmail(ownerEmail)) {
      sendJson(response, 400, { error: 'Expected a valid owner email address.' });
      return;
    }
    if (contactPhone && contactPhone.replace(/\D/g, '').length < 8) {
      sendJson(response, 400, { error: 'Expected a valid contact phone number.' });
      return;
    }
    if (requestedPassword && requestedPassword.length < 8) {
      sendJson(response, 400, { error: 'Password must be at least 8 characters.' });
      return;
    }

    const allocatedStoreId = await allocateUniqueStoreId(storeName);
    const merchantPassword = requestedPassword || generateMerchantPassword();
    const nowIso = new Date().toISOString();
    const createdQueueState = createInitialQueueState();
    const created = await createMerchantStore(
      defaultStoreId,
      defaultStorePassword,
      {
        storeId: allocatedStoreId,
        storeName,
        passwordHash: hashPassword(merchantPassword),
        queueState: createdQueueState,
        updatedAt: nowIso,
      },
      {
        storeId: allocatedStoreId,
        storeName,
        ownerName,
        ownerEmail,
        contactPhone,
        planCode,
        subscriptionStatus: 'trialing',
        billingCycle,
        onboardingStatus: 'live',
        qrIssuedAt: nowIso,
        createdAt: nowIso,
        activatedAt: nowIso,
        trialEndsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
        updatedAt: nowIso,
      }
    );

    const session = {
      token: randomBytes(32).toString('hex'),
      storeId: allocatedStoreId,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
    };
    await createSession(defaultStoreId, defaultStorePassword, session);
    const profilePayload = await buildMerchantProfilePayload(allocatedStoreId);

    sendJson(response, 201, {
      token: session.token,
      auth: toMerchantAuth(created.store),
      profile: profilePayload,
      provisioning: {
        storeId: allocatedStoreId,
        temporaryPassword: merchantPassword,
        planCode,
        subscriptionStatus: 'trialing',
        trialEndsAt: created.profile?.trialEndsAt ?? null,
      },
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/auth/session') {
    const session = await requireSession(request, response);
    if (!session) {
      return;
    }

    sendJson(response, 200, {
      auth: toMerchantAuth(session.store),
      expiresAt: session.session.expiresAt,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/auth/logout') {
    const token = getAuthToken(request);
    if (token) {
      await deleteSession(defaultStoreId, defaultStorePassword, token);
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && pathname === '/stores') {
    const stores = await listStores(defaultStoreId, defaultStorePassword);
    sendJson(response, 200, { stores });
    return;
  }

  if (matchedStoreRoute?.storeId && shouldReconcileOverdueCalls(matchedStoreRoute.storeId)) {
    await reconcileOverdueCallsForStore(matchedStoreRoute.storeId);
  }

  if (matchedStoreRoute?.type === 'public-queue-state' && request.method === 'GET') {
    const store = await getStore(defaultStoreId, defaultStorePassword, matchedStoreRoute.storeId);
    if (!store) {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }
    sendJson(response, 200, buildPublicQueueStatePayload(store));
    return;
  }

  if (matchedStoreRoute?.type === 'queue-state' && request.method === 'GET') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    sendJson(response, 200, normalizeQueueState(session.store.queueState));
    return;
  }

  if (matchedStoreRoute?.type === 'profile' && request.method === 'GET') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const profile = await buildMerchantProfilePayload(matchedStoreRoute.storeId);
    sendJson(response, profile ? 200 : 404, profile ? { profile } : { error: 'Store not found' });
    return;
  }

  if (matchedStoreRoute?.type === 'profile' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const patch = {
      storeName: typeof body?.storeName === 'string' ? body.storeName.trim() : undefined,
      ownerName: typeof body?.ownerName === 'string' ? body.ownerName.trim() : undefined,
      ownerEmail:
        typeof body?.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : undefined,
      contactPhone: typeof body?.contactPhone === 'string' ? body.contactPhone.trim() : undefined,
      planCode: typeof body?.planCode === 'string' ? normalizePlanCode(body.planCode) : undefined,
      subscriptionStatus:
        typeof body?.subscriptionStatus === 'string'
          ? body.subscriptionStatus.trim().toLowerCase()
          : undefined,
      billingCycle:
        typeof body?.billingCycle === 'string' ? body.billingCycle.trim().toLowerCase() : undefined,
    };

    if (patch.storeName !== undefined && (patch.storeName.length < 2 || patch.storeName.length > 64)) {
      sendJson(response, 400, { error: 'Store name must be between 2 and 64 characters.' });
      return;
    }
    if (patch.ownerName !== undefined && (patch.ownerName.length < 2 || patch.ownerName.length > 64)) {
      sendJson(response, 400, { error: 'Owner name must be between 2 and 64 characters.' });
      return;
    }
    if (patch.ownerEmail !== undefined && !isValidEmail(patch.ownerEmail)) {
      sendJson(response, 400, { error: 'Expected a valid owner email address.' });
      return;
    }
    if (
      patch.contactPhone !== undefined &&
      patch.contactPhone.length > 0 &&
      patch.contactPhone.replace(/\D/g, '').length < 8
    ) {
      sendJson(response, 400, { error: 'Expected a valid contact phone number.' });
      return;
    }

    await updateMerchantProfile(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId,
      patch
    );
    const profile = await buildMerchantProfilePayload(matchedStoreRoute.storeId);
    sendJson(response, profile ? 200 : 404, profile ? { profile } : { error: 'Store not found' });
    return;
  }

  if (matchedStoreRoute?.type === 'password' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    if (!enforceRateLimit(request, response, 'password', [matchedStoreRoute.storeId])) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const nextPassword = typeof body?.nextPassword === 'string' ? body.nextPassword : '';

    if (currentPassword.length === 0 || nextPassword.length === 0) {
      sendJson(response, 400, { error: 'Current password and new password are required.' });
      return;
    }

    if (nextPassword.length < 8) {
      sendJson(response, 400, { error: 'New password must be at least 8 characters.' });
      return;
    }

    const verified = await verifyStorePassword(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId,
      currentPassword
    );

    if (!verified.ok || !verified.store) {
      sendJson(response, 403, { error: 'Current password is incorrect.' });
      return;
    }

    await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
      await tx.writeStorePassword(matchedStoreRoute.storeId, hashPassword(nextPassword));
    });

    sendJson(response, 200, { ok: true });
    return;
  }

  if (matchedStoreRoute?.type === 'billing-checkout' && request.method === 'POST') {
    if (!(await requireSession(request, response, matchedStoreRoute.storeId))) {
      return;
    }

    const profile = await getMerchantProfile(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId
    );
    if (!profile) {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }

    const existingBilling = await getMerchantBilling(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId
    );
    const body = await readRequestBody(request).catch(() => null);
    const requestedPlanCode = normalizePlanCode(body?.planCode ?? profile.planCode);

    try {
      const checkout = await billingService.createCheckoutSession({
        existingCustomerId: existingBilling?.stripeCustomerId ?? null,
        profile: {
          ...profile,
          storeId: matchedStoreRoute.storeId.toUpperCase(),
        },
        requestedPlanCode,
        successUrl: resolveMerchantAppUrl(request, { billing: 'success' }),
        cancelUrl: resolveMerchantAppUrl(request, { billing: 'cancel' }),
      });

      await updateMerchantBilling(defaultStoreId, defaultStorePassword, matchedStoreRoute.storeId, {
        stripeCustomerId: checkout.customerId,
        stripeCheckoutSessionId: checkout.sessionId,
        lastCheckoutAt: new Date().toISOString(),
      });

      sendJson(response, 200, { url: checkout.url });
    } catch (error) {
      sendJson(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to start Stripe checkout right now.',
      });
    }
    return;
  }

  if (matchedStoreRoute?.type === 'billing-portal' && request.method === 'POST') {
    if (!(await requireSession(request, response, matchedStoreRoute.storeId))) {
      return;
    }

    const billing = await getMerchantBilling(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId
    );
    if (!billing?.stripeCustomerId) {
      sendJson(response, 400, { error: 'No Stripe billing customer is linked to this store yet.' });
      return;
    }

    try {
      const portal = await billingService.createPortalSession({
        customerId: billing.stripeCustomerId,
        returnUrl: resolveMerchantAppUrl(request, { billing: 'portal' }),
      });
      sendJson(response, 200, { url: portal.url });
    } catch (error) {
      sendJson(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to open Stripe billing portal right now.',
      });
    }
    return;
  }

  if (matchedStoreRoute?.type === 'notification-logs' && request.method === 'GET') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const logs = await listNotificationLogs(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId,
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    );
    sendJson(response, 200, { logs });
    return;
  }

  if (matchedStoreRoute?.type === 'notifications-test-email' && request.method === 'POST') {
    if (!(await requireSession(request, response, matchedStoreRoute.storeId))) {
      return;
    }

    const profile = await getMerchantProfile(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId
    );
    if (!profile) {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const requestedRecipient =
      typeof body?.recipient === 'string' ? body.recipient.trim().toLowerCase() : '';
    const recipient = requestedRecipient || profile.ownerEmail;

    if (!isValidEmail(recipient)) {
      sendJson(response, 400, { error: 'Expected a valid recipient email address.' });
      return;
    }

    const result = await notificationService.sendTestEmail({
      storeId: matchedStoreRoute.storeId.toUpperCase(),
      storeName: profile.storeName,
      recipient,
    });

    if (!result.ok && !notificationService.isConfigured) {
      sendJson(response, 503, {
        error: 'Email delivery is not configured on the backend yet.',
      });
      return;
    }

    if (!result.ok) {
      sendJson(response, 500, {
        error: 'Unable to deliver the test email right now. Check notification logs for details.',
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      recipient,
    });
    return;
  }

  if (matchedStoreRoute?.type === 'queue-events' && request.method === 'GET') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const events = await listQueueEvents(
      defaultStoreId,
      defaultStorePassword,
      matchedStoreRoute.storeId,
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100
    );
    sendJson(response, 200, { events });
    return;
  }

  if (matchedStoreRoute?.type === 'auto-mode' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);
    const enabled = Boolean(body?.enabled);

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const toggledState = setAutoMode(currentState, enabled);
        const automation = applyAutomationToQueueState(toggledState);
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const savedStore = await tx.writeStore(store.storeId, store, automation.state);

        return {
          type: 'ok',
          automation,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'configure-tables' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const body = await readRequestBody(request).catch(() => null);
    const tables = normalizeConfiguredTables(body?.tables);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);

    if (!tables) {
      sendJson(response, 400, { error: 'Expected a valid tables array' });
      return;
    }

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const nextState = configureTables(currentState, tables);
        const automation = applyAutomationToQueueState(nextState);
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const savedStore = await tx.writeStore(store.storeId, store, automation.state);

        return {
          type: 'ok',
          automation,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'add-table' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const capacity = Number.parseInt(String(body?.capacity ?? ''), 10);

    if (!Number.isInteger(capacity) || capacity <= 0) {
      sendJson(response, 400, { error: 'A valid table capacity is required.' });
      return;
    }

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const nextState = addTable(currentState, capacity);
        const automation = applyAutomationToQueueState(nextState);
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const savedStore = await tx.writeStore(store.storeId, store, automation.state);

        return {
          type: 'ok',
          automation,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'release-table' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);

    if (!isValidOpaqueId(matchedStoreRoute.tableId)) {
      sendJson(response, 400, { error: 'Invalid table id' });
      return;
    }

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const assignedCustomerId = currentState.tables.find(
          table => table.id === matchedStoreRoute.tableId
        )?.assignedCustomerId;
        const nextState = releaseTable(currentState, matchedStoreRoute.tableId);
        const automation = applyAutomationToQueueState(nextState);

        if (assignedCustomerId) {
          await tx.deleteCustomerTokensForCustomer(store.storeId, assignedCustomerId);
          await tx.deleteCustomerPushSubscriptionsForCustomer(store.storeId, assignedCustomerId);
        }
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const savedStore = await tx.writeStore(store.storeId, store, automation.state);

        return {
          type: 'ok',
          assignedCustomerId,
          automation,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    if (result.assignedCustomerId) {
      clearExpiryTimer(matchedStoreRoute.storeId, result.assignedCustomerId);
    }
    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'join-customer' && request.method === 'POST') {
    if (!enforceRateLimit(request, response, 'customerJoin', [matchedStoreRoute.storeId])) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const email = rawEmail.length > 0 ? rawEmail : undefined;
    const partySize = Number.parseInt(String(body?.partySize ?? ''), 10);

    if (!isValidStoreId(matchedStoreRoute.storeId.toUpperCase())) {
      sendJson(response, 400, { error: 'Invalid store id' });
      return;
    }
    if (phone.length < 8 || phone.length > 20) {
      sendJson(response, 400, { error: 'Expected a valid phone number' });
      return;
    }
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 8) {
      sendJson(response, 400, { error: 'Expected a valid party size between 1 and 8' });
      return;
    }
    if (email && !isValidEmail(email)) {
      sendJson(response, 400, { error: 'Expected a valid email address' });
      return;
    }

    const entrySessionToken = getCustomerEntryTokenHeader(request);
    const joinRequestHash = buildCustomerJoinRequestHash({ phone, email, partySize });

    const result = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
      const store = await tx.getStore(matchedStoreRoute.storeId);
      if (!store) {
        return { type: 'not-found' };
      }

      const queueState = normalizeQueueState(store.queueState);
      if (entrySessionToken) {
        const replay = await tx.getCustomerJoinReplay(entrySessionToken);
        if (replay) {
          if (
            replay.storeId !== store.storeId ||
            Date.parse(replay.expiresAt) <= Date.now()
          ) {
            return {
              type: 'entry-session-required',
              status: 410,
              error: 'Customer entry session expired. Refresh the page to continue.',
            };
          }

          if (replay.requestHash !== joinRequestHash) {
            return {
              type: 'idempotency-conflict',
              error: 'This entry session was already used for a different join request.',
            };
          }

          return {
            type: 'ok',
            autoCalled: [],
            replayed: true,
            responsePayload: replay.response,
          };
        }
      }

      if (!queueState.isTablesConfigured || queueState.tables.length === 0) {
        return {
          type: 'queue-closed',
          publicStateStore: {
            storeId: store.storeId,
            storeName: store.storeName,
          },
          queueState,
        };
      }

      const existingCustomer = findRecoverableCustomerByPhone(queueState, phone);
      if (existingCustomer) {
        const existingToken = getCustomerTokenHeader(request);
        if (!existingToken) {
          return {
            type: 'active-session-required',
            error:
              'An active queue session already exists for this phone. Reopen the original page/browser to continue.',
          };
        }

        const existingRecord = await tx.getCustomerToken(existingToken);
        if (
          !existingRecord ||
          existingRecord.store_id !== store.storeId ||
          existingRecord.customer_id !== existingCustomer.id ||
          isCustomerSessionTokenExpired(existingRecord)
        ) {
          if (
            existingRecord?.store_id === store.storeId &&
            existingRecord?.customer_id === existingCustomer.id
          ) {
            await tx.deleteCustomerTokensForCustomer(store.storeId, existingCustomer.id);
          }

          return {
            type: 'active-session-required',
            error:
              'An active queue session already exists for this phone. Reopen the original page/browser to continue.',
          };
        }

        await tx.touchCustomerToken(existingToken, new Date().toISOString());

        return {
          type: 'ok',
          customer: existingCustomer,
          customerToken: existingToken,
          recovered: true,
          responsePayload: buildCustomerJoinReplayResponse({
            customer: existingCustomer,
            customerToken: existingToken,
            recovered: true,
            publicStateStore: {
              storeId: store.storeId,
              storeName: store.storeName,
            },
            state: queueState,
          }),
          publicStateStore: {
            storeId: store.storeId,
            storeName: store.storeName,
          },
          state: queueState,
        };
      }

      if (!entrySessionToken) {
        return {
          type: 'entry-session-required',
          status: 401,
          error: 'A fresh customer entry session is required.',
        };
      }

      const entrySession = await tx.getCustomerEntrySession(entrySessionToken);
      if (!entrySession || entrySession.store_id !== store.storeId) {
        return {
          type: 'entry-session-required',
          status: 403,
          error: 'Invalid customer entry session.',
        };
      }

      if (isCustomerEntrySessionExpired(entrySession)) {
        await tx.deleteCustomerEntrySession(entrySessionToken);
        return {
          type: 'entry-session-required',
          status: 410,
          error: 'Customer entry session expired. Refresh the page to continue.',
        };
      }

      const joined = joinQueue(queueState, phone, partySize, email);
      const customerToken = randomBytes(24).toString('hex');
      const nowIso = new Date().toISOString();
      await tx.deleteCustomerEntrySession(entrySessionToken);
      await tx.issueCustomerToken({
        token: customerToken,
        storeId: store.storeId,
        customerId: joined.customer.id,
        createdAt: nowIso,
        lastSeenAt: nowIso,
      });

      const automation = applyAutomationToQueueState(joined.state);
      const savedStore = joined.changed
        ? await tx.writeStore(store.storeId, store, automation.state)
        : store;
      if (joined.changed) {
        await tx.createQueueEvent(buildQueueEvent(store.storeId, 'joined', joined.customer));
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
      }
      const latestCustomer =
        normalizeQueueState(savedStore.queueState).customers.find(
          customer => customer.id === joined.customer.id
        ) ?? joined.customer;
      const latestState = normalizeQueueState(savedStore.queueState);
      const publicStateStore = {
        storeId: store.storeId,
        storeName: store.storeName,
      };
      const responsePayload = buildCustomerJoinReplayResponse({
        customer: latestCustomer,
        customerToken,
        recovered: !joined.changed,
        publicStateStore,
        state: latestState,
      });
      await tx.createCustomerJoinReplay({
        token: entrySessionToken,
        storeId: store.storeId,
        requestHash: joinRequestHash,
        response: responsePayload,
        createdAt: nowIso,
        expiresAt: entrySession.expires_at,
      });

      return {
        type: 'ok',
        autoCalled: automation.autoCalled,
        customer: latestCustomer,
        customerToken,
        recovered: !joined.changed,
        responsePayload,
        publicStateStore,
        state: latestState,
      };
    });

    if (result.type === 'not-found') {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }
    if (result.type === 'queue-closed') {
      sendJson(response, 409, {
        error: 'Queue is not open yet for this store.',
        state: buildPublicQueueStatePayload({
          ...result.publicStateStore,
          queueState: result.queueState,
        }),
      });
      return;
    }
    if (result.type === 'active-session-required') {
      sendJson(response, 409, { error: result.error });
      return;
    }
    if (result.type === 'entry-session-required') {
      sendJson(response, result.status, { error: result.error });
      return;
    }
    if (result.type === 'idempotency-conflict') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, {
      autoCalled: result.autoCalled ?? [],
      removedExpiredCustomers: [],
    });
    if (result.autoCalled?.length) {
      void notifyAutoCalledCustomers(
        request,
        {
          ...result.publicStateStore,
          queueState: result.state,
        },
        result.autoCalled
      );
    }

    sendJson(response, 200, result.responsePayload);
    return;
  }

  if (matchedStoreRoute?.type === 'walk-in-customer' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const name =
      typeof body?.name === 'string' && body.name.trim().length > 0
        ? body.name.trim().slice(0, 64)
        : undefined;
    const partySize = Number.parseInt(String(body?.partySize ?? ''), 10);

    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 8) {
      sendJson(response, 400, { error: 'Expected a valid party size between 1 and 8' });
      return;
    }

    const result = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
      const store = await tx.getStore(matchedStoreRoute.storeId);
      if (!store) {
        return { type: 'not-found' };
      }

      const queueState = normalizeQueueState(store.queueState);
      const joined = joinQueue(queueState, '', partySize, undefined, {
        name,
        source: 'walk-in',
      });
      const automation = applyAutomationToQueueState(joined.state);
      const savedStore = joined.changed
        ? await tx.writeStore(store.storeId, store, automation.state)
        : store;

      if (joined.changed) {
        await tx.createQueueEvent(buildQueueEvent(store.storeId, 'joined', joined.customer));
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
      }

      return {
        type: 'ok',
        autoCalled: automation.autoCalled,
        customer:
          normalizeQueueState(savedStore.queueState).customers.find(
            customer => customer.id === joined.customer.id
          ) ?? joined.customer,
        state: normalizeQueueState(savedStore.queueState),
      };
    });

    if (result.type === 'not-found') {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, {
      autoCalled: result.autoCalled ?? [],
      removedExpiredCustomers: [],
    });
    if (result.autoCalled?.length) {
      void notifyAutoCalledCustomers(
        request,
        {
          storeId: matchedStoreRoute.storeId.toUpperCase(),
          storeName: session.store.storeName,
          queueState: result.state,
        },
        result.autoCalled
      );
    }

    sendJson(response, 200, {
      customer: result.customer,
      recovered: false,
      state: result.state,
    });
    return;
  }

  if (matchedStoreRoute?.type === 'merchant-customer' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const email = rawEmail.length > 0 ? rawEmail : undefined;
    const partySize = Number.parseInt(String(body?.partySize ?? ''), 10);

    if (phone.length < 8 || phone.length > 20) {
      sendJson(response, 400, { error: 'Expected a valid phone number' });
      return;
    }
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 8) {
      sendJson(response, 400, { error: 'Expected a valid party size between 1 and 8' });
      return;
    }
    if (email && !isValidEmail(email)) {
      sendJson(response, 400, { error: 'Expected a valid email address' });
      return;
    }

    const result = await runTransaction(defaultStoreId, defaultStorePassword, async tx => {
      const store = await tx.getStore(matchedStoreRoute.storeId);
      if (!store) {
        return { type: 'not-found' };
      }

      const queueState = normalizeQueueState(store.queueState);
      if (!queueState.isTablesConfigured || queueState.tables.length === 0) {
        return {
          type: 'queue-closed',
          queueState,
        };
      }

      const existingCustomer = findRecoverableCustomerByPhone(queueState, phone);
      if (existingCustomer) {
        return {
          type: 'ok',
          customer: existingCustomer,
          recovered: true,
          state: queueState,
        };
      }

      const joined = joinQueue(queueState, phone, partySize, email);
      const automation = applyAutomationToQueueState(joined.state);
      const savedStore = joined.changed
        ? await tx.writeStore(store.storeId, store, automation.state)
        : store;

      if (joined.changed) {
        await tx.createQueueEvent(buildQueueEvent(store.storeId, 'joined', joined.customer));
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
      }

      return {
        type: 'ok',
        customer: joined.customer,
        recovered: false,
        autoCalled: automation.autoCalled,
        state: normalizeQueueState(savedStore.queueState),
        store: savedStore,
      };
    });

    if (result.type === 'not-found') {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }

    if (result.type === 'queue-closed') {
      sendJson(response, 409, {
        error: 'Configure tables before adding customers to the queue.',
        state: result.queueState,
      });
      return;
    }

    syncAutomationTimers(matchedStoreRoute.storeId, {
      autoCalled: result.autoCalled ?? [],
      removedExpiredCustomers: [],
    });
    if (result.store && result.autoCalled?.length) {
      void notifyAutoCalledCustomers(request, result.store, result.autoCalled);
    }

    sendJson(response, 200, {
      customer: result.customer,
      recovered: Boolean(result.recovered),
      state: result.state,
    });
    return;
  }

  if (matchedStoreRoute?.type === 'customer-entry-session' && request.method === 'GET') {
    if (!enforceRateLimit(request, response, 'customerEntry', [matchedStoreRoute.storeId])) {
      return;
    }

    const store = await getStore(defaultStoreId, defaultStorePassword, matchedStoreRoute.storeId);
    if (!store) {
      sendJson(response, 404, { error: 'Store not found' });
      return;
    }

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + customerEntrySessionTtlMs).toISOString();
    const token = randomBytes(24).toString('hex');

    await issueCustomerEntrySession(defaultStoreId, defaultStorePassword, {
      token,
      storeId: store.storeId,
      createdAt,
      expiresAt,
    });

    sendJson(response, 200, {
      token,
      expiresAt,
    });
    return;
  }

  if (matchedStoreRoute?.type === 'customer-session' && request.method === 'GET') {
    const customerSession = await requireCustomerToken(
      request,
      response,
      matchedStoreRoute.storeId,
      matchedStoreRoute.customerId
    );
    if (!customerSession) {
      return;
    }

    sendJson(response, 200, {
      valid: true,
      customerId: matchedStoreRoute.customerId,
      status: customerSession.customer.status,
    });
    return;
  }

  if (matchedStoreRoute?.type === 'push-subscriptions' && request.method === 'POST') {
    if (
      !(await requireCustomerToken(
        request,
        response,
        matchedStoreRoute.storeId,
        matchedStoreRoute.customerId
      ))
    ) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const subscription =
      body && typeof body === 'object' && typeof body.subscription === 'object'
        ? body.subscription
        : null;
    const endpoint =
      typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : '';

    if (!endpoint) {
      sendJson(response, 400, { error: 'A valid push subscription endpoint is required.' });
      return;
    }

    const nowIso = new Date().toISOString();
    const record = await upsertCustomerPushSubscription(
      defaultStoreId,
      defaultStorePassword,
      {
        storeId: matchedStoreRoute.storeId,
        customerId: matchedStoreRoute.customerId,
        endpoint,
        subscription,
        userAgent:
          typeof body?.userAgent === 'string' ? body.userAgent.slice(0, 512) : '',
        createdAt: nowIso,
        updatedAt: nowIso,
      }
    );

    sendJson(response, 200, {
      ok: true,
      endpoint: record?.endpoint ?? endpoint,
    });
    return;
  }

  const publicAction = ['confirm-customer', 'seat-customer', 'expire-customer', 'leave-customer'];
  if (matchedStoreRoute?.customerId && publicAction.includes(matchedStoreRoute.type) && request.method === 'POST') {
    // seat/expire can be called by a merchant only when the bearer token owns this store.
    const merchantBearerToken = getAuthToken(request);
    const isMerchantAction =
      (matchedStoreRoute.type === 'seat-customer' || matchedStoreRoute.type === 'expire-customer') &&
      Boolean(await getMerchantSessionForStore(merchantBearerToken, matchedStoreRoute.storeId));
    if (!isMerchantAction) {
      const tokenRecord = await requireCustomerToken(
        request,
        response,
        matchedStoreRoute.storeId,
        matchedStoreRoute.customerId
      );
      if (!tokenRecord) {
        return;
      }
    }
  }

  if (matchedStoreRoute?.type === 'call-customer' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);
    const requestedTableId =
      typeof body?.tableId === 'string' && body.tableId.trim().length > 0
        ? body.tableId.trim()
        : undefined;

    if (requestedTableId && !isValidOpaqueId(requestedTableId)) {
      sendJson(response, 400, { error: 'Invalid table id' });
      return;
    }

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'missing-customer' };
        }
        if (currentCustomer.status !== 'waiting') {
          return {
            type: 'invalid-state',
            error: 'This customer is no longer waiting to be called.',
            state: currentState,
          };
        }

        const called = callCustomer(currentState, matchedStoreRoute.customerId, requestedTableId);
        if (!called.changed || !called.customer || !called.table) {
          return {
            type: 'no-table',
            error: 'No suitable table is available for this party right now.',
          };
        }

        const updatedStore = await tx.writeStore(store.storeId, store, called.state);
        await tx.createQueueEvent(
          buildQueueEvent(store.storeId, 'called', called.customer, {
            metadata: {
              tableId: called.table?.id ?? '',
              tableName: called.table?.name ?? '',
            },
          })
        );

        return {
          type: 'ok',
          called,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }
    if (result.type === 'invalid-state' || result.type === 'no-table') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    if (result.called.customer?.callTime) {
      scheduleCallExpiry(
        matchedStoreRoute.storeId,
        result.called.customer.id,
        result.called.customer.callTime
      );
    }
    if (result.savedStore && result.called.customer && result.called.table) {
      void sendCallNotification(
        request,
        result.savedStore,
        result.called.customer,
        result.called.table
      ).catch(() => undefined);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'confirm-customer' && request.method === 'POST') {
    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'missing-customer' };
        }
        if (currentCustomer.status === 'confirmed' || currentCustomer.status === 'seated') {
          return {
            type: 'ok',
            changed: false,
            savedStore: store,
          };
        }
        if (currentCustomer.status !== 'called') {
          return {
            type: 'invalid-state',
            error: 'This customer is not waiting for confirmation.',
          };
        }

        const nextState = confirmArrival(currentState, matchedStoreRoute.customerId);
        const updatedCustomer = nextState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        const updatedStore = await tx.writeStore(store.storeId, store, nextState);
        if (updatedCustomer?.status === 'confirmed') {
          await tx.createQueueEvent(buildQueueEvent(store.storeId, 'confirmed', updatedCustomer));
        }

        return {
          type: 'ok',
          changed: true,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result, 'customer')) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }
    if (result.type === 'invalid-state') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    if (result.changed) {
      clearExpiryTimer(matchedStoreRoute.storeId, matchedStoreRoute.customerId);
    }
    sendJson(response, 200, { state: buildPublicQueueStatePayload(result.savedStore) });
    return;
  }

  if (matchedStoreRoute?.type === 'seat-customer' && request.method === 'POST') {
    const merchantToken = getAuthToken(request);
    const isMerchant = Boolean(
      await getMerchantSessionForStore(merchantToken, matchedStoreRoute.storeId)
    );

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'missing-customer' };
        }
        if (currentCustomer.status === 'seated') {
          return {
            type: 'ok',
            changed: false,
            savedStore: store,
          };
        }

        const nextState = seatCustomer(currentState, matchedStoreRoute.customerId);
        if (nextState === currentState) {
          return {
            type: 'invalid-state',
            error: 'This customer is not ready to be seated yet.',
          };
        }

        const updatedCustomer = nextState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        const updatedStore = await tx.writeStore(store.storeId, store, nextState);
        if (updatedCustomer?.status === 'seated') {
          await tx.createQueueEvent(
            buildQueueEvent(store.storeId, 'seated', updatedCustomer, {
              waitMs: Number.isFinite(Date.parse(currentCustomer.joinTime))
                ? Date.now() - Date.parse(currentCustomer.joinTime)
                : null,
            })
          );
        }

        return {
          type: 'ok',
          changed: true,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result, isMerchant ? 'merchant' : 'customer')) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }
    if (result.type === 'invalid-state') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    sendJson(
      response,
      200,
      {
        state: isMerchant
          ? result.savedStore.queueState
          : buildPublicQueueStatePayload(result.savedStore),
      }
    );
    return;
  }

  if (matchedStoreRoute?.type === 'expire-customer' && request.method === 'POST') {
    const merchantToken = getAuthToken(request);
    const isMerchant = Boolean(
      await getMerchantSessionForStore(merchantToken, matchedStoreRoute.storeId)
    );

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'missing-customer' };
        }
        if (currentCustomer.status === 'expired') {
          return {
            type: 'ok',
            changed: false,
            automation: { autoCalled: [], removedExpiredCustomers: [] },
            expiredCustomer: currentCustomer,
            savedStore: store,
          };
        }

        const nextState = expireCustomer(currentState, matchedStoreRoute.customerId);
        if (nextState === currentState) {
          return {
            type: 'invalid-state',
            error: 'This customer can no longer be marked as no-show.',
          };
        }

        const updatedCustomer = nextState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        const automation = applyAutomationToQueueState(nextState);
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const updatedStore = await tx.writeStore(store.storeId, store, automation.state);
        if (updatedCustomer?.status === 'expired') {
          await tx.createQueueEvent(
            buildQueueEvent(store.storeId, 'expired', updatedCustomer, {
              waitMs: Number.isFinite(Date.parse(currentCustomer.joinTime))
                ? Date.now() - Date.parse(currentCustomer.joinTime)
                : null,
            })
          );
        }

        return {
          type: 'ok',
          changed: true,
          automation,
          expiredCustomer: updatedCustomer,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result, isMerchant ? 'merchant' : 'customer')) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }
    if (result.type === 'invalid-state') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    if (result.changed) {
      clearExpiryTimer(matchedStoreRoute.storeId, matchedStoreRoute.customerId);
    }
    if (result.expiredCustomer?.expiredAt) {
      scheduleExpiredCleanup(
        matchedStoreRoute.storeId,
        result.expiredCustomer.id,
        result.expiredCustomer.expiredAt
      );
    }
    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }
    sendJson(
      response,
      200,
      {
        state: isMerchant
          ? result.savedStore.queueState
          : buildPublicQueueStatePayload(result.savedStore),
      }
    );
    return;
  }

  if (matchedStoreRoute?.type === 'requeue-customer' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }

    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'missing-customer' };
        }
        if (currentCustomer.status === 'waiting') {
          return {
            type: 'ok',
            changed: false,
            automation: { autoCalled: [], removedExpiredCustomers: [] },
            savedStore: store,
          };
        }

        const requeuedState = requeueCustomer(currentState, matchedStoreRoute.customerId);
        if (requeuedState === currentState) {
          return { type: 'invalid-state', error: 'This customer cannot be requeued right now.' };
        }

        const automation = applyAutomationToQueueState(requeuedState);
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const savedStore = await tx.writeStore(store.storeId, store, automation.state);

        return {
          type: 'ok',
          changed: true,
          automation,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }
    if (result.type === 'invalid-state') {
      sendJson(response, 409, { error: result.error });
      return;
    }

    if (result.changed) {
      clearExpiryTimer(matchedStoreRoute.storeId, matchedStoreRoute.customerId);
    }
    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'leave-customer' && request.method === 'POST') {
    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const currentCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!currentCustomer) {
          return { type: 'invalid-session' };
        }

        const nextState = removeCustomerFromQueueState(currentState, matchedStoreRoute.customerId);
        const automation = applyAutomationToQueueState(nextState);
        await tx.deleteCustomerTokensForCustomer(store.storeId, matchedStoreRoute.customerId);
        await tx.deleteCustomerPushSubscriptionsForCustomer(
          store.storeId,
          matchedStoreRoute.customerId
        );
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const updatedStore = await tx.writeStore(store.storeId, store, automation.state);
        await tx.createQueueEvent(
          buildQueueEvent(store.storeId, 'left', currentCustomer, {
            waitMs: Number.isFinite(Date.parse(currentCustomer.joinTime))
              ? Date.now() - Date.parse(currentCustomer.joinTime)
              : null,
          })
        );

        return {
          type: 'ok',
          automation,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result, 'customer')) {
      return;
    }
    if (result.type === 'invalid-session') {
      sendJson(response, 410, { error: buildInvalidCustomerSessionError() });
      return;
    }

    clearExpiryTimer(matchedStoreRoute.storeId, matchedStoreRoute.customerId);
    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }
    sendJson(response, 200, { state: buildPublicQueueStatePayload(result.savedStore) });
    return;
  }

  if (matchedStoreRoute?.type === 'remove-customer' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const removedCustomer = currentState.customers.find(
          customer => customer.id === matchedStoreRoute.customerId
        );
        if (!removedCustomer) {
          return { type: 'missing-customer' };
        }

        const nextState = removeCustomerFromQueueState(currentState, matchedStoreRoute.customerId);
        const automation = applyAutomationToQueueState(nextState);
        await tx.deleteCustomerTokensForCustomer(store.storeId, matchedStoreRoute.customerId);
        await tx.deleteCustomerPushSubscriptionsForCustomer(
          store.storeId,
          matchedStoreRoute.customerId
        );
        await recordAutomatedQueueSideEffects(tx, store.storeId, automation);
        const updatedStore = await tx.writeStore(store.storeId, store, automation.state);
        await tx.createQueueEvent(
          buildQueueEvent(store.storeId, 'removed', removedCustomer, {
            waitMs: Number.isFinite(Date.parse(removedCustomer.joinTime))
              ? Date.now() - Date.parse(removedCustomer.joinTime)
              : null,
          })
        );

        return {
          type: 'ok',
          automation,
          removedCustomer,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }
    if (result.type === 'missing-customer') {
      sendJson(response, 404, { error: buildMissingCustomerError() });
      return;
    }

    clearExpiryTimer(matchedStoreRoute.storeId, matchedStoreRoute.customerId);
    syncAutomationTimers(matchedStoreRoute.storeId, result.automation);
    if (result.savedStore) {
      void notifyAutoCalledCustomers(request, result.savedStore, result.automation.autoCalled);
    }
    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'clear-queue' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const body = await readRequestBody(request).catch(() => null);
    const expectedVersion = parseExpectedVersion(body?.expectedVersion);

    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      expectedVersion,
      async ({ tx, store, currentState }) => {
        const customerIds = currentState.customers.map(customer => customer.id);
        const nextState = clearQueue(currentState);
        for (const customerId of customerIds) {
          await tx.deleteCustomerTokensForCustomer(store.storeId, customerId);
          await tx.deleteCustomerPushSubscriptionsForCustomer(store.storeId, customerId);
        }

        const updatedStore = await tx.writeStore(store.storeId, store, nextState);
        await tx.createQueueEvent(
          buildQueueEvent(store.storeId, 'queue_cleared', null, {
            metadata: {
              clearedCustomers: customerIds.length,
            },
          })
        );
        return {
          type: 'ok',
          customerIds,
          savedStore: updatedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    for (const customerId of result.customerIds) {
      clearExpiryTimer(matchedStoreRoute.storeId, customerId);
    }

    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  if (matchedStoreRoute?.type === 'reset' && request.method === 'POST') {
    const session = await requireSession(request, response, matchedStoreRoute.storeId);
    if (!session) {
      return;
    }
    const result = await runLockedStoreMutation(
      matchedStoreRoute.storeId,
      null,
      async ({ tx, store, currentState }) => {
        const customerIds = currentState.customers.map(customer => customer.id);
        for (const customerId of customerIds) {
          await tx.deleteCustomerTokensForCustomer(store.storeId, customerId);
          await tx.deleteCustomerPushSubscriptionsForCustomer(store.storeId, customerId);
        }
        const savedStore = await tx.writeStore(store.storeId, store, createInitialQueueState());
        return {
          type: 'ok',
          customerIds,
          savedStore,
        };
      }
    );

    if (sendStoreMutationError(response, result)) {
      return;
    }

    for (const customerId of result.customerIds) {
      clearExpiryTimer(matchedStoreRoute.storeId, customerId);
    }
    sendJson(response, 200, { state: result.savedStore.queueState });
    return;
  }

  sendJson(response, 404, {
    error: 'Not found',
    availableRoutes: [
      'GET /health',
      'GET /stores',
      'POST /merchant/register',
      'POST /auth/login',
      'GET /auth/session',
      'POST /auth/logout',
      'GET /stores/:storeId/public-queue-state',
      'GET /stores/:storeId/queue-state',
      'GET /stores/:storeId/profile',
      'POST /stores/:storeId/profile',
      'POST /stores/:storeId/password',
      'POST /stores/:storeId/billing/checkout',
      'POST /stores/:storeId/billing/portal',
      'GET /stores/:storeId/notification-logs',
      'POST /stores/:storeId/notifications/test-email',
      'GET /stores/:storeId/queue-events',
      'POST /stores/:storeId/auto-mode',
      'POST /stores/:storeId/tables/add',
      'POST /stores/:storeId/tables/configure',
      'POST /stores/:storeId/tables/:tableId/release',
      'GET /stores/:storeId/customer-entry-session',
      'POST /stores/:storeId/customers/join',
      'POST /stores/:storeId/customers/manual',
      'POST /stores/:storeId/customers/walk-in',
      'GET /stores/:storeId/customers/:customerId/session',
      'POST /stores/:storeId/customers/:customerId/push-subscriptions',
      'POST /stores/:storeId/customers/:customerId/call',
      'POST /stores/:storeId/customers/:customerId/confirm',
      'POST /stores/:storeId/customers/:customerId/seat',
      'POST /stores/:storeId/customers/:customerId/expire',
      'POST /stores/:storeId/customers/:customerId/requeue',
      'POST /stores/:storeId/customers/:customerId/leave',
      'POST /stores/:storeId/customers/:customerId/remove',
      'POST /stores/:storeId/clear-queue',
      'POST /stores/:storeId/reset',
      'POST /stripe/webhook',
    ],
  });
}

export async function handleRequest(request, response) {
  try {
    await handleRequestInternal(request, response);
  } catch (error) {
    sendUnhandledError(response, error);
  }
}

export function createQueueServer() {
  return createServer((request, response) => {
    void handleRequest(request, response);
  });
}

const isDirectExecution =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  await initializeQueueRuntime({ scheduleExpiryTimers: true });

  const server = createQueueServer();
  server.listen(port, host, () => {
    console.log(`Mock queue server listening on http://${host}:${port}`);
    console.log(`Default store: ${defaultStoreId}`);
    console.log(`SQLite data file: ${dbFilePath}`);
  });
}
