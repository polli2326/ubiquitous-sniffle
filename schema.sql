BEGIN;
CREATE TABLE IF NOT EXISTS wallets (
  user_id text PRIMARY KEY,
  available bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES wallets(user_id),
  kind text NOT NULL CHECK (kind IN ('deposit','withdrawal')),
  amount bigint NOT NULL CHECK (amount BETWEEN 1000 AND 5000000),
  phone text NOT NULL,
  reference text NOT NULL UNIQUE,
  internal_reference text UNIQUE,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('created','dispatching','pending','unknown','review','success','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payments_owner_time ON payments(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ledger (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES wallets(user_id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  event text NOT NULL CHECK (event IN ('reserve','success','failed')),
  available_delta bigint NOT NULL,
  reserved_delta bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_id, event)
);
CREATE TABLE IF NOT EXISTS webhook_receipts (
  reference text NOT NULL,
  internal_reference text NOT NULL,
  status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(reference, internal_reference, status)
);
-- Serializes limits across replicas; there is no in-memory rate-limit bypass.
CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  bucket bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(key, bucket)
);
COMMIT;
