import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { envMapToObject, readEnvFile } from './env-file-utils.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const productionUrl = (
  process.env.PRODUCTION_URL ?? 'https://quvery-systerm.vercel.app'
).replace(/\/+$/g, '');
const productionSmokeStoreId = (process.env.PRODUCTION_SMOKE_STORE_ID ?? 'LOOK-XUNT').toUpperCase();

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: process.platform === 'win32',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    if (options.capture) {
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });
    }

    child.on('error', rejectRun);
    child.on('exit', code => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        resolveRun({ stdout, stderr, durationMs });
        return;
      }

      rejectRun(
        new Error(
          `${command} ${args.join(' ')} failed with code ${code}.${stderr ? `\n${stderr}` : ''}`
        )
      );
    });
  });
}

async function runStep(name, callback) {
  const startedAt = Date.now();
  process.stdout.write(`\n[production-go] ${name}\n`);
  await callback();
  console.log(
    JSON.stringify({
      ok: true,
      step: name,
      durationMs: Date.now() - startedAt,
    })
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'queueflow-production-go-check/1.0',
    },
  });
  const payload = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    payload,
  };
}

function buildProductionEnv(productionEnvFile) {
  return {
    ...envMapToObject(productionEnvFile),
    QUEUEFLOW_PG_SCHEMA: 'public',
  };
}

async function main() {
  const productionEnvFile = await readEnvFile(resolve(projectRoot, '.env.production.local'));
  const productionEnv = buildProductionEnv(productionEnvFile);

  await runStep('lint', () => runCommand('npm', ['run', 'lint']));
  await runStep('unit tests', () => runCommand('npm', ['test']));
  await runStep('build', () => runCommand('npm', ['run', 'build']));
  await runStep('staging env is isolated', () => runCommand('npm', ['run', 'check:staging-env']));
  await runStep('managed Postgres staging integration', () =>
    runCommand('npm', ['run', 'test:postgres:staging'])
  );
  await runStep('managed Postgres hotspot load', () =>
    runCommand('npm', ['run', 'load:artillery:postgres'])
  );
  await runStep('production Postgres public schema', () =>
    runCommand('npm', ['run', 'check:postgres'], { env: productionEnv })
  );
  await runStep('production health endpoint', async () => {
    const health = await fetchJson(`${productionUrl}/api/health`);
    assert.equal(health.status, 200, JSON.stringify(health.payload));
    assert.equal(health.payload?.storageProvider, 'postgres');
    assert.equal(health.payload?.storageProductionReady, true);
    assert.equal(health.payload?.stores, undefined);
    assert.equal(health.payload?.notificationMissingEnv, undefined);
  });
  await runStep('production public queue smoke', async () => {
    const state = await fetchJson(
      `${productionUrl}/api/stores/${productionSmokeStoreId}/public-queue-state`
    );
    assert.equal(state.status, 200, JSON.stringify(state.payload));
    assert.equal(state.payload?.auth?.storeId, productionSmokeStoreId);
    assert.equal(Array.isArray(state.payload?.customers), true);
    assert.equal(Array.isArray(state.payload?.tables), true);
  });
  await runStep('Vercel production error log scan', async () => {
    const logs = await runCommand(
      'npx',
      [
        'vercel',
        'logs',
        productionUrl,
        '--no-follow',
        '--level',
        'error',
        '--since',
        '10m',
        '--limit',
        '20',
      ],
      { capture: true }
    );
    const combinedOutput = `${logs.stdout}\n${logs.stderr}`;
    assert.doesNotMatch(combinedOutput, /status:\s*500|Unhandled|Exception|Error:/i);
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        productionGo: true,
        productionUrl,
        productionSmokeStoreId,
      },
      null,
      2
    )
  );
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        productionGo: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
