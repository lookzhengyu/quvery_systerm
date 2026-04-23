import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertQueueStateInvariants, repairQueueStateForWrite } from './queue-domain.mjs';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaFilePath = resolve(__dirname, '..', 'db', 'postgres', 'schema.sql');

function normalizeConnectionString(value) {
  return String(value ?? '')
    .replace(/(?:\\r|\\n|\r|\n)+$/g, '')
    .trim();
}

const postgresUrl = (
  normalizeConnectionString(
    process.env.QUEUEFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''
  )
);
const pgSchema = normalizePgSchema(process.env.QUEUEFLOW_PG_SCHEMA ?? 'public');
const autoInitSchema = (process.env.QUEUEFLOW_PG_AUTO_INIT ?? 'true').trim().toLowerCase() !== 'false';
const sslMode = (process.env.QUEUEFLOW_PG_SSL ?? '').trim().toLowerCase();
const poolMax = Number.parseInt(process.env.QUEUEFLOW_PG_POOL_MAX ?? '5', 10);
const poolIdleTimeoutMs = Number.parseInt(process.env.QUEUEFLOW_PG_IDLE_TIMEOUT_MS ?? '10000', 10);
const poolConnectionTimeoutMs = Number.parseInt(
  process.env.QUEUEFLOW_PG_CONNECTION_TIMEOUT_MS ?? '15000',
  10
);
const pgLockTimeoutMs = parsePositiveInteger(process.env.QUEUEFLOW_PG_LOCK_TIMEOUT_MS, 15000);
const pgStatementTimeoutMs = parsePositiveInteger(
  process.env.QUEUEFLOW_PG_STATEMENT_TIMEOUT_MS,
  30000
);
const pgTransactionRetryCount = parsePositiveInteger(
  process.env.QUEUEFLOW_PG_TRANSACTION_RETRIES,
  4
);

const storageEngine = 'node-postgres';
const storageProductionReady = true;
const storageRecommendation = 'Managed Postgres is suitable for production multi-merchant traffic.';
const dataDirPath = null;
const dbFilePath = null;
const legacyJsonPath = null;

let poolPromise = null;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePgSchema(value) {
  const normalized = String(value ?? 'public').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(normalized)) {
    throw new Error('QUEUEFLOW_PG_SCHEMA must be a valid Postgres identifier.');
  }

  return normalized;
}

function quotePgIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setLocalSchemaSearchPath(client) {
  await client.query(`SET LOCAL search_path TO ${quotePgIdentifier(pgSchema)}`);
}

function isRetryableTransactionError(error) {
  if (error?.code === '40001' || error?.code === '40P01' || error?.code === '55P03') {
    return true;
  }

  return (
    error?.code === '57014' &&
    /lock timeout|statement timeout|canceling statement/i.test(String(error?.message ?? ''))
  );
}

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

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

function buildDefaultQueueState() {
  return {
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
  };
}

function buildDefaultMerchantProfile(storeId, storeName, overrides = {}) {
  const createdAt =
    typeof overrides.createdAt === 'string' ? overrides.createdAt : new Date().toISOString();
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
      typeof overrides.subscriptionStatus === 'string' &&
      overrides.subscriptionStatus.trim().length > 0
        ? overrides.subscriptionStatus.trim().toLowerCase()
        : 'trialing',
    billingCycle:
      typeof overrides.billingCycle === 'string' && overrides.billingCycle.trim().length > 0
        ? overrides.billingCycle.trim().toLowerCase()
        : 'monthly',
    onboardingStatus:
      typeof overrides.onboardingStatus === 'string' &&
      overrides.onboardingStatus.trim().length > 0
        ? overrides.onboardingStatus.trim().toLowerCase()
        : 'live',
    qrIssuedAt: typeof overrides.qrIssuedAt === 'string' ? overrides.qrIssuedAt : activatedAt,
    createdAt,
    activatedAt,
    trialEndsAt,
    updatedAt: typeof overrides.updatedAt === 'string' ? overrides.updatedAt : createdAt,
  };
}

