// Types for the Restaurant Queue Management System

export type CustomerStatus = 'waiting' | 'called' | 'confirmed' | 'seated' | 'expired';
export type TableStatus = 'available' | 'reserved' | 'occupied' | 'cleaning';
export type QueueSyncMode = 'local' | 'remote';
export type SyncStatus = 'connected' | 'syncing' | 'offline' | 'conflict-refreshed' | 'error';
export type NotificationLogStatus = 'pending' | 'sent' | 'skipped' | 'failed';
export type MerchantPlanCode = 'starter' | 'growth' | 'scale';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'inactive';
export type BillingProvider = 'stripe' | 'none';
export type NotificationProvider = 'smtp' | 'gmail' | 'disabled';
export type CustomerSource = 'online' | 'walk-in';
export type QueueEventType =
  | 'joined'
  | 'called'
  | 'confirmed'
  | 'seated'
  | 'expired'
  | 'left'
  | 'removed'
  | 'queue_cleared';

export interface NotificationLog {
  id: number;
  storeId: string;
  customerId?: string;
  channel: string;
  recipient: string;
  eventType: string;
  subject: string;
  body: string;
  status: NotificationLogStatus;
  provider: string;
  errorMessage: string;
  createdAt: string;
  sentAt: string | null;
}

export interface QueueEvent {
  id: number;
  storeId: string;
  customerId?: string;
  queueNumber: number | null;
  partySize: number | null;
  eventType: QueueEventType;
  waitMs: number | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Customer {
  id: string;
  phone: string;
  email?: string;
  name?: string;
  source: CustomerSource;
  partySize: number;
  queueNumber: number;
  status: CustomerStatus;
  joinTime: Date;
  callTime?: Date;
  expiredAt?: Date;
  assignedTableId?: string;
}

export interface Table {
  id: string;
  name: string;
  capacity: number;
  status: TableStatus;
  assignedCustomerId?: string;
}

export interface MerchantAuth {
  storeId: string;
  storeName: string;
  isLoggedIn: boolean;
}

export interface MerchantProfile {
  storeId: string;
  storeName: string;
  ownerName: string;
  ownerEmail: string;
  contactPhone: string;
  planCode: MerchantPlanCode;
  subscriptionStatus: SubscriptionStatus;
  billingCycle: string;
  onboardingStatus: string;
  qrIssuedAt: string;
  createdAt: string;
  activatedAt: string;
  trialEndsAt: string | null;
  updatedAt: string;
  billing: MerchantBillingSummary;
  notifications: MerchantNotificationSummary;
}

export interface MerchantIntegrationConfigStatus {
  configured: boolean;
  missingEnv: string[];
}

export interface MerchantBillingPlan {
  planCode: MerchantPlanCode;
  label: string;
  description: string;
  amount: number;
  currency: string;
  interval: string;
}

export interface MerchantBillingSummary {
  provider: BillingProvider;
  checkoutEnabled: boolean;
  portalEnabled: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lastInvoiceStatus: string | null;
  lastCheckoutAt: string | null;
  plans: Record<MerchantPlanCode, MerchantBillingPlan>;
  config: MerchantIntegrationConfigStatus;
}

export interface MerchantNotificationSummary {
  provider: NotificationProvider;
  deliveryEnabled: boolean;
  fromAddress: string | null;
  config: MerchantIntegrationConfigStatus;
}

export interface MerchantProvisioning {
  storeId: string;
  temporaryPassword: string;
  planCode: MerchantPlanCode;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
}

export interface MerchantRegistrationInput {
  storeName: string;
  ownerName: string;
  ownerEmail: string;
  contactPhone: string;
  password?: string;
  planCode: MerchantPlanCode;
  billingCycle?: string;
}

export interface MerchantProfileUpdateInput {
  storeName?: string;
  ownerName?: string;
  ownerEmail?: string;
  contactPhone?: string;
  planCode?: MerchantPlanCode;
  subscriptionStatus?: SubscriptionStatus;
  billingCycle?: string;
}

export interface MerchantPasswordUpdateInput {
  currentPassword: string;
  nextPassword: string;
}

export interface QueueJoinResult {
  customer: Customer | null;
  recovered: boolean;
}

export interface QueueContextType {
  // State
  customers: Customer[];
  tables: Table[];
  auth: MerchantAuth;
  merchantProfile: MerchantProfile | null;
  recentProvisioning: MerchantProvisioning | null;
  isTablesConfigured: boolean;
  autoMode: boolean;
  syncMode: QueueSyncMode;
  syncStatus: SyncStatus;

  // Auth actions
  login: (storeId: string, password: string) => Promise<boolean>;
  registerMerchant: (input: MerchantRegistrationInput) => Promise<void>;
  logout: () => Promise<void>;
  dismissProvisioning: () => void;

  // Table actions
  setTables: (tables: Table[]) => Promise<void>;
  addTable: (capacity: number) => Promise<void>;
  removeTable: (tableId: string) => Promise<void>;
  markTableCleaning: (tableId: string) => Promise<void>;
  markTableAvailable: (tableId: string) => Promise<void>;
  releaseTable: (tableId: string) => Promise<void>;
  resetQueue: () => Promise<void>;
  setAutoMode: (enabled: boolean) => Promise<void>;

  // Queue actions
  addCustomer: (phone: string, partySize: number, email?: string) => Promise<QueueJoinResult>;
  addWalkInCustomer: (partySize: number, name?: string) => Promise<QueueJoinResult>;
  prepareCustomerEntry: () => Promise<void>;
  callCustomer: (customerId: string, tableId?: string) => Promise<void>;
  confirmArrival: (customerId: string) => Promise<void>;
  seatCustomer: (customerId: string) => Promise<void>;
  expireCustomer: (customerId: string) => Promise<void>;
  requeueCustomer: (customerId: string) => Promise<void>;
  leaveQueue: (customerId: string) => Promise<void>;
  removeCustomer: (customerId: string) => Promise<void>;

  // Helpers
  getCustomerByPhone: (phone: string) => Customer | undefined;
  getWaitingAhead: (customer: Customer) => number;
  getEstimatedWait: (customer: Customer) => number;
  refreshMerchantProfile: () => Promise<MerchantProfile | null>;
  updateMerchantProfile: (input: MerchantProfileUpdateInput) => Promise<MerchantProfile | null>;
  updateMerchantPassword: (input: MerchantPasswordUpdateInput) => Promise<void>;
  startSubscriptionCheckout: (planCode?: MerchantPlanCode) => Promise<string>;
  openBillingPortal: () => Promise<string>;
  sendTestNotificationEmail: (recipient?: string) => Promise<void>;
  validateCustomerSession: (customerId: string) => Promise<boolean>;

  // Notification logs
  fetchNotificationLogs: (limit?: number) => Promise<NotificationLog[]>;
  fetchQueueEvents: (limit?: number) => Promise<QueueEvent[]>;
}
