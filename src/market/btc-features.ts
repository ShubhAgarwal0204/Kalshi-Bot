import type { Candle } from '../analysis/types.js';

export interface BTCFeatures {
  currentPrice: number | null;
  price1hAgo: number | null;
  price4hAgo: number | null;
  price24hAgo: number | null;
  change1h: number | null; // Percentage change
  change4h: number | null;
  change24h: number | null;
  volatility24h: number | null; // Std dev of hourly returns
  trendSlope: number | null; // Linear regression slope of last 12 hourly closes
}

/**
 * Compute BTC features from candles and current price.
 */
export function computeBTCFeatures(candles: Candle[], currentPrice: number | null): BTCFeatures {
  if (candles.length === 0 || currentPrice === null) {
    return {
      currentPrice: null,
      price1hAgo: null,
      price4hAgo: null,
      price24hAgo: null,
      change1h: null,
      change4h: null,
      change24h: null,
      volatility24h: null,
      trendSlope: null,
    };
  }

  // Sort candles by timestamp (most recent last)
  const sortedCandles = [...candles].sort((a, b) => a.t - b.t);

  // Get prices at different time intervals
  const now = Date.now() / 1000; // Unix timestamp in seconds
  const oneHourAgo = now - 3600;
  const fourHoursAgo = now - 4 * 3600;
  const twentyFourHoursAgo = now - 24 * 3600;

  const price1hAgo = findPriceAtTime(sortedCandles, oneHourAgo);
  const price4hAgo = findPriceAtTime(sortedCandles, fourHoursAgo);
  const price24hAgo = findPriceAtTime(sortedCandles, twentyFourHoursAgo);

  // Calculate percentage changes
  const change1h = price1hAgo ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : null;
  const change4h = price4hAgo ? ((currentPrice - price4hAgo) / price4hAgo) * 100 : null;
  const change24h = price24hAgo ? ((currentPrice - price24hAgo) / price24hAgo) * 100 : null;

  // Compute 24h volatility (std dev of hourly returns)
  const volatility24h = computeVolatility(sortedCandles, 24);

  // Compute trend slope (linear regression of last 12 hourly closes)
  const trendSlope = computeTrendSlope(sortedCandles, 12);

  return {
    currentPrice,
    price1hAgo,
    price4hAgo,
    price24hAgo,
    change1h,
    change4h,
    change24h,
    volatility24h,
    trendSlope,
  };
}

/**
 * Find price at a specific time (or closest candle).
 */
function findPriceAtTime(candles: Candle[], targetTime: number): number | null {
  if (candles.length === 0) return null;

  // Find the candle closest to target time
  let closestCandle = candles[0];
  let minDiff = Math.abs(candles[0].t - targetTime);

  for (const candle of candles) {
    const diff = Math.abs(candle.t - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestCandle = candle;
    }
  }

  // Only return if within 2 hours of target (reasonable tolerance)
  if (minDiff <= 7200) {
    return closestCandle.c;
  }

  return null;
}

/**
 * Compute volatility as standard deviation of hourly returns.
 * Uses the last N hours of candles.
 */
export function computeVolatility(candles: Candle[], hours: number): number | null {
  if (candles.length < 2) return null;

  // Get last N hours of candles
  const recentCandles = candles.slice(-hours);
  if (recentCandles.length < 2) return null;

  // Calculate hourly returns
  const returns: number[] = [];
  for (let i = 1; i < recentCandles.length; i++) {
    const prevClose = recentCandles[i - 1].c;
    const currClose = recentCandles[i].c;
    if (prevClose > 0) {
      const ret = (currClose - prevClose) / prevClose;
      returns.push(ret);
    }
  }

  if (returns.length === 0) return null;

  // Calculate mean return
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Calculate variance
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;

  // Return standard deviation (volatility)
  return Math.sqrt(variance);
}

/**
 * Compute trend slope using linear regression of last N hourly closes.
 * Returns the slope coefficient (price change per hour).
 */
export function computeTrendSlope(candles: Candle[], hours: number): number | null {
  if (candles.length < hours) return null;

  // Get last N hours of candles
  const recentCandles = candles.slice(-hours);
  if (recentCandles.length < 2) return null;

  // Prepare data for linear regression: y = mx + b
  // x = hour index (0, 1, 2, ...)
  // y = close price
  const n = recentCandles.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = recentCandles[i].c;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  // Calculate slope: m = (n*ΣXY - ΣX*ΣY) / (n*ΣX² - (ΣX)²)
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  return slope;
}

/**
 * Compute momentum as percentage changes over different periods.
 */
export function computeMomentum(candles: Candle[]): {
  change1h: number | null;
  change4h: number | null;
  change24h: number | null;
} {
  if (candles.length === 0) {
    return {
      change1h: null,
      change4h: null,
      change24h: null,
    };
  }

  const sortedCandles = [...candles].sort((a, b) => a.t - b.t);
  const currentPrice = sortedCandles[sortedCandles.length - 1].c;

  // Get prices at different intervals
  const now = Date.now() / 1000;
  const price1hAgo = findPriceAtTime(sortedCandles, now - 3600);
  const price4hAgo = findPriceAtTime(sortedCandles, now - 4 * 3600);
  const price24hAgo = findPriceAtTime(sortedCandles, now - 24 * 3600);

  const change1h = price1hAgo ? ((currentPrice - price1hAgo) / price1hAgo) * 100 : null;
  const change4h = price4hAgo ? ((currentPrice - price4hAgo) / price4hAgo) * 100 : null;
  const change24h = price24hAgo ? ((currentPrice - price24hAgo) / price24hAgo) * 100 : null;

  return {
    change1h,
    change4h,
    change24h,
  };
}

