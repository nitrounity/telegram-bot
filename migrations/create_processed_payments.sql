-- Run this once against your Supabase database to enable persistent
-- payment deduplication (see server.js: isPaymentProcessed / markPaymentProcessed).
CREATE TABLE IF NOT EXISTS processed_payments (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount TEXT,
  processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_payments_user_id ON processed_payments(user_id);

-- Persistent "seen user" tracking (see bot.js: trackNewUser).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  seen_at TIMESTAMP DEFAULT NOW()
);
