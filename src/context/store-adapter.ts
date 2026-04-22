import type {
  Customer,
  CustomerSource,
  MerchantAuth,
  MerchantPasswordUpdateInput,
  MerchantPlanCode,
  MerchantProfile,
  MerchantProfileUpdateInput,
  MerchantProvisioning,
  MerchantRegistrationInput,
  NotificationLog,
  QueueEvent,
  QueueJoinResult,
  QueueSyncMode,
  SyncStatus,
  Table,
} from '../types';
import { findBestTable } from '../utils/tableMatching';
import {
  clearActiveCustomerSession,
  clearCustomerEntryToken,
  clearAuthToken,
  createInitialQueueState,
  getQueueStorageKey,
  normalizeQueueState,
  readActiveCustomerToken,
  readCustomerEntryToken,
  readAuthToken,
  readLocalQueueState,
  REMOTE_SYNC_POLL_MS,
  resolveRemoteApiBaseUrl,
  resolveQueueSyncMode,
  serializeQueueState,
  type QueueStoreState,
  writeActiveCustomerToken,
  writeCustomerEntryToken,
  writeAuthToken,
  writeLocalQueueState,
} from './storage';
import { resolveInitialRemoteStoreId } from '../utils/portal';

const LOCAL_CREDENTIALS: Record<string, { password: string; storeName: string }> = {
  'RESTO-001': { password: 'admin123', storeName: 'The Grand Table' },
};

export type QueueFetchScope = 'public' | 'merchant';

interface RemoteLoginResponse {
  token: string;
  auth: MerchantAuth;
}

interface RemoteRegisterResponse extends RemoteLoginResponse {
  profile: MerchantProfile;
  provisioning: MerchantProvisioning;
}

interface MerchantProfileResponse {
  profile: MerchantProfile;
}

interface RemoteBillingLinkResponse {
  url: string;
}

interface QueueStateResponse {
  error?: string;
  state: QueueStoreState;
}

interface QueueJoinResponse extends QueueStateResponse {
  customer: Customer | null;
  customerToken?: string | null;
  recovered?: boolean;
}

interface CustomerSessionValidationResponse {
  valid: boolean;
  customerId: string;
  status: Customer['status'];
}

interface CustomerEntrySessionResponse {
  token: string;
  expiresAt: string;
}

interface QueueActionResult {
  state: QueueStoreState;
}

const REMOTE_SERVER_UNREACHABLE_MESSAGE =
  'Queue server is unreachable. Start the remote queue server and try again.';
const EXPIRED_CUSTOMER_RETENTION_MS = 1000 * 60 * 5;

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function isInQueue(status: Customer['status']): boolean {
  return status === 'waiting' || status === 'called' || status === 'confirmed';
}

function withNextVersion(state: QueueStoreState, partial: Omit<QueueStoreState, 'version'>): QueueStoreState {
  return {
    ...partial,
    version: state.version + 1,
  };
}

function sortTablesForAutoMode(tables: Table[]): Table[] {
  return [...tables].sort((left, right) => {
    if (left.capacity !== right.capacity) {
      return left.capacity - right.capacity;
    }

    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function getExpiredCustomerAgeMs(customer: Customer, nowMs: number): number | null {
  if (!customer.expiredAt) {
    return null;
  }

  const expiredAtMs = customer.expiredAt.getTime();
  if (!Number.isFinite(expiredAtMs)) {
    return null;
  }

  return nowMs - expiredAtMs;
}

function releaseCustomerTables(tables: Table[], customerId: string): Table[] {
  return tables.map(table =>
    table.assignedCustomerId === customerId
      ? { ...table, status: 'available', assignedCustomerId: undefined }
      : table
  );
}

function addTableState(state: QueueStoreState, capacity: number): QueueStoreState {
  const nextIndex = state.tables.length + 1;
  const newTable: Table = {
    id: generateId(),
    name: `T-${String(nextIndex).padStart(2, '0')}`,
    capacity,
    status: 'available',
  };
  return withNextVersion(state, {
    ...state,
    tables: [...state.tables, newTable],
    isTablesConfigured: true,
  });
}

function removeTableState(state: QueueStoreState, tableId: string): QueueStoreState {
  const table = state.tables.find(t => t.id === tableId);
  if (!table || table.status !== 'available') {
    return state;
  }
  const filtered = state.tables.filter(t => t.id !== tableId);
  return withNextVersion(state, {
    ...state,
    tables: filtered,
    isTablesConfigured: filtered.length > 0,
  });
}

function markTableCleaningState(state: QueueStoreState, tableId: string): QueueStoreState {
  const table = state.tables.find(t => t.id === tableId);
  if (!table || table.status === 'cleaning') {
    return state;
  }
  let customers = state.customers;
  if (table.assignedCustomerId) {
    customers = state.customers.filter(c => c.id !== table.assignedCustomerId);
  }
  return withNextVersion(state, {
    ...state,
    customers,
    tables: state.tables.map(t =>
      t.id === tableId ? { ...t, status: 'cleaning' as const, assignedCustomerId: undefined } : t
    ),
  });
}

function markTableAvailableState(state: QueueStoreState, tableId: string): QueueStoreState {
  const table = state.tables.find(t => t.id === tableId);
  if (!table || table.status !== 'cleaning') {
    return state;
  }
  return withNextVersion(state, {
    ...state,
    tables: state.tables.map(t =>
      t.id === tableId ? { ...t, status: 'available' as const, assignedCustomerId: undefined } : t
    ),
  });
}

function removeCustomerFromState(state: QueueStoreState, customerId: string): QueueStoreState {
  const exists = state.customers.some(customer => customer.id === customerId);
  if (!exists) {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.filter(customer => customer.id !== customerId),
    tables: releaseCustomerTables(state.tables, customerId),
  });
}

function configureTablesState(state: QueueStoreState, tables: Table[]): QueueStoreState {
  return withNextVersion(state, {
    ...state,
    tables,
    isTablesConfigured: tables.length > 0,
  });
}

function clearQueueState(state: QueueStoreState): QueueStoreState {
  return withNextVersion(state, {
    ...state,
    customers: [],
    tables: state.tables.map(table => ({
      ...table,
      status: 'available',
      assignedCustomerId: undefined,
    })),
    nextQueueNumber: 1,
  });
}

function releaseTableState(state: QueueStoreState, tableId: string): QueueStoreState {
  const table = state.tables.find(entry => entry.id === tableId);
  if (!table || table.status === 'available') {
    return state;
  }

  let customers = state.customers;
  if (table.assignedCustomerId) {
    if (table.status === 'reserved') {
      // Table was held for a called customer — put customer back to waiting
      customers = state.customers.map(customer => {
        if (customer.id !== table.assignedCustomerId) {
          return customer;
        }
        return {
          ...customer,
          status: 'waiting' as const,
          callTime: undefined,
          expiredAt: undefined,
          assignedTableId: undefined,
        };
      });
    } else {
      // Table was occupied — customer is done, remove from active queue
      customers = state.customers.filter(
        customer => customer.id !== table.assignedCustomerId
      );
    }
  }

  return withNextVersion(state, {
    ...state,
    customers,
    tables: state.tables.map(entry =>
      entry.id === tableId
        ? { ...entry, status: 'available', assignedCustomerId: undefined }
        : entry
    ),
  });
}

function requeueCustomerState(state: QueueStoreState, customerId: string): QueueStoreState {
  const customer = state.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status === 'waiting' || customer.status === 'seated') {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.map(entry =>
      entry.id === customerId
        ? {
            ...entry,
            status: 'waiting' as const,
            callTime: undefined,
            expiredAt: undefined,
            assignedTableId: undefined,
          }
        : entry
    ),
    tables: releaseCustomerTables(state.tables, customerId),
  });
}

