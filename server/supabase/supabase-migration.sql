-- Rebuild schema for ZapPay

-- Required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Safety: drop tables if they exist (order respects FKs)
DROP TABLE IF EXISTS merchant_payment_configs CASCADE;
DROP TABLE IF EXISTS payment_links CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS balances CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

-- Profiles: stores merchant settings and API keys
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL,
  email TEXT,
  display_name TEXT,
  api_key TEXT UNIQUE,
  api_key_created_at TIMESTAMP WITH TIME ZONE,
  wallet_address TEXT,
  solana_wallet_address TEXT,
  stellar_wallet_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  pricing DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  total_spent DECIMAL(12,2) DEFAULT 0,
  total_transactions INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payment Links
CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  link_name TEXT NOT NULL,
  payment_link TEXT UNIQUE NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  pricing DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  expiry_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Balances (per chain/token)
CREATE TABLE IF NOT EXISTS balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  currency TEXT NOT NULL,
  chain TEXT,
  amount DECIMAL(38, 18) NOT NULL DEFAULT 0,
  usd_value DECIMAL(18,2) DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Merchant payment configs (multichain/multi-token acceptance)
CREATE TABLE IF NOT EXISTS merchant_payment_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL,
  chain_id     TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  asset        TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (owner_id, chain_id, token_symbol)
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  payment_link_id UUID REFERENCES payment_links(id) ON DELETE SET NULL,
  type TEXT CHECK (type IN ('payment','withdrawal','deposit')) NOT NULL,
  status TEXT CHECK (status IN ('pending','processing','completed','failed','blocked','cancelled')) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency TEXT NOT NULL,
  crypto_amount DECIMAL(38, 18),
  crypto_currency TEXT,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  tx_hash TEXT,
  network_fee DECIMAL(12,2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Utility: updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers
CREATE TRIGGER trg_merchant_payment_configs_updated
BEFORE UPDATE ON merchant_payment_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_products_updated
BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_customers_updated
BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_payment_links_updated
BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_merchant_payment_configs_owner ON merchant_payment_configs(owner_id);
CREATE INDEX IF NOT EXISTS idx_profiles_wallet ON profiles(wallet_address);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_owner ON payment_links(owner_id);
CREATE INDEX IF NOT EXISTS idx_balances_owner ON balances(owner_id);
CREATE INDEX IF NOT EXISTS idx_transactions_owner ON transactions(owner_id);

-- Additive: on-chain confirmation support
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS network TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_processing ON transactions(created_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_payment_links_link ON payment_links(payment_link);

-- RLS
ALTER TABLE merchant_payment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Establish ownership FKs to profiles(user_id)
ALTER TABLE products
  ADD CONSTRAINT fk_products_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

ALTER TABLE customers
  ADD CONSTRAINT fk_customers_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

ALTER TABLE payment_links
  ADD CONSTRAINT fk_payment_links_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

ALTER TABLE balances
  ADD CONSTRAINT fk_balances_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

ALTER TABLE transactions
  ADD CONSTRAINT fk_transactions_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

ALTER TABLE merchant_payment_configs
  ADD CONSTRAINT fk_merchant_payment_configs_owner
  FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE;

-- Policies: owner-scoped using profiles.user_id = auth.uid()
-- Assume profiles.user_id is the auth uid for the tenant

-- Profiles: user can manage own profile
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING ( user_id = auth.uid() );
CREATE POLICY profiles_update ON profiles
  FOR UPDATE USING ( user_id = auth.uid() );
CREATE POLICY profiles_insert ON profiles
  FOR INSERT WITH CHECK ( user_id = auth.uid() );

-- Helper function to assert ownership
CREATE OR REPLACE FUNCTION is_owner(owner UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN owner = auth.uid();
END; $$ LANGUAGE plpgsql STABLE;

-- Products
CREATE POLICY products_select ON products FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY products_modify ON products FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- Customers
CREATE POLICY customers_select ON customers FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY customers_modify ON customers FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- Payment Links
CREATE POLICY payment_links_select ON payment_links FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY payment_links_modify ON payment_links FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- Balances
CREATE POLICY balances_select ON balances FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY balances_modify ON balances FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- Transactions
CREATE POLICY transactions_select ON transactions FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY transactions_modify ON transactions FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- Merchant Payment Configs
CREATE POLICY mpc_select ON merchant_payment_configs FOR SELECT USING ( is_owner(owner_id) );
CREATE POLICY mpc_modify ON merchant_payment_configs FOR ALL USING ( is_owner(owner_id) ) WITH CHECK ( is_owner(owner_id) );

-- API key generation on profiles
CREATE OR REPLACE FUNCTION generate_profile_api_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.api_key IS NULL THEN
    NEW.api_key := encode(gen_random_bytes(24), 'hex');
    NEW.api_key_created_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_apikey
BEFORE INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION generate_profile_api_key();
