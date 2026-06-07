import { KalshiRESTClient } from './rest-client.js';
import type { KalshiMarket } from './types.js';

/**
 * Discovers KXBTCD hourly markets from Kalshi.
 */
export class MarketDiscovery {
  private restClient: KalshiRESTClient;

  constructor(restClient: KalshiRESTClient) {
    this.restClient = restClient;
  }

  /**
   * Find the current hour's KXBTCD market.
   * @param targetHour Resolution hour (ET timezone)
   */
  async findCurrentHourMarket(targetHour: Date): Promise<KalshiMarket | null> {
    // Get all KXBTCD markets
    const allMarkets = await this.getAllKXBTCDMarkets();

    // Filter for hourly markets that resolve at the target hour
    const targetHourStart = new Date(targetHour);
    targetHourStart.setMinutes(0, 0, 0);
    const targetHourEnd = new Date(targetHourStart);
    targetHourEnd.setHours(targetHourEnd.getHours() + 1);

    const matchingMarkets = allMarkets.filter((market) => {
      const expirationTime = new Date(market.expiration_time);
      return expirationTime >= targetHourStart && expirationTime < targetHourEnd;
    });

    if (matchingMarkets.length === 0) {
      return null;
    }

    // Return the market with the closest expiration time
    matchingMarkets.sort((a, b) => {
      const timeA = new Date(a.expiration_time).getTime();
      const timeB = new Date(b.expiration_time).getTime();
      return timeA - timeB;
    });

    return matchingMarkets[0];
  }

  /**
   * Get all KXBTCD markets.
   */
  async getAllKXBTCDMarkets(): Promise<KalshiMarket[]> {
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.restClient.getMarkets({
        series_ticker: 'KXBTCD',
        limit: 100,
        cursor,
      });

      allMarkets.push(...response.markets);
      cursor = response.cursor;
    } while (cursor);

    return allMarkets;
  }

  /**
   * Get markets for a specific hour range.
   */
  async getMarketsForHourRange(startHour: Date, endHour: Date): Promise<KalshiMarket[]> {
    const allMarkets = await this.getAllKXBTCDMarkets();

    return allMarkets.filter((market) => {
      const expirationTime = new Date(market.expiration_time);
      return expirationTime >= startHour && expirationTime < endHour;
    });
  }

  /**
   * Get contracts for a market (YES and NO sides).
   */
  getContractsForMarket(market: KalshiMarket): Array<{ contract_id: string; side: 'YES' | 'NO' }> {
    // Kalshi contract IDs are typically: {ticker}-{YES|NO}
    return [
      { contract_id: `${market.ticker}-YES`, side: 'YES' as const },
      { contract_id: `${market.ticker}-NO`, side: 'NO' as const },
    ];
  }
}

