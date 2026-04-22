import type { Customer, MerchantAuth, QueueSyncMode, Table } from '../types';

export interface QueueStoreState {
  customers: Customer[];
  tables: Table[];
  auth: MerchantAuth;
  isTablesConfigured: boolean;
  autoMode: boolean;
  nextQueueNumber: number;
  version: number;
}

interface PersistedCustomer extends Omit<Customer, 'joinTime' | 'callTime' | 'expiredAt'> {
  joinTime: string;
  callTime?: string;
  expiredAt?: string;
}

interface PersistedQueueStoreState extends Omit<QueueStoreState, 'customers'> {
  customers: PersistedCustomer[];
}

export const QUEUE_STORAGE_KEY = 'queueflow.store.v1';
export const ACTIVE_CUSTOMER_STORAGE_KEY = 'queueflow.active-customer.v1';
export const ACTIVE_CUSTOMER_TOKEN_STORAGE_KEY = 'queueflow.active-customer-token.v1';
export const CUSTOMER_ENTRY_TOKEN_STORAGE_KEY = 'queueflow.customer-entry-token.v1';
export const AUTH_TOKEN_STORAGE_KEY = 'queueflow.auth-token.v1';
export const CUSTOMER_SESSION_INVALIDATED_EVENT = 'queueflow:customer-session-invalidated';
export const REMOTE_QUEUE_PATH = '/queue-state';
export const REMOTE_SYNC_POLL_MS = 800;
export const DEFAULT_REMOTE_STORE_ID = 'RESTO-001';

const EMPTY_AUTH: MerchantAuth = {
  storeId: '',
  storeName: '',
  isLoggedIn: false,
};

function normalizeStorageScope(storeId?: string): string | null {
  if (typeof storeId !== 'string') {
    return null;
  }

  const normalized = storeId.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function dispatchCustomerSessionInvalidated(storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(CUSTOMER_SESSION_INVALIDATED_EVENT, {
      detail: {
        storeId: normalizeStorageScope(storeId),
      },
    })
  );
}

function deriveNextQueueNumber(customers: Customer[]): number {
  return customers.reduce((max, customer) => Math.max(max, customer.queueNumber), 0) + 1;
}

function hydrateCustomer(customer: PersistedCustomer): Customer {
  const joinTime = new Date(customer.joinTime);
  const expiredAt =
    customer.expiredAt
      ? new Date(customer.expiredAt)
      : customer.status === 'expired'
        ? joinTime
        : undefined;

  return {
    ...customer,
    source: customer.source === 'walk-in' ? 'walk-in' : 'online',
    joinTime,
    callTime: customer.callTime ? new Date(customer.callTime) : undefined,
    expiredAt,
  };
}

function serializeCustomer(customer: Customer): PersistedCustomer {
  return {
    ...customer,
    joinTime: customer.joinTime.toISOString(),
    callTime: customer.callTime?.toISOString(),
    expiredAt: customer.expiredAt?.toISOString(),
  };
}

export function createInitialQueueState(): QueueStoreState {
  return {
    customers: [],
    tables: [],
    auth: { ...EMPTY_AUTH },
    isTablesConfigured: false,
    autoMode: false,
    nextQueueNumber: 1,
    version: 1,
  };
}

export function getQueueStorageKey(scope = 'local'): string {
  return `${QUEUE_STORAGE_KEY}:${scope}`;
}

export function getActiveCustomerStorageKey(storeId?: string): string {
  const normalizedScope = normalizeStorageScope(storeId);
  return normalizedScope ? `${ACTIVE_CUSTOMER_STORAGE_KEY}:${normalizedScope}` : ACTIVE_CUSTOMER_STORAGE_KEY;
}

export function getActiveCustomerTokenStorageKey(storeId?: string): string {
  const normalizedScope = normalizeStorageScope(storeId);
  return normalizedScope
    ? `${ACTIVE_CUSTOMER_TOKEN_STORAGE_KEY}:${normalizedScope}`
    : ACTIVE_CUSTOMER_TOKEN_STORAGE_KEY;
}

export function getCustomerEntryTokenStorageKey(storeId?: string): string {
  const normalizedScope = normalizeStorageScope(storeId);
  return normalizedScope
    ? `${CUSTOMER_ENTRY_TOKEN_STORAGE_KEY}:${normalizedScope}`
    : CUSTOMER_ENTRY_TOKEN_STORAGE_KEY;
}

export function readAuthToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

export function readActiveCustomerId(storeId?: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(getActiveCustomerStorageKey(storeId));
}

export function writeActiveCustomerId(customerId: string, storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(getActiveCustomerStorageKey(storeId), customerId);
}

export function clearActiveCustomerId(storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(getActiveCustomerStorageKey(storeId));
  if (storeId) {
    window.localStorage.removeItem(ACTIVE_CUSTOMER_STORAGE_KEY);
  }
}

export function readActiveCustomerToken(storeId?: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(getActiveCustomerTokenStorageKey(storeId));
}

