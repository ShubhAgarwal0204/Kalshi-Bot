-- Create kalshi_trades table for tracking completed trades
CREATE TABLE IF NOT EXISTS kalshi_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO', 'BUY', 'SELL')),
  entry_price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WON', 'LOST', 'OPEN', 'CANCELLED', 'SETTLED')),
  exit_price NUMERIC,
  pnl NUMERIC,
  metadata JSONB
);

-- Indexes for efficient queries
CREATE INDEX idx_kalshi_trades_created_at ON kalshi_trades(created_at DESC);
CREATE INDEX idx_kalshi_trades_status ON kalshi_trades(status);
CREATE INDEX idx_kalshi_trades_market_ticker ON kalshi_trades(market_ticker);

