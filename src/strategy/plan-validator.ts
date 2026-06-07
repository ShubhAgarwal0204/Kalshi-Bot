import { getConfig } from '../config.js';
import { KalshiWebSocketClient } from '../kalshi/websocket-client.js';
import { KalshiRESTClient } from '../kalshi/rest-client.js';
import type { TradePlan } from '../openai/schemas.js';
import { isWithinTradingHours } from '../engine/session-manager.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates OpenAI trade plans against hard constraints.
 * All validation is deterministic - OpenAI recommendations are advisory only.
 */
export class PlanValidator {
  private wsClient: KalshiWebSocketClient;
  private lastFeedUpdate: Map<string, Date> = new Map();

  constructor(wsClient: KalshiWebSocketClient, _restClient: KalshiRESTClient) {
    this.wsClient = wsClient;
    // restClient kept in constructor for future use
  }

  /**
   * Validate a trade plan.
   */
  async validate(plan: TradePlan, remainingHourlyCapital: number): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = getConfig();

    // If action is SKIP, no further validation needed
    if (plan.action === 'SKIP') {
      return { valid: true, errors: [] };
    }

    // Validate action is ENTER
    if (plan.action !== 'ENTER') {
      errors.push(`Invalid action: ${plan.action}. Expected ENTER or SKIP.`);
    }

    // Validate required fields for ENTER
    if (!plan.contract_id) {
      errors.push('contract_id is required for ENTER action');
    }
    if (plan.entry_limit_price === undefined || plan.entry_limit_price === null) {
      errors.push('entry_limit_price is required for ENTER action');
    }
    if (plan.dollars_to_spend === undefined || plan.dollars_to_spend === null) {
      errors.push('dollars_to_spend is required for ENTER action');
    }
    if (!plan.side) {
      errors.push('side is required for ENTER action');
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Validate entry price range
    if (
      plan.entry_limit_price! < config.ENTRY_PRICE_MIN ||
      plan.entry_limit_price! > config.ENTRY_PRICE_MAX
    ) {
      errors.push(
        `Entry price ${plan.entry_limit_price} is outside allowed range [${config.ENTRY_PRICE_MIN}, ${config.ENTRY_PRICE_MAX}]`
      );
    }

    // Validate stop loss price
    if (plan.stop_loss_price !== config.STOP_LOSS_PRICE) {
      errors.push(
        `Stop loss price ${plan.stop_loss_price} does not match configured value ${config.STOP_LOSS_PRICE}`
      );
    }

    // Validate dollars_to_spend doesn't exceed remaining capital
    if (plan.dollars_to_spend! > remainingHourlyCapital) {
      errors.push(
        `dollars_to_spend ${plan.dollars_to_spend} exceeds remaining hourly capital ${remainingHourlyCapital}`
      );
    }

    // Validate contract exists and is live
    if (plan.contract_id) {
      try {
        // Check if we have recent order book data
        const orderBook = this.wsClient.getOrderBook(plan.contract_id);
        if (!orderBook) {
          errors.push(`No order book data available for contract ${plan.contract_id}`);
        } else {
          // Update feed timestamp
          this.lastFeedUpdate.set(plan.contract_id, new Date());
        }
      } catch (error) {
        errors.push(`Error validating contract ${plan.contract_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Validate feeds are not stale (< 5 seconds old)
    if (plan.contract_id) {
      const lastUpdate = this.lastFeedUpdate.get(plan.contract_id);
      if (lastUpdate) {
        const ageMs = Date.now() - lastUpdate.getTime();
        if (ageMs > 5000) {
          errors.push(`Feed data for contract ${plan.contract_id} is stale (${ageMs}ms old)`);
        }
      }
    }

    // Validate WebSocket connection
    if (!this.wsClient.isConnected()) {
      errors.push('Kalshi WebSocket is not connected');
    }

    // Validate within trading hours
    const nowET = new Date();
    if (!isWithinTradingHours(nowET)) {
      errors.push('Current time is outside trading hours');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Update feed timestamp for a contract (called when order book updates).
   */
  updateFeedTimestamp(contractId: string): void {
    this.lastFeedUpdate.set(contractId, new Date());
  }
}

