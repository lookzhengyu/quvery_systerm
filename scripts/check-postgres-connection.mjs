import pg from 'pg';
import { loadProjectEnv } from './load-project-env.mjs';
import {
  buildPgClientConfig,
  normalizeConnectionString,
  normalizePgSchema,
  setPgSchemaSearchPath,
} from './postgres-script-helpers.mjs';

const { Client } = pg;

await loadProjectEnv(['.env.staging.local', '.env.production.local']);

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

function buildConnectionLabel(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\/+/, '')}`;
  } catch {
    return '(unparsed connection string)';
  }
}

if (!postgresUrl.trim()) {
  throw new Error(
    'Missing Postgres connection string. Set QUEUEFLOW_POSTGRES_URL, DATABASE_URL, or POSTGRES_URL first.'
  );
}

const client = new Client(buildPgClientConfig(postgresUrl));

try {
  await client.connect();
  await setPgSchemaSearchPath(client, pgSchema);
  const result = await client.query(`
    SELECT
      current_database() AS database_name,
      current_schema() AS schema_name,
      current_user AS current_user_name,
      now() AS server_time
  `);
  const row = result.rows[0] ?? {};

  console.log(
    JSON.stringify(
      {
        ok: true,
        connection: buildConnectionLabel(postgresUrl),
        database: row.database_name ?? null,
        schema: row.schema_name ?? null,
        user: row.current_user_name ?? null,
        serverTime: row.server_time ?? null,
      },
      null,
      2
    )
  );
} finally {
  await client.end().catch(() => {});
}
