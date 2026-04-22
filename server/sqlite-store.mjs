import initSqlJs from 'sql.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQueueStateInvariants, repairQueueStateForWrite } from './queue-domain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDataDirPath =
  process.env.VERCEL === '1' ? resolve('/tmp', 'queueflow-data') : resolve(__dirname, '.data');
const dataDirPath = process.env.QUEUEFLOW_DATA_DIR
  ? resolve(process.env.QUEUEFLOW_DATA_DIR)
  : defaultDataDirPath;
const dbFilePath = resolve(dataDirPath, 'queueflow.sqlite');
const legacyJsonPath = resolve(dataDirPath, 'stores.json');
const storageEngine = 'sql.js';
const storageProductionReady = false;
const storageRecommendation =
  'SQLite is fine for local development and demos. Move to managed Postgres for production scale.';

let dbPromise = null;

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(storedPassword, candidatePassword) {
  if (typeof storedPassword !== 'string' || typeof candidatePassword !== 'string') {
    return false;
  }

  if (!storedPassword.startsWith('scrypt$')) {
    return storedPassword === candidatePassword;
  }

  const [, salt, expectedKey] = storedPassword.split('$');
  if (!salt || !expectedKey) {
    return false;
  }

  const derivedKey = scryptSync(candidatePassword, salt, 64);
  const expectedBuffer = Buffer.from(expectedKey, 'hex');

  if (expectedBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, derivedKey);
}

function isPasswordHashed(password) {
  return typeof password === 'string' && password.startsWith('scrypt$');
}

function buildDefaultMerchantProfile(storeId, storeName, overrides = {}) {
  const createdAt = typeof overrides.createdAt === 'string' ? overrides.createdAt : new Date().toISOString();
  const activatedAt =
    typeof overrides.activatedAt === 'string' ? overrides.activatedAt : createdAt;
  const trialEndsAt =
    typeof overrides.trialEndsAt === 'string'
      ? overrides.trialEndsAt
      : new Date(Date.parse(createdAt) + 1000 * 60 * 60 * 24 * 14).toISOString();

  return {
    storeId,
    storeName,
    ownerName:
      typeof overrides.ownerName === 'string' && overrides.ownerName.trim().length > 0
        ? overrides.ownerName.trim()
        : 'Store Owner',
    ownerEmail:
      typeof overrides.ownerEmail === 'string' && overrides.ownerEmail.trim().length > 0
        ? overrides.ownerEmail.trim().toLowerCase()
        : `${storeId.toLowerCase()}@queueflow.local`,
    contactPhone:
      typeof overrides.contactPhone === 'string' && overrides.contactPhone.trim().length > 0
        ? overrides.contactPhone.trim()
        : '',
    planCode:
      typeof overrides.planCode === 'string' && overrides.planCode.trim().length > 0
        ? overrides.planCode.trim().toLowerCase()
        : 'starter',
    subscriptionStatus:
      typeof overrides.subscriptionStatus === 'string' && overrides.subscriptionStatus.trim().length > 0
        ? overrides.subscriptionStatus.trim().toLowerCase()
        : 'trialing',
    billingCycle:
      typeof overrides.billingCycle === 'string' && overrides.billingCycle.trim().length > 0
        ? overrides.billingCycle.trim().toLowerCase()
        : 'monthly',
    onboardingStatus:
      typeof overrides.onboardingStatus === 'string' && overrides.onboardingStatus.trim().length > 0
        ? overrides.onboardingStatus.trim().toLowerCase()
        : 'live',
    qrIssuedAt:
      typeof overrides.qrIssuedAt === 'string' ? overrides.qrIssuedAt : activatedAt,
    createdAt,
    activatedAt,
    trialEndsAt,
    updatedAt:
      typeof overrides.updatedAt === 'string' ? overrides.updatedAt : createdAt,
  };
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function execRows(db, sql, params = []) {
  const [result] = db.exec(sql, params);
  if (!result) {
    return [];
  }

  return result.values.map(values =>
    Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))
  );
}

function execFirstRow(db, sql, params = []) {
  return execRows(db, sql, params)[0] ?? null;
}

function rowToStore(row) {
  if (!row) {
    return null;
  }

  return {
    storeId: row.store_id,
    storeName: row.store_name,
    credentials: {
      password: row.password,
    },
    queueState: parseJson(row.queue_state_json, null),
    updatedAt: row.updated_at,
  };
}

function rowToMerchantProfile(row) {
  if (!row) {
    return null;
  }

  return {
    storeId: row.store_id,
    storeName: row.store_name,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    contactPhone: row.contact_phone ?? '',
    planCode: row.plan_code,
    subscriptionStatus: row.subscription_status,
    billingCycle: row.billing_cycle,
    onboardingStatus: row.onboarding_status,
    qrIssuedAt: row.qr_issued_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    trialEndsAt: row.trial_ends_at ?? null,
    updatedAt: row.profile_updated_at ?? row.updated_at,
  };
}