function addCustomerState(
  state: QueueStoreState,
  phone: string,
  partySize: number,
  email?: string,
  options?: {
    name?: string;
    source?: CustomerSource;
  }
): { state: QueueStoreState; customer: Customer | null } {
  const normalizedPhone = typeof phone === 'string' ? phone : '';
  const existing =
    normalizedPhone.length > 0
      ? state.customers.find(customer => customer.phone === normalizedPhone && isInQueue(customer.status))
      : undefined;

  if (existing) {
    return { state, customer: existing };
  }

  const customer: Customer = {
    id: generateId(),
    phone: normalizedPhone,
    email,
    name: options?.name?.trim() ? options.name.trim() : undefined,
    source: options?.source === 'walk-in' ? 'walk-in' : 'online',
    partySize,
    queueNumber: state.nextQueueNumber,
    status: 'waiting',
    joinTime: new Date(),
  };

  return {
    customer,
    state: withNextVersion(state, {
      ...state,
      customers: [...state.customers, customer],
      nextQueueNumber: state.nextQueueNumber + 1,
    }),
  };
}

function callCustomerState(
  state: QueueStoreState,
  customerId: string,
  tableId?: string
): QueueStoreState {
  const customer = state.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status !== 'waiting') {
    return state;
  }

  const table = tableId
    ? state.tables.find(
        entry =>
          entry.id === tableId &&
          entry.status === 'available' &&
          entry.capacity >= customer.partySize
      ) ?? null
    : findBestTable(customer.partySize, state.tables);
  if (!table) {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.map(entry =>
      entry.id === customerId
        ? {
            ...entry,
            status: 'called',
            callTime: new Date(),
            expiredAt: undefined,
            assignedTableId: table.id,
          }
        : entry
    ),
    tables: state.tables.map(entry =>
      entry.id === table.id
        ? { ...entry, status: 'reserved', assignedCustomerId: customerId }
        : entry
    ),
  });
}

function confirmArrivalState(state: QueueStoreState, customerId: string): QueueStoreState {
  const customer = state.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status !== 'called') {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.map(entry =>
      entry.id === customerId ? { ...entry, status: 'confirmed', expiredAt: undefined } : entry
    ),
    tables: state.tables.map(table =>
      table.assignedCustomerId === customerId ? { ...table, status: 'occupied' } : table
    ),
  });
}

function seatCustomerState(state: QueueStoreState, customerId: string): QueueStoreState {
  const customer = state.customers.find(entry => entry.id === customerId);
  const canSeatDirectly =
    customer?.status === 'confirmed' ||
    (customer?.status === 'called' && customer.source === 'walk-in');
  if (!customer || !canSeatDirectly) {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.map(entry =>
      entry.id === customerId ? { ...entry, status: 'seated', expiredAt: undefined } : entry
    ),
    tables: state.tables.map(table =>
      table.assignedCustomerId === customerId ? { ...table, status: 'occupied' } : table
    ),
  });
}

function expireCustomerState(state: QueueStoreState, customerId: string): QueueStoreState {
  const customer = state.customers.find(entry => entry.id === customerId);
  if (!customer || (customer.status !== 'called' && customer.status !== 'confirmed')) {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    customers: state.customers.map(entry =>
      entry.id === customerId
        ? {
            ...entry,
            status: 'expired',
            callTime: undefined,
            expiredAt: new Date(),
            assignedTableId: undefined,
          }
        : entry
    ),
    tables: releaseCustomerTables(state.tables, customerId),
  });
}

function setAutoModeState(state: QueueStoreState, enabled: boolean): QueueStoreState {
  if (state.autoMode === enabled) {
    return state;
  }

  return withNextVersion(state, {
    ...state,
    autoMode: enabled,
  });
}

function pruneExpiredCustomersState(
  state: QueueStoreState,
  nowMs = Date.now()
): QueueStoreState {
  const expiredCustomerIds = state.customers
    .filter(customer => customer.status === 'expired')
    .filter(customer => {
      const ageMs = getExpiredCustomerAgeMs(customer, nowMs);
      return ageMs !== null && ageMs >= EXPIRED_CUSTOMER_RETENTION_MS;
    })
    .map(customer => customer.id);

  if (expiredCustomerIds.length === 0) {
    return state;
  }

  return expiredCustomerIds.reduce(
    (nextState, customerId) => removeCustomerFromState(nextState, customerId),
    state
  );
}

