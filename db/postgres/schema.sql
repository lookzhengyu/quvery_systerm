-- QueueFlow production schema for managed Postgres.
-- Mirrors the current SQLite data model while using Postgres-native types.

CREATE TABLE IF NOT EXISTS stores (
  store_id TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  password TEXT NOT NULL,
  queue_state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_store_id ON sessions(store_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS customer_tokens (
  token TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_tokens_store_customer
  ON customer_tokens(store_id, customer_id);

CREATE TABLE IF NOT EXISTS customer_entry_sessions (
  token TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_entry_sessions_store_id
  ON customer_entry_sessions(store_id);

CREATE INDEX IF NOT EXISTS idx_customer_entry_sessions_expires_at
  ON customer_entry_sessions(expires_at);

CREATE TABLE IF NOT EXISTS customer_join_replays (
  token TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_join_replays_store_id
  ON customer_join_replays(store_id);

CREATE INDEX IF NOT EXISTS idx_customer_join_replays_expires_at
  ON customer_join_replays(expires_at);

CREATE TABLE IF NOT EXISTS customer_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  subscription_json JSONB NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_push_subscriptions_endpoint
  ON customer_push_subscriptions(endpoint);

CREATE INDEX IF NOT EXISTS idx_customer_push_subscriptions_store_customer
  ON customer_push_subscriptions(store_id, customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS merchant_profiles (
  store_id TEXT PRIMARY KEY REFERENCES stores(store_id) ON DELETE CASCADE,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  contact_phone TEXT,
  plan_code TEXT NOT NULL,
  subscription_status TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  onboarding_status TEXT NOT NULL,
  qr_issued_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  trial_ends_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_owner_email
  ON merchant_profiles(owner_email);

CREATE TABLE IF NOT EXISTS merchant_billing (
  store_id TEXT PRIMARY KEY REFERENCES stores(store_id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  stripe_checkout_session_id TEXT,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  last_invoice_status TEXT,
  last_checkout_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_billing_customer_id
  ON merchant_billing(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_billing_subscription_id
  ON merchant_billing(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_billing_checkout_session_id
  ON merchant_billing(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_logs (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  customer_id TEXT,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_store_id
  ON notification_logs(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS queue_events (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  customer_id TEXT,
  queue_number INTEGER,
  party_size INTEGER,
  event_type TEXT NOT NULL,
  wait_ms INTEGER,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_events_store_id
  ON queue_events(store_id, created_at DESC);
