import { KrakenBTCFeed } from '../market/krakenBtcFeed.js';
import { KrakenOHLC } from '../market/krakenOhlc.js';
import { KalshiTradesRepository } from '../trades/kalshiTradesRepo.js';
import { computeBTCFeatures, computeTradeStats } from './features.js';
import { OpenAIJudge } from './openaiJudge.js';
import type { CandidateTrade, EvalResult } from './types.js';

// Singleton instances
let btcFeed: KrakenBTCFeed | null = null;
let ohlcClient: KrakenOHLC | null = null;
let tradesRepo: KalshiTradesRepository | null = null;
let judge: OpenAIJudge | null = null;

/**
 * Initialize the BTC feed (should be called once at startup).
 */
export async function initializeBTCFeed(): Promise<KrakenBTCFeed> {
  if (!btcFeed) {
    btcFeed = new KrakenBTCFeed();
    await btcFeed.connect();
  }
  return btcFeed;
}

/**
 * Get or create singleton instances.
 */
function getInstances() {
  if (!ohlcClient) {
    ohlcClient = new KrakenOHLC();
  }
  if (!tradesRepo) {
    tradesRepo = new KalshiTradesRepository();
  }
  if (!judge) {
    judge = new OpenAIJudge();
  }
  return { btcFeed, ohlcClient, tradesRepo, judge };
}

/**
 * Evaluate a candidate trade based on BTC market data and past trading performance.
 * This is the main exported function for integration with the trading bot.
 */
export async function evaluateCandidateTrade(candidate: CandidateTrade): Promise<EvalResult> {
  const { btcFeed, ohlcClient, tradesRepo, judge } = getInstances();

  try {
    // 1. Get current BTC price from WebSocket feed
    if (!btcFeed) {
      throw new Error('BTC feed not initialized. Call initializeBTCFeed() first.');
    }

    const currentPrice = btcFeed.getCurrentPrice();
    if (!currentPrice) {
      return {
        verdict: 'UNCLEAR',
        confidence: 0,
        reasons: ['BTC price feed not available'],
        risk_flags: ['Cannot evaluate without current BTC price'],
        suggested_action: 'WAIT',
        notes_for_logs: 'BTC feed not ready',
      };
    }

    // 2. Fetch OHLC candles (24h/7d/30d) with caching
    const [candles24h, candles7d, candles30d] = await Promise.all([
      ohlcClient!.getCandles24h(),
      ohlcClient!.getCandles7d(),
      ohlcClient!.getCandles30d(),
    ]);

    // 3. Fetch last 24 trades from Supabase
    const trades = await tradesRepo!.getLastTrades(24);

    // 4. Compute features from BTC data and trades
    const btcFeatures = computeBTCFeatures(currentPrice, candles24h);
    const tradeStats = computeTradeStats(trades, candles24h);

    // 5. Call OpenAI judge with all data
    const evalResult = await judge!.evaluate(
      candidate,
      btcFeatures,
      tradeStats,
      candles24h,
      candles7d,
      candles30d
    );

    return evalResult;
  } catch (error) {
    // Return UNCLEAR verdict with error details if any step fails
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error evaluating candidate trade:', errorMessage);
    return {
      verdict: 'UNCLEAR',
      confidence: 0,
      reasons: [`Evaluation failed: ${errorMessage}`],
      risk_flags: ['System error during evaluation'],
      suggested_action: 'WAIT',
      notes_for_logs: `Error: ${errorMessage}`,
    };
  }
}

/**
 * Get the BTC feed instance (for external access if needed).
 */
export function getBTCFeed(): KrakenBTCFeed | null {
  return btcFeed;
}

