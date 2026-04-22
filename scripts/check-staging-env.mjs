import { loadProjectEnv } from './load-project-env.mjs';
import { normalizeConnectionString, normalizePgSchema } from './postgres-script-helpers.mjs';

await loadProjectEnv(['.env.staging.local']);

const postgresUrl = (
  normalizeConnectionString(
    process.env.STAGING_POSTGRES_URL ??
      process.env.QUEUEFLOW_POSTGRES_URL ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_URL ??
      ''
  )
);
const targetEnv = (
  process.env.STAGING_TARGET_ENV ??
  process.env.VERCEL_ENV ??
  process.env.VERCEL_TARGET_ENV ??
  'staging'
).trim().toLowerCase();
const pgSchema = normalizePgSchema(process.env.QUEUEFLOW_PG_SCHEMA ?? 'public');

function maskConnectionLabel(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname || ''}`;
  } catch {
    return '(unparsed connection string)';
  }
}

const result = {
  ok: Boolean(postgresUrl) && targetEnv !== 'production' && pgSchema !== 'public',
  hasPostgresUrl: Boolean(postgresUrl),
  targetEnv,
  pgSchema,
  connection: postgresUrl ? maskConnectionLabel(postgresUrl) : null,
  safeToRunWriteTests: Boolean(postgresUrl) && targetEnv !== 'production' && pgSchema !== 'public',
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}
