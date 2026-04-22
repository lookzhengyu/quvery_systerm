import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadProjectEnv } from './load-project-env.mjs';

await loadProjectEnv();

const defaultStoreId = (process.env.DEFAULT_STORE_ID ?? 'RESTO-001').toUpperCase();
const defaultStorePassword = process.env.DEFAULT_STORE_PASSWORD ?? 'admin123';

const {
  dataDirPath,
  getMerchantBilling,
  getMerchantProfile,
  getStore,
  listNotificationLogs,
  listQueueEvents,
  listStores,
  storageEngine,
  storageProvider,
} = await import('../server/store.mjs');

const fallbackExportDir = resolve(process.cwd(), 'server', '.data', 'exports');
const exportBaseDir = dataDirPath ? resolve(dataDirPath, 'exports') : fallbackExportDir;

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const requestedOutputPath = process.argv[2]?.trim();
const outputPath =
  requestedOutputPath && requestedOutputPath.length > 0
    ? resolve(requestedOutputPath)
    : resolve(exportBaseDir, `queueflow-snapshot-${buildTimestamp()}.json`);

const stores = await listStores(defaultStoreId, defaultStorePassword);
const exportedStores = [];

for (const storeSummary of stores) {
  const [store, profile, billing, notificationLogs, queueEvents] = await Promise.all([
    getStore(defaultStoreId, defaultStorePassword, storeSummary.storeId),
    getMerchantProfile(defaultStoreId, defaultStorePassword, storeSummary.storeId),
    getMerchantBilling(defaultStoreId, defaultStorePassword, storeSummary.storeId),
    listNotificationLogs(defaultStoreId, defaultStorePassword, storeSummary.storeId, 5000),
    listQueueEvents(defaultStoreId, defaultStorePassword, storeSummary.storeId, 5000),
  ]);

  exportedStores.push({
    storeId: storeSummary.storeId,
    storeName: storeSummary.storeName,
    store,
    profile,
    billing,
    notificationLogs,
    queueEvents,
  });
}

const snapshot = {
  exportedAt: new Date().toISOString(),
  storageProvider,
  storageEngine,
  counts: {
    stores: exportedStores.length,
    notificationLogs: exportedStores.reduce(
      (sum, entry) => sum + entry.notificationLogs.length,
      0
    ),
    queueEvents: exportedStores.reduce((sum, entry) => sum + entry.queueEvents.length, 0),
  },
  notes: [
    'This snapshot intentionally exports store, profile, billing, notification, and queue event data.',
    'Ephemeral sessions and customer tokens are not included because they can be regenerated after migration.',
  ],
  stores: exportedStores,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(
  JSON.stringify(
    {
      ok: true,
      outputPath,
      storageProvider,
      storageEngine,
      counts: snapshot.counts,
    },
    null,
    2
  )
);
