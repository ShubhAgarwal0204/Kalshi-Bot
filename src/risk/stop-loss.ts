import { getConfig } from '../config.js';
import { KalshiWebSocketClient } from '../kalshi/websocket-client.js';
import { KalshiRESTClient } from '../kalshi/rest-client.js';
import { OrdersRepository } from '../supabase/repositories/orders.js';

export interface Position {
  contract_id: string;
  side: 'YES' | 'NO';
  order_id: string;
  hour_session_id: string;
  entry_price: number;
  size: number;
}

/**
 * Monitors positions for stop-loss triggers.
 * Sells immediately if exit price ≤ STOP_LOSS_PRICE.
 */
export class StopLossMonitor {
  private wsClient: KalshiWebSocketClient;
  private restClient: KalshiRESTClient;
  private ordersRepo: OrdersRepository;
  private positions: Map<string, Position> = new Map(); // contract_id -> Position

  constructor(
    wsClient: KalshiWebSocketClient,
    restClient: KalshiRESTClient,
    ordersRepo: OrdersRepository
  ) {
    this.wsClient = wsClient;
    this.restClient = restClient;
    this.ordersRepo = ordersRepo;
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
   * Execute stop-loss for a contract.
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

      // Remove from monitoring
      this.removePosition(contractId);
    } catch (error) {
      console.error(`Error executing stop-loss for ${contractId}:`, error);
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