function parseJsonValue(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  if (typeof value === 'object') {
    return value;
  }

  return fallback;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function buildPoolConfig() {
  if (!postgresUrl.trim()) {
    throw new Error(
      'QUEUEFLOW_POSTGRES_URL or DATABASE_URL is required when QUEUEFLOW_STORAGE_PROVIDER=postgres.'
    );
  }

  const config = {
    connectionString: postgresUrl,
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
    idleTimeoutMillis:
      Number.isFinite(poolIdleTimeoutMs) && poolIdleTimeoutMs > 0 ? poolIdleTimeoutMs : 10000,
    connectionTimeoutMillis:
      Number.isFinite(poolConnectionTimeoutMs) && poolConnectionTimeoutMs > 0
        ? poolConnectionTimeoutMs
        : 15000,
  };

  if (sslMode === 'true' || sslMode === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

async function execRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function execFirstRow(client, sql, params = []) {
  const rows = await execRows(client, sql, params);
  return rows[0] ?? null;
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
    queueState: parseJsonValue(row.queue_state_json, null),
    updatedAt: toIsoString(row.updated_at),
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
    qrIssuedAt: toIsoString(row.qr_issued_at),
    createdAt: toIsoString(row.created_at),
    activatedAt: toIsoString(row.activated_at),
    trialEndsAt: toIsoString(row.trial_ends_at),
    updatedAt: toIsoString(row.profile_updated_at ?? row.updated_at),
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
    currentPeriodEnd: toIsoString(row.current_period_end),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    lastInvoiceStatus: row.last_invoice_status ?? null,
    lastCheckoutAt: toIsoString(row.last_checkout_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToSession(row) {
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    storeId: row.store_id,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
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
    response: parseJsonValue(row.response_json, null),
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
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
    subscription: parseJsonValue(row.subscription_json, null),
    userAgent: row.user_agent ?? '',
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToNotificationLog(row) {
  return {
    id: Number(row.id),
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
    metadata: parseJsonValue(row.metadata_json, {}),
    createdAt: toIsoString(row.created_at),
    sentAt: toIsoString(row.sent_at),
  };
}

function rowToQueueEvent(row) {
  return {
    id: Number(row.id),
    storeId: row.store_id,
    customerId: row.customer_id ?? undefined,
    queueNumber: typeof row.queue_number === 'number' ? row.queue_number : null,
    partySize: typeof row.party_size === 'number' ? row.party_size : null,
    eventType: row.event_type,
    waitMs: typeof row.wait_ms === 'number' ? row.wait_ms : null,
    metadata: parseJsonValue(row.metadata_json, {}),
    createdAt: toIsoString(row.created_at),
  };
}

async function initSchema(client) {
  if (!autoInitSchema) {
    return;
  }

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(pgSchema)}`);
  const schemaSql = await readFile(schemaFilePath, 'utf8');
  await client.query(schemaSql);
}

async function hasAnyStores(client) {
  const row = await execFirstRow(client, 'SELECT COUNT(*)::int AS count FROM stores');
  return Number(row?.count ?? 0) > 0;
}

async function seedDefaultStore(client, defaultStoreId, defaultStorePassword) {
  await client.query(
    `
      INSERT INTO stores (store_id, store_name, password, queue_state_json, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (store_id) DO NOTHING
    `,
    [
      defaultStoreId,
      'The Grand Table',
      hashPassword(defaultStorePassword),
      JSON.stringify(buildDefaultQueueState()),
      new Date().toISOString(),
    ]
  );
}

async function ensureMerchantProfiles(client) {
  const rows = await execRows(
    client,
    `
      SELECT s.store_id, s.store_name
      FROM stores s
      LEFT JOIN merchant_profiles mp ON mp.store_id = s.store_id
      WHERE mp.store_id IS NULL
      ORDER BY s.store_id ASC
    `
  );

  for (const row of rows) {
    await upsertMerchantProfileRow(
      client,
      row.store_id,
      buildDefaultMerchantProfile(row.store_id, row.store_name)
    );
  }
}

async function initPool(defaultStoreId, defaultStorePassword) {
  const pool = new Pool(buildPoolConfig());
  pool.on('error', () => {
    // Avoid crashing on background idle client errors. The request path will still fail loudly.
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(pgSchema)}`);
    await setLocalSchemaSearchPath(client);
    await initSchema(client);

    if (!(await hasAnyStores(client))) {
      await seedDefaultStore(client, defaultStoreId, defaultStorePassword);
    }

    await ensureMerchantProfiles(client);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors during pool initialization.
    }
    throw error;
  } finally {
    client.release();
  }

  return pool;
}

async function getPool(defaultStoreId, defaultStorePassword) {
  if (!poolPromise) {
    poolPromise = initPool(defaultStoreId, defaultStorePassword);
  }

  return poolPromise;
}

async function withRead(defaultStoreId, defaultStorePassword, callback) {
  const pool = await getPool(defaultStoreId, defaultStorePassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setLocalSchemaSearchPath(client);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors after read transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function withWrite(defaultStoreId, defaultStorePassword, callback) {
  const pool = await getPool(defaultStoreId, defaultStorePassword);

  for (let attempt = 0; attempt <= pgTransactionRetryCount; attempt += 1) {
    const client = await pool.connect();
    let released = false;

    try {
      await client.query('BEGIN');
      await setLocalSchemaSearchPath(client);
      await client.query(`SET LOCAL lock_timeout = '${pgLockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${pgStatementTimeoutMs}ms'`);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors after a failed transaction.
      }

      if (attempt < pgTransactionRetryCount && isRetryableTransactionError(error)) {
        client.release();
        released = true;
        await wait(25 * (attempt + 1));
        continue;
      }

      throw error;
    } finally {
      if (!released) {
        client.release();
      }
    }
  }

  throw new Error('Postgres transaction failed after retry attempts.');
}

async function readStore(client, storeId, options = {}) {
  const lockClause = options.lockForUpdate ? 'FOR UPDATE' : '';
  const row = await execFirstRow(
    client,
    `
      SELECT store_id, store_name, password, queue_state_json, updated_at
      FROM stores
      WHERE store_id = $1
      ${lockClause}
    `,
    [storeId.toUpperCase()]
  );

  return rowToStore(row);
}

async function writeStore(client, storeId, existingStore, queueState) {
  const repair = repairQueueStateForWrite(queueState);
  if (repair.repairs.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'queue_state_repaired_before_write',
        at: new Date().toISOString(),
        storeId: storeId.toUpperCase(),
        storage: 'postgres',
        repairs: repair.repairs,
      })
    );
  }
  const writableQueueState = repair.state;
  assertQueueStateInvariants(writableQueueState, {
    storeId: storeId.toUpperCase(),
    storage: 'postgres',
  });

  const updatedAt = new Date().toISOString();

  await client.query(
    `
      UPDATE stores
      SET queue_state_json = $1::jsonb, updated_at = $2
      WHERE store_id = $3
  `,
    [JSON.stringify(writableQueueState), updatedAt, storeId.toUpperCase()]
  );

  return {
    ...existingStore,
    queueState: writableQueueState,
    updatedAt,
  };
}

async function writeStoreName(client, storeId, storeName) {
  await client.query(
    `
      UPDATE stores
      SET store_name = $1, updated_at = $2
      WHERE store_id = $3
    `,
    [storeName, new Date().toISOString(), storeId.toUpperCase()]
  );
}

async function writeStorePassword(client, storeId, passwordHash) {
  await client.query(
    `
      UPDATE stores
      SET password = $1, updated_at = $2
      WHERE store_id = $3
    `,
    [passwordHash, new Date().toISOString(), storeId.toUpperCase()]
  );
}

async function createStoreRow(client, storeRecord) {
  await client.query(
    `
      INSERT INTO stores (store_id, store_name, password, queue_state_json, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
    [
      storeRecord.storeId.toUpperCase(),
      storeRecord.storeName,
      storeRecord.passwordHash,
      JSON.stringify(storeRecord.queueState),
      storeRecord.updatedAt,
    ]
  );

  return readStore(client, storeRecord.storeId);
}

async function readMerchantProfile(client, storeId) {
  const row = await execFirstRow(
    client,
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
      WHERE s.store_id = $1
    `,
    [storeId.toUpperCase()]
  );

  if (!row) {
    return null;
  }

  if (!row.owner_name || !row.owner_email) {
    const fallbackProfile = buildDefaultMerchantProfile(row.store_id, row.store_name);
    await upsertMerchantProfileRow(client, row.store_id, fallbackProfile);
    return fallbackProfile;
  }

  return rowToMerchantProfile(row);
}

async function upsertMerchantProfileRow(client, storeId, profile) {
  await client.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (store_id) DO UPDATE SET
        owner_name = EXCLUDED.owner_name,
        owner_email = EXCLUDED.owner_email,
        contact_phone = EXCLUDED.contact_phone,
        plan_code = EXCLUDED.plan_code,
        subscription_status = EXCLUDED.subscription_status,
        billing_cycle = EXCLUDED.billing_cycle,
        onboarding_status = EXCLUDED.onboarding_status,
        qr_issued_at = EXCLUDED.qr_issued_at,
        created_at = EXCLUDED.created_at,
        activated_at = EXCLUDED.activated_at,
        trial_ends_at = EXCLUDED.trial_ends_at,
        updated_at = EXCLUDED.updated_at
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

async function updateMerchantProfileRow(client, storeId, patch) {
  const currentProfile = await readMerchantProfile(client, storeId);
  const currentStore = await readStore(client, storeId);
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
    trialEndsAt: hasOwn(patch, 'trialEndsAt') ? patch.trialEndsAt ?? null : currentProfile.trialEndsAt,
    updatedAt: new Date().toISOString(),
  };

  await writeStoreName(client, storeId, nextStoreName);
  await upsertMerchantProfileRow(client, storeId, nextProfile);
  return readMerchantProfile(client, storeId);
}

async function readMerchantBilling(client, storeId) {
  const row = await execFirstRow(
    client,
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
      WHERE store_id = $1
    `,
    [storeId.toUpperCase()]
  );

  return rowToMerchantBilling(row);
}

async function upsertMerchantBillingRow(client, storeId, patch) {
  const current = await readMerchantBilling(client, storeId);
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
    currentPeriodEnd: hasOwn(patch, 'currentPeriodEnd')
      ? patch.currentPeriodEnd ?? null
      : current?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd:
      typeof patch.cancelAtPeriodEnd === 'boolean'
        ? patch.cancelAtPeriodEnd
        : current?.cancelAtPeriodEnd ?? false,
    lastInvoiceStatus: hasOwn(patch, 'lastInvoiceStatus')
      ? patch.lastInvoiceStatus ?? null
      : current?.lastInvoiceStatus ?? null,
    lastCheckoutAt: hasOwn(patch, 'lastCheckoutAt')
      ? patch.lastCheckoutAt ?? null
      : current?.lastCheckoutAt ?? null,
    createdAt: current?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  await client.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (store_id) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_price_id = EXCLUDED.stripe_price_id,
        stripe_checkout_session_id = EXCLUDED.stripe_checkout_session_id,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        last_invoice_status = EXCLUDED.last_invoice_status,
        last_checkout_at = EXCLUDED.last_checkout_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `,
    [
      nextRecord.storeId,
      nextRecord.stripeCustomerId,
      nextRecord.stripeSubscriptionId,
      nextRecord.stripePriceId,
      nextRecord.stripeCheckoutSessionId,
      nextRecord.currentPeriodEnd,
      nextRecord.cancelAtPeriodEnd,
      nextRecord.lastInvoiceStatus,
      nextRecord.lastCheckoutAt,
      nextRecord.createdAt,
      nextRecord.updatedAt,
    ]
  );

  return readMerchantBilling(client, storeId);
}

async function readSessionRow(client, token) {
  const row = await execFirstRow(
    client,
    `
      SELECT token, store_id, created_at, expires_at
      FROM sessions
      WHERE token = $1
    `,
    [token]
  );

  return rowToSession(row);
}

async function readCustomerTokenRow(client, token) {
  const row = await execFirstRow(
    client,
    `
      SELECT token, store_id, customer_id, created_at, last_seen_at
      FROM customer_tokens
      WHERE token = $1
    `,
    [token]
  );

  if (!row) {
    return null;
  }

  return {
    token: row.token,
    store_id: row.store_id,
    customer_id: row.customer_id,
    created_at: toIsoString(row.created_at),
    last_seen_at: toIsoString(row.last_seen_at),
  };
}

async function readCustomerEntrySessionRow(client, token) {
  const row = await execFirstRow(
    client,
    `
      SELECT token, store_id, created_at, expires_at
      FROM customer_entry_sessions
      WHERE token = $1
    `,
    [token]
  );

  if (!row) {
    return null;
  }

  return {
    token: row.token,
    store_id: row.store_id,
    created_at: toIsoString(row.created_at),
    expires_at: toIsoString(row.expires_at),
  };
}

async function readCustomerJoinReplayRow(client, token) {
  const row = await execFirstRow(
    client,
    `
      SELECT token, store_id, request_hash, response_json, created_at, expires_at
      FROM customer_join_replays
      WHERE token = $1
    `,
    [token]
  );

  return rowToCustomerJoinReplay(row);
}

async function createCustomerJoinReplayRow(client, record) {
  await client.query(
    `
      INSERT INTO customer_join_replays (
        token,
        store_id,
        request_hash,
        response_json,
        created_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (token) DO UPDATE SET
        store_id = EXCLUDED.store_id,
        request_hash = EXCLUDED.request_hash,
        response_json = EXCLUDED.response_json,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
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

async function upsertCustomerPushSubscriptionRow(client, record) {
  const row = await execFirstRow(
    client,
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
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (endpoint) DO UPDATE SET
        store_id = EXCLUDED.store_id,
        customer_id = EXCLUDED.customer_id,
        subscription_json = EXCLUDED.subscription_json,
        user_agent = EXCLUDED.user_agent,
        updated_at = EXCLUDED.updated_at
      RETURNING
        id,
        store_id,
        customer_id,
        endpoint,
        subscription_json,
        user_agent,
        created_at,
        updated_at
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

  return rowToCustomerPushSubscription(row);
}

async function readCustomerPushSubscriptions(client, storeId, customerId) {
  const rows = await execRows(
    client,
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
      WHERE store_id = $1 AND customer_id = $2
      ORDER BY updated_at DESC, id DESC
    `,
    [storeId.toUpperCase(), customerId]
  );

  return rows.map(rowToCustomerPushSubscription);
}

async function removeCustomerPushSubscription(client, storeId, endpoint) {
  await client.query(
    `
      DELETE FROM customer_push_subscriptions
      WHERE store_id = $1 AND endpoint = $2
    `,
    [storeId.toUpperCase(), endpoint]
  );
}

async function removeCustomerPushSubscriptionsForCustomer(client, storeId, customerId) {
  await client.query(
    `
      DELETE FROM customer_push_subscriptions
      WHERE store_id = $1 AND customer_id = $2
    `,
    [storeId.toUpperCase(), customerId]
  );
}

async function insertNotificationLogRow(client, log) {
  const row = await execFirstRow(
    client,
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
      RETURNING id
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

  return Number(row?.id ?? 0);
}

async function updateNotificationLogRow(client, id, patch) {
  const fields = [];
  const values = [];

  if (typeof patch.status === 'string') {
    values.push(patch.status);
    fields.push(`status = $${values.length}`);
  }

  if (typeof patch.provider === 'string') {
    values.push(patch.provider);
    fields.push(`provider = $${values.length}`);
  }

  if (typeof patch.errorMessage === 'string') {
    values.push(patch.errorMessage);
    fields.push(`error_message = $${values.length}`);
  }

  if (hasOwn(patch, 'sentAt')) {
    values.push(patch.sentAt ?? null);
    fields.push(`sent_at = $${values.length}`);
  }

  if (hasOwn(patch, 'metadata')) {
    values.push(JSON.stringify(patch.metadata ?? {}));
    fields.push(`metadata_json = $${values.length}::jsonb`);
  }

  if (fields.length === 0) {
    return;
  }

  values.push(id);
  await client.query(
    `
      UPDATE notification_logs
      SET ${fields.join(', ')}
      WHERE id = $${values.length}
    `,
    values
  );
}

async function insertQueueEventRow(client, event) {
  const row = await execFirstRow(
    client,
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
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING id
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

  return Number(row?.id ?? 0);
}

export async function getStore(defaultStoreId, defaultStorePassword, storeId) {
  return withRead(defaultStoreId, defaultStorePassword, client => readStore(client, storeId));
}

export async function getMerchantProfile(defaultStoreId, defaultStorePassword, storeId) {
  return withRead(defaultStoreId, defaultStorePassword, client =>
    readMerchantProfile(client, storeId)
  );
}

export async function getMerchantBilling(defaultStoreId, defaultStorePassword, storeId) {
  return withRead(defaultStoreId, defaultStorePassword, client =>
    readMerchantBilling(client, storeId)
  );
}

export async function runTransaction(defaultStoreId, defaultStorePassword, callback) {
  return withWrite(defaultStoreId, defaultStorePassword, async client =>
    callback({
      client,
      getStore(storeId) {
        return readStore(client, storeId, { lockForUpdate: true });
      },
      writeStore(storeId, existingStore, queueState) {
        return writeStore(client, storeId, existingStore, queueState);
      },
      createStore(storeRecord) {
        return createStoreRow(client, storeRecord);
      },
      writeStoreName(storeId, storeName) {
        return writeStoreName(client, storeId, storeName);
      },
      writeStorePassword(storeId, passwordHash) {
        return writeStorePassword(client, storeId, passwordHash);
      },
      getMerchantProfile(storeId) {
        return readMerchantProfile(client, storeId);
      },
      updateMerchantProfile(storeId, patch) {
        return updateMerchantProfileRow(client, storeId, patch);
      },
      async upsertMerchantProfile(storeId, profile) {
        await upsertMerchantProfileRow(client, storeId, profile);
        return readMerchantProfile(client, storeId);
      },
      getMerchantBilling(storeId) {
        return readMerchantBilling(client, storeId);
      },
      updateMerchantBilling(storeId, patch) {
        return upsertMerchantBillingRow(client, storeId, patch);
      },
      getSession(token) {
        return readSessionRow(client, token);
      },
      async createSession(session) {
        await client.query(
          `
            INSERT INTO sessions (token, store_id, created_at, expires_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (token) DO UPDATE SET
              store_id = EXCLUDED.store_id,
              created_at = EXCLUDED.created_at,
              expires_at = EXCLUDED.expires_at
          `,
          [session.token, session.storeId.toUpperCase(), session.createdAt, session.expiresAt]
        );

        return session;
      },
      deleteSession(token) {
        return client.query('DELETE FROM sessions WHERE token = $1', [token]);
      },
      pruneExpiredSessions(nowIso) {
        return Promise.all([
          client.query('DELETE FROM sessions WHERE expires_at <= $1', [nowIso]),
          client.query('DELETE FROM customer_entry_sessions WHERE expires_at <= $1', [nowIso]),
          client.query('DELETE FROM customer_join_replays WHERE expires_at <= $1', [nowIso]),
        ]);
      },
      async issueCustomerEntrySession(sessionRecord) {
        await client.query(
          `
            INSERT INTO customer_entry_sessions (token, store_id, created_at, expires_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (token) DO UPDATE SET
              store_id = EXCLUDED.store_id,
              created_at = EXCLUDED.created_at,
              expires_at = EXCLUDED.expires_at
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
        return readCustomerEntrySessionRow(client, token);
      },
      deleteCustomerEntrySession(token) {
        return client.query('DELETE FROM customer_entry_sessions WHERE token = $1', [token]);
      },
      getCustomerJoinReplay(token) {
        return readCustomerJoinReplayRow(client, token);
      },
      createCustomerJoinReplay(record) {
        return createCustomerJoinReplayRow(client, record);
      },
      getCustomerToken(token) {
        return readCustomerTokenRow(client, token);
      },
      async issueCustomerToken(tokenRecord) {
        await client.query(
          `
            DELETE FROM customer_tokens
            WHERE store_id = $1 AND customer_id = $2
          `,
          [tokenRecord.storeId.toUpperCase(), tokenRecord.customerId]
        );

        await client.query(
          `
            INSERT INTO customer_tokens (token, store_id, customer_id, created_at, last_seen_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (token) DO UPDATE SET
              store_id = EXCLUDED.store_id,
              customer_id = EXCLUDED.customer_id,
              created_at = EXCLUDED.created_at,
              last_seen_at = EXCLUDED.last_seen_at
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
        return client.query(
          `
            UPDATE customer_tokens
            SET last_seen_at = $1
            WHERE token = $2
          `,
          [lastSeenAt, token]
        );
      },
      deleteCustomerTokensForCustomer(storeId, customerId) {
        return client.query(
          `
            DELETE FROM customer_tokens
            WHERE store_id = $1 AND customer_id = $2
          `,
          [storeId.toUpperCase(), customerId]
        );
      },
      upsertCustomerPushSubscription(record) {
        return upsertCustomerPushSubscriptionRow(client, record);
      },
      listCustomerPushSubscriptions(storeId, customerId) {
        return readCustomerPushSubscriptions(client, storeId, customerId);
      },
      deleteCustomerPushSubscription(storeId, endpoint) {
        return removeCustomerPushSubscription(client, storeId, endpoint);
      },
      deleteCustomerPushSubscriptionsForCustomer(storeId, customerId) {
        return removeCustomerPushSubscriptionsForCustomer(client, storeId, customerId);
      },
      createNotificationLog(log) {
        return insertNotificationLogRow(client, log);
      },
      updateNotificationLog(id, patch) {
        return updateNotificationLogRow(client, id, patch);
      },
      createQueueEvent(event) {
        return insertQueueEventRow(client, event);
      },
    })
  );
}

export async function listStores(defaultStoreId, defaultStorePassword) {
  return withRead(defaultStoreId, defaultStorePassword, async client => {
    const rows = await execRows(
      client,
      `
        SELECT store_id, store_name, updated_at
        FROM stores
        ORDER BY store_id ASC
      `
    );

    return rows.map(row => ({
      storeId: row.store_id,
      storeName: row.store_name,
      updatedAt: toIsoString(row.updated_at),
    }));
  });
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
    await withWrite(defaultStoreId, defaultStorePassword, client =>
      writeStorePassword(client, storeId, passwordHash)
    );

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

export async function createMerchantStore(
  defaultStoreId,
  defaultStorePassword,
  storeRecord,
  profileRecord
) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    const createdStore = await createStoreRow(client, storeRecord);
    await upsertMerchantProfileRow(client, storeRecord.storeId, profileRecord);
    return {
      store: createdStore,
      profile: await readMerchantProfile(client, storeRecord.storeId),
    };
  });
}

export async function updateMerchantProfile(defaultStoreId, defaultStorePassword, storeId, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    updateMerchantProfileRow(client, storeId, patch)
  );
}

export async function updateMerchantBilling(defaultStoreId, defaultStorePassword, storeId, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    upsertMerchantBillingRow(client, storeId, patch)
  );
}

export async function updateStore(defaultStoreId, defaultStorePassword, storeId, queueState) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    const existing = await readStore(client, storeId, { lockForUpdate: true });
    if (!existing) {
      return null;
    }

    return writeStore(client, storeId, existing, queueState);
  });
}

