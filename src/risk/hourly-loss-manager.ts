import { getConfig } from '../config.js';
import { HourSessionsRepository } from '../supabase/repositories/hour-sessions.js';

/**
 * Manages hourly loss limits and tracking.
 * Enforces 15% of max trade budget as hourly loss cap.
 */
export class HourlyLossManager {
  private hourSessionsRepo: HourSessionsRepository;

  constructor(hourSessionsRepo: HourSessionsRepository) {
    this.hourSessionsRepo = hourSessionsRepo;
  }

  /**
   * Calculate max trade budget (25% of portfolio cash).
   */
  calculateMaxTradeBudget(portfolioCash: number): number {
    return portfolioCash * 0.25;
  }

  /**
   * Calculate hourly loss cap (15% of max trade budget).
   */
  calculateHourlyLossCap(portfolioCash: number): number {
    const maxTradeBudget = this.calculateMaxTradeBudget(portfolioCash);
    const config = getConfig();
    return maxTradeBudget * (config.HOURLY_LOSS_CAP_PERCENT / 100);
  }

  /**
   * Check if hourly loss cap has been breached.
   */
  async isLossCapBreached(sessionId: string): Promise<boolean> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      return true; // Err on the side of caution
    }

    const hourlyLossCap = this.calculateHourlyLossCap(session.cash_at_start);
    return session.realized_losses >= hourlyLossCap;
  }

  /**
   * Record a realized loss from a filled sell order.
   * Calculates P&L: (exit_price - entry_price) * size for YES, (entry_price - exit_price) * size for NO
   */
  async recordLoss(
    sessionId: string,
    entryPrice: number,
    exitPrice: number,
    size: number,
    side: 'YES' | 'NO'
  ): Promise<void> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      throw new Error('Hour session not found');
    }

    // Calculate P&L
    // For YES: profit = (1 - entry_price) - (1 - exit_price) = exit_price - entry_price
    // For NO: profit = entry_price - exit_price
    // Loss is negative P&L
    const pnl = side === 'YES' 
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;

    const loss = pnl < 0 ? Math.abs(pnl) : 0;
    const newRealizedLosses = session.realized_losses + loss;

    await this.hourSessionsRepo.update(sessionId, {
      realized_losses: newRealizedLosses,
    });
  }

  /**
   * Get current realized losses for a session.
   */
  async getRealizedLosses(sessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      return 0;
    }
    return session.realized_losses;
  }

  /**
   * Get hourly loss cap for a session.
   */
  async getHourlyLossCap(sessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      return 0;
    }
    return this.calculateHourlyLossCap(session.cash_at_start);
  }

  /**
   * Get remaining loss capacity before cap is breached.
   */
  async getRemainingLossCapacity(sessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      return 0;
    }

    const hourlyLossCap = this.calculateHourlyLossCap(session.cash_at_start);
    return Math.max(0, hourlyLossCap - session.realized_losses);
  }
}

