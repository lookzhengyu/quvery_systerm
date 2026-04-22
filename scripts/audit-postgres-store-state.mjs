import pg from 'pg';
import {
  normalizeQueueState,
  validateQueueStateInvariants,
} from '../server/queue-domain.mjs';
import { loadProjectEnv } from './load-project-env.mjs';
import {
  buildPgClientConfig,
  normalizeConnectionString,
  normalizePgSchema,
  setPgSchemaSearchPath,
} from './postgres-script-helpers.mjs';

const { Client } = pg;

await loadProjectEnv(['.env.staging.local', '.env.production.local']);

function buildPgClient() {
  const postgresUrl = normalizeConnectionString(
    process.env.STAGING_POSTGRES_URL ??
      process.env.QUEUEFLOW_POSTGRES_URL ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL ??
      ''
  );

  if (!postgresUrl) {
    throw new Error('Missing STAGING_POSTGRES_URL, QUEUEFLOW_POSTGRES_URL, DATABASE_URL, or POSTGRES_URL.');
  }

  return new Client(buildPgClientConfig(postgresUrl));
}

function summarizeState(queueState) {
  const state = normalizeQueueState(queueState);
  return {
    version: state.version,
    nextQueueNumber: state.nextQueueNumber,
    autoMode: state.autoMode,
    isTablesConfigured: state.isTablesConfigured,
    customers: state.customers.map(customer => ({
      id: customer.id,
      source: customer.source,
      status: customer.status,
      queueNumber: customer.queueNumber,
      partySize: customer.partySize,
      assignedTableId: customer.assignedTableId ?? null,
      hasCallTime: Boolean(customer.callTime),
      hasExpiredAt: Boolean(customer.expiredAt),
    })),
    tables: state.tables.map(table => ({
      id: table.id,
      name: table.name,
      capacity: table.capacity,
      status: table.status,
      assignedCustomerId: table.assignedCustomerId ?? null,
    })),
    invariantErrors: validateQueueStateInvariants(state),
  };
}

const storeId = (process.argv[2] ?? '').trim().toUpperCase();
if (!storeId) {
  throw new Error('Usage: node scripts/audit-postgres-store-state.mjs STORE_ID');
}

const client = buildPgClient();
const pgSchema = normalizePgSchema(process.env.QUEUEFLOW_PG_SCHEMA ?? 'public');
await client.connect();
try {
  await setPgSchemaSearchPath(client, pgSchema);
  const result = await client.query(
    `
      SELECT store_id, store_name, queue_state_json, updated_at
      FROM stores
      WHERE store_id = $1
    `,
    [storeId]
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    console.log(JSON.stringify({ ok: false, storeId, error: 'store_not_found' }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          storeId: row.store_id,
          storeName: row.store_name,
          schema: pgSchema,
          updatedAt: row.updated_at,
          state: summarizeState(row.queue_state_json),
        },
        null,
        2
      )
    );
  }
} finally {
  await client.end().catch(() => {});
}