export async function createSession(defaultStoreId, defaultStorePassword, session) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    await client.query(
      `
        INSERT INTO sessions (token, store_id, created_at, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (token) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
      `,
      [session.token, session.storeId.toUpperCase(), session.createdAt, session.expiresAt]
    );

    return session;
  });
}

export async function getSession(defaultStoreId, defaultStorePassword, token) {
  return withRead(defaultStoreId, defaultStorePassword, client => readSessionRow(client, token));
}

export async function deleteSession(defaultStoreId, defaultStorePassword, token) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    client.query('DELETE FROM sessions WHERE token = $1', [token])
  );
}

export async function pruneExpiredSessions(defaultStoreId, defaultStorePassword, nowIso) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    await client.query('DELETE FROM sessions WHERE expires_at <= $1', [nowIso]);
    await client.query('DELETE FROM customer_entry_sessions WHERE expires_at <= $1', [nowIso]);
    await client.query('DELETE FROM customer_join_replays WHERE expires_at <= $1', [nowIso]);
  });
}

export async function issueCustomerEntrySession(defaultStoreId, defaultStorePassword, sessionRecord) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    await client.query(
      `
        INSERT INTO customer_entry_sessions (token, store_id, created_at, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (token) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
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
  return withRead(defaultStoreId, defaultStorePassword, client =>
    readCustomerEntrySessionRow(client, token)
  );
}

export async function deleteCustomerEntrySession(defaultStoreId, defaultStorePassword, token) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    client.query('DELETE FROM customer_entry_sessions WHERE token = $1', [token])
  );
}

export async function issueCustomerToken(defaultStoreId, defaultStorePassword, tokenRecord) {
  return withWrite(defaultStoreId, defaultStorePassword, async client => {
    await client.query(
      `
        DELETE FROM customer_tokens
        WHERE store_id = $1 AND customer_id = $2
      `,
      [tokenRecord.storeId.toUpperCase(), tokenRecord.customerId]
    );

    await client.query(
      `
        INSERT INTO customer_tokens (token, store_id, customer_id, created_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (token) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          customer_id = EXCLUDED.customer_id,
          created_at = EXCLUDED.created_at,
          last_seen_at = EXCLUDED.last_seen_at
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
  return withRead(defaultStoreId, defaultStorePassword, client => readCustomerTokenRow(client, token));
}

export async function touchCustomerToken(defaultStoreId, defaultStorePassword, token, lastSeenAt) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    client.query(
      `
        UPDATE customer_tokens
        SET last_seen_at = $1
        WHERE token = $2
      `,
      [lastSeenAt, token]
    )
  );
}

