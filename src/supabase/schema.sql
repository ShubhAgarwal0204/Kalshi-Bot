-- Bot runs table
CREATE TABLE IF NOT EXISTS bot_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'error')),
  initial_cash NUMERIC NOT NULL,
  final_cash NUMERIC,
  consecutive_losing_hours INTEGER NOT NULL DEFAULT 0
);

-- Hour sessions table
CREATE TABLE IF NOT EXISTS hour_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_run_id UUID NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
  market_hour TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
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
  )),
  entry_window_start TIMESTAMPTZ NOT NULL,
  cash_at_start NUMERIC NOT NULL,
  cash_spent NUMERIC NOT NULL DEFAULT 0,
  max_spend_allowed NUMERIC NOT NULL,
  is_skip_hour BOOLEAN NOT NULL DEFAULT false,
  trades_count INTEGER NOT NULL DEFAULT 0,
  realized_losses NUMERIC NOT NULL DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  size_multiplier NUMERIC NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hour_sessions_bot_run_id ON hour_sessions(bot_run_id);
CREATE INDEX idx_hour_sessions_state ON hour_sessions(state) WHERE state != 'DONE';
CREATE INDEX idx_hour_sessions_market_hour ON hour_sessions(market_hour);

-- Trade plans table
CREATE TABLE IF NOT EXISTS trade_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_session_id UUID NOT NULL REFERENCES hour_sessions(id) ON DELETE CASCADE,
  openai_response JSONB NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'SKIP')),
  side TEXT CHECK (side IN ('YES', 'NO')),
  contract_id TEXT,
  entry_limit_price NUMERIC,
  dollars_to_spend NUMERIC,
  stop_loss_price NUMERIC NOT NULL,
  rationale TEXT NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'rejected')),
  validation_errors JSONB,
  plan_type TEXT CHECK (plan_type IN ('A', 'B')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_plans_hour_session_id ON trade_plans(hour_session_id);
CREATE INDEX idx_trade_plans_validation_status ON trade_plans(validation_status);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_session_id UUID NOT NULL REFERENCES hour_sessions(id) ON DELETE CASCADE,
  trade_plan_id UUID REFERENCES trade_plans(id) ON DELETE SET NULL,
  kalshi_order_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  limit_price NUMERIC NOT NULL,
  size INTEGER NOT NULL,
  dollars_spent NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected')),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ
);

CREATE INDEX idx_orders_hour_session_id ON orders(hour_session_id);
CREATE INDEX idx_orders_kalshi_order_id ON orders(kalshi_order_id);
CREATE INDEX idx_orders_status ON orders(status);

-- Fills table
CREATE TABLE IF NOT EXISTS fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kalshi_fill_id TEXT NOT NULL UNIQUE,
  price NUMERIC NOT NULL,
  size INTEGER NOT NULL,
  filled_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_fills_order_id ON fills(order_id);
CREATE INDEX idx_fills_kalshi_fill_id ON fills(kalshi_fill_id);

-- Trade analyses table
CREATE TABLE IF NOT EXISTS trade_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hour_session_id UUID NOT NULL REFERENCES hour_sessions(id) ON DELETE CASCADE,
  openai_analysis JSONB NOT NULL,
  summary TEXT NOT NULL,
  what_worked TEXT NOT NULL,
  what_didnt_work TEXT NOT NULL,
  suggestions TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_analyses_hour_session_id ON trade_analyses(hour_session_id);

-- Shadow trades table (for skip hour shadow trading)
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

CREATE INDEX idx_shadow_trades_hour_session_id ON shadow_trades(hour_session_id);
CREATE INDEX idx_shadow_trades_plan_type ON shadow_trades(plan_type);
CREATE INDEX idx_trade_plans_plan_type ON trade_plans(plan_type);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for hour_sessions updated_at
CREATE TRIGGER update_hour_sessions_updated_at
  BEFORE UPDATE ON hour_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