function applyAutomaticQueueState(state: QueueStoreState): QueueStoreState {
  let nextState = pruneExpiredCustomersState(state);

  if (!nextState.autoMode) {
    return nextState;
  }

  while (true) {
    const availableTables = sortTablesForAutoMode(
      nextState.tables.filter(table => table.status === 'available')
    );
    const waitingCustomers = [...nextState.customers]
      .filter(customer => customer.status === 'waiting')
      .sort((left, right) => left.queueNumber - right.queueNumber);

    let matched = false;

    for (const table of availableTables) {
      const candidate = waitingCustomers.find(customer => customer.partySize <= table.capacity);
      if (!candidate) {
        continue;
      }

      const updatedState = callCustomerState(nextState, candidate.id, table.id);
      if (updatedState === nextState) {
        continue;
      }

      nextState = updatedState;
      matched = true;
      break;
    }

    if (!matched) {
      return nextState;
    }
  }
}

function sanitizeCustomerForPublic(customer: Customer): Customer {
  return {
    ...customer,
    phone: '',
    email: undefined,
    name: undefined,
  };
}

function sanitizePublicState(state: QueueStoreState): QueueStoreState {
  return {
    ...state,
    customers: state.customers.map(sanitizeCustomerForPublic),
    auth: {
      storeId: state.auth.storeId,
      storeName: state.auth.storeName,
      isLoggedIn: false,
    },
  };
}

function sanitizeCachedRemoteState(state: QueueStoreState): QueueStoreState {
  return {
    ...state,
    auth: {
      storeId: state.auth.storeId,
      storeName: state.auth.storeName,
      isLoggedIn: false,
    },
  };
}

function writeRemoteQueueCacheIfNewer(state: QueueStoreState, storeId: string): void {
  const remoteScope = getRemoteScope(storeId);
  const cachedState = readLocalQueueState(remoteScope);

  if (cachedState.version > state.version) {
    return;
  }

  writeLocalQueueState(state, remoteScope);
}

function parseErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }

  return fallback;
}

function isInvalidCustomerSessionStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

function formatRemoteActionError(
  scope: QueueFetchScope,
  status: number,
  payload: unknown
): string {
  const parsedError = parseErrorMessage(payload, '');

  if (scope === 'public' && isInvalidCustomerSessionStatus(status)) {
    return 'Your queue session is no longer valid. Reopen the latest queue page to continue.';
  }

  if (
    scope === 'merchant' &&
    status === 404 &&
    (!parsedError || parsedError === 'Not found' || parsedError === 'Store not found')
  ) {
    return 'This queue item is no longer available. Refresh and try again.';
  }

  return parsedError || `Remote queue action failed with ${status}`;
}

function normalizeRemoteFetchError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message !== 'Failed to fetch'
  ) {
    return error;
  }

  return new Error(REMOTE_SERVER_UNREACHABLE_MESSAGE);
}

export interface QueueStoreAdapter {
  mode: QueueSyncMode;
  getInitialState: (storeId?: string) => QueueStoreState;
  hydrate: (storeId?: string, scope?: QueueFetchScope) => Promise<QueueStoreState>;
  persist: (state: QueueStoreState) => Promise<void>;
  subscribe: (
    storeId: string | undefined,
    scope: QueueFetchScope,
    onChange: (state: QueueStoreState) => void,
    onSyncStatus?: (status: SyncStatus) => void
  ) => () => void;
  login: (storeId: string, password: string) => Promise<MerchantAuth | null>;
  registerMerchant: (input: MerchantRegistrationInput) => Promise<{
    auth: MerchantAuth;
    profile: MerchantProfile;
    provisioning: MerchantProvisioning;
  }>;
  restoreAuth: () => Promise<MerchantAuth | null>;
  logout: (auth: MerchantAuth) => Promise<void>;
  fetchMerchantProfile: (auth: MerchantAuth) => Promise<MerchantProfile | null>;
  updateMerchantProfile: (
    auth: MerchantAuth,
    input: MerchantProfileUpdateInput
  ) => Promise<MerchantProfile | null>;
  updateMerchantPassword: (
    auth: MerchantAuth,
    input: MerchantPasswordUpdateInput
  ) => Promise<void>;
  startSubscriptionCheckout: (
    auth: MerchantAuth,
    planCode?: MerchantPlanCode
  ) => Promise<string>;
  openBillingPortal: (auth: MerchantAuth) => Promise<string>;
  sendTestNotificationEmail: (auth: MerchantAuth, recipient?: string) => Promise<void>;
  setTables: (state: QueueStoreState, tables: Table[]) => Promise<QueueStoreState>;
  addTable: (state: QueueStoreState, capacity: number) => Promise<QueueStoreState>;
  removeTable: (state: QueueStoreState, tableId: string) => Promise<QueueStoreState>;
  markTableCleaning: (state: QueueStoreState, tableId: string) => Promise<QueueStoreState>;
  markTableAvailable: (state: QueueStoreState, tableId: string) => Promise<QueueStoreState>;
  releaseTable: (state: QueueStoreState, tableId: string) => Promise<QueueStoreState>;
  resetQueue: (state: QueueStoreState) => Promise<QueueStoreState>;
  setAutoMode: (state: QueueStoreState, enabled: boolean) => Promise<QueueStoreState>;
  addCustomer: (
    state: QueueStoreState,
    phone: string,
    partySize: number,
    email?: string
  ) => Promise<{ state: QueueStoreState; result: QueueJoinResult }>;
  addWalkInCustomer: (
    state: QueueStoreState,
    partySize: number,
    name?: string
  ) => Promise<{ state: QueueStoreState; result: QueueJoinResult }>;
  prepareCustomerEntry: (state: QueueStoreState) => Promise<void>;
  callCustomer: (
    state: QueueStoreState,
    customerId: string,
    tableId?: string
  ) => Promise<QueueStoreState>;
  confirmArrival: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  seatCustomer: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  expireCustomer: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  requeueCustomer: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  leaveQueue: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  removeCustomer: (state: QueueStoreState, customerId: string) => Promise<QueueStoreState>;
  fetchNotificationLogs: (state: QueueStoreState, limit?: number) => Promise<NotificationLog[]>;
  fetchQueueEvents: (state: QueueStoreState, limit?: number) => Promise<QueueEvent[]>;
  validateCustomerSession: (state: QueueStoreState, customerId: string) => Promise<boolean>;
}

function getRemoteScope(storeId: string): string {
  return `remote:${storeId.toUpperCase()}`;
}

