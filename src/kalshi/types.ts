// Kalshi API Types
// Based on Kalshi API documentation structure

export interface KalshiMarket {
  ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
  previous_price: number | null;
  volume: number;
  open_interest: number;
  expiration_time: string; // ISO 8601 timestamp
  strike_price: number | null;
  strike_price_display: string | null;
}

export interface KalshiContract {
  contract_id: string;
  ticker: string;
  side: 'YES' | 'NO';
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
}

export interface KalshiOrderBook {
  contract_id: string;
  yes_bids: Array<{ price: number; size: number }>;
  yes_asks: Array<{ price: number; size: number }>;
  no_bids: Array<{ price: number; size: number }>;
  no_asks: Array<{ price: number; size: number }>;
}

export interface KalshiOrder {
  order_id: string;
  contract_id: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  limit_price: number;
  size: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  placed_time: string; // ISO 8601 timestamp
  filled_time?: string; // ISO 8601 timestamp
}

export interface KalshiFill {
  fill_id: string;
  order_id: string;
  contract_id: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  price: number;
  size: number;
  filled_time: string; // ISO 8601 timestamp
}

export interface KalshiPortfolioBalance {
  balance: number;
  available_balance: number;
  portfolio_value?: number;
}

export interface CreateOrderParams {
  contract_id: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  limit_price: number;
  size: number;
}

export interface KalshiWebSocketMessage {
  type: string;
  data: unknown;
}

