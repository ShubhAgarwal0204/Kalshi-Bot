import { getConfig } from '../config.js';
import { KalshiWebSocketClient } from '../kalshi/websocket-client.js';
import { KalshiRESTClient } from '../kalshi/rest-client.js';
import { OrdersRepository } from '../supabase/repositories/orders.js';
import { HourSessionsRepository } from '../supabase/repositories/hour-sessions.js';

export interface Position {
  contract_id: string;
  side: 'YES' | 'NO';
  order_id: string;
  hour_session_id: string;
  entry_price: number;
  size: number;
}

/**
 * Monitors positions for stop-loss and take-profit triggers.
 * Handles both SL (≤ 0.70) and TP (≥ 0.96) exits.
 */
export class PositionMonitor {
  private wsClient: KalshiWebSocketClient;
  private restClient: KalshiRESTClient;
  private ordersRepo: OrdersRepository;
  private hourSessionsRepo: HourSessionsRepository;
  private positions: Map<string, Position> = new Map(); // contract_id -> Position

  constructor(
    wsClient: KalshiWebSocketClient,
    restClient: KalshiRESTClient,
    ordersRepo: OrdersRepository,
    hourSessionsRepo: HourSessionsRepository
  ) {
    this.wsClient = wsClient;
    this.restClient = restClient;
    this.ordersRepo = ordersRepo;
    this.hourSessionsRepo = hourSessionsRepo;
  }

  /**
   * Register a position to monitor.
   */
  registerPosition(position: Position): void {
    this.positions.set(position.contract_id, position);
  }

  /**
   * Remove a position from monitoring (e.g., after sell).
   */
  removePosition(contractId: string): void {
    this.positions.delete(contractId);
  }

  /**
   * Check all positions for stop-loss triggers.
   * Returns list of contracts that triggered stop-loss.
   */
  async checkStopLosses(): Promise<string[]> {
    const config = getConfig();
    const triggered: string[] = [];

    for (const [contractId, position] of this.positions.entries()) {
      const bidAsk = this.wsClient.getBestBidAsk(contractId, position.side);
      
      // Exit price: best bid for YES positions, best ask for NO positions
      const exitPrice = position.side === 'YES' ? bidAsk.bid : bidAsk.ask;

      if (exitPrice !== null && exitPrice <= config.STOP_LOSS_PRICE) {
        triggered.push(contractId);
      }
    }

    return triggered;
  }

  /**
   * Check all positions for take-profit triggers.
   * Returns list of contracts that triggered take-profit.
   * During SELL_ONLY phase: only triggers if price >= 0.96 and < 0.99
   * Otherwise: triggers if price >= 0.96
   */
  async checkTakeProfit(isSellOnlyPhase: boolean = false): Promise<string[]> {
    const config = getConfig();
    const triggered: string[] = [];

    for (const [contractId, position] of this.positions.entries()) {
      const bidAsk = this.wsClient.getBestBidAsk(contractId, position.side);
      
      // Exit price: best bid for YES positions, best ask for NO positions
      const exitPrice = position.side === 'YES' ? bidAsk.bid : bidAsk.ask;

      if (exitPrice !== null) {
        if (isSellOnlyPhase) {
          // During SELL_ONLY phase: only TP if >= 0.96 and < 0.99
          if (exitPrice >= config.TAKE_PROFIT_PRICE && exitPrice < 0.99) {
            triggered.push(contractId);
          }
        } else {
          // Normal phase: TP if >= 0.96
          if (exitPrice >= config.TAKE_PROFIT_PRICE) {
            triggered.push(contractId);
          }
        }
      }
    }

    return triggered;
  }

  /**
   * Execute stop-loss for a contract.
   * Sets cooldown after execution.
   */
  async executeStopLoss(contractId: string): Promise<void> {
    const position = this.positions.get(contractId);
    if (!position) {
      return; // Position already closed or doesn't exist
    }

    const bidAsk = this.wsClient.getBestBidAsk(contractId, position.side);
    const exitPrice = position.side === 'YES' ? bidAsk.bid : bidAsk.ask;

    if (exitPrice === null) {
      console.warn(`Cannot execute stop-loss for ${contractId}: no exit price available`);
      return;
    }

    try {
      // Cancel any pending buy orders for this contract
      const openOrders = await this.ordersRepo.getOpenOrders(position.hour_session_id);
      for (const order of openOrders) {
        if (order.contract_id === contractId && order.action === 'BUY') {
          try {
            await this.restClient.cancelOrder(order.kalshi_order_id);
            await this.ordersRepo.update(order.id, { status: 'cancelled' });
          } catch (error) {
            console.error(`Error cancelling order ${order.kalshi_order_id}:`, error);
          }
        }
      }

      // Place sell order
      const sellOrder = await this.restClient.createOrder({
        contract_id: contractId,
        side: position.side,
        action: 'SELL',
        limit_price: exitPrice,
        size: position.size,
      });

      console.log(`Stop-loss executed for ${contractId}: sold ${position.size} contracts at ${exitPrice}`);

      // Update order status in database
      const dbOrder = await this.ordersRepo.getByKalshiOrderId(sellOrder.order_id);
      if (dbOrder) {
        await this.ordersRepo.update(dbOrder.id, { status: 'pending' });
      }

      // Set cooldown after stop-loss
      const config = getConfig();
      const cooldownUntil = new Date(Date.now() + config.STOP_LOSS_COOLDOWN_SECONDS * 1000);
      await this.hourSessionsRepo.update(position.hour_session_id, {
        cooldown_until: cooldownUntil,
      });

      // Remove from monitoring
      this.removePosition(contractId);
    } catch (error) {
      console.error(`Error executing stop-loss for ${contractId}:`, error);
      throw error;
    }
  }

  /**
   * Execute take-profit for a contract.
   */
  async executeTakeProfit(contractId: string): Promise<void> {
    const position = this.positions.get(contractId);
    if (!position) {
      return; // Position already closed or doesn't exist
    }

    const bidAsk = this.wsClient.getBestBidAsk(contractId, position.side);
    const exitPrice = position.side === 'YES' ? bidAsk.bid : bidAsk.ask;

    if (exitPrice === null) {
      console.warn(`Cannot execute take-profit for ${contractId}: no exit price available`);
      return;
    }

    try {
      // Place sell order
      const sellOrder = await this.restClient.createOrder({
        contract_id: contractId,
        side: position.side,
        action: 'SELL',
        limit_price: exitPrice,
        size: position.size,
      });

      console.log(`Take-profit executed for ${contractId}: sold ${position.size} contracts at ${exitPrice}`);

      // Update order status in database
      const dbOrder = await this.ordersRepo.getByKalshiOrderId(sellOrder.order_id);
      if (dbOrder) {
        await this.ordersRepo.update(dbOrder.id, { status: 'pending' });
      }

      // Remove from monitoring
      this.removePosition(contractId);
    } catch (error) {
      console.error(`Error executing take-profit for ${contractId}:`, error);
      throw error;
    }
  }

  /**
   * Get all monitored positions.
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}

