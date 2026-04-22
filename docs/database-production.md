# QueueFlow Database Plan

## Short answer

Yes, a database is required.

The app already has one today:

- Current runtime storage: local `SQLite` file via `sql.js`
- Current file: `server/.data/queueflow.sqlite`

That is acceptable for:

- local development
- single-machine demos
- one small server with persistent disk

That is not the final shape for:

- multiple app instances
- managed cloud deployment
- production failover / scaling
- long-term paid SaaS operations

## What was added now

This repo now includes the first production-database migration layer:

- `server/store.mjs`
  Central storage entrypoint so the server stops depending directly on `sqlite-store.mjs`
- `server/pg-store.mjs`
  Postgres runtime implementation with the same API as the current SQLite store
- `db/postgres/schema.sql`
  Production Postgres schema that mirrors the current data model
- `npm run export:data`
  Exports the current SQLite store into a migration-friendly JSON snapshot
- `npm run import:data:postgres`
  Imports a snapshot into Postgres

## Recommended production target

Use a managed Postgres database, for example:

- Supabase Postgres
- Neon Postgres
- AWS RDS Postgres

Why Postgres is the right next step:

- better durability than a single local SQLite file
- safer concurrent writes for multi-merchant traffic
- easier backups and restore workflows
- easier future analytics / reporting queries
- cleaner fit for Stripe billing and long-term notification logs

## Migration order

1. Keep using SQLite for local development.
2. Provision a managed Postgres database.
3. Apply [`db/postgres/schema.sql`](../db/postgres/schema.sql).
4. Run `npm run export:data` to generate a snapshot from the current SQLite data.
5. Set:
   `QUEUEFLOW_STORAGE_PROVIDER=postgres`
   `QUEUEFLOW_POSTGRES_URL=postgresql://...`
6. Run `npm run import:data:postgres -- <snapshot-path>` or let it import the latest snapshot.
7. Start the app against Postgres and verify `/health` reports `storageProvider: postgres`.

## Supabase quick start

If you are using Supabase specifically:

1. Create a Supabase project.
2. Copy the Postgres connection string from Supabase.
   For production on Vercel, prefer the transaction pooler URI.
3. Set:
   `QUEUEFLOW_STORAGE_PROVIDER=postgres`
   `QUEUEFLOW_POSTGRES_URL=postgresql://...`
   `QUEUEFLOW_PG_SSL=require`
4. Run `npm run check:postgres` to verify the connection.
5. Run `npm run export:data` to create a SQLite snapshot.
6. Run `npm run import:data:postgres` to apply schema and import the latest snapshot.
7. Redeploy and confirm `/api/health` reports `storageProvider: postgres`.

## What the snapshot exports

The snapshot includes:

- stores
- queue state
- merchant profile
- billing state
- notification logs
- queue event history

It intentionally does not export:

- active sessions
- temporary customer tokens

Those are ephemeral and can be recreated after cutover.

## Practical recommendation

If your goal is only to demo locally, SQLite is enough for now.

If your goal is to onboard real paying merchants, then yes, production Postgres should be the next infrastructure step after domain, Stripe, and SMTP are ready.
