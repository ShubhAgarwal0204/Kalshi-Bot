import { HourSessionsRepository } from '../supabase/repositories/hour-sessions.js';
import { OrdersRepository } from '../supabase/repositories/orders.js';
import { FillsRepository } from '../supabase/repositories/fills.js';

/**
 * Manages exposure limits per hour session.
 * Enforces 25% cash cap per hour with size reduction after losses.
 */
export class ExposureManager {
  private hourSessionsRepo: HourSessionsRepository;
  private ordersRepo: OrdersRepository;
  private fillsRepo: FillsRepository;

  constructor(
    hourSessionsRepo: HourSessionsRepository,
    ordersRepo: OrdersRepository,
    fillsRepo: FillsRepository
  ) {
    this.hourSessionsRepo = hourSessionsRepo;
    this.ordersRepo = ordersRepo;
    this.fillsRepo = fillsRepo;
  }

  /**
   * Check if a new trade can be executed within exposure limits.
   */
  async canSpend(hourSessionId: string, amount: number): Promise<{ allowed: boolean; reason?: string }> {
    const session = await this.hourSessionsRepo.getById(hourSessionId);
    if (!session) {
      return { allowed: false, reason: 'Hour session not found' };
    }

    const newTotalSpent = session.cash_spent + amount;
    if (newTotalSpent > session.max_spend_allowed) {
      return {
        allowed: false,
        reason: `Would exceed max spend allowed. Current: $${session.cash_spent.toFixed(2)}, Max: $${session.max_spend_allowed.toFixed(2)}, Requested: $${amount.toFixed(2)}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a trade spend (atomically update cash_spent).
   */
  async recordSpend(hourSessionId: string, amount: number): Promise<void> {
    const session = await this.hourSessionsRepo.getById(hourSessionId);
    if (!session) {
      throw new Error('Hour session not found');
    }

    const newCashSpent = session.cash_spent + amount;
    if (newCashSpent > session.max_spend_allowed) {
      throw new Error(`Cannot spend $${amount.toFixed(2)}: would exceed max spend allowed`);
    }

    await this.hourSessionsRepo.update(hourSessionId, {
      cash_spent: newCashSpent,
    });
  }

  /**
   * Get remaining spend capacity for an hour session.
   * Applies size multiplier based on losses.
   */
  async getRemainingCapacity(hourSessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(hourSessionId);
    if (!session) {
      return 0;
    }

    const baseCapacity = Math.max(0, session.max_spend_allowed - session.cash_spent);
    const multiplier = await this.getSizeMultiplier(hourSessionId);
    return baseCapacity * multiplier;
  }

  /**
   * Get size multiplier based on number of losses in the hour.
   * Returns 1.0 (100%) if 0 losses, 0.7 (70%) if 1 loss, 0.5 (50%) if 2+ losses.
   */
  async getSizeMultiplier(hourSessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(hourSessionId);
    if (!session) {
      return 1.0;
    }

    // Use stored multiplier if available (updated after each loss)
    if (session.size_multiplier !== 1.0) {
      return session.size_multiplier;
    }

    // Count losing trades by checking filled sell orders
    const losingTradesCount = await this.countLosingTrades(hourSessionId);

    if (losingTradesCount === 0) {
      return 1.0; // 100%
    } else if (losingTradesCount === 1) {
      return 0.7; // 70%
    } else {
      return 0.5; // 50%
    }
  }

  /**
   * Count the number of losing trades in this hour session.
   * A losing trade is a filled sell order where exit price < entry price (for YES) or exit price > entry price (for NO).
   */
  private async countLosingTrades(hourSessionId: string): Promise<number> {
    const orders = await this.ordersRepo.getByHourSession(hourSessionId);
    let losingCount = 0;

    for (const order of orders) {
      // Only count filled sell orders
      if (order.action === 'SELL' && order.status === 'filled') {
        const fills = await this.fillsRepo.getByOrderId(order.id);
        if (fills.length === 0) continue;

        // Get average exit price
        const totalSize = fills.reduce((sum, f) => sum + f.size, 0);
        const avgExitPrice = fills.reduce((sum, f) => sum + f.price * f.size, 0) / totalSize;

        // Find the corresponding buy order to get entry price
        const buyOrders = orders.filter(
          (o) => o.contract_id === order.contract_id && o.side === order.side && o.action === 'BUY'
        );

        if (buyOrders.length > 0) {
          const buyOrder = buyOrders[0];
          const buyFills = await this.fillsRepo.getByOrderId(buyOrder.id);
          if (buyFills.length > 0) {
            const buyTotalSize = buyFills.reduce((sum, f) => sum + f.size, 0);
            const avgEntryPrice = buyFills.reduce((sum, f) => sum + f.price * f.size, 0) / buyTotalSize;

            // Check if it's a loss
            const isLoss = order.side === 'YES' 
              ? avgExitPrice < avgEntryPrice 
              : avgExitPrice > avgEntryPrice;

            if (isLoss) {
              losingCount++;
            }
          }
        }
      }
    }

    return losingCount;
  }

  /**
   * Update size multiplier after a loss.
   * Should be called after a losing trade is filled.
   */
  async updateSizeMultiplierAfterLoss(hourSessionId: string): Promise<void> {
    const losingTradesCount = await this.countLosingTrades(hourSessionId);
    let newMultiplier: number;

    if (losingTradesCount === 0) {
      newMultiplier = 1.0; // 100%
    } else if (losingTradesCount === 1) {
      newMultiplier = 0.7; // 70%
    } else {
      newMultiplier = 0.5; // 50%
    }

    await this.hourSessionsRepo.update(hourSessionId, {
      size_multiplier: newMultiplier,
    });
  }
}

