-- Customers table used to track Stripe/PayPal subscribers and their
-- subscription status so cancelled customers can be automatically
-- removed from the Telegram group after 30 days.
create table if not exists customers (
  id bigint generated always as identity primary key,
  user_id text not null unique,
  stripe_customer_id text,
  paypal_id text,
  status text not null default 'active', -- 'active' | 'cancelled'
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create index if not exists customers_status_cancelled_at_idx
  on customers (status, cancelled_at);
