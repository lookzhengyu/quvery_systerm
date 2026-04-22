import { DEFAULT_REMOTE_STORE_ID } from '../context/storage';

export type Portal = 'merchant' | 'customer';
export type MerchantDashboardTab = 'queue' | 'tables' | 'logs' | 'activity';
export interface CustomerPortalTarget {
  customerPortalUrl: string;
  entryUrl: string;
  hostname: string;
  protocol: string;
  usesConfiguredPublicUrl: boolean;
  usesPrivateOrLocalHost: boolean;
  usesHttps: boolean;
  readyForLiveCustomers: boolean;
  warning: string | null;
}

function readSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') {
    return new URLSearchParams();
  }

  return new URLSearchParams(window.location.search);
}

function readPathname(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  return window.location.pathname || '/';
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }

  const trimmed = pathname.replace(/\/+$/, '') || '/';

  if (trimmed === '/app.html' || trimmed === '/index.html') {
    return '/';
  }

  return trimmed;
}

function getPathSegments(): string[] {
  return normalizePathname(readPathname())
    .split('/')
    .filter(Boolean);
}

export function normalizeStoreId(storeId: string | null | undefined): string | null {
  if (typeof storeId !== 'string') {
    return null;
  }

  const normalized = storeId.trim().toUpperCase();
  return /^[A-Z0-9-]+$/.test(normalized) ? normalized : null;
}

export function resolveRequestedPortal(): Portal | null {
  const [firstSegment] = getPathSegments();

  if (firstSegment === 'merchant' || firstSegment === 'customer') {
    return firstSegment;
  }

  const portal = readSearchParams().get('portal');

  if (portal === 'merchant' || portal === 'customer') {
    return portal;
  }

  return null;
}

export function hasPortalOverride(): boolean {
  return resolveRequestedPortal() !== null;
}

export function resolveInitialPortal(): Portal {
  return resolveRequestedPortal() ?? 'merchant';
}

export function resolveInitialRemoteStoreId(): string {
  const requestedStoreId = normalizeStoreId(readSearchParams().get('store'));
  const configuredStoreId = normalizeStoreId(import.meta.env.VITE_DEFAULT_STORE_ID);

  return requestedStoreId ?? configuredStoreId ?? DEFAULT_REMOTE_STORE_ID;
}

export function resolveInitialMerchantTab(): MerchantDashboardTab {
  const [, secondSegment] = getPathSegments();

  if (
    secondSegment === 'queue' ||
    secondSegment === 'tables' ||
    secondSegment === 'logs' ||
    secondSegment === 'activity'
  ) {
    return secondSegment;
  }

  return 'queue';
}

function hasConfiguredPublicAppUrl(): boolean {
  return (
    typeof import.meta.env.VITE_PUBLIC_APP_URL === 'string' &&
    import.meta.env.VITE_PUBLIC_APP_URL.trim().length > 0
  );
}

function resolveAppEntryUrl(): URL {
  const configuredUrl = import.meta.env.VITE_PUBLIC_APP_URL;

  if (typeof configuredUrl === 'string' && configuredUrl.trim().length > 0) {
    if (typeof window !== 'undefined') {
      return new URL(configuredUrl, window.location.origin);
    }

    return new URL(configuredUrl);
  }

  if (typeof window !== 'undefined') {
    return new URL('/', window.location.origin);
  }

  return new URL('/', 'http://localhost');
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();

  if (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  if (normalized.startsWith('127.')) {
    return true;
  }

  if (normalized.startsWith('10.')) {
    return true;
  }

  if (normalized.startsWith('192.168.')) {
    return true;
  }

  const private172Match = normalized.match(/^172\.(\d{1,3})\./);
  if (private172Match) {
    const secondOctet = Number.parseInt(private172Match[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function buildCustomerPortalUrlFromBase(storeId: string, baseUrl: URL): string {
  const url = new URL(baseUrl.toString());
  const normalizedStoreId = normalizeStoreId(storeId) ?? resolveInitialRemoteStoreId();

  url.pathname = '/customer';
  url.search = '';
  url.hash = '';
  url.searchParams.set('store', normalizedStoreId);

  return url.toString();
}

export function buildMerchantDashboardUrl(tab: MerchantDashboardTab = 'queue'): string {
  const url = resolveAppEntryUrl();

  url.pathname = tab === 'queue' ? '/merchant' : `/merchant/${tab}`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

export function buildCustomerPortalUrl(storeId: string): string {
  return buildCustomerPortalUrlFromBase(storeId, resolveAppEntryUrl());
}

export function getCustomerPortalTarget(storeId: string): CustomerPortalTarget {
  const entryUrl = resolveAppEntryUrl();
  const hostname = entryUrl.hostname || 'localhost';
  const protocol = entryUrl.protocol || 'http:';
  const usesConfiguredPublicUrl = hasConfiguredPublicAppUrl();
  const usesPrivateOrLocalHost = isPrivateOrLocalHost(hostname);
  const usesHttps = protocol === 'https:';
  const readyForLiveCustomers =
    usesConfiguredPublicUrl && !usesPrivateOrLocalHost && usesHttps;

  let warning = null;
  if (!usesConfiguredPublicUrl) {
    warning =
      'Set VITE_PUBLIC_APP_URL to your live app domain before printing this QR. Otherwise customers will scan into a local preview URL.';
  } else if (usesPrivateOrLocalHost) {
    warning =
      'This QR currently points to a local or private-network address. External customers will not be able to open it outside your machine or LAN.';
  } else if (!usesHttps) {
    warning =
      'Use an HTTPS app URL before going live. Browser notifications and customer access are more reliable on a secure origin.';
  }

  return {
    customerPortalUrl: buildCustomerPortalUrlFromBase(storeId, entryUrl),
    entryUrl: entryUrl.toString(),
    hostname,
    protocol,
    usesConfiguredPublicUrl,
    usesPrivateOrLocalHost,
    usesHttps,
    readyForLiveCustomers,
    warning,
  };
}
