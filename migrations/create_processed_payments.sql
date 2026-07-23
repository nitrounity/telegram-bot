-- Run this once against your Supabase database to enable persistent
-- payment deduplication (see server.js: isPaymentProcessed / markPaymentProcessed).
CREATE TABLE IF NOT EXISTS processed_payments (
  id TEXT PRIMARY KEY,
  payment_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_payments_user_id ON processed_payments(user_id);
