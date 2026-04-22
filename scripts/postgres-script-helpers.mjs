export function normalizeConnectionString(value) {
  return String(value ?? '')
    .replace(/(?:\\r|\\n|\r|\n)+$/g, '')
    .trim();
}

export function normalizePgSchema(value) {
  const normalized = String(value ?? 'public').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(normalized)) {
    throw new Error('QUEUEFLOW_PG_SCHEMA must be a valid Postgres identifier.');
  }

  return normalized;
}

export function quotePgIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function ensurePgSchema(client, schema) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)}`);
  await setPgSchemaSearchPath(client, schema);
}

export async function setPgSchemaSearchPath(client, schema) {
  await client.query(`SET search_path TO ${quotePgIdentifier(schema)}`);
}

export function buildPgClientConfig(connectionString) {
  const sslMode = (process.env.QUEUEFLOW_PG_SSL ?? '').trim().toLowerCase();
  return {
    connectionString,
    ...(sslMode === 'true' || sslMode === 'require'
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  };
}
