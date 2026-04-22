const requestedStorageProvider = (process.env.QUEUEFLOW_STORAGE_PROVIDER ?? 'sqlite')
  .trim()
  .toLowerCase();

const supportedProviders = new Set(['sqlite', 'postgres']);

if (!supportedProviders.has(requestedStorageProvider)) {
  throw new Error(
    `Unsupported QUEUEFLOW_STORAGE_PROVIDER "${requestedStorageProvider}". Supported values: sqlite, postgres.`
  );
}

const selectedModule =
  requestedStorageProvider === 'postgres'
    ? await import('./pg-store.mjs')
    : await import('./sqlite-store.mjs');

export const storageProvider = requestedStorageProvider;
export const storageEngine = selectedModule.storageEngine ?? 'unknown';
export const storageProductionReady = selectedModule.storageProductionReady ?? false;
export const storageRecommendation =
  selectedModule.storageRecommendation ??
  'Use a managed Postgres database before running multi-merchant production traffic.';

export const dataDirPath = selectedModule.dataDirPath ?? null;
export const dbFilePath = selectedModule.dbFilePath ?? null;
export const legacyJsonPath = selectedModule.legacyJsonPath ?? null;
export const hashPassword = selectedModule.hashPassword;
export const verifyPassword = selectedModule.verifyPassword;

export const getStore = selectedModule.getStore;
export const getMerchantProfile = selectedModule.getMerchantProfile;
export const getMerchantBilling = selectedModule.getMerchantBilling;
export const runTransaction = selectedModule.runTransaction;
export const listStores = selectedModule.listStores;
export const verifyStorePassword = selectedModule.verifyStorePassword;
export const createMerchantStore = selectedModule.createMerchantStore;
export const updateMerchantProfile = selectedModule.updateMerchantProfile;
export const updateMerchantBilling = selectedModule.updateMerchantBilling;
export const updateStore = selectedModule.updateStore;
export const createSession = selectedModule.createSession;
export const getSession = selectedModule.getSession;
export const deleteSession = selectedModule.deleteSession;
export const pruneExpiredSessions = selectedModule.pruneExpiredSessions;
export const issueCustomerEntrySession = selectedModule.issueCustomerEntrySession;
export const getCustomerEntrySession = selectedModule.getCustomerEntrySession;
export const deleteCustomerEntrySession = selectedModule.deleteCustomerEntrySession;
export const issueCustomerToken = selectedModule.issueCustomerToken;
export const getCustomerToken = selectedModule.getCustomerToken;
export const touchCustomerToken = selectedModule.touchCustomerToken;
export const deleteCustomerTokensForCustomer = selectedModule.deleteCustomerTokensForCustomer;
export const upsertCustomerPushSubscription = selectedModule.upsertCustomerPushSubscription;
export const listCustomerPushSubscriptions = selectedModule.listCustomerPushSubscriptions;
export const deleteCustomerPushSubscription = selectedModule.deleteCustomerPushSubscription;
export const deleteCustomerPushSubscriptionsForCustomer =
  selectedModule.deleteCustomerPushSubscriptionsForCustomer;
export const createNotificationLog = selectedModule.createNotificationLog;
export const updateNotificationLog = selectedModule.updateNotificationLog;
export const listNotificationLogs = selectedModule.listNotificationLogs;
export const createQueueEvent = selectedModule.createQueueEvent;
export const listQueueEvents = selectedModule.listQueueEvents;