function rowToMerchantBilling(row) {
  if (!row) {
    return null;
  }

  return {
    storeId: row.store_id,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    lastInvoiceStatus: row.last_invoice_status ?? null,
    lastCheckoutAt: row.last_checkout_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row) {
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    storeId: row.store_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function rowToCustomerJoinReplay(row) {
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    storeId: row.store_id,
    requestHash: row.request_hash,
    response: parseJson(row.response_json, null),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function rowToCustomerPushSubscription(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    storeId: row.store_id,
    customerId: row.customer_id,
    endpoint: row.endpoint,
    subscription: parseJson(row.subscription_json, null),
    userAgent: row.user_agent ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNotificationLog(row) {
  return {
    id: row.id,
    storeId: row.store_id,
    customerId: row.customer_id ?? undefined,
    channel: row.channel,
    recipient: row.recipient,
    eventType: row.event_type,
    subject: row.subject ?? '',
    body: row.body,
    status: row.status,
    provider: row.provider ?? '',
    errorMessage: row.error_message ?? '',
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    sentAt: row.sent_at ?? null,
  };
}

function rowToQueueEvent(row) {
  return {
    id: row.id,
    storeId: row.store_id,
    customerId: row.customer_id ?? undefined,
    queueNumber: typeof row.queue_number === 'number' ? row.queue_number : null,
    partySize: typeof row.party_size === 'number' ? row.party_size : null,
    eventType: row.event_type,
    waitMs: typeof row.wait_ms === 'number' ? row.wait_ms : null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

async function saveDatabase(db) {
  await mkdir(dataDirPath, { recursive: true });
  await writeFile(dbFilePath, Buffer.from(db.export()));
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      store_id TEXT PRIMARY KEY,
      store_name TEXT NOT NULL,
      password TEXT NOT NULL,
      queue_state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_store_id ON sessions(store_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS customer_tokens (
      token TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_tokens_store_customer
      ON customer_tokens(store_id, customer_id);

    CREATE TABLE IF NOT EXISTS customer_entry_sessions (
      token TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customer_entry_sessions_store_id
      ON customer_entry_sessions(store_id);

    CREATE INDEX IF NOT EXISTS idx_customer_entry_sessions_expires_at
      ON customer_entry_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS customer_join_replays (
      token TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customer_join_replays_store_id
      ON customer_join_replays(store_id);

    CREATE INDEX IF NOT EXISTS idx_customer_join_replays_expires_at
      ON customer_join_replays(expires_at);

    CREATE TABLE IF NOT EXISTS customer_push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      subscription_json TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_push_subscriptions_endpoint
      ON customer_push_subscriptions(endpoint);

    CREATE INDEX IF NOT EXISTS idx_customer_push_subscriptions_store_customer
      ON customer_push_subscriptions(store_id, customer_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL,
      customer_id TEXT,
      channel TEXT NOT NULL,
      recipient TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      error_message TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notification_logs_store_id
      ON notification_logs(store_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS queue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL,
      customer_id TEXT,
      queue_number INTEGER,
      party_size INTEGER,
      event_type TEXT NOT NULL,
      wait_ms INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_queue_events_store_id
      ON queue_events(store_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS merchant_profiles (
      store_id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      contact_phone TEXT,
      plan_code TEXT NOT NULL,
      subscription_status TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      onboarding_status TEXT NOT NULL,
      qr_issued_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      trial_ends_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_merchant_profiles_owner_email
      ON merchant_profiles(owner_email);

    CREATE TABLE IF NOT EXISTS merchant_billing (
      store_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      stripe_checkout_session_id TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      last_invoice_status TEXT,
      last_checkout_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function hasAnyStores(db) {
  const row = execFirstRow(db, 'SELECT COUNT(*) AS count FROM stores');
  return Number(row?.count ?? 0) > 0;
}

async function tryMigrateLegacyJson(db) {
  try {
    const raw = await readFile(legacyJsonPath, 'utf8');
    const parsed = parseJson(raw, null);

    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    db.exec('BEGIN');

    for (const [storeId, store] of Object.entries(parsed.stores ?? {})) {
      db.run(
        `
          INSERT OR REPLACE INTO stores (store_id, store_name, password, queue_state_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        [
        storeId.toUpperCase(),
        typeof store?.storeName === 'string' && store.storeName.length > 0
          ? store.storeName
          : 'The Grand Table',
        typeof store?.credentials?.password === 'string' && store.credentials.password.length > 0
          ? hashPassword(store.credentials.password)
          : hashPassword('admin123'),
        JSON.stringify(store?.queueState ?? {}),
        typeof store?.updatedAt === 'string' ? store.updatedAt : new Date().toISOString(),
        ]
      );
    }

    for (const [token, session] of Object.entries(parsed.sessions ?? {})) {
      if (!session || typeof session !== 'object') {
        continue;
      }

      db.run(
        `
          INSERT OR REPLACE INTO sessions (token, store_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `,
        [
          token,
          typeof session.storeId === 'string' ? session.storeId.toUpperCase() : '',
          typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
          typeof session.expiresAt === 'string' ? session.expiresAt : new Date().toISOString(),
        ]
      );
    }

    db.exec('COMMIT');
    return hasAnyStores(db);
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore nested rollback errors.
    }
    return false;
  }
}

function upgradeLegacyStorePasswords(db) {
  const rows = execRows(
    db,
    `
      SELECT store_id, password
      FROM stores
    `
  );

  for (const row of rows) {
    if (!isPasswordHashed(row.password)) {
      db.run(
        `
          UPDATE stores
          SET password = ?
          WHERE store_id = ?
        `,
        [hashPassword(row.password), row.store_id]
      );
    }
  }
}

async function seedDefaultStore(db, defaultStoreId, defaultStorePassword) {
  db.run(
    `
      INSERT OR IGNORE INTO stores (store_id, store_name, password, queue_state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      defaultStoreId,
      'The Grand Table',
      hashPassword(defaultStorePassword),
      JSON.stringify({
        customers: [],
        tables: [],
        auth: {
          storeId: '',
          storeName: '',
          isLoggedIn: false,
        },
        isTablesConfigured: false,
        autoMode: false,
        nextQueueNumber: 1,
        version: 1,
      }),
      new Date().toISOString(),
    ]
  );
}

function upsertMerchantProfileRow(db, storeId, profile) {
  db.run(
    `
      INSERT INTO merchant_profiles (
        store_id,
        owner_name,
        owner_email,
        contact_phone,
        plan_code,
        subscription_status,
        billing_cycle,
        onboarding_status,
        qr_issued_at,
        created_at,
        activated_at,
        trial_ends_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id) DO UPDATE SET
        owner_name = excluded.owner_name,
        owner_email = excluded.owner_email,
        contact_phone = excluded.contact_phone,
        plan_code = excluded.plan_code,
        subscription_status = excluded.subscription_status,
        billing_cycle = excluded.billing_cycle,
        onboarding_status = excluded.onboarding_status,
        qr_issued_at = excluded.qr_issued_at,
        created_at = excluded.created_at,
        activated_at = excluded.activated_at,
        trial_ends_at = excluded.trial_ends_at,
        updated_at = excluded.updated_at
    `,
    [
      storeId.toUpperCase(),
      profile.ownerName,
      profile.ownerEmail,
      profile.contactPhone || '',
      profile.planCode,
      profile.subscriptionStatus,
      profile.billingCycle,
      profile.onboardingStatus,
      profile.qrIssuedAt,
      profile.createdAt,
      profile.activatedAt,
      profile.trialEndsAt ?? null,
      profile.updatedAt,
    ]
  );
}

function readMerchantBilling(db, storeId) {
  const row = execFirstRow(
    db,
    `
      SELECT
        store_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_price_id,
        stripe_checkout_session_id,
        current_period_end,
        cancel_at_period_end,
        last_invoice_status,
        last_checkout_at,
        created_at,
        updated_at
      FROM merchant_billing
      WHERE store_id = ?
    `,
    [storeId.toUpperCase()]
  );

  return rowToMerchantBilling(row);
}

function upsertMerchantBillingRow(db, storeId, patch) {
  const current = readMerchantBilling(db, storeId);
  const nowIso = new Date().toISOString();

  const nextRecord = {
    storeId: storeId.toUpperCase(),
    stripeCustomerId:
      typeof patch.stripeCustomerId === 'string'
        ? patch.stripeCustomerId
        : current?.stripeCustomerId ?? null,
    stripeSubscriptionId:
      typeof patch.stripeSubscriptionId === 'string'
        ? patch.stripeSubscriptionId
        : current?.stripeSubscriptionId ?? null,
    stripePriceId:
      typeof patch.stripePriceId === 'string' ? patch.stripePriceId : current?.stripePriceId ?? null,
    stripeCheckoutSessionId:
      typeof patch.stripeCheckoutSessionId === 'string'
        ? patch.stripeCheckoutSessionId
        : current?.stripeCheckoutSessionId ?? null,
    currentPeriodEnd:
      Object.hasOwn(patch, 'currentPeriodEnd')
        ? patch.currentPeriodEnd ?? null
        : current?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd:
      typeof patch.cancelAtPeriodEnd === 'boolean'
        ? patch.cancelAtPeriodEnd
        : current?.cancelAtPeriodEnd ?? false,
    lastInvoiceStatus:
      Object.hasOwn(patch, 'lastInvoiceStatus')
        ? patch.lastInvoiceStatus ?? null
        : current?.lastInvoiceStatus ?? null,
    lastCheckoutAt:
      Object.hasOwn(patch, 'lastCheckoutAt')
        ? patch.lastCheckoutAt ?? null
        : current?.lastCheckoutAt ?? null,
    createdAt: current?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  db.run(
    `
      INSERT INTO merchant_billing (
        store_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_price_id,
        stripe_checkout_session_id,
        current_period_end,
        cancel_at_period_end,
        last_invoice_status,
        last_checkout_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        stripe_checkout_session_id = excluded.stripe_checkout_session_id,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        last_invoice_status = excluded.last_invoice_status,
        last_checkout_at = excluded.last_checkout_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      nextRecord.storeId,
      nextRecord.stripeCustomerId,
      nextRecord.stripeSubscriptionId,
      nextRecord.stripePriceId,
      nextRecord.stripeCheckoutSessionId,
      nextRecord.currentPeriodEnd,
      nextRecord.cancelAtPeriodEnd ? 1 : 0,
      nextRecord.lastInvoiceStatus,
      nextRecord.lastCheckoutAt,
      nextRecord.createdAt,
      nextRecord.updatedAt,
    ]
  );

  return readMerchantBilling(db, storeId);
}

function ensureMerchantProfiles(db) {
  const rows = execRows(
    db,
    `
      SELECT s.store_id, s.store_name
      FROM stores s
      LEFT JOIN merchant_profiles mp ON mp.store_id = s.store_id
      WHERE mp.store_id IS NULL
    `
  );

  for (const row of rows) {
    upsertMerchantProfileRow(
      db,
      row.store_id,
      buildDefaultMerchantProfile(row.store_id, row.store_name)
    );
  }
}

async function initDatabase(defaultStoreId, defaultStorePassword) {
  await mkdir(dataDirPath, { recursive: true });

  const SQL = await initSqlJs();
  let db;

  try {
    const buffer = await readFile(dbFilePath);
    db = new SQL.Database(new Uint8Array(buffer));
  } catch {
    db = new SQL.Database();
  }

  initSchema(db);
  upgradeLegacyStorePasswords(db);

  if (!hasAnyStores(db)) {
    const migrated = await tryMigrateLegacyJson(db);
    if (!migrated && !hasAnyStores(db)) {
      await seedDefaultStore(db, defaultStoreId, defaultStorePassword);
    }

  }

  ensureMerchantProfiles(db);
  await saveDatabase(db);

  return db;
}

async function getDb(defaultStoreId, defaultStorePassword) {
  if (!dbPromise) {
    dbPromise = initDatabase(defaultStoreId, defaultStorePassword);
  }

  return dbPromise;
}

async function withWrite(defaultStoreId, defaultStorePassword, callback) {
  const db = await getDb(defaultStoreId, defaultStorePassword);

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await callback(db);
    db.exec('COMMIT');
    await saveDatabase(db);
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors if no transaction is active.
    }
    throw error;
  }
}

function readStore(db, storeId) {
  const row = execFirstRow(
    db,
    `
      SELECT store_id, store_name, password, queue_state_json, updated_at
      FROM stores
      WHERE store_id = ?
    `,
    [storeId.toUpperCase()]
  );

  return rowToStore(row);
}

function writeStore(db, storeId, existingStore, queueState) {
  const repair = repairQueueStateForWrite(queueState);
  if (repair.repairs.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'queue_state_repaired_before_write',
        at: new Date().toISOString(),
        storeId: storeId.toUpperCase(),
        storage: 'sqlite',
        repairs: repair.repairs,
      })
    );
  }
  const writableQueueState = repair.state;
  assertQueueStateInvariants(writableQueueState, {
    storeId: storeId.toUpperCase(),
    storage: 'sqlite',
  });

  const updatedAt = new Date().toISOString();

  db.run(
    `
      UPDATE stores
      SET queue_state_json = ?, updated_at = ?
      WHERE store_id = ?
    `,
    [JSON.stringify(writableQueueState), updatedAt, storeId.toUpperCase()]
  );

  return {
    ...existingStore,
    queueState: writableQueueState,
    updatedAt,
  };
}

function writeStoreName(db, storeId, storeName) {
  db.run(
    `
      UPDATE stores
      SET store_name = ?, updated_at = ?
      WHERE store_id = ?
    `,
    [storeName, new Date().toISOString(), storeId.toUpperCase()]
  );
}

function writeStorePassword(db, storeId, passwordHash) {
  db.run(
    `
      UPDATE stores
      SET password = ?, updated_at = ?
      WHERE store_id = ?
    `,
    [passwordHash, new Date().toISOString(), storeId.toUpperCase()]
  );
}

function createStoreRow(db, storeRecord) {
  db.run(
    `
      INSERT INTO stores (store_id, store_name, password, queue_state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      storeRecord.storeId.toUpperCase(),
      storeRecord.storeName,
      storeRecord.passwordHash,
      JSON.stringify(storeRecord.queueState),
      storeRecord.updatedAt,
    ]
  );

  return readStore(db, storeRecord.storeId);
}

function readMerchantProfile(db, storeId) {
  const row = execFirstRow(
    db,
    `
      SELECT
        s.store_id,
        s.store_name,
        mp.owner_name,
        mp.owner_email,
        mp.contact_phone,
        mp.plan_code,
        mp.subscription_status,
        mp.billing_cycle,
        mp.onboarding_status,
        mp.qr_issued_at,
        mp.created_at,
        mp.activated_at,
        mp.trial_ends_at,
        mp.updated_at AS profile_updated_at,
        s.updated_at
      FROM stores s
      LEFT JOIN merchant_profiles mp ON mp.store_id = s.store_id
      WHERE s.store_id = ?
    `,
    [storeId.toUpperCase()]
  );

  if (!row) {
    return null;
  }

  if (!row.owner_name || !row.owner_email) {
    const fallbackProfile = buildDefaultMerchantProfile(row.store_id, row.store_name);
    upsertMerchantProfileRow(db, row.store_id, fallbackProfile);
    return fallbackProfile;
  }

  return rowToMerchantProfile(row);
}

function updateMerchantProfileRow(db, storeId, patch) {
  const currentProfile = readMerchantProfile(db, storeId);
  const currentStore = readStore(db, storeId);
  if (!currentProfile || !currentStore) {
    return null;
  }

  const nextStoreName =
    typeof patch.storeName === 'string' && patch.storeName.trim().length > 0
      ? patch.storeName.trim()
      : currentStore.storeName;
  const nextProfile = {
    ...currentProfile,
    storeName: nextStoreName,
    ownerName:
      typeof patch.ownerName === 'string' && patch.ownerName.trim().length > 0
        ? patch.ownerName.trim()
        : currentProfile.ownerName,
    ownerEmail:
      typeof patch.ownerEmail === 'string' && patch.ownerEmail.trim().length > 0
        ? patch.ownerEmail.trim().toLowerCase()
        : currentProfile.ownerEmail,
    contactPhone:
      typeof patch.contactPhone === 'string' ? patch.contactPhone.trim() : currentProfile.contactPhone,
    planCode:
      typeof patch.planCode === 'string' && patch.planCode.trim().length > 0
        ? patch.planCode.trim().toLowerCase()
        : currentProfile.planCode,
    subscriptionStatus:
      typeof patch.subscriptionStatus === 'string' && patch.subscriptionStatus.trim().length > 0
        ? patch.subscriptionStatus.trim().toLowerCase()
        : currentProfile.subscriptionStatus,
    billingCycle:
      typeof patch.billingCycle === 'string' && patch.billingCycle.trim().length > 0
        ? patch.billingCycle.trim().toLowerCase()
        : currentProfile.billingCycle,
    onboardingStatus:
      typeof patch.onboardingStatus === 'string' && patch.onboardingStatus.trim().length > 0
        ? patch.onboardingStatus.trim().toLowerCase()
        : currentProfile.onboardingStatus,
    qrIssuedAt:
      typeof patch.qrIssuedAt === 'string' && patch.qrIssuedAt.length > 0
        ? patch.qrIssuedAt
        : currentProfile.qrIssuedAt,
    createdAt: currentProfile.createdAt,
    activatedAt:
      typeof patch.activatedAt === 'string' && patch.activatedAt.length > 0
        ? patch.activatedAt
        : currentProfile.activatedAt,
    trialEndsAt:
      Object.hasOwn(patch, 'trialEndsAt') ? patch.trialEndsAt ?? null : currentProfile.trialEndsAt,
    updatedAt: new Date().toISOString(),
  };

  writeStoreName(db, storeId, nextStoreName);
  upsertMerchantProfileRow(db, storeId, nextProfile);
  return readMerchantProfile(db, storeId);
}

function readSessionRow(db, token) {
  const row = execFirstRow(
    db,
    `
      SELECT token, store_id, created_at, expires_at
      FROM sessions
      WHERE token = ?
    `,
    [token]
  );

  return rowToSession(row);
}

function readCustomerTokenRow(db, token) {
  return execFirstRow(
    db,
    `
      SELECT token, store_id, customer_id, created_at, last_seen_at
      FROM customer_tokens
      WHERE token = ?
    `,
    [token]
  );
}

function readCustomerEntrySessionRow(db, token) {
  return execFirstRow(
    db,
    `
      SELECT token, store_id, created_at, expires_at
      FROM customer_entry_sessions
      WHERE token = ?
    `,
    [token]
  );
}

function readCustomerJoinReplayRow(db, token) {
  return rowToCustomerJoinReplay(
    execFirstRow(
      db,
      `
        SELECT token, store_id, request_hash, response_json, created_at, expires_at
        FROM customer_join_replays
        WHERE token = ?
      `,
      [token]
    )
  );
}

function createCustomerJoinReplayRow(db, record) {
  db.run(
    `
      INSERT OR REPLACE INTO customer_join_replays (
        token,
        store_id,
        request_hash,
        response_json,
        created_at,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      record.token,
      record.storeId.toUpperCase(),
      record.requestHash,
      JSON.stringify(record.response),
      record.createdAt,
      record.expiresAt,
    ]
  );

  return record;
}

function upsertCustomerPushSubscriptionRow(db, record) {
  const existing = execFirstRow(
    db,
    `
      SELECT id
      FROM customer_push_subscriptions
      WHERE endpoint = ?
    `,
    [record.endpoint]
  );

  if (existing) {
    db.run(
      `
        UPDATE customer_push_subscriptions
        SET
          store_id = ?,
          customer_id = ?,
          subscription_json = ?,
          user_agent = ?,
          updated_at = ?
        WHERE endpoint = ?
      `,
      [
        record.storeId.toUpperCase(),
        record.customerId,
        JSON.stringify(record.subscription),
        record.userAgent ?? '',
        record.updatedAt,
        record.endpoint,
      ]
    );

    return rowToCustomerPushSubscription(
      execFirstRow(
        db,
        `
          SELECT
            id,
            store_id,
            customer_id,
            endpoint,
            subscription_json,
            user_agent,
            created_at,
            updated_at
          FROM customer_push_subscriptions
          WHERE id = ?
        `,
        [existing.id]
      )
    );
  }

  db.run(
    `
      INSERT INTO customer_push_subscriptions (
        store_id,
        customer_id,
        endpoint,
        subscription_json,
        user_agent,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.storeId.toUpperCase(),
      record.customerId,
      record.endpoint,
      JSON.stringify(record.subscription),
      record.userAgent ?? '',
      record.createdAt,
      record.updatedAt,
    ]
  );

  const row = execFirstRow(db, 'SELECT last_insert_rowid() AS id');
  return rowToCustomerPushSubscription(
    execFirstRow(
      db,
      `
        SELECT
          id,
          store_id,
          customer_id,
          endpoint,
          subscription_json,
          user_agent,
          created_at,
          updated_at
        FROM customer_push_subscriptions
        WHERE id = ?
      `,
      [Number(row?.id ?? 0)]
    )
  );
}

function readCustomerPushSubscriptions(db, storeId, customerId) {
  const rows = execRows(
    db,
    `
      SELECT
        id,
        store_id,
        customer_id,
        endpoint,
        subscription_json,
        user_agent,
        created_at,
        updated_at
      FROM customer_push_subscriptions
      WHERE store_id = ? AND customer_id = ?
      ORDER BY updated_at DESC, id DESC
    `,
    [storeId.toUpperCase(), customerId]
  );

  return rows.map(rowToCustomerPushSubscription);
}

function removeCustomerPushSubscription(db, storeId, endpoint) {
  db.run(
    `
      DELETE FROM customer_push_subscriptions
      WHERE store_id = ? AND endpoint = ?
    `,
    [storeId.toUpperCase(), endpoint]
  );
}

function removeCustomerPushSubscriptionsForCustomer(db, storeId, customerId) {
  db.run(
    `
      DELETE FROM customer_push_subscriptions
      WHERE store_id = ? AND customer_id = ?
    `,
    [storeId.toUpperCase(), customerId]
  );
}

function insertNotificationLogRow(db, log) {
  db.run(
    `
      INSERT INTO notification_logs (
        store_id,
        customer_id,
        channel,
        recipient,
        event_type,
        subject,
        body,
        status,
        provider,
        error_message,
        metadata_json,
        created_at,
        sent_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      log.storeId.toUpperCase(),
      log.customerId ?? null,
      log.channel,
      log.recipient,
      log.eventType,
      log.subject ?? '',
      log.body,
      log.status,
      log.provider ?? '',
      log.errorMessage ?? '',
      JSON.stringify(log.metadata ?? {}),
      log.createdAt,
      log.sentAt ?? null,
    ]
  );

  const row = execFirstRow(db, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id ?? 0);
}

function updateNotificationLogRow(db, id, patch) {
  const fields = [];
  const values = [];

  if (typeof patch.status === 'string') {
    fields.push('status = ?');
    values.push(patch.status);
  }

  if (typeof patch.provider === 'string') {
    fields.push('provider = ?');
    values.push(patch.provider);
  }

  if (typeof patch.errorMessage === 'string') {
    fields.push('error_message = ?');
    values.push(patch.errorMessage);
  }

  if (Object.hasOwn(patch, 'sentAt')) {
    fields.push('sent_at = ?');
    values.push(patch.sentAt ?? null);
  }

  if (Object.hasOwn(patch, 'metadata')) {
    fields.push('metadata_json = ?');
    values.push(JSON.stringify(patch.metadata ?? {}));
  }

  if (fields.length === 0) {
    return;
  }

  values.push(id);
  db.run(
    `
      UPDATE notification_logs
      SET ${fields.join(', ')}
      WHERE id = ?
    `,
    values
  );
}

function insertQueueEventRow(db, event) {
  db.run(
    `
      INSERT INTO queue_events (
        store_id,
        customer_id,
        queue_number,
        party_size,
        event_type,
        wait_ms,
        metadata_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      event.storeId.toUpperCase(),
      event.customerId ?? null,
      typeof event.queueNumber === 'number' ? event.queueNumber : null,
      typeof event.partySize === 'number' ? event.partySize : null,
      event.eventType,
      typeof event.waitMs === 'number' ? event.waitMs : null,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt,
    ]
  );

  const row = execFirstRow(db, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id ?? 0);
}

export async function getStore(defaultStoreId, defaultStorePassword, storeId) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readStore(db, storeId);
}

export async function getMerchantProfile(defaultStoreId, defaultStorePassword, storeId) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readMerchantProfile(db, storeId);
}

export async function getMerchantBilling(defaultStoreId, defaultStorePassword, storeId) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readMerchantBilling(db, storeId);
}

export async function runTransaction(defaultStoreId, defaultStorePassword, callback) {
  return withWrite(defaultStoreId, defaultStorePassword, async db =>
    callback({
      db,
      getStore(storeId) {
        return readStore(db, storeId);
      },
      writeStore(storeId, existingStore, queueState) {
        return writeStore(db, storeId, existingStore, queueState);
      },
      createStore(storeRecord) {
        return createStoreRow(db, storeRecord);
      },
      writeStoreName(storeId, storeName) {
        return writeStoreName(db, storeId, storeName);
      },
      writeStorePassword(storeId, passwordHash) {
        return writeStorePassword(db, storeId, passwordHash);
      },
      getMerchantProfile(storeId) {
        return readMerchantProfile(db, storeId);
      },
      updateMerchantProfile(storeId, patch) {
        return updateMerchantProfileRow(db, storeId, patch);
      },
      upsertMerchantProfile(storeId, profile) {
        upsertMerchantProfileRow(db, storeId, profile);
        return readMerchantProfile(db, storeId);
      },
      getMerchantBilling(storeId) {
        return readMerchantBilling(db, storeId);
      },
      updateMerchantBilling(storeId, patch) {
        return upsertMerchantBillingRow(db, storeId, patch);
      },
      getSession(token) {
        return readSessionRow(db, token);
      },
      createSession(session) {
        db.run(
          `
            INSERT OR REPLACE INTO sessions (token, store_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
          `,
          [session.token, session.storeId.toUpperCase(), session.createdAt, session.expiresAt]
        );

        return session;
      },
      deleteSession(token) {
        db.run('DELETE FROM sessions WHERE token = ?', [token]);
      },
      pruneExpiredSessions(nowIso) {
        db.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso]);
        db.run('DELETE FROM customer_entry_sessions WHERE expires_at <= ?', [nowIso]);
        db.run('DELETE FROM customer_join_replays WHERE expires_at <= ?', [nowIso]);
      },
      issueCustomerEntrySession(sessionRecord) {
        db.run(
          `
            INSERT INTO customer_entry_sessions (token, store_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
          `,
          [
            sessionRecord.token,
            sessionRecord.storeId.toUpperCase(),
            sessionRecord.createdAt,
            sessionRecord.expiresAt,
          ]
        );

        return sessionRecord;
      },
      getCustomerEntrySession(token) {
        return readCustomerEntrySessionRow(db, token);
      },
      deleteCustomerEntrySession(token) {
        db.run('DELETE FROM customer_entry_sessions WHERE token = ?', [token]);
      },
      getCustomerJoinReplay(token) {
        return readCustomerJoinReplayRow(db, token);
      },
      createCustomerJoinReplay(record) {
        return createCustomerJoinReplayRow(db, record);
      },
      getCustomerToken(token) {
        return readCustomerTokenRow(db, token);
      },
      issueCustomerToken(tokenRecord) {
        db.run(
          `
            DELETE FROM customer_tokens
            WHERE store_id = ? AND customer_id = ?
          `,
          [tokenRecord.storeId.toUpperCase(), tokenRecord.customerId]
        );

        db.run(
          `
            INSERT INTO customer_tokens (token, store_id, customer_id, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
          `,
          [
            tokenRecord.token,
            tokenRecord.storeId.toUpperCase(),
            tokenRecord.customerId,
            tokenRecord.createdAt,
            tokenRecord.lastSeenAt,
          ]
        );

        return tokenRecord;
      },
      touchCustomerToken(token, lastSeenAt) {
        db.run(
          `
            UPDATE customer_tokens
            SET last_seen_at = ?
            WHERE token = ?
          `,
          [lastSeenAt, token]
        );
      },
      deleteCustomerTokensForCustomer(storeId, customerId) {
        db.run(
          `
            DELETE FROM customer_tokens
            WHERE store_id = ? AND customer_id = ?
          `,
          [storeId.toUpperCase(), customerId]
        );
      },
      upsertCustomerPushSubscription(record) {
        return upsertCustomerPushSubscriptionRow(db, record);
      },
      listCustomerPushSubscriptions(storeId, customerId) {
        return readCustomerPushSubscriptions(db, storeId, customerId);
      },
      deleteCustomerPushSubscription(storeId, endpoint) {
        removeCustomerPushSubscription(db, storeId, endpoint);
      },
      deleteCustomerPushSubscriptionsForCustomer(storeId, customerId) {
        removeCustomerPushSubscriptionsForCustomer(db, storeId, customerId);
      },
      createNotificationLog(log) {
        return insertNotificationLogRow(db, log);
      },
      updateNotificationLog(id, patch) {
        updateNotificationLogRow(db, id, patch);
      },
      createQueueEvent(event) {
        return insertQueueEventRow(db, event);
      },
    })
  );
}

export async function listStores(defaultStoreId, defaultStorePassword) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  const rows = execRows(
    db,
    `
    SELECT store_id, store_name, updated_at
    FROM stores
    ORDER BY store_id ASC
  `
  );

  return rows.map(row => ({
    storeId: row.store_id,
    storeName: row.store_name,
    updatedAt: row.updated_at,
  }));
}

export async function verifyStorePassword(defaultStoreId, defaultStorePassword, storeId, password) {
  const store = await getStore(defaultStoreId, defaultStorePassword, storeId);
  if (!store) {
    return { ok: false, store: null, upgraded: false };
  }

  const matched = verifyPassword(store.credentials.password, password);
  if (!matched) {
    return { ok: false, store, upgraded: false };
  }

  if (!isPasswordHashed(store.credentials.password)) {
    const passwordHash = hashPassword(password);
    await withWrite(defaultStoreId, defaultStorePassword, db => {
      writeStorePassword(db, storeId, passwordHash);
    });

    return {
      ok: true,
      store: {
        ...store,
        credentials: {
          password: passwordHash,
        },
      },
      upgraded: true,
    };
  }

  return { ok: true, store, upgraded: false };
}

export async function createMerchantStore(defaultStoreId, defaultStorePassword, storeRecord, profileRecord) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    const createdStore = createStoreRow(db, storeRecord);
    upsertMerchantProfileRow(db, storeRecord.storeId, profileRecord);
    return {
      store: createdStore,
      profile: readMerchantProfile(db, storeRecord.storeId),
    };
  });
}

export async function updateMerchantProfile(defaultStoreId, defaultStorePassword, storeId, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, db => updateMerchantProfileRow(db, storeId, patch));
}

export async function updateMerchantBilling(defaultStoreId, defaultStorePassword, storeId, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, db => upsertMerchantBillingRow(db, storeId, patch));
}

export async function updateStore(defaultStoreId, defaultStorePassword, storeId, queueState) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    const existing = readStore(db, storeId);
    if (!existing) {
      return null;
    }

    const updatedAt = new Date().toISOString();

    db.run(
      `
        UPDATE stores
        SET queue_state_json = ?, updated_at = ?
        WHERE store_id = ?
      `,
      [JSON.stringify(queueState), updatedAt, storeId.toUpperCase()]
    );

    return {
      ...existing,
      queueState,
      updatedAt,
    };
  });
}

export async function createSession(defaultStoreId, defaultStorePassword, session) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run(
      `
        INSERT OR REPLACE INTO sessions (token, store_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `,
      [session.token, session.storeId.toUpperCase(), session.createdAt, session.expiresAt]
    );

    return session;
  });
}

export async function getSession(defaultStoreId, defaultStorePassword, token) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readSessionRow(db, token);
}

export async function deleteSession(defaultStoreId, defaultStorePassword, token) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run('DELETE FROM sessions WHERE token = ?', [token]);
  });
}

