import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadProjectEnv } from './load-project-env.mjs';

const { Pool } = pg;

await loadProjectEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const exportsDir = resolve(projectRoot, 'server', '.data', 'exports');
const schemaPath = resolve(projectRoot, 'db', 'postgres', 'schema.sql');
const postgresUrl = (
  process.env.QUEUEFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? ''
).trim();
const sslMode = (process.env.QUEUEFLOW_PG_SSL ?? '').trim().toLowerCase();

if (!postgresUrl.trim()) {
  throw new Error(
    'QUEUEFLOW_POSTGRES_URL or DATABASE_URL is required to import a snapshot into Postgres.'
  );
}

function buildPoolConfig() {
  const config = {
    connectionString: postgresUrl,
  };

  if (sslMode === 'true' || sslMode === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

async function resolveSnapshotPath() {
  const requestedPath = process.argv[2]?.trim();
  if (requestedPath) {
    return resolve(requestedPath);
  }

  const entries = await readdir(exportsDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => resolve(exportsDir, entry.name));

  if (candidates.length === 0) {
    throw new Error(
      'No snapshot file was provided and no exports were found under server/.data/exports.'
    );
  }

  candidates.sort();
  return candidates[candidates.length - 1];
}

function normalizeJson(value, fallback = {}) {
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

const snapshotPath = await resolveSnapshotPath();
const rawSnapshot = await readFile(snapshotPath, 'utf8');
const snapshot = JSON.parse(rawSnapshot);
const truncateFirst = process.argv.includes('--truncate');
const schemaSql = await readFile(schemaPath, 'utf8');

const pool = new Pool(buildPoolConfig());
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(schemaSql);

  if (truncateFirst) {
    await client.query(`
      TRUNCATE TABLE
        queue_events,
        notification_logs,
        customer_tokens,
        sessions,
        merchant_billing,
        merchant_profiles,
        stores
      RESTART IDENTITY CASCADE
    `);
  }

  let importedStores = 0;
  let importedNotificationLogs = 0;
  let importedQueueEvents = 0;

  for (const storeEntry of snapshot.stores ?? []) {
    const store = storeEntry.store;
    const profile = storeEntry.profile;
    const billing = storeEntry.billing;
    const notificationLogs = Array.isArray(storeEntry.notificationLogs)
      ? storeEntry.notificationLogs
      : [];
    const queueEvents = Array.isArray(storeEntry.queueEvents) ? storeEntry.queueEvents : [];

    if (!store?.storeId || !store?.storeName || !store?.credentials?.password) {
      continue;
    }

    await client.query(
      `
        INSERT INTO stores (store_id, store_name, password, queue_state_json, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (store_id) DO UPDATE SET
          store_name = EXCLUDED.store_name,
          password = EXCLUDED.password,
          queue_state_json = EXCLUDED.queue_state_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        store.storeId.toUpperCase(),
        store.storeName,
        store.credentials.password,
        JSON.stringify(normalizeJson(store.queueState, {})),
        store.updatedAt ?? new Date().toISOString(),
      ]
    );

    if (profile) {
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
          profile.storeId.toUpperCase(),
          profile.ownerName,
          profile.ownerEmail,
          profile.contactPhone ?? '',
          profile.planCode,
          profile.subscriptionStatus,
          profile.billingCycle,
          profile.onboardingStatus,
          profile.qrIssuedAt,
          profile.createdAt,
          profile.activatedAt,
          profile.trialEndsAt ?? null,
          profile.updatedAt ?? new Date().toISOString(),
        ]
      );
    }

    if (billing) {
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
          billing.storeId.toUpperCase(),
          billing.stripeCustomerId ?? null,
          billing.stripeSubscriptionId ?? null,
          billing.stripePriceId ?? null,
          billing.stripeCheckoutSessionId ?? null,
          billing.currentPeriodEnd ?? null,
          Boolean(billing.cancelAtPeriodEnd),
          billing.lastInvoiceStatus ?? null,
          billing.lastCheckoutAt ?? null,
          billing.createdAt ?? new Date().toISOString(),
          billing.updatedAt ?? new Date().toISOString(),
        ]
      );
    }

    for (const log of notificationLogs) {
      await client.query(
        `
          INSERT INTO notification_logs (
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
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
          ON CONFLICT (id) DO UPDATE SET
            store_id = EXCLUDED.store_id,
            customer_id = EXCLUDED.customer_id,
            channel = EXCLUDED.channel,
            recipient = EXCLUDED.recipient,
            event_type = EXCLUDED.event_type,
            subject = EXCLUDED.subject,
            body = EXCLUDED.body,
            status = EXCLUDED.status,
            provider = EXCLUDED.provider,
            error_message = EXCLUDED.error_message,
            metadata_json = EXCLUDED.metadata_json,
            created_at = EXCLUDED.created_at,
            sent_at = EXCLUDED.sent_at
        `,
        [
          log.id,
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
          JSON.stringify(normalizeJson(log.metadata, {})),
          log.createdAt,
          log.sentAt ?? null,
        ]
      );
      importedNotificationLogs += 1;
    }

    for (const event of queueEvents) {
      await client.query(
        `
          INSERT INTO queue_events (
            id,
            store_id,
            customer_id,
            queue_number,
            party_size,
            event_type,
            wait_ms,
            metadata_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          ON CONFLICT (id) DO UPDATE SET
            store_id = EXCLUDED.store_id,
            customer_id = EXCLUDED.customer_id,
            queue_number = EXCLUDED.queue_number,
            party_size = EXCLUDED.party_size,
            event_type = EXCLUDED.event_type,
            wait_ms = EXCLUDED.wait_ms,
            metadata_json = EXCLUDED.metadata_json,
            created_at = EXCLUDED.created_at
        `,
        [
          event.id,
          event.storeId.toUpperCase(),
          event.customerId ?? null,
          event.queueNumber ?? null,
          event.partySize ?? null,
          event.eventType,
          event.waitMs ?? null,
          JSON.stringify(normalizeJson(event.metadata, {})),
          event.createdAt,
        ]
      );
      importedQueueEvents += 1;
    }

    importedStores += 1;
  }

  await client.query(`
    SELECT
      setval(
        pg_get_serial_sequence('notification_logs', 'id'),
        COALESCE((SELECT MAX(id) FROM notification_logs), 1),
        true
      ),
      setval(
        pg_get_serial_sequence('queue_events', 'id'),
        COALESCE((SELECT MAX(id) FROM queue_events), 1),
        true
      )
  `);

  await client.query('COMMIT');

  console.log(
    JSON.stringify(
      {
        ok: true,
        snapshotPath,
        truncateFirst,
        importedStores,
        importedNotificationLogs,
        importedQueueEvents,
      },
      null,
      2
    )
  );
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Ignore rollback errors after a failed import.
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