export async function deleteCustomerTokensForCustomer(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    client.query(
      `
        DELETE FROM customer_tokens
        WHERE store_id = $1 AND customer_id = $2
      `,
      [storeId.toUpperCase(), customerId]
    )
  );
}

export async function upsertCustomerPushSubscription(defaultStoreId, defaultStorePassword, record) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    upsertCustomerPushSubscriptionRow(client, record)
  );
}

export async function listCustomerPushSubscriptions(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  return withRead(defaultStoreId, defaultStorePassword, client =>
    readCustomerPushSubscriptions(client, storeId, customerId)
  );
}

export async function deleteCustomerPushSubscription(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  endpoint
) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    removeCustomerPushSubscription(client, storeId, endpoint)
  );
}

export async function deleteCustomerPushSubscriptionsForCustomer(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  customerId
) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    removeCustomerPushSubscriptionsForCustomer(client, storeId, customerId)
  );
}

export async function createNotificationLog(defaultStoreId, defaultStorePassword, log) {
  return withWrite(defaultStoreId, defaultStorePassword, client => insertNotificationLogRow(client, log));
}

export async function updateNotificationLog(defaultStoreId, defaultStorePassword, id, patch) {
  return withWrite(defaultStoreId, defaultStorePassword, client =>
    updateNotificationLogRow(client, id, patch)
  );
}

export async function listNotificationLogs(
  defaultStoreId,
  defaultStorePassword,
  storeId,
  limit = 50
) {
  return withRead(defaultStoreId, defaultStorePassword, async client => {
    const rows = await execRows(
      client,
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
        WHERE store_id = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [storeId.toUpperCase(), limit]
    );

    return rows.map(rowToNotificationLog);
  });
}

export async function createQueueEvent(defaultStoreId, defaultStorePassword, event) {
  return withWrite(defaultStoreId, defaultStorePassword, client => insertQueueEventRow(client, event));
}

export async function listQueueEvents(defaultStoreId, defaultStorePassword, storeId, limit = 100) {
  return withRead(defaultStoreId, defaultStorePassword, async client => {
    const rows = await execRows(
      client,
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
        WHERE store_id = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [storeId.toUpperCase(), limit]
    );

    return rows.map(rowToQueueEvent);
  });
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