class LocalQueueStoreAdapter implements QueueStoreAdapter {
  mode: QueueSyncMode = 'local';

  getInitialState(): QueueStoreState {
    return applyAutomaticQueueState(readLocalQueueState());
  }

  async hydrate(): Promise<QueueStoreState> {
    return applyAutomaticQueueState(readLocalQueueState());
  }

  async persist(state: QueueStoreState): Promise<void> {
    writeLocalQueueState(state);
  }

  subscribe(
    _: string | undefined,
    __: QueueFetchScope,
    onChange: (state: QueueStoreState) => void,
    onSyncStatus?: (status: SyncStatus) => void
  ): () => void {
    if (typeof window === 'undefined') {
      return () => undefined;
    }

    const localKey = getQueueStorageKey('local');
    onSyncStatus?.('connected');

    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== localKey) {
        return;
      }

      onSyncStatus?.('connected');
      onChange(event.newValue ? readLocalQueueState() : createInitialQueueState());
    };

    window.addEventListener('storage', syncFromStorage);
    return () => window.removeEventListener('storage', syncFromStorage);
  }

  async login(storeId: string, password: string): Promise<MerchantAuth | null> {
    const normalizedStoreId = storeId.toUpperCase();
    const credentials = LOCAL_CREDENTIALS[normalizedStoreId];

    if (!credentials || credentials.password !== password) {
      return null;
    }

    return {
      storeId: normalizedStoreId,
      storeName: credentials.storeName,
      isLoggedIn: true,
    };
  }

  async registerMerchant(): Promise<{
    auth: MerchantAuth;
    profile: MerchantProfile;
    provisioning: MerchantProvisioning;
  }> {
    throw new Error('Merchant onboarding is only available in remote mode.');
  }

  async restoreAuth(): Promise<MerchantAuth | null> {
    return null;
  }

  async logout(): Promise<void> {
    // Local mode has no remote session to revoke.
  }

  async fetchMerchantProfile(auth: MerchantAuth): Promise<MerchantProfile | null> {
    if (!auth.isLoggedIn) {
      return null;
    }

    const nowIso = new Date().toISOString();
    return {
      storeId: auth.storeId,
      storeName: auth.storeName,
      ownerName: 'Local Merchant',
      ownerEmail: 'local-demo@queueflow.local',
      contactPhone: '',
      planCode: 'starter',
      subscriptionStatus: 'active',
      billingCycle: 'device',
      onboardingStatus: 'local-demo',
      qrIssuedAt: nowIso,
      createdAt: nowIso,
      activatedAt: nowIso,
      trialEndsAt: null,
      updatedAt: nowIso,
      billing: {
        provider: 'none',
        checkoutEnabled: false,
        portalEnabled: false,
        customerId: null,
        subscriptionId: null,
        priceId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        lastInvoiceStatus: null,
        lastCheckoutAt: null,
        plans: {
          starter: {
            planCode: 'starter',
            label: 'Starter',
            description: 'QueueFlow Starter monthly subscription',
            amount: 4900,
            currency: 'usd',
            interval: 'month',
          },
          growth: {
            planCode: 'growth',
            label: 'Growth',
            description: 'QueueFlow Growth monthly subscription',
            amount: 9900,
            currency: 'usd',
            interval: 'month',
          },
          scale: {
            planCode: 'scale',
            label: 'Scale',
            description: 'QueueFlow Scale monthly subscription',
            amount: 19900,
            currency: 'usd',
            interval: 'month',
          },
        },
        config: {
          configured: false,
          missingEnv: [],
        },
      },
      notifications: {
        provider: 'disabled',
        deliveryEnabled: false,
        fromAddress: null,
        config: {
          configured: false,
          missingEnv: [],
        },
      },
    };
  }

  async updateMerchantProfile(auth: MerchantAuth, input: MerchantProfileUpdateInput): Promise<MerchantProfile | null> {
    const currentProfile = await this.fetchMerchantProfile(auth);
    if (!currentProfile) {
      return null;
    }

    return {
      ...currentProfile,
      storeName: input.storeName?.trim() || currentProfile.storeName,
      ownerName: input.ownerName?.trim() || currentProfile.ownerName,
      ownerEmail: input.ownerEmail?.trim().toLowerCase() || currentProfile.ownerEmail,
      contactPhone: typeof input.contactPhone === 'string' ? input.contactPhone.trim() : currentProfile.contactPhone,
      planCode: input.planCode ?? currentProfile.planCode,
      subscriptionStatus: input.subscriptionStatus ?? currentProfile.subscriptionStatus,
      billingCycle: input.billingCycle?.trim().toLowerCase() || currentProfile.billingCycle,
      updatedAt: new Date().toISOString(),
    };
  }

  async updateMerchantPassword(): Promise<void> {
    throw new Error('Password changes are only available in remote mode.');
  }

  async startSubscriptionCheckout(): Promise<string> {
    throw new Error('Billing checkout is only available in remote mode.');
  }

  async openBillingPortal(): Promise<string> {
    throw new Error('Billing portal is only available in remote mode.');
  }

  async sendTestNotificationEmail(): Promise<void> {
    throw new Error('Notification email testing is only available in remote mode.');
  }

  async setTables(state: QueueStoreState, tables: Table[]): Promise<QueueStoreState> {
    return applyAutomaticQueueState(configureTablesState(state, tables));
  }

  async addTable(state: QueueStoreState, capacity: number): Promise<QueueStoreState> {
    return applyAutomaticQueueState(addTableState(state, capacity));
  }

  async removeTable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    return removeTableState(state, tableId);
  }

  async markTableCleaning(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    return markTableCleaningState(state, tableId);
  }

  async markTableAvailable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(markTableAvailableState(state, tableId));
  }

  async releaseTable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(releaseTableState(state, tableId));
  }

  async resetQueue(state: QueueStoreState): Promise<QueueStoreState> {
    return clearQueueState(state);
  }

  async setAutoMode(state: QueueStoreState, enabled: boolean): Promise<QueueStoreState> {
    return applyAutomaticQueueState(setAutoModeState(state, enabled));
  }

  async addCustomer(
    state: QueueStoreState,
    phone: string,
    partySize: number,
    email?: string
  ): Promise<{ state: QueueStoreState; result: QueueJoinResult }> {
    const result = addCustomerState(state, phone, partySize, email);
    return {
      state: applyAutomaticQueueState(result.state),
      result: {
        customer: result.customer,
        recovered: result.customer ? result.state === state : false,
      },
    };
  }

  async addWalkInCustomer(
    state: QueueStoreState,
    partySize: number,
    name?: string
  ): Promise<{ state: QueueStoreState; result: QueueJoinResult }> {
    const result = addCustomerState(state, '', partySize, undefined, {
      name,
      source: 'walk-in',
    });
    return {
      state: applyAutomaticQueueState(result.state),
      result: {
        customer: result.customer,
        recovered: false,
      },
    };
  }

  async prepareCustomerEntry(): Promise<void> {
    return;
  }

  async callCustomer(
    state: QueueStoreState,
    customerId: string,
    tableId?: string
  ): Promise<QueueStoreState> {
    return callCustomerState(state, customerId, tableId);
  }

  async confirmArrival(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return confirmArrivalState(state, customerId);
  }

  async seatCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return seatCustomerState(state, customerId);
  }

  async expireCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(expireCustomerState(state, customerId));
  }

  async requeueCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(requeueCustomerState(state, customerId));
  }

  async leaveQueue(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(removeCustomerFromState(state, customerId));
  }

  async removeCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    return applyAutomaticQueueState(removeCustomerFromState(state, customerId));
  }

  async fetchNotificationLogs(): Promise<NotificationLog[]> {
    // Local mode has no notification logs backend.
    return [];
  }

  async fetchQueueEvents(): Promise<QueueEvent[]> {
    // Local mode has no persistent activity feed.
    return [];
  }

  async validateCustomerSession(state: QueueStoreState, customerId: string): Promise<boolean> {
    return state.customers.some(customer => customer.id === customerId);
  }
}

