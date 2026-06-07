import type { Candle, BTCFeatures, TradeStats, KalshiTrade } from './types.js';

/**
 * Compute BTC features from current price and candles.
 */
export function computeBTCFeatures(currentPrice: number | null, candles: Candle[]): BTCFeatures {
  if (!currentPrice || candles.length === 0) {
    throw new Error('Cannot compute BTC features: missing price or candles');
  }

  // Sort candles by timestamp ascending
  const sortedCandles = [...candles].sort((a, b) => a.t - b.t);

  // Find candles at 1h, 4h, 24h ago
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;
  const fourHoursAgo = now - 14400;
  const twentyFourHoursAgo = now - 86400;

  const findNearestCandle = (targetTime: number): Candle | null => {
    let nearest: Candle | null = null;
    let minDiff = Infinity;
    for (const candle of sortedCandles) {
      const diff = Math.abs(candle.t - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = candle;
      }
    }
    return nearest;
  };

  const candle1h = findNearestCandle(oneHourAgo);
  const candle4h = findNearestCandle(fourHoursAgo);
  const candle24h = findNearestCandle(twentyFourHoursAgo);

  // Calculate percentage changes
  const change1h = candle1h ? ((currentPrice - candle1h.c) / candle1h.c) * 100 : 0;
  const change4h = candle4h ? ((currentPrice - candle4h.c) / candle4h.c) * 100 : 0;
  const change24h = candle24h ? ((currentPrice - candle24h.c) / candle24h.c) * 100 : 0;

  // Calculate 24h realized volatility (std dev of hourly returns)
  const last24Candles = sortedCandles.slice(-24);
  const returns: number[] = [];
  for (let i = 1; i < last24Candles.length; i++) {
    const prevClose = last24Candles[i - 1].c;
    const currClose = last24Candles[i].c;
    if (prevClose > 0) {
      returns.push(Math.log(currClose / prevClose)); // Log returns
    }
  }

  const volatility = returns.length > 0 ? calculateStdDev(returns) : 0;

  // Calculate trend: linear regression slope of last 12 hourly closes
  const last12Candles = sortedCandles.slice(-12);
  const trendSlope = last12Candles.length >= 2 ? calculateLinearRegressionSlope(last12Candles) : 0;

  return {
    current_price: currentPrice,
    change_1h_pct: change1h,
    change_4h_pct: change4h,
    change_24h_pct: change24h,
    volatility_24h: volatility,
    trend_slope: trendSlope,
  };
}

/**
 * Compute trade statistics from last 24 trades.
 */
export function computeTradeStats(trades: KalshiTrade[], candles: Candle[]): TradeStats {
  if (trades.length === 0) {
    return {
      win_rate: 0,
      avg_pnl: 0,
      avg_entry_price: 0,
      top_markets: [],
      current_streak: { type: 'NONE', count: 0 },
      btc_correlation: 0,
    };
  }

  // Filter completed trades (WON/LOST)
  const completedTrades = trades.filter((t) => t.status === 'WON' || t.status === 'LOST');

  // Calculate win rate
  const wins = completedTrades.filter((t) => t.status === 'WON').length;
  const winRate = completedTrades.length > 0 ? wins / completedTrades.length : 0;

  // Calculate average PnL
  const pnls = completedTrades.map((t) => t.pnl || 0).filter((pnl) => pnl !== null);
  const avgPnl = pnls.length > 0 ? pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length : 0;

  // Calculate average entry price
  const avgEntryPrice =
    trades.length > 0
      ? trades.reduce((sum, t) => sum + t.entry_price, 0) / trades.length
      : 0;

  // Top 3 market tickers by frequency
  const marketCounts = new Map<string, number>();
  for (const trade of trades) {
    marketCounts.set(trade.market_ticker, (marketCounts.get(trade.market_ticker) || 0) + 1);
  }
  const topMarkets = Array.from(marketCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ticker, count]) => ({ ticker, count }));

  // Current streak (consecutive wins/losses)
  let streakType: 'WIN' | 'LOSS' | 'NONE' = 'NONE';
  let streakCount = 0;
  for (const trade of completedTrades) {
    if (trade.status === 'WON') {
      if (streakType === 'WIN') {
        streakCount++;
      } else {
        streakType = 'WIN';
        streakCount = 1;
      }
    } else if (trade.status === 'LOST') {
      if (streakType === 'LOSS') {
        streakCount++;
      } else {
        streakType = 'LOSS';
        streakCount = 1;
      }
    }
  }

  // Correlation between trade outcome and BTC direction
  // For each trade, find nearest BTC candle, compute direction, correlate with outcome
  const btcCorrelation = calculateBTCCorrelation(completedTrades, candles);

  return {
    win_rate: winRate,
    avg_pnl: avgPnl,
    avg_entry_price: avgEntryPrice,
    top_markets: topMarkets,
    current_streak: { type: streakType, count: streakCount },
    btc_correlation: btcCorrelation,
  };
}

/**
 * Calculate standard deviation of an array of numbers.
 */
function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Calculate linear regression slope (y = mx + b, return m).
 */
function calculateLinearRegressionSlope(candles: Candle[]): number {
  if (candles.length < 2) return 0;

  const n = candles.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    const x = i; // Time index
    const y = candles[i].c; // Close price
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return slope;
}

/**
 * Calculate correlation between trade outcomes and BTC direction.
 */
function calculateBTCCorrelation(trades: KalshiTrade[], candles: Candle[]): number {
  if (trades.length === 0 || candles.length === 0) return 0;

  const sortedCandles = [...candles].sort((a, b) => a.t - b.t);
  const outcomes: number[] = [];
  const btcDirections: number[] = [];

  for (const trade of trades) {
    // Map trade outcome: WON = 1, LOST = -1
    const outcome = trade.status === 'WON' ? 1 : -1;
    outcomes.push(outcome);

    // Find nearest BTC candle to trade timestamp
    const tradeTimestamp = Math.floor(trade.created_at.getTime() / 1000);
    let nearestCandle: Candle | null = null;
    let minDiff = Infinity;

    for (const candle of sortedCandles) {
      const diff = Math.abs(candle.t - tradeTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        nearestCandle = candle;
      }
    }

    if (nearestCandle) {
      // Find previous candle to compute direction
      const candleIndex = sortedCandles.indexOf(nearestCandle);
      if (candleIndex > 0) {
        const prevCandle = sortedCandles[candleIndex - 1];
        const direction = nearestCandle.c > prevCandle.c ? 1 : nearestCandle.c < prevCandle.c ? -1 : 0;
        btcDirections.push(direction);
      } else {
        btcDirections.push(0);
      }
    } else {
      btcDirections.push(0);
    }
  }

  // Calculate Pearson correlation coefficient
  if (outcomes.length === 0 || btcDirections.length === 0) return 0;

  const meanOutcome = outcomes.reduce((sum, val) => sum + val, 0) / outcomes.length;
  const meanBTC = btcDirections.reduce((sum, val) => sum + val, 0) / btcDirections.length;

  let numerator = 0;
  let sumSqOutcome = 0;
  let sumSqBTC = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const diffOutcome = outcomes[i] - meanOutcome;
    const diffBTC = btcDirections[i] - meanBTC;
    numerator += diffOutcome * diffBTC;
    sumSqOutcome += diffOutcome * diffOutcome;
    sumSqBTC += diffBTC * diffBTC;
  }

  const denominator = Math.sqrt(sumSqOutcome * sumSqBTC);
  if (denominator === 0) return 0;

  return numerator / denominator;
}

