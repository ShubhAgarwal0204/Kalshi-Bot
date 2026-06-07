import { getConfig } from '../config.js';
import { KalshiWebSocketClient } from '../kalshi/websocket-client.js';
import type { KalshiMarket } from '../kalshi/types.js';

export interface ContractCandidate {
  contract_id: string;
  side: 'YES' | 'NO';
  strike: string;
  best_bid: number | null;
  best_ask: number | null;
  spread: number;
  entry_price: number | null; // Buy-side price (ask for YES, ask for NO)
}

/**
 * Selects contract candidates based on entry price criteria.
 * Filters contracts where buy-side price is between [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX].
 */
export class CandidateSelector {
  private wsClient: KalshiWebSocketClient;

  constructor(wsClient: KalshiWebSocketClient) {
    this.wsClient = wsClient;
  }

  /**
   * Find candidate contracts from a market that meet entry price criteria.
   * Entry eligibility:
   * - Executable ask in [0.75, 0.85] OR
   * - Last traded price > 0.85 and <= 0.90
   */
  findCandidates(market: KalshiMarket): ContractCandidate[] {
    const candidates: ContractCandidate[] = [];

    // Get contracts for YES and NO sides
    const yesContractId = `${market.ticker}-YES`;
    const noContractId = `${market.ticker}-NO`;

    // Check YES contract
    const yesBidAsk = this.wsClient.getBestBidAsk(yesContractId, 'YES');
    if (yesBidAsk.ask !== null) {
      const entryPrice = yesBidAsk.ask;
      const lastPrice = market.last_price;
      
      // Check eligibility: executable ask in [0.75, 0.85] OR last traded price > 0.85 and <= 0.90
      const isEligible = 
        (entryPrice >= 0.75 && entryPrice <= 0.85) ||
        (lastPrice !== null && lastPrice > 0.85 && lastPrice <= 0.90);

      if (isEligible) {
        const spread = yesBidAsk.bid !== null ? yesBidAsk.ask - yesBidAsk.bid : 0;
        candidates.push({
          contract_id: yesContractId,
          side: 'YES',
          strike: market.strike_price_display || market.ticker,
          best_bid: yesBidAsk.bid,
          best_ask: yesBidAsk.ask,
          spread,
          entry_price: entryPrice,
        });
      }
    }

    // Check NO contract
    const noBidAsk = this.wsClient.getBestBidAsk(noContractId, 'NO');
    if (noBidAsk.ask !== null) {
      const entryPrice = noBidAsk.ask;
      const lastPrice = market.last_price;
      
      // Check eligibility: executable ask in [0.75, 0.85] OR last traded price > 0.85 and <= 0.90
      const isEligible = 
        (entryPrice >= 0.75 && entryPrice <= 0.85) ||
        (lastPrice !== null && lastPrice > 0.85 && lastPrice <= 0.90);

      if (isEligible) {
        const spread = noBidAsk.bid !== null ? noBidAsk.ask - noBidAsk.bid : 0;
        candidates.push({
          contract_id: noContractId,
          side: 'NO',
          strike: market.strike_price_display || market.ticker,
          best_bid: noBidAsk.bid,
          best_ask: noBidAsk.ask,
          spread,
          entry_price: entryPrice,
        });
      }
    }

    // Sort by spread (lower spread = better)
    candidates.sort((a, b) => a.spread - b.spread);

    return candidates;
  }

  /**
   * Subscribe to order book updates for market contracts.
   */
  subscribeToMarket(market: KalshiMarket): void {
    const yesContractId = `${market.ticker}-YES`;
    const noContractId = `${market.ticker}-NO`;

    this.wsClient.subscribeToOrderBook(yesContractId);
    this.wsClient.subscribeToOrderBook(noContractId);
  }

  /**
   * Unsubscribe from order book updates for market contracts.
   */
  unsubscribeFromMarket(market: KalshiMarket): void {
    const yesContractId = `${market.ticker}-YES`;
    const noContractId = `${market.ticker}-NO`;

    this.wsClient.unsubscribeFromOrderBook(yesContractId);
    this.wsClient.unsubscribeFromOrderBook(noContractId);
  }
}

