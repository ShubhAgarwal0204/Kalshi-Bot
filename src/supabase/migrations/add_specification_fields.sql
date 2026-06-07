-- Migration: Add specification fields for full bot implementation
-- Adds fields for hourly loss limits, cooldown, size reduction, skip hours, and Plan A/B

-- Add consecutive_losing_hours to bot_runs
ALTER TABLE bot_runs
ADD COLUMN IF NOT EXISTS consecutive_losing_hours INTEGER NOT NULL DEFAULT 0;

-- Add new fields to hour_sessions
ALTER TABLE hour_sessions
ADD COLUMN IF NOT EXISTS is_skip_hour BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS trades_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS realized_losses NUMERIC NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS size_multiplier NUMERIC NOT NULL DEFAULT 1.0;

-- Update state enum to include new states
ALTER TABLE hour_sessions
DROP CONSTRAINT IF EXISTS hour_sessions_state_check;

ALTER TABLE hour_sessions
ADD CONSTRAINT hour_sessions_state_check CHECK (state IN (
  'IDLE',
  'WAIT_ENTRY_WINDOW',
  'IGNORE_EARLY',
  'SCAN_PLAN',
  'BUILD_CANDIDATES',
  'OPENAI_RECOMMENDATION',
  'VALIDATE_PLAN',
  'PLACING_BUY',
  'TRADE_ACTIVE',
  'IN_POSITION',
  'PLACING_SELL',
  'SELL_ONLY',
  'SKIP_HOUR_OBSERVE',
  'COOLDOWN',
  'DONE'
));

-- Add plan_type to trade_plans
ALTER TABLE trade_plans
ADD COLUMN IF NOT EXISTS plan_type TEXT CHECK (plan_type IN ('A', 'B'));

CREATE INDEX IF NOT EXISTS idx_trade_plans_plan_type ON trade_plans(plan_type);

-- Create shadow_trades table for skip hour shadow trading
CREATE TABLE IF NOT EXISTS shadow_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_session_id UUID NOT NULL REFERENCES hour_sessions(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('A', 'B')),
  contract_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  entry_price NUMERIC NOT NULL,
  openai_response JSONB NOT NULL,
  would_have_pnl NUMERIC,
  actual_settlement_price NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_trades_hour_session_id ON shadow_trades(hour_session_id);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_plan_type ON shadow_trades(plan_type);

