import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

await loadProjectEnv(['.env.staging.local']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverScriptPath = join(projectRoot, 'server', 'mock-queue-server.mjs');
const artilleryScriptPath = join(
  projectRoot,
  process.env.QUEUEFLOW_ARTILLERY_SCRIPT ?? join('load', 'queue-hotspot.artillery.yml')
);
const artifactsDir = join(projectRoot, 'artifacts');
const artilleryReportPath = join(artifactsDir, 'artillery-postgres-report.json');
const postgresUrl = normalizeConnectionString(
  process.env.STAGING_POSTGRES_URL ??
    process.env.QUEUEFLOW_POSTGRES_URL ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    ''
);
const pgSchema = normalizePgSchema(process.env.QUEUEFLOW_PG_SCHEMA ?? 'public');
const targetEnv = (
  process.env.STAGING_TARGET_ENV ??
  process.env.VERCEL_ENV ??
  process.env.VERCEL_TARGET_ENV ??
  'staging'
).trim().toLowerCase();
const cleanupEnabled =
  (process.env.QUEUEFLOW_STAGING_CLEANUP ?? 'true').trim().toLowerCase() !== 'false';

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
  if (targetEnv === 'production' && process.env.ALLOW_PRODUCTION_LOAD_TEST !== 'true') {
    throw new Error(
      'Refusing to run Artillery against production env. Use staging Postgres, or set ALLOW_PRODUCTION_LOAD_TEST=true intentionally.'
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
      QUEUEFLOW_RATE_LIMIT_GLOBAL_LIMIT: process.env.QUEUEFLOW_RATE_LIMIT_GLOBAL_LIMIT ?? '5000',
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
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    payload,
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
    storeName: `Artillery Queue ${suffix}`,
    ownerName: 'QueueFlow Load',
    ownerEmail: `artillery-${suffix}@example.com`,
    contactPhone: '+60 12-345 6789',
    password: `Artillery-${suffix}-Password`,
    planCode: 'scale',
  });

  assert.equal(response.status, 201, JSON.stringify(response.payload));
  return response.payload;
}

async function configureTable(baseUrl, storeId, merchantToken) {
  const response = await postJson(
    baseUrl,
    `/stores/${storeId}/tables/configure`,
    {
      expectedVersion: 1,
      tables: [{ id: 'table-a', name: 'Table A', capacity: 4 }],
    },
    {
      Authorization: `Bearer ${merchantToken}`,
    }
  );

  assert.equal(response.status, 200, JSON.stringify(response.payload));
}

function runArtillery(baseUrl, storeId, merchantToken) {
  const useBundledWindowsNpx = process.platform === 'win32';
  const npxCliPath = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const command = useBundledWindowsNpx ? process.execPath : 'npx';
  const commandArgs = [
    ...(useBundledWindowsNpx ? [npxCliPath] : []),
    'artillery',
    'run',
    '--target',
    baseUrl,
    '--output',
    artilleryReportPath,
    artilleryScriptPath,
  ];
  const allowedEnvKeys = [
    'ALLUSERSPROFILE',
    'APPDATA',
    'ComSpec',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'NODE_OPTIONS',
    'NPM_CONFIG_CACHE',
    'Path',
    'PATH',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'windir',
  ];
  const childEnv = Object.fromEntries(
    allowedEnvKeys
      .filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]])
  );
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env: {
        ...childEnv,
        QUEUEFLOW_LOAD_STORE_ID: storeId,
        QUEUEFLOW_LOAD_MERCHANT_TOKEN: merchantToken,
      },
      stdio: 'inherit',
    });

    child.on('error', error => {
      rejectRun(new Error(`Unable to start Artillery through npx. ${error.message}`));
    });
    child.on('exit', code => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`Artillery exited with code ${code}.`));
    });
  });
}

async function fetchMerchantState(baseUrl, storeId, merchantToken) {
  const response = await jsonRequest(baseUrl, `/stores/${storeId}/queue-state`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return normalizeQueueState(response.payload);
}

function summarizeArtilleryReport(report) {
  const aggregate = report?.aggregate ?? {};
  const latency = aggregate.summaries?.['http.response_time'] ?? {};
  return {
    scenariosCreated: aggregate.counters?.['vusers.created'] ?? 0,
    scenariosCompleted: aggregate.counters?.['vusers.completed'] ?? 0,
    scenariosFailed: aggregate.counters?.['vusers.failed'] ?? 0,
    httpRequests: aggregate.counters?.['http.requests'] ?? 0,
    codes: Object.fromEntries(
      Object.entries(aggregate.counters ?? {})
        .filter(([key]) => key.startsWith('http.codes.'))
        .map(([key, value]) => [key.replace('http.codes.', ''), value])
    ),
    errors: Object.fromEntries(
      Object.entries(aggregate.counters ?? {}).filter(([key]) => key.startsWith('errors.'))
    ),
    latencyMs: {
      min: latency.min ?? null,
      max: latency.max ?? null,
      median: latency.median ?? null,
      p95: latency.p95 ?? null,
      p99: latency.p99 ?? null,
    },
  };
}

function summarizeQueueState(state) {
  const invariantErrors = validateQueueStateInvariants(state);
  const queueNumbers = state.customers.map(customer => customer.queueNumber);
  return {
    invariantErrors,
    duplicateQueueNumbers: queueNumbers.length - new Set(queueNumbers).size,
    version: state.version,
    nextQueueNumber: state.nextQueueNumber,
    customers: state.customers.length,
    tables: state.tables.length,
    statuses: state.customers.reduce((counts, customer) => {
      counts[customer.status] = (counts[customer.status] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

async function run() {
  await mkdir(artifactsDir, { recursive: true });
  const server = await startPostgresServer();
  let registration;

  try {
    registration = await registerStore(server.baseUrl);
    const storeId = registration.auth.storeId;
    const merchantToken = registration.token;
    await configureTable(server.baseUrl, storeId, merchantToken);
    await runArtillery(server.baseUrl, storeId, merchantToken);

    const [reportRaw, finalState] = await Promise.all([
      readFile(artilleryReportPath, 'utf8'),
      fetchMerchantState(server.baseUrl, storeId, merchantToken),
    ]);
    const queue = summarizeQueueState(finalState);
    const artillery = summarizeArtilleryReport(JSON.parse(reportRaw));
    assert.ok(artillery.httpRequests > 0, 'Artillery did not send any HTTP requests.');
    assert.equal(artillery.scenariosFailed, 0, 'Artillery virtual users failed.');
    assert.deepEqual(queue.invariantErrors, []);
    assert.equal(queue.duplicateQueueNumbers, 0);

    console.log(
      JSON.stringify(
        {
          ok: true,
          storeId,
          artillery,
          queue,
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
