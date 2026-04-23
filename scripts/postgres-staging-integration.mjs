import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadProjectEnv } from './load-project-env.mjs';
import {
  buildPgClientConfig,
  normalizeConnectionString,
  normalizePgSchema,
  setPgSchemaSearchPath,
} from './postgres-script-helpers.mjs';

const { Client } = pg;

await loadProjectEnv(['.env.staging.local']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverScriptPath = join(projectRoot, 'server', 'mock-queue-server.mjs');
const postgresUrl = (
  normalizeConnectionString(
    process.env.STAGING_POSTGRES_URL ??
      process.env.QUEUEFLOW_POSTGRES_URL ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL ??
      ''
  )
);
const pgSchema = normalizePgSchema(process.env.QUEUEFLOW_PG_SCHEMA ?? 'public');
const targetEnv = (
  process.env.STAGING_TARGET_ENV ??
  process.env.VERCEL_ENV ??
  process.env.VERCEL_TARGET_ENV ??
  'staging'
).trim().toLowerCase();

const joinConcurrency = parsePositiveInteger(process.env.QUEUEFLOW_STAGING_JOIN_CONCURRENCY, 15);
const walkInConcurrency = parsePositiveInteger(process.env.QUEUEFLOW_STAGING_WALKIN_CONCURRENCY, 30);
const cleanupEnabled = (process.env.QUEUEFLOW_STAGING_CLEANUP ?? 'true').trim().toLowerCase() !== 'false';

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1
  );
  return Math.round(sorted[index]);
}

function summarizeLatencies(samples) {
  return {
    count: samples.length,
    minMs: samples.length ? Math.min(...samples) : 0,
    maxMs: samples.length ? Math.max(...samples) : 0,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
  };
}

function buildPgClient() {
  return new Client(buildPgClientConfig(postgresUrl));
}

async function cleanupStore(storeId) {
  if (!cleanupEnabled || !storeId) {
    return false;
  }

  const client = buildPgClient();
  await client.connect();
  try {
    await setPgSchemaSearchPath(client, pgSchema);
    await client.query('DELETE FROM stores WHERE store_id = $1', [storeId.toUpperCase()]);
    return true;
  } finally {
    await client.end().catch(() => {});
  }
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolvePort(address.port);
          return;
        }

        rejectPort(new Error('Unable to allocate a free port.'));
      });
    });
    server.on('error', rejectPort);
  });
}

