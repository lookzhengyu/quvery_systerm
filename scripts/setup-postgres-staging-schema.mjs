import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseEnvFile } from './env-file-utils.mjs';
import { loadProjectEnv } from './load-project-env.mjs';
import {
  buildPgClientConfig,
  ensurePgSchema,
  normalizeConnectionString,
  normalizePgSchema,
} from './postgres-script-helpers.mjs';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const schemaFilePath = resolve(projectRoot, 'db', 'postgres', 'schema.sql');
const stagingEnvPath = resolve(projectRoot, '.env.staging.local');

await loadProjectEnv(['.env.staging.local', '.env.production.local']);

const postgresUrl = normalizeConnectionString(
  process.env.STAGING_POSTGRES_URL ??
    process.env.QUEUEFLOW_POSTGRES_URL ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    ''
);
const pgSchema = normalizePgSchema(
  process.env.QUEUEFLOW_STAGING_PG_SCHEMA ?? process.env.QUEUEFLOW_PG_SCHEMA ?? 'queueflow_staging'
);

function maskConnectionLabel(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname || ''}`;
  } catch {
    return '(unparsed connection string)';
  }
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value ?? ''));
}

async function upsertStagingEnvFile(values) {
  let existing = new Map();
  try {
    existing = parseEnvFile(await readFile(stagingEnvPath, 'utf8'));
  } catch {
    existing = new Map();
  }

  for (const [key, value] of Object.entries(values)) {
    existing.set(key, value);
  }

  const lines = [
    '# Local managed Postgres staging configuration.',
    '# This file is gitignored. Do not commit secrets.',
    ...[...existing.entries()].map(([key, value]) => `${key}=${quoteEnvValue(value)}`),
    '',
  ];
  await writeFile(stagingEnvPath, lines.join('\n'), 'utf8');
}

if (!postgresUrl) {
  throw new Error(
    'Missing Postgres URL. Pull production env or set STAGING_POSTGRES_URL/QUEUEFLOW_POSTGRES_URL.'
  );
}
if (pgSchema === 'public' && process.env.ALLOW_PUBLIC_STAGING_SCHEMA !== 'true') {
  throw new Error(
    'Refusing to use public as staging schema. Set QUEUEFLOW_STAGING_PG_SCHEMA=queueflow_staging.'
  );
}

const client = new Client(buildPgClientConfig(postgresUrl));
await client.connect();
try {
  await ensurePgSchema(client, pgSchema);
  const schemaSql = await readFile(schemaFilePath, 'utf8');
  await client.query(schemaSql);

  const countResult = await client.query('SELECT COUNT(*)::int AS stores FROM stores');
  await upsertStagingEnvFile({
    STAGING_POSTGRES_URL: postgresUrl,
    STAGING_TARGET_ENV: 'staging',
    QUEUEFLOW_STORAGE_PROVIDER: 'postgres',
    QUEUEFLOW_POSTGRES_URL: postgresUrl,
    QUEUEFLOW_PG_SSL: process.env.QUEUEFLOW_PG_SSL ?? 'require',
    QUEUEFLOW_PG_SCHEMA: pgSchema,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        connection: maskConnectionLabel(postgresUrl),
        pgSchema,
        storesInSchema: countResult.rows[0]?.stores ?? 0,
        wroteLocalEnv: '.env.staging.local',
      },
      null,
      2
    )
  );
} finally {
  await client.end().catch(() => {});
}
