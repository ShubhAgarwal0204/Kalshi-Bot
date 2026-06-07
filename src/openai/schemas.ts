import { z } from 'zod';

/**
 * Schema for BTC features input.
 */
export const BTCFeaturesInputSchema = z.object({
  currentPrice: z.number().nullable(),
  price1hAgo: z.number().nullable(),
  price4hAgo: z.number().nullable(),
  price24hAgo: z.number().nullable(),
  change1h: z.number().nullable(),
  change4h: z.number().nullable(),
  change24h: z.number().nullable(),
  volatility24h: z.number().nullable(),
  trendSlope: z.number().nullable(),
});

export type BTCFeaturesInput = z.infer<typeof BTCFeaturesInputSchema>;

/**
 * Schema for trade history input.
 */
export const TradeHistoryInputSchema = z.object({
  winRate: z.number(),
  avgPnl: z.number(),
  avgEntryPrice: z.number(),
  topMarkets: z.array(z.object({ ticker: z.string(), count: z.number() })),
  currentStreak: z.object({
    type: z.enum(['WIN', 'LOSS', 'NONE']),
    count: z.number(),
  }),
  recentTrades: z.array(
    z.object({
      market_ticker: z.string(),
      side: z.string(),
      entry_price: z.number(),
      exit_price: z.number().nullable(),
      pnl: z.number().nullable(),
      result: z.enum(['WON', 'LOST', 'OPEN', 'SETTLED']).optional(),
    })
  ),
});

export type TradeHistoryInput = z.infer<typeof TradeHistoryInputSchema>;

/**
 * Schema for OpenAI decision advisor input.
 */
export const DecisionAdvisorInputSchema = z.object({
  current_time_et: z.string(),
  market_resolution_time: z.string(),
  candidates: z.array(
    z.object({
      contract_id: z.string(),
      strike: z.string(),
      best_bid: z.number().nullable(),
      best_ask: z.number().nullable(),
      spread: z.number(),
    })
  ),
  remaining_hourly_capital: z.number(),
  constraints: z.object({
    entry_price_range: z.tuple([z.number(), z.number()]),
    stop_loss_price: z.number(),
    max_spend_remaining: z.number(),
  }),
  btcFeatures: BTCFeaturesInputSchema.optional(),
  tradeHistory: TradeHistoryInputSchema.optional(),
});

export type DecisionAdvisorInput = z.infer<typeof DecisionAdvisorInputSchema>;

/**
 * Schema for OpenAI decision advisor output (trade plan).
 */
export const TradePlanSchema = z.object({
  action: z.enum(['ENTER', 'SKIP']),
  side: z.enum(['YES', 'NO']).optional(),
  contract_id: z.string().optional(),
  entry_limit_price: z.number().min(0).max(1).optional(),
  dollars_to_spend: z.number().positive().optional(),
  stop_loss_price: z.number().min(0).max(1),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});

export type TradePlan = z.infer<typeof TradePlanSchema>;

/**
 * Schema for post-trade analysis input.
 */
export const PostTradeAnalysisInputSchema = z.object({
  hour_session_id: z.string(),
  market_hour: z.string(),
  trades_executed: z.array(
    z.object({
      contract_id: z.string(),
      side: z.enum(['YES', 'NO']),
      entry_price: z.number(),
      exit_price: z.number().nullable(),
      dollars_spent: z.number(),
      pnl: z.number(),
      status: z.enum(['open', 'closed', 'settled']),
    })
  ),
  total_pnl: z.number(),
  cash_at_start: z.number(),
  cash_at_end: z.number(),
});

export type PostTradeAnalysisInput = z.infer<typeof PostTradeAnalysisInputSchema>;

/**
 * Schema for post-trade analysis output.
 */
export const TradeAnalysisSchema = z.object({
  summary: z.string(),
  what_worked: z.string(),
  what_didnt_work: z.string(),
  suggestions: z.string(),
});

export type TradeAnalysis = z.infer<typeof TradeAnalysisSchema>;