async function startPostgresServer() {
  if (!postgresUrl) {
    throw new Error(
      'Missing managed Postgres staging URL. Set STAGING_POSTGRES_URL or QUEUEFLOW_POSTGRES_URL.'
    );
  }
  if (targetEnv === 'production' && process.env.ALLOW_PRODUCTION_STAGING_TEST !== 'true') {
    throw new Error(
      'Refusing to run write-heavy staging integration against production env. Use a staging Postgres URL, or set ALLOW_PRODUCTION_STAGING_TEST=true intentionally.'
    );
  }

  const port = await getFreePort();
  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      QUEUEFLOW_STORAGE_PROVIDER: 'postgres',
      QUEUEFLOW_POSTGRES_URL: postgresUrl,
      QUEUEFLOW_PG_SSL: process.env.QUEUEFLOW_PG_SSL ?? 'require',
      QUEUEFLOW_PG_SCHEMA: pgSchema,
      QUEUEFLOW_PG_POOL_MAX: process.env.QUEUEFLOW_PG_POOL_MAX ?? '20',
      QUEUEFLOW_PG_CONNECTION_TIMEOUT_MS:
        process.env.QUEUEFLOW_PG_CONNECTION_TIMEOUT_MS ?? '30000',
      QUEUEFLOW_PG_LOCK_TIMEOUT_MS: process.env.QUEUEFLOW_PG_LOCK_TIMEOUT_MS ?? '45000',
      QUEUEFLOW_PG_STATEMENT_TIMEOUT_MS:
        process.env.QUEUEFLOW_PG_STATEMENT_TIMEOUT_MS ?? '60000',
      QUEUEFLOW_PG_TRANSACTION_RETRIES: process.env.QUEUEFLOW_PG_TRANSACTION_RETRIES ?? '4',
      DEFAULT_STORE_ID: process.env.DEFAULT_STORE_ID ?? 'STAGING-SEED',
      DEFAULT_STORE_PASSWORD: process.env.DEFAULT_STORE_PASSWORD ?? 'staging-seed-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const waitForReady = new Promise((resolveReady, rejectReady) => {
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('Mock queue server listening on')) {
        resolveReady();
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.once('exit', code => {
      rejectReady(new Error(`Server exited early with code ${code}. ${stderr}`.trim()));
    });
  });

  await waitForReady;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolveStop => {
        child.once('exit', () => resolveStop());
      });
    },
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    payload,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function postJson(baseUrl, pathname, body, headers = {}) {
  return jsonRequest(baseUrl, pathname, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function registerStore(baseUrl) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await postJson(baseUrl, '/merchant/register', {
    storeName: `Staging Queue ${suffix}`,
    ownerName: 'QueueFlow Staging',
    ownerEmail: `staging-${suffix}@example.com`,
    contactPhone: '+60 12-345 6789',
    password: `Staging-${suffix}-Password`,
    planCode: 'scale',
  });

  assert.equal(response.status, 201, JSON.stringify(response.payload));
  return response.payload;
}

async function configureTables(baseUrl, storeId, token, tables) {
  const response = await postJson(
    baseUrl,
    `/stores/${storeId}/tables/configure`,
    {
      expectedVersion: 1,
      tables,
    },
    {
      Authorization: `Bearer ${token}`,
    }
  );

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload.state;
}

async function fetchMerchantState(baseUrl, storeId, token) {
  const response = await jsonRequest(baseUrl, `/stores/${storeId}/queue-state`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload;
}

async function fetchEntryToken(baseUrl, storeId) {
  const response = await jsonRequest(baseUrl, `/stores/${storeId}/customer-entry-session`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload.token;
}

async function joinCustomer(baseUrl, storeId, body, entryToken) {
  const token = entryToken ?? (await fetchEntryToken(baseUrl, storeId));
  return postJson(baseUrl, `/stores/${storeId}/customers/join`, body, {
    'X-Queue-Entry-Token': token,
  });
}

async function walkInCustomer(baseUrl, storeId, token, index) {
  return postJson(
    baseUrl,
    `/stores/${storeId}/customers/walk-in`,
    {
      partySize: 2,
      name: `Walk In ${index}`,
    },
    {
      Authorization: `Bearer ${token}`,
    }
  );
}

function assertQueueInvariants(state) {
  const queueNumbers = state.customers.map(customer => customer.queueNumber);
  assert.equal(new Set(queueNumbers).size, queueNumbers.length, 'queue numbers must be unique');
  const maxQueueNumber = queueNumbers.length > 0 ? Math.max(...queueNumbers) : 0;
  assert.ok(state.nextQueueNumber > maxQueueNumber, 'nextQueueNumber must be ahead of issued numbers');

  for (const table of state.tables) {
    if (!table.assignedCustomerId) {
      continue;
    }

    const customer = state.customers.find(entry => entry.id === table.assignedCustomerId);
    if (customer) {
      assert.equal(customer.assignedTableId, table.id, 'table/customer assignment must agree');
    }
  }
}

async function run() {
  const server = await startPostgresServer();
  const latencies = [];
  const checks = [];
  let registration;

  try {
    const health = await jsonRequest(server.baseUrl, '/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    latencies.push(health.durationMs);
    assert.equal(health.status, 200, JSON.stringify(health.payload));
    assert.equal(health.payload.storageProvider, 'postgres');
    assert.equal(health.payload.storageProductionReady, true);
    checks.push('health:postgres');

    registration = await registerStore(server.baseUrl);
    latencies.push(0);
    const storeId = registration.auth.storeId;
    const merchantToken = registration.token;

    await configureTables(server.baseUrl, storeId, merchantToken, [
      { id: 'table-a', name: 'Table A', capacity: 4 },
      { id: 'table-b', name: 'Table B', capacity: 4 },
    ]);
    checks.push('configure:tables');

    const replayEntryToken = await fetchEntryToken(server.baseUrl, storeId);
    const firstJoin = await joinCustomer(
      server.baseUrl,
      storeId,
      { phone: '60170000000', partySize: 2 },
      replayEntryToken
    );
    const replayedJoin = await joinCustomer(
      server.baseUrl,
      storeId,
      { phone: '60170000000', partySize: 2 },
      replayEntryToken
    );
    const conflictingReplay = await joinCustomer(
      server.baseUrl,
      storeId,
      { phone: '60170000001', partySize: 2 },
      replayEntryToken
    );
    latencies.push(firstJoin.durationMs, replayedJoin.durationMs, conflictingReplay.durationMs);
    assert.equal(firstJoin.status, 200, JSON.stringify(firstJoin.payload));
    assert.equal(replayedJoin.status, 200, JSON.stringify(replayedJoin.payload));
    assert.equal(replayedJoin.payload.customer.id, firstJoin.payload.customer.id);
    assert.equal(replayedJoin.payload.customerToken, firstJoin.payload.customerToken);
    assert.equal(conflictingReplay.status, 409, JSON.stringify(conflictingReplay.payload));
    checks.push('join:replay-safe');

    const joins = await Promise.all(
      Array.from({ length: joinConcurrency }, (_, index) =>
        joinCustomer(server.baseUrl, storeId, {
          phone: `60171${String(index).padStart(7, '0')}`,
          partySize: 2,
        })
      )
    );
    latencies.push(...joins.map(result => result.durationMs));
    assert.equal(joins.every(result => result.status === 200), true, JSON.stringify(joins));
    checks.push(`join:concurrent:${joinConcurrency}`);

    const walkIns = await Promise.all(
      Array.from({ length: walkInConcurrency }, (_, index) =>
        walkInCustomer(server.baseUrl, storeId, merchantToken, index)
      )
    );
    latencies.push(...walkIns.map(result => result.durationMs));
    assert.equal(walkIns.every(result => result.status === 200), true, JSON.stringify(walkIns));
    checks.push(`walk-in:hotspot:${walkInConcurrency}`);

    const stateBeforeCall = await fetchMerchantState(server.baseUrl, storeId, merchantToken);
    assertQueueInvariants(stateBeforeCall);
    const waitingCustomers = stateBeforeCall.customers.filter(customer => customer.status === 'waiting');
    const lockCandidates = waitingCustomers.filter(
      customer => customer.id !== firstJoin.payload.customer.id
    );
    assert.ok(lockCandidates.length >= 2, 'expected waiting customers for call lock test');

    const [firstCall, secondCall] = await Promise.all([
      postJson(
        server.baseUrl,
        `/stores/${storeId}/customers/${lockCandidates[0].id}/call`,
        { tableId: 'table-a' },
        { Authorization: `Bearer ${merchantToken}` }
      ),
      postJson(
        server.baseUrl,
        `/stores/${storeId}/customers/${lockCandidates[1].id}/call`,
        { tableId: 'table-a' },
        { Authorization: `Bearer ${merchantToken}` }
      ),
    ]);
    latencies.push(firstCall.durationMs, secondCall.durationMs);
    assert.deepEqual([firstCall.status, secondCall.status].sort(), [200, 409]);
    checks.push('call:single-table-lock');

    const callTarget = firstJoin.payload.customer.id;
    const callResponse = await postJson(
      server.baseUrl,
      `/stores/${storeId}/customers/${callTarget}/call`,
      { tableId: 'table-b' },
      { Authorization: `Bearer ${merchantToken}` }
    );
    latencies.push(callResponse.durationMs);
    assert.equal(callResponse.status, 200, JSON.stringify(callResponse.payload));

    const confirmHeaders = { 'X-Queue-Customer-Token': firstJoin.payload.customerToken };
    const firstConfirm = await postJson(
      server.baseUrl,
      `/stores/${storeId}/customers/${callTarget}/confirm`,
      {},
      confirmHeaders
    );
    const secondConfirm = await postJson(
      server.baseUrl,
      `/stores/${storeId}/customers/${callTarget}/confirm`,
      {},
      confirmHeaders
    );
    latencies.push(firstConfirm.durationMs, secondConfirm.durationMs);
    assert.equal(firstConfirm.status, 200, JSON.stringify(firstConfirm.payload));
    assert.equal(secondConfirm.status, 200, JSON.stringify(secondConfirm.payload));
    checks.push('confirm:retry-safe');

    const events = await jsonRequest(server.baseUrl, `/stores/${storeId}/queue-events`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
      },
    });
    assert.equal(events.status, 200, JSON.stringify(events.payload));
    const confirmedEvents = events.payload.events.filter(
      event => event.eventType === 'confirmed' && event.customerId === callTarget
    );
    assert.equal(confirmedEvents.length, 1, 'repeated confirm should create one event');
    checks.push('events:no-duplicate-confirm');

    const finalState = await fetchMerchantState(server.baseUrl, storeId, merchantToken);
    assertQueueInvariants(finalState);
    checks.push('state:invariants');

    console.log(
      JSON.stringify(
        {
          ok: true,
          storeId,
          checks,
          latency: summarizeLatencies(latencies.filter(value => value > 0)),
          totals: {
            customers: finalState.customers.length,
            tables: finalState.tables.length,
            queueEvents: events.payload.events.length,
          },
        },
        null,
        2
      )
    );
  } finally {
    await server.stop().catch(() => {});
    if (registration?.auth?.storeId) {
      await cleanupStore(registration.auth.storeId).catch(error => {
        console.error(
          JSON.stringify({
            ok: false,
            cleanupError: error instanceof Error ? error.message : String(error),
            storeId: registration.auth.storeId,
          })
        );
      });
    }
  }
}

try {
  await run();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