export function readCustomerEntryToken(storeId?: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(getCustomerEntryTokenStorageKey(storeId));
}

export function writeAuthToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export function writeActiveCustomerToken(token: string, storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(getActiveCustomerTokenStorageKey(storeId), token);
}

export function writeCustomerEntryToken(token: string, storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(getCustomerEntryTokenStorageKey(storeId), token);
}

export function clearActiveCustomerToken(storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(getActiveCustomerTokenStorageKey(storeId));
  if (storeId) {
    window.localStorage.removeItem(ACTIVE_CUSTOMER_TOKEN_STORAGE_KEY);
  }
}

export function clearCustomerEntryToken(storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(getCustomerEntryTokenStorageKey(storeId));
  if (storeId) {
    window.localStorage.removeItem(CUSTOMER_ENTRY_TOKEN_STORAGE_KEY);
  }
}

export function clearActiveCustomerSession(storeId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  clearActiveCustomerId(storeId);
  clearActiveCustomerToken(storeId);
  clearCustomerEntryToken(storeId);
  dispatchCustomerSessionInvalidated(storeId);
}

export function normalizeQueueState(
  rawState: Partial<PersistedQueueStoreState> | null | undefined
): QueueStoreState {
  const customers = Array.isArray(rawState?.customers)
    ? rawState.customers.map(customer => hydrateCustomer(customer as PersistedCustomer))
    : [];
  const tables = Array.isArray(rawState?.tables) ? (rawState.tables as Table[]) : [];
  const auth = rawState?.auth
    ? {
        storeId: typeof rawState.auth.storeId === 'string' ? rawState.auth.storeId : '',
        storeName: typeof rawState.auth.storeName === 'string' ? rawState.auth.storeName : '',
        isLoggedIn: Boolean(rawState.auth.isLoggedIn),
      }
    : { ...EMPTY_AUTH };
  const nextQueueNumber =
    typeof rawState?.nextQueueNumber === 'number' && rawState.nextQueueNumber > 0
      ? rawState.nextQueueNumber
      : deriveNextQueueNumber(customers);
  const version =
    typeof rawState?.version === 'number' && rawState.version > 0 ? rawState.version : 1;

  return {
    customers,
    tables,
    auth,
    isTablesConfigured: Boolean(rawState?.isTablesConfigured) && tables.length > 0,
    autoMode: Boolean(rawState?.autoMode),
    nextQueueNumber,
    version,
  };
}

export function serializeQueueState(state: QueueStoreState): PersistedQueueStoreState {
  return {
    ...state,
    customers: state.customers.map(serializeCustomer),
  };
}

export function readLocalQueueState(scope = 'local'): QueueStoreState {
  if (typeof window === 'undefined') {
    return createInitialQueueState();
  }

  try {
    const raw = window.localStorage.getItem(getQueueStorageKey(scope));
    if (!raw) {
      return createInitialQueueState();
    }

    return normalizeQueueState(JSON.parse(raw) as Partial<PersistedQueueStoreState>);
  } catch {
    return createInitialQueueState();
  }
}

export function writeLocalQueueState(state: QueueStoreState, scope = 'local'): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getQueueStorageKey(scope), JSON.stringify(serializeQueueState(state)));
  } catch {
    // Keep the app usable even if localStorage writes fail.
  }
}

export function resolveDefaultRemoteStoreId(): string {
  const storeId = import.meta.env.VITE_DEFAULT_STORE_ID;

  if (typeof storeId === 'string' && storeId.length > 0) {
    return storeId.toUpperCase();
  }

  return DEFAULT_REMOTE_STORE_ID;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();

  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }

  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }

  const private172Match = normalized.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (private172Match) {
    const secondOctet = Number.parseInt(private172Match[1] ?? '', 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

function shouldUseSameOriginRemoteApi(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const configuredMode = import.meta.env.VITE_QUEUE_SYNC_MODE;

  if (configuredMode === 'local') {
    return false;
  }

  if (configuredMode === 'remote') {
    return true;
  }

  return import.meta.env.PROD && !isPrivateOrLocalHostname(window.location.hostname);
}

export function resolveRemoteApiBaseUrl(): string | null {
  const configuredBaseUrl = import.meta.env.VITE_QUEUE_API_BASE_URL;

  if (typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim().length > 0) {
    return configuredBaseUrl.trim();
  }

  if (shouldUseSameOriginRemoteApi()) {
    return `${window.location.origin}/api`;
  }

  return null;
}

export function resolveQueueSyncMode(): QueueSyncMode {
  const mode = import.meta.env.VITE_QUEUE_SYNC_MODE;
  const apiBaseUrl = resolveRemoteApiBaseUrl();

  if (mode === 'local') {
    return 'local';
  }

  if (typeof apiBaseUrl === 'string' && apiBaseUrl.length > 0) {
    return 'remote';
  }

  return 'local';
}
