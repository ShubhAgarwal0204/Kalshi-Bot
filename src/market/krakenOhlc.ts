import { getConfig } from '../config.js';
import type { Candle } from '../analysis/types.js';

/**
 * Cache entry for OHLC data.
 */
interface CacheEntry {
  candles: Candle[];
  timestamp: number;
}

/**
 * REST client for Kraken OHLC data with caching.
 */
export class KrakenOHLC {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTTL = 60000; // 60 seconds

  /**
   * Get hourly candles for the specified number of hours back.
   */
  async getHourlyCandles(hoursBack: number): Promise<Candle[]> {
    const cacheKey = `hours_${hoursBack}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // Return cached data if still valid
    if (cached && now - cached.timestamp < this.cacheTTL) {
      return cached.candles;
    }

    const config = getConfig();
    const since = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000); // Unix timestamp in seconds

    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const url = `${config.KRAKEN_REST_URL}/OHLC?pair=XBTUSD&interval=60&since=${since}`;
        const response = await fetch(url, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Kraken API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (data.error && data.error.length > 0) {
          throw new Error(`Kraken API error: ${data.error.join(', ')}`);
        }

        const candles = this.parseOHLCResponse(data);
        
        // Update cache
        this.cache.set(cacheKey, {
          candles,
          timestamp: now,
        });

        return candles;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          // Exponential backoff: wait 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }
      }
    }

    throw new Error(`Failed to fetch Kraken OHLC after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Parse Kraken OHLC API response.
   * Format: { result: { XBTUSD: [[time, open, high, low, close, volume, ...], ...], last: timestamp } } }
   */
  private parseOHLCResponse(data: any): Candle[] {
    const result = data.result;
    if (!result || !result.XBTUSD) {
      throw new Error('Invalid Kraken OHLC response format');
    }

    const ohlcArray = result.XBTUSD;
    const candles: Candle[] = [];

    for (const candle of ohlcArray) {
      if (Array.isArray(candle) && candle.length >= 6) {
        candles.push({
          t: parseInt(candle[0], 10), // Unix timestamp in seconds
          o: parseFloat(candle[1]),
          h: parseFloat(candle[2]),
          l: parseFloat(candle[3]),
          c: parseFloat(candle[4]),
          v: parseFloat(candle[5]),
        });
      }
    }

    // Sort by timestamp ascending
    candles.sort((a, b) => a.t - b.t);

    return candles;
  }

  /**
   * Get last 24 hours of hourly candles.
   */
  async getCandles24h(): Promise<Candle[]> {
    return this.getHourlyCandles(24);
  }

  /**
   * Get last 7 days of hourly candles.
   */
  async getCandles7d(): Promise<Candle[]> {
    return this.getHourlyCandles(7 * 24);
  }

  /**
   * Get last 30 days of hourly candles.
   */
  async getCandles30d(): Promise<Candle[]> {
    return this.getHourlyCandles(30 * 24);
  }

  /**
   * Clear cache (useful for testing or forced refresh).
   */
  clearCache(): void {
    this.cache.clear();
  }
}

