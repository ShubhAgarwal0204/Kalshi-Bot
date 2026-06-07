/**
 * Type definitions for BTC market data and trade evaluation system.
 */

/**
 * Candidate trade to be evaluated.
 */
export interface CandidateTrade {
  market_ticker: string;
  side: string;
  intended_entry_price?: number;
  size: number;
  metadata?: Record<string, any>;
}

/**
 * Evaluation result from OpenAI judge.
 */
export interface EvalResult {
  verdict: 'GOOD' | 'BAD' | 'UNCLEAR';
  confidence: number; // 0..1
  reasons: string[];
  risk_flags: string[];
  suggested_action: 'PROCEED' | 'SKIP' | 'REDUCE_SIZE' | 'WAIT';
  notes_for_logs?: string;
}

/**
 * OHLC candle data.
 */
export interface Candle {
  t: number; // Unix timestamp in seconds
  o: number; // Open
  h: number; // High
  l: number; // Low
  c: number; // Close
  v: number; // Volume
}

/**
 * BTC market features computed from price data.
 */
export interface BTCFeatures {
  current_price: number;
  change_1h_pct: number;
  change_4h_pct: number;
  change_24h_pct: number;
  volatility_24h: number; // Standard deviation of hourly returns
  trend_slope: number; // Linear regression slope of last 12 hourly closes
}

/**
 * Trade statistics computed from last 24 trades.
 */
export interface TradeStats {
  win_rate: number; // 0..1
  avg_pnl: number;
  avg_entry_price: number;
  top_markets: Array<{ ticker: string; count: number }>; // Top 3 market_tickers
  current_streak: {
    type: 'WIN' | 'LOSS' | 'NONE';
    count: number;
  };
  btc_correlation: number; // Correlation between trade outcome and BTC direction (-1..1)
}

/**
 * Kalshi trade record from database.
 */
export interface KalshiTrade {
  id: string;
  created_at: Date;
  market_ticker: string;
  side: string;
  entry_price: number;
  size: number;
  status: 'WON' | 'LOST' | 'OPEN' | 'CANCELLED' | 'SETTLED';
  exit_price: number | null;
  pnl: number | null;
  metadata: Record<string, any> | null;
}

