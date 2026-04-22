import {
  readActiveCustomerToken,
  resolveRemoteApiBaseUrl,
} from '../context/storage';

interface SyncCustomerPushSubscriptionOptions {
  storeId: string;
  customerId: string;
  requestPermission?: boolean;
}

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | 'unsupported'
  | 'insecure-context'
  | 'ios-needs-home-screen'
  | 'missing-vapid-key';

type PushSyncReason =
  | 'synced'
  | 'unsupported'
  | 'missing-api-base'
  | 'missing-store-id'
  | 'missing-customer-id'
  | 'missing-customer-token'
  | 'missing-vapid-key'
  | 'insecure-context'
  | 'ios-needs-home-screen'
  | 'permission-denied'
  | 'permission-pending'
  | 'sync-failed';

export interface PushSyncResult {
  ok: boolean;
  reason: PushSyncReason;
}

const inflightSyncs = new Map<string, Promise<PushSyncResult>>();

function isPushSupported(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneWebApp(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    navigatorWithStandalone.standalone === true
  );
}

function getVapidPublicKey(): string {
  return typeof import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY === 'string'
    ? import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY.trim()
    : '';
}

export function getBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === 'undefined') {
    return 'unsupported';
  }

  if (!window.isSecureContext && !isLocalhost(window.location.hostname)) {
    return 'insecure-context';
  }

  if (isIOSDevice() && !isStandaloneWebApp()) {
    return 'ios-needs-home-screen';
  }

  if (!isPushSupported()) {
    return 'unsupported';
  }

  if (!getVapidPublicKey()) {
    return 'missing-vapid-key';
  }

  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const currentState = getBrowserNotificationPermissionState();
  if (currentState === 'unsupported' || currentState === 'insecure-context') {
    return currentState;
  }

  if (currentState !== 'default') {
    return currentState;
  }

  return Notification.requestPermission();
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(normalized);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}

async function getReadyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/queueflow-sw.js');
  return navigator.serviceWorker.ready;
}

async function getOrCreateSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    return existing;
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}

async function runPushSync({
  storeId,
  customerId,
  requestPermission = false,
}: SyncCustomerPushSubscriptionOptions): Promise<PushSyncResult> {
  const normalizedStoreId = storeId.trim().toUpperCase();
  const normalizedCustomerId = customerId.trim();
  const apiBaseUrl = resolveRemoteApiBaseUrl();
  const vapidPublicKey = getVapidPublicKey();

  if (!normalizedStoreId) {
    return { ok: false, reason: 'missing-store-id' };
  }
  if (!normalizedCustomerId) {
    return { ok: false, reason: 'missing-customer-id' };
  }
  if (!apiBaseUrl) {
    return { ok: false, reason: 'missing-api-base' };
  }
  const customerToken = readActiveCustomerToken(normalizedStoreId);
  if (!customerToken) {
    return { ok: false, reason: 'missing-customer-token' };
  }

  if (!window.isSecureContext && !isLocalhost(window.location.hostname)) {
    return { ok: false, reason: 'insecure-context' };
  }
  if (isIOSDevice() && !isStandaloneWebApp()) {
    return { ok: false, reason: 'ios-needs-home-screen' };
  }
  if (!isPushSupported()) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!vapidPublicKey) {
    return { ok: false, reason: 'missing-vapid-key' };
  }

  let permission = Notification.permission;
  if (permission === 'default' && requestPermission) {
    permission = await Notification.requestPermission();
  }

  if (permission === 'denied') {
    return { ok: false, reason: 'permission-denied' };
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'permission-pending' };
  }

  const registration = await getReadyServiceWorkerRegistration();
  const subscription = await getOrCreateSubscription(registration, vapidPublicKey);
  const response = await fetch(
    `${apiBaseUrl}/stores/${encodeURIComponent(
      normalizedStoreId
    )}/customers/${encodeURIComponent(normalizedCustomerId)}/push-subscriptions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Push subscription sync failed with ${response.status}`);
  }

  return { ok: true, reason: 'synced' };
}

export async function syncCustomerPushSubscription(
  options: SyncCustomerPushSubscriptionOptions
): Promise<PushSyncResult> {
  const key = `${options.storeId.trim().toUpperCase()}:${options.customerId.trim()}`;
  const existing = inflightSyncs.get(key);
  if (existing) {
    return existing;
  }

  const pending = runPushSync(options).finally(() => {
    inflightSyncs.delete(key);
  });
  inflightSyncs.set(key, pending);
  return pending;
}