class RemoteQueueStoreAdapter implements QueueStoreAdapter {
  mode: QueueSyncMode = 'remote';
  private readonly baseUrl: string;
  private readonly fallbackStoreId: string;
  private syncStatusListener?: (status: SyncStatus) => void;

  constructor(baseUrl: string, fallbackStoreId: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.fallbackStoreId = fallbackStoreId.toUpperCase();
  }

  getInitialState(storeId?: string): QueueStoreState {
    return readLocalQueueState(getRemoteScope(this.resolveStoreId(storeId)));
  }

  async hydrate(storeId?: string, scope: QueueFetchScope = 'public'): Promise<QueueStoreState> {
    const resolvedStoreId = this.resolveStoreId(storeId);

    try {
      const state = await this.fetchRemoteState(resolvedStoreId, scope);
      writeRemoteQueueCacheIfNewer(state, resolvedStoreId);
      return state;
    } catch {
      return readLocalQueueState(getRemoteScope(resolvedStoreId));
    }
  }

  async persist(state: QueueStoreState): Promise<void> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    writeLocalQueueState(sanitizeCachedRemoteState(state), getRemoteScope(resolvedStoreId));
  }

  subscribe(
    storeId: string | undefined,
    scope: QueueFetchScope,
    onChange: (state: QueueStoreState) => void,
    onSyncStatus?: (status: SyncStatus) => void
  ): () => void {
    if (typeof window === 'undefined') {
      return () => undefined;
    }

    this.syncStatusListener = onSyncStatus;

    const resolvedStoreId = this.resolveStoreId(storeId);
    const remoteScope = getRemoteScope(resolvedStoreId);
    const remoteKey = getQueueStorageKey(remoteScope);
    let lastSnapshot = JSON.stringify(serializeQueueState(readLocalQueueState(remoteScope)));
    let isPolling = false;

    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== remoteKey) {
        return;
      }

      this.syncStatusListener?.('connected');
      onChange(event.newValue ? readLocalQueueState(remoteScope) : createInitialQueueState());
    };

    const poll = async () => {
      if (isPolling) {
        return;
      }

      isPolling = true;

      try {
        const state = await this.fetchRemoteState(resolvedStoreId, scope);
        const cachedState = readLocalQueueState(remoteScope);

        if (state.version < cachedState.version) {
          this.syncStatusListener?.('connected');
          return;
        }

        const snapshot = JSON.stringify(serializeQueueState(state));

        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          writeLocalQueueState(state, remoteScope);
          onChange(state);
        }

        this.syncStatusListener?.('connected');
      } catch {
        // Keep the last good cached state if the backend is unavailable.
        this.syncStatusListener?.('offline');
      } finally {
        isPolling = false;
      }
    };

    const syncOnFocus = () => {
      void poll();
    };

    const syncOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };

    window.addEventListener('storage', syncFromStorage);
    window.addEventListener('focus', syncOnFocus);
    document.addEventListener('visibilitychange', syncOnVisibility);
    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, REMOTE_SYNC_POLL_MS);

    return () => {
      if (this.syncStatusListener === onSyncStatus) {
        this.syncStatusListener = undefined;
      }

      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener('focus', syncOnFocus);
      document.removeEventListener('visibilitychange', syncOnVisibility);
      window.clearInterval(interval);
    };
  }

  async login(storeId: string, password: string): Promise<MerchantAuth | null> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ storeId: storeId.toUpperCase(), password }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as RemoteLoginResponse;
      writeAuthToken(payload.token);
      return payload.auth;
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async registerMerchant(input: MerchantRegistrationInput): Promise<{
    auth: MerchantAuth;
    profile: MerchantProfile;
    provisioning: MerchantProvisioning;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/merchant/register`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      const payload = (await response.json().catch(() => null)) as RemoteRegisterResponse | null;
      if (!response.ok || !payload?.auth || !payload.profile || !payload.provisioning) {
        throw new Error(parseErrorMessage(payload, `Merchant registration failed with ${response.status}`));
      }

      writeAuthToken(payload.token);
      return {
        auth: payload.auth,
        profile: payload.profile,
        provisioning: payload.provisioning,
      };
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async restoreAuth(): Promise<MerchantAuth | null> {
    const token = readAuthToken();
    if (!token) {
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/session`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        clearAuthToken();
        return null;
      }

      const payload = (await response.json()) as { auth: MerchantAuth };
      return payload.auth;
    } catch {
      return null;
    }
  }

  async logout(auth: MerchantAuth): Promise<void> {
    const token = readAuthToken();

    try {
      if (token) {
        await fetch(`${this.baseUrl}/auth/logout`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ storeId: auth.storeId }),
        });
      }
    } finally {
      clearAuthToken();
    }
  }

  async fetchMerchantProfile(auth: MerchantAuth): Promise<MerchantProfile | null> {
    if (!auth.isLoggedIn || !auth.storeId) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/profile`,
        {
          method: 'GET',
          headers: this.getRequestHeaders({ includeAuth: true }),
        }
      );

      const payload = (await response.json().catch(() => null)) as MerchantProfileResponse | null;
      if (!response.ok || !payload?.profile) {
        if (response.status === 404) {
          return null;
        }

        throw new Error(parseErrorMessage(payload, `Merchant profile fetch failed with ${response.status}`));
      }

      return payload.profile;
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async updateMerchantProfile(
    auth: MerchantAuth,
    input: MerchantProfileUpdateInput
  ): Promise<MerchantProfile | null> {
    if (!auth.isLoggedIn || !auth.storeId) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/profile`,
        {
          method: 'POST',
          headers: this.getRequestHeaders({ includeAuth: true }),
          body: JSON.stringify(input),
        }
      );

      const payload = (await response.json().catch(() => null)) as MerchantProfileResponse | null;
      if (!response.ok || !payload?.profile) {
        throw new Error(parseErrorMessage(payload, `Merchant profile update failed with ${response.status}`));
      }

      return payload.profile;
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async updateMerchantPassword(
    auth: MerchantAuth,
    input: MerchantPasswordUpdateInput
  ): Promise<void> {
    if (!auth.isLoggedIn || !auth.storeId) {
      return;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/password`,
        {
          method: 'POST',
          headers: this.getRequestHeaders({ includeAuth: true }),
          body: JSON.stringify(input),
        }
      );

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Password update failed with ${response.status}`));
      }
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async startSubscriptionCheckout(
    auth: MerchantAuth,
    planCode?: MerchantPlanCode
  ): Promise<string> {
    if (!auth.isLoggedIn || !auth.storeId) {
      throw new Error('Merchant login is required before starting billing.');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/billing/checkout`,
        {
          method: 'POST',
          headers: this.getRequestHeaders({ includeAuth: true }),
          body: JSON.stringify(planCode ? { planCode } : {}),
        }
      );

      const payload = (await response.json().catch(() => null)) as RemoteBillingLinkResponse | null;
      if (!response.ok || !payload?.url) {
        throw new Error(parseErrorMessage(payload, `Stripe checkout failed with ${response.status}`));
      }

      return payload.url;
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async openBillingPortal(auth: MerchantAuth): Promise<string> {
    if (!auth.isLoggedIn || !auth.storeId) {
      throw new Error('Merchant login is required before opening billing.');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/billing/portal`,
        {
          method: 'POST',
          headers: this.getRequestHeaders({ includeAuth: true }),
        }
      );

      const payload = (await response.json().catch(() => null)) as RemoteBillingLinkResponse | null;
      if (!response.ok || !payload?.url) {
        throw new Error(parseErrorMessage(payload, `Stripe billing portal failed with ${response.status}`));
      }

      return payload.url;
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async sendTestNotificationEmail(auth: MerchantAuth, recipient?: string): Promise<void> {
    if (!auth.isLoggedIn || !auth.storeId) {
      throw new Error('Merchant login is required before sending a test notification.');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(auth.storeId)}/notifications/test-email`,
        {
          method: 'POST',
          headers: this.getRequestHeaders({ includeAuth: true }),
          body: JSON.stringify(recipient ? { recipient } : {}),
        }
      );

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, `Test notification failed with ${response.status}`));
      }
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  async setTables(state: QueueStoreState, tables: Table[]): Promise<QueueStoreState> {
    return this.persistTables(state, tables);
  }

  async addTable(state: QueueStoreState, capacity: number): Promise<QueueStoreState> {
    const result = await this.postStateAction(state, 'merchant', '/tables/add', {
      capacity,
    });
    return result.state;
  }

  async removeTable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    const nextState = removeTableState(state, tableId);
    if (nextState === state) {
      return state;
    }

    return this.persistTables(state, nextState.tables);
  }

  async markTableCleaning(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    const nextState = markTableCleaningState(state, tableId);
    if (nextState === state) {
      return state;
    }

    return this.persistTables(state, nextState.tables);
  }

  async markTableAvailable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    const nextState = markTableAvailableState(state, tableId);
    if (nextState === state) {
      return state;
    }

    return this.persistTables(state, nextState.tables);
  }

  async releaseTable(state: QueueStoreState, tableId: string): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'merchant',
      `/tables/${encodeURIComponent(tableId)}/release`,
      {
        expectedVersion: state.version,
      }
    );
    return result.state;
  }

  async resetQueue(state: QueueStoreState): Promise<QueueStoreState> {
    const result = await this.postStateAction(state, 'merchant', '/clear-queue', {
      expectedVersion: state.version,
    });
    return result.state;
  }

  async setAutoMode(state: QueueStoreState, enabled: boolean): Promise<QueueStoreState> {
    const result = await this.postStateAction(state, 'merchant', '/auto-mode', {
      expectedVersion: state.version,
      enabled,
    });
    return result.state;
  }

  async addCustomer(
    state: QueueStoreState,
    phone: string,
    partySize: number,
    email?: string
  ): Promise<{ state: QueueStoreState; result: QueueJoinResult }> {
    const result = state.auth.isLoggedIn
      ? await this.postMerchantJoinAction(state, '/customers/manual', {
          phone,
          partySize,
          ...(email ? { email } : {}),
        })
      : await this.postJoinAction(state, '/customers/join', {
          phone,
          partySize,
          ...(email ? { email } : {}),
        });
    return {
      state: result.state,
      result: {
        customer: result.customer,
        recovered: Boolean(result.recovered),
      },
    };
  }

  async addWalkInCustomer(
    state: QueueStoreState,
    partySize: number,
    name?: string
  ): Promise<{ state: QueueStoreState; result: QueueJoinResult }> {
    const result = await this.postMerchantJoinAction(state, '/customers/walk-in', {
      partySize,
      ...(name?.trim() ? { name: name.trim() } : {}),
    });
    return {
      state: result.state,
      result: {
        customer: result.customer,
        recovered: false,
      },
    };
  }

  async prepareCustomerEntry(state: QueueStoreState): Promise<void> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    if (readActiveCustomerToken(resolvedStoreId)) {
      clearCustomerEntryToken(resolvedStoreId);
      return;
    }

    await this.issueCustomerEntrySession(resolvedStoreId);
  }

  async callCustomer(
    state: QueueStoreState,
    customerId: string,
    tableId?: string
  ): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'merchant',
      `/customers/${encodeURIComponent(customerId)}/call`,
      {
        expectedVersion: state.version,
        ...(tableId ? { tableId } : {}),
      }
    );
    return result.state;
  }

  async confirmArrival(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'public',
      `/customers/${encodeURIComponent(customerId)}/confirm`
    );
    return result.state;
  }

  async seatCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const scope: QueueFetchScope = state.auth.isLoggedIn ? 'merchant' : 'public';
    const result = await this.postStateAction(
      state,
      scope,
      `/customers/${encodeURIComponent(customerId)}/seat`
    );
    return result.state;
  }

  async expireCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const scope: QueueFetchScope = state.auth.isLoggedIn ? 'merchant' : 'public';
    const result = await this.postStateAction(
      state,
      scope,
      `/customers/${encodeURIComponent(customerId)}/expire`
    );
    return result.state;
  }

  async requeueCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'merchant',
      `/customers/${encodeURIComponent(customerId)}/requeue`,
      {
        expectedVersion: state.version,
      }
    );
    return result.state;
  }

  async leaveQueue(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'public',
      `/customers/${encodeURIComponent(customerId)}/leave`
    );
    clearActiveCustomerSession(this.resolveStoreId(state.auth.storeId));
    return result.state;
  }

  async removeCustomer(state: QueueStoreState, customerId: string): Promise<QueueStoreState> {
    const result = await this.postStateAction(
      state,
      'merchant',
      `/customers/${encodeURIComponent(customerId)}/remove`,
      {
        expectedVersion: state.version,
      }
    );
    return result.state;
  }

  async fetchNotificationLogs(state: QueueStoreState, limit = 50): Promise<NotificationLog[]> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    const url = `${this.baseUrl}/stores/${encodeURIComponent(resolvedStoreId)}/notification-logs?limit=${limit}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getRequestHeaders({ includeAuth: true }),
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as { logs: NotificationLog[] };
      return Array.isArray(payload.logs) ? payload.logs : [];
    } catch {
      return [];
    }
  }

  async fetchQueueEvents(state: QueueStoreState, limit = 100): Promise<QueueEvent[]> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    const url = `${this.baseUrl}/stores/${encodeURIComponent(resolvedStoreId)}/queue-events?limit=${limit}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getRequestHeaders({ includeAuth: true }),
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as { events: QueueEvent[] };
      return Array.isArray(payload.events) ? payload.events : [];
    } catch {
      return [];
    }
  }

  async validateCustomerSession(state: QueueStoreState, customerId: string): Promise<boolean> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    const normalizedCustomerId = customerId.trim();

    if (!normalizedCustomerId) {
      return false;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/stores/${encodeURIComponent(
          resolvedStoreId
        )}/customers/${encodeURIComponent(normalizedCustomerId)}/session`,
        {
          method: 'GET',
          headers: this.getRequestHeaders({
            includeCustomerToken: true,
            storeId: resolvedStoreId,
          }),
        }
      );

      if (!response.ok) {
        if (isInvalidCustomerSessionStatus(response.status)) {
          clearActiveCustomerSession(resolvedStoreId);
        }
        return false;
      }

      const payload =
        (await response.json().catch(() => null)) as CustomerSessionValidationResponse | null;
      return Boolean(payload?.valid && payload.customerId === normalizedCustomerId);
    } catch {
      return false;
    }
  }

  private resolveStoreId(storeId?: string): string {
    return (storeId && storeId.length > 0 ? storeId : this.fallbackStoreId).toUpperCase();
  }

  private getQueueStateEndpoint(storeId: string, scope: QueueFetchScope): string {
    const suffix = scope === 'merchant' ? '/queue-state' : '/public-queue-state';
    return `${this.baseUrl}/stores/${encodeURIComponent(storeId)}${suffix}`;
  }

  private getActionEndpoint(storeId: string, suffix: string): string {
    return `${this.baseUrl}/stores/${encodeURIComponent(storeId)}${suffix}`;
  }

  private async persistTables(
    state: QueueStoreState,
    tables: Table[]
  ): Promise<QueueStoreState> {
    const result = await this.postStateAction(state, 'merchant', '/tables/configure', {
      expectedVersion: state.version,
      tables,
    });
    return result.state;
  }

  private getRequestHeaders(options: {
    includeAuth?: boolean;
    includeCustomerToken?: boolean;
    includeEntryToken?: boolean;
    entryTokenOverride?: string | null;
    storeId?: string;
  } = {}): HeadersInit {
    const token = options.includeAuth ? readAuthToken() : null;
    const customerToken = options.includeCustomerToken
      ? readActiveCustomerToken(this.resolveStoreId(options.storeId))
      : null;
    const entryToken = options.includeEntryToken
      ? (options.entryTokenOverride ??
        readCustomerEntryToken(this.resolveStoreId(options.storeId)))
      : null;

    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(customerToken ? { 'X-Queue-Customer-Token': customerToken } : {}),
      ...(entryToken ? { 'X-Queue-Entry-Token': entryToken } : {}),
    };
  }

  private async fetchRemoteState(storeId: string, scope: QueueFetchScope): Promise<QueueStoreState> {
    const merchantToken = readAuthToken();
    try {
      const response = await fetch(this.getQueueStateEndpoint(storeId, scope), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(scope === 'merchant' && merchantToken ? { Authorization: `Bearer ${merchantToken}` } : {}),
        },
      });

      if (!response.ok) {
        throw new Error(`Remote queue state fetch failed with ${response.status}`);
      }

      return normalizeQueueState((await response.json()) as Record<string, unknown>);
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  private async postStateAction(
    state: QueueStoreState,
    scope: QueueFetchScope,
    suffix: string,
    body?: Record<string, unknown>
  ): Promise<QueueActionResult> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);

    try {
      const response = await fetch(this.getActionEndpoint(resolvedStoreId, suffix), {
        method: 'POST',
        headers: this.getRequestHeaders({
          includeAuth: scope === 'merchant',
          includeCustomerToken: scope === 'public',
          storeId: resolvedStoreId,
        }),
        body: body ? JSON.stringify(body) : undefined,
      });

      const payload = (await response.json().catch(() => null)) as QueueStateResponse | null;

      if (response.status === 409 && payload?.state) {
        const conflictState = normalizeQueueState(payload.state as unknown as Record<string, unknown>);
        writeRemoteQueueCacheIfNewer(conflictState, resolvedStoreId);
        this.syncStatusListener?.('connected');
        return { state: conflictState };
      }

      if (!response.ok || !payload?.state) {
        if (scope === 'public' && isInvalidCustomerSessionStatus(response.status)) {
          clearActiveCustomerSession(resolvedStoreId);
        }

        throw new Error(formatRemoteActionError(scope, response.status, payload));
      }

      const nextState = normalizeQueueState(payload.state as unknown as Record<string, unknown>);
      writeRemoteQueueCacheIfNewer(nextState, resolvedStoreId);
      this.syncStatusListener?.('connected');
      return { state: nextState };
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  private async postJoinAction(
    state: QueueStoreState,
    suffix: string,
    body: Record<string, unknown>
  ): Promise<QueueJoinResponse> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    const customerToken = readActiveCustomerToken(resolvedStoreId);
    let entryToken = readCustomerEntryToken(resolvedStoreId);
    try {
      if (!customerToken && !entryToken) {
        entryToken = await this.issueCustomerEntrySession(resolvedStoreId);
      }

      let response = await fetch(this.getActionEndpoint(resolvedStoreId, suffix), {
        method: 'POST',
        headers: this.getRequestHeaders({
          includeCustomerToken: true,
          includeEntryToken: true,
          entryTokenOverride: entryToken,
          storeId: resolvedStoreId,
        }),
        body: JSON.stringify(body),
      });

      let payload = (await response.json().catch(() => null)) as QueueJoinResponse | null;

      if (!response.ok && !customerToken && (response.status === 401 || response.status === 410)) {
        clearCustomerEntryToken(resolvedStoreId);
        entryToken = await this.issueCustomerEntrySession(resolvedStoreId);
        response = await fetch(this.getActionEndpoint(resolvedStoreId, suffix), {
          method: 'POST',
          headers: this.getRequestHeaders({
            includeCustomerToken: true,
            includeEntryToken: true,
            entryTokenOverride: entryToken,
            storeId: resolvedStoreId,
          }),
          body: JSON.stringify(body),
        });
        payload = (await response.json().catch(() => null)) as QueueJoinResponse | null;
      }

      if (!response.ok || !payload?.state) {
        throw new Error(parseErrorMessage(payload, `Remote queue join failed with ${response.status}`));
      }

      const nextState = normalizeQueueState(payload.state as unknown as Record<string, unknown>);
      writeRemoteQueueCacheIfNewer(nextState, resolvedStoreId);
      clearCustomerEntryToken(resolvedStoreId);

      if (payload.customerToken) {
        writeActiveCustomerToken(payload.customerToken, resolvedStoreId);
      }

      this.syncStatusListener?.('connected');

      return {
        state: nextState,
        customer: payload.customer ? sanitizeCustomerForPublic(payload.customer) : null,
        customerToken: payload.customerToken ?? null,
        recovered: Boolean(payload.recovered),
      };
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  private async postMerchantJoinAction(
    state: QueueStoreState,
    suffix: string,
    body: Record<string, unknown>
  ): Promise<QueueJoinResponse> {
    const resolvedStoreId = this.resolveStoreId(state.auth.storeId);
    try {
      const response = await fetch(this.getActionEndpoint(resolvedStoreId, suffix), {
        method: 'POST',
        headers: this.getRequestHeaders({
          includeAuth: true,
        }),
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => null)) as QueueJoinResponse | null;

      if (!response.ok || !payload?.state) {
        throw new Error(formatRemoteActionError('merchant', response.status, payload));
      }

      const nextState = normalizeQueueState(payload.state as unknown as Record<string, unknown>);
      writeRemoteQueueCacheIfNewer(nextState, resolvedStoreId);
      this.syncStatusListener?.('connected');

      return {
        state: nextState,
        customer: payload.customer ? sanitizeCustomerForPublic(payload.customer) : null,
        customerToken: null,
        recovered: false,
      };
    } catch (error) {
      throw normalizeRemoteFetchError(error);
    }
  }

  private async issueCustomerEntrySession(storeId: string): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/stores/${encodeURIComponent(storeId)}/customer-entry-session`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const payload =
      (await response.json().catch(() => null)) as
        | CustomerEntrySessionResponse
        | { error?: string }
        | null;

    if (!response.ok || !payload || !('token' in payload) || typeof payload.token !== 'string') {
      throw new Error(
        parseErrorMessage(payload, `Customer entry session failed with ${response.status}`)
      );
    }

    writeCustomerEntryToken(payload.token, storeId);
    return payload.token;
  }
}

export function createQueueStoreAdapter(): QueueStoreAdapter {
  const syncMode = resolveQueueSyncMode();
  const apiBaseUrl = resolveRemoteApiBaseUrl();

  if (syncMode === 'remote' && typeof apiBaseUrl === 'string' && apiBaseUrl.length > 0) {
    return new RemoteQueueStoreAdapter(apiBaseUrl, resolveInitialRemoteStoreId());
  }

  return new LocalQueueStoreAdapter();
}

export {
  applyAutomaticQueueState,
  addTableState,
  addCustomerState,
  callCustomerState,
  confirmArrivalState,
  clearQueueState,
  configureTablesState,
  expireCustomerState,
  markTableAvailableState,
  markTableCleaningState,
  releaseTableState,
  removeCustomerFromState,
  removeTableState,
  requeueCustomerState,
  sanitizePublicState,
  setAutoModeState,
  seatCustomerState,
};