export async function pruneExpiredSessions(defaultStoreId, defaultStorePassword, nowIso) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso]);
    db.run('DELETE FROM customer_entry_sessions WHERE expires_at <= ?', [nowIso]);
    db.run('DELETE FROM customer_join_replays WHERE expires_at <= ?', [nowIso]);
  });
}

export async function issueCustomerEntrySession(defaultStoreId, defaultStorePassword, sessionRecord) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run(
      `
        INSERT INTO customer_entry_sessions (token, store_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `,
      [
        sessionRecord.token,
        sessionRecord.storeId.toUpperCase(),
        sessionRecord.createdAt,
        sessionRecord.expiresAt,
      ]
    );

    return sessionRecord;
  });
}

export async function getCustomerEntrySession(defaultStoreId, defaultStorePassword, token) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readCustomerEntrySessionRow(db, token);
}

export async function deleteCustomerEntrySession(defaultStoreId, defaultStorePassword, token) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run('DELETE FROM customer_entry_sessions WHERE token = ?', [token]);
  });
}

export async function issueCustomerToken(defaultStoreId, defaultStorePassword, tokenRecord) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run(
      `
        DELETE FROM customer_tokens
        WHERE store_id = ? AND customer_id = ?
      `,
      [tokenRecord.storeId.toUpperCase(), tokenRecord.customerId]
    );

    db.run(
      `
        INSERT INTO customer_tokens (token, store_id, customer_id, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        tokenRecord.token,
        tokenRecord.storeId.toUpperCase(),
        tokenRecord.customerId,
        tokenRecord.createdAt,
        tokenRecord.lastSeenAt,
      ]
    );

    return tokenRecord;
  });
}

export async function getCustomerToken(defaultStoreId, defaultStorePassword, token) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readCustomerTokenRow(db, token);
}

export async function touchCustomerToken(defaultStoreId, defaultStorePassword, token, lastSeenAt) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run(
      `
        UPDATE customer_tokens
        SET last_seen_at = ?
        WHERE token = ?
      `,
      [lastSeenAt, token]
    );
  });
}

export async function deleteCustomerTokensForCustomer(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    db.run(
      `
        DELETE FROM customer_tokens
        WHERE store_id = ? AND customer_id = ?
      `,
      [storeId.toUpperCase(), customerId]
    );
  });
}

export async function upsertCustomerPushSubscription(defaultStoreId, defaultStorePassword, record) {
  return withWrite(defaultStoreId, defaultStorePassword, db =>
    upsertCustomerPushSubscriptionRow(db, record)
  );
}

export async function listCustomerPushSubscriptions(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  return readCustomerPushSubscriptions(db, storeId, customerId);
}

export async function deleteCustomerPushSubscription(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  endpoint
) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    removeCustomerPushSubscription(db, storeId, endpoint);
  });
}

export async function deleteCustomerPushSubscriptionsForCustomer(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  return withWrite(defaultStoreId, defaultStorePassword, db => {
    removeCustomerPushSubscriptionsForCustomer(db, storeId, customerId);
  });
}

export async function createNotificationLog(defaultStoreId, defaultStorePassword, log) {
  return withWrite(defaultStoreId, defaultStorePassword, db => insertNotificationLogRow(db, log));
}

export async function updateNotificationLog(defaultStoreId, defaultStorePassword, id, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, db => updateNotificationLogRow(db, id, patch));
}

export async function listNotificationLogs(defaultStoreId, defaultStorePassword, storeId, limit = 50) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  const rows = execRows(
    db,
    `
      SELECT
        id,
        store_id,
        customer_id,
        channel,
        recipient,
        event_type,
        subject,
        body,
        status,
        provider,
        error_message,
        metadata_json,
        created_at,
        sent_at
      FROM notification_logs
      WHERE store_id = ?
      ORDER BY id DESC
      LIMIT ?
    `,
    [storeId.toUpperCase(), limit]
  );

  return rows.map(row =>
    rowToNotificationLog({
      id: row.id,
      store_id: row.store_id,
      customer_id: row.customer_id,
      channel: row.channel,
      recipient: row.recipient,
      event_type: row.event_type,
      subject: row.subject,
      body: row.body,
      status: row.status,
      provider: row.provider,
      error_message: row.error_message,
      metadata_json: row.metadata_json,
      created_at: row.created_at,
      sent_at: row.sent_at,
    })
  );
}

export async function createQueueEvent(defaultStoreId, defaultStorePassword, event) {
  return withWrite(defaultStoreId, defaultStorePassword, db => insertQueueEventRow(db, event));
}

export async function listQueueEvents(defaultStoreId, defaultStorePassword, storeId, limit = 100) {
  const db = await getDb(defaultStoreId, defaultStorePassword);
  const rows = execRows(
    db,
    `
      SELECT
        id,
        store_id,
        customer_id,
        queue_number,
        party_size,
        event_type,
        wait_ms,
        metadata_json,
        created_at
      FROM queue_events
      WHERE store_id = ?
      ORDER BY id DESC
      LIMIT ?
    `,
    [storeId.toUpperCase(), limit]
  );

  return rows.map(row =>
    rowToQueueEvent({
      id: row.id,
      store_id: row.store_id,
      customer_id: row.customer_id,
      queue_number: row.queue_number,
      party_size: row.party_size,
      event_type: row.event_type,
      wait_ms: row.wait_ms,
      metadata_json: row.metadata_json,
      created_at: row.created_at,
    })
  );
}

export {
  dbFilePath,
  dataDirPath,
  hashPassword,
  legacyJsonPath,
  storageEngine,
  storageProductionReady,
  storageRecommendation,
  verifyPassword,
};
