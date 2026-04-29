-- ZapPay SaaS Schema — drop and recreate everything
-- Auth: Clerk (clerk_user_id TEXT). No RLS. App layer enforces isolation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop all existing tables (order respects FKs)
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS merchant_payment_configs CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS payment_links CASCADE;
DROP TABLE IF EXISTS checkouts CASCADE;
DROP TABLE IF EXISTS balances CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

-- ─── profiles ────────────────────────────────────────────────────────────────
-- One row per merchant. clerk_user_id is the identity from Clerk.
-- profiles.id (UUID) is used as owner_id everywhere — never the Clerk string ID.
CREATE TABLE profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id          TEXT UNIQUE NOT NULL,
  email                  TEXT,
  display_name           TEXT,
  api_key                TEXT UNIQUE,
  api_key_created_at     TIMESTAMPTZ,
  wallet_address         TEXT,
  solana_wallet_address  TEXT,
  stellar_wallet_address TEXT,
  webhook_url            TEXT,
  webhook_secret         TEXT,
  plan                   TEXT NOT NULL DEFAULT 'free'
                           CHECK (plan IN ('free','starter','pro','enterprise')),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── products ────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  pricing     DECIMAL(10,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  active      BOOLEAN NOT NULL DEFAULT true,
  image_url   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── customers ───────────────────────────────────────────────────────────────
CREATE TABLE customers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  email              TEXT,
  wallet_address     TEXT,
  total_spent        DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_transactions INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── checkouts ───────────────────────────────────────────────────────────────
-- Stripe-style hosted checkout sessions. Merchant creates via API, consumer pays via hosted URL.
CREATE TABLE checkouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','expired','cancelled')),
  total_amount DECIMAL(12,2) NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  line_items   JSONB NOT NULL,
  -- line_items schema: [{ product_id, name, unit_price, qty, subtotal }]
  success_url  TEXT,
  cancel_url   TEXT,
  metadata     JSONB,
  expires_at   TIMESTAMPTZ NOT NULL,
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── payment_links ───────────────────────────────────────────────────────────
CREATE TABLE payment_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  link_name    TEXT NOT NULL,
  payment_link TEXT UNIQUE NOT NULL,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  pricing      DECIMAL(10,2) NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  expiry_date  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── balances ────────────────────────────────────────────────────────────────
CREATE TABLE balances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL,
  chain        TEXT NOT NULL,
  chain_id     TEXT NOT NULL,
  amount       DECIMAL(38,18) NOT NULL DEFAULT 0,
  usd_value    DECIMAL(18,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (owner_id, currency, chain_id)
);

-- ─── merchant_payment_configs ─────────────────────────────────────────────────
CREATE TABLE merchant_payment_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  chain_id     TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  asset        TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (owner_id, chain_id, token_symbol)
);

-- ─── transactions ────────────────────────────────────────────────────────────
CREATE TABLE transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  payment_link_id      UUID REFERENCES payment_links(id) ON DELETE SET NULL,
  checkout_id          UUID REFERENCES checkouts(id) ON DELETE SET NULL,
  customer_id          UUID REFERENCES customers(id) ON DELETE SET NULL,
  type                 TEXT NOT NULL
                         CHECK (type IN ('payment','withdrawal','deposit')),
  status               TEXT NOT NULL
                         CHECK (status IN
                           ('pending','processing','completed','failed',
                            'blocked','cancelled')),
  amount               DECIMAL(12,2) NOT NULL,
  currency             TEXT NOT NULL,
  crypto_amount        DECIMAL(38,18),
  crypto_currency      TEXT,
  tx_hash              TEXT,
  network              TEXT,
  network_fee          DECIMAL(12,2),
  wallet_address       TEXT,
  session_id           TEXT,
  block_reason         TEXT,
  risk_score           INT,
  webhook_delivered_at TIMESTAMPTZ,
  webhook_attempts     INT NOT NULL DEFAULT 0,
  webhook_last_error   TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── subscriptions (SaaS billing tier tracking) ───────────────────────────────
CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free','starter','pro','enterprise')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','cancelled','past_due')),
  current_period_end  TIMESTAMPTZ,
  stripe_sub_id       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_profiles_clerk        ON profiles(clerk_user_id);
CREATE INDEX idx_profiles_api_key      ON profiles(api_key);
CREATE INDEX idx_profiles_wallet       ON profiles(wallet_address);
CREATE INDEX idx_products_owner        ON products(owner_id);
CREATE INDEX idx_customers_owner       ON customers(owner_id);
CREATE INDEX idx_checkouts_owner       ON checkouts(owner_id);
CREATE INDEX idx_checkouts_expires     ON checkouts(expires_at) WHERE status = 'pending';
CREATE INDEX idx_payment_links_owner   ON payment_links(owner_id);
CREATE INDEX idx_payment_links_hash    ON payment_links(payment_link);
CREATE INDEX idx_balances_owner        ON balances(owner_id);
CREATE INDEX idx_mpc_owner             ON merchant_payment_configs(owner_id);
CREATE INDEX idx_transactions_owner    ON transactions(owner_id);
CREATE INDEX idx_transactions_status   ON transactions(status, created_at DESC);
CREATE INDEX idx_transactions_processing ON transactions(created_at)
  WHERE status = 'processing';
CREATE INDEX idx_transactions_webhook  ON transactions(status, webhook_delivered_at, webhook_attempts)
  WHERE status = 'completed' AND webhook_delivered_at IS NULL;
CREATE INDEX idx_transactions_session  ON transactions(session_id);
CREATE INDEX idx_subscriptions_owner   ON subscriptions(owner_id);

-- ─── Triggers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_products_updated
  BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_customers_updated
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_payment_links_updated
  BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_mpc_updated
  BEFORE UPDATE ON merchant_payment_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_subscriptions_updated
  BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── API key auto-generation ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_profile_api_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.api_key IS NULL THEN
    NEW.api_key := 'zp_live_' || encode(gen_random_bytes(24), 'hex');
    NEW.api_key_created_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_apikey
  BEFORE INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION generate_profile_api_key();

-- ─── Webhook secret auto-generation ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_webhook_secret()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.webhook_secret IS NULL THEN
    NEW.webhook_secret := 'whsec_' || encode(gen_random_bytes(32), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_webhook_secret
  BEFORE INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION generate_webhook_secret();
