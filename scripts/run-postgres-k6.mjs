import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './load-project-env.mjs';
import { normalizeConnectionString, normalizePgSchema } from './postgres-script-helpers.mjs';

await loadProjectEnv(['.env.staging.local']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const serverScriptPath = join(projectRoot, 'server', 'mock-queue-server.mjs');
const k6ScriptPath = join(projectRoot, 'load', 'queue-hotspot.k6.js');
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
      'Refusing to run k6 against production env. Use a staging Postgres URL, or set ALLOW_PRODUCTION_LOAD_TEST=true intentionally.'
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

function runK6(baseUrl) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      'k6',
      [
        'run',
        '--summary-export',
        join(projectRoot, 'artifacts', 'k6-postgres-summary.json'),
        k6ScriptPath,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          BASE_URL: baseUrl,
        },
        stdio: 'inherit',
      }
    );

    child.on('error', error => {
      rejectRun(
        new Error(
          `Unable to start k6. Install k6 first, then rerun npm run load:k6:postgres. ${error.message}`
        )
      );
    });
    child.on('exit', code => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(new Error(`k6 exited with code ${code}.`));
    });
  });
}

const server = await startPostgresServer();
try {
  await mkdir(join(projectRoot, 'artifacts'), { recursive: true });
  await runK6(server.baseUrl);
} finally {
  await server.stop().catch(() => {});
}
