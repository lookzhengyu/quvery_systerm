# Production Go Gate

This project is production-ready only when this gate passes.

## Local

Run:

```bash
npm run production-go
```

The gate checks:

- lint
- unit tests
- production build
- managed Postgres staging isolation
- Postgres staging integration
- Artillery hotspot load test
- production Postgres public schema connectivity
- production `/api/health`
- production public queue read
- recent Vercel production error logs

## Required Environment

Local files are gitignored:

- `.env.staging.local`
- `.env.production.local`

Required staging values:

```bash
STAGING_POSTGRES_URL=...
STAGING_TARGET_ENV=staging
QUEUEFLOW_STORAGE_PROVIDER=postgres
QUEUEFLOW_POSTGRES_URL=...
QUEUEFLOW_PG_SSL=require
QUEUEFLOW_PG_SCHEMA=queueflow_staging
```

Required production values:

```bash
QUEUEFLOW_STORAGE_PROVIDER=postgres
QUEUEFLOW_POSTGRES_URL=...
QUEUEFLOW_PG_SSL=require
QUEUEFLOW_PG_SCHEMA=public
```

## GitHub Actions

Add these repository secrets before relying on CI:

- `STAGING_POSTGRES_URL`
- `PRODUCTION_POSTGRES_URL`

The workflow is `.github/workflows/production-go.yml`.

## Vercel

Production must have:

- `QUEUEFLOW_STORAGE_PROVIDER=postgres`
- `QUEUEFLOW_POSTGRES_URL`
- `QUEUEFLOW_PG_SSL=require`
- `QUEUEFLOW_PG_SCHEMA=public`

This Vercel project currently has no connected Git repository. To enable Preview branch environment variables and automatic Vercel Git deployments, connect a repo:

```bash
npx vercel git connect <git-url>
```

Then set Preview env to use `QUEUEFLOW_PG_SCHEMA=queueflow_staging`, not `public`.
