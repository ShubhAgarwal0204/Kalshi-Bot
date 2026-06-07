import { getConfig } from '../config.js';
import { KalshiWebSocketClient } from '../kalshi/websocket-client.js';
import { KalshiRESTClient } from '../kalshi/rest-client.js';
import { isWithinTradingHours } from '../engine/session-manager.js';
import { BotRunsRepository } from '../supabase/repositories/bot-runs.js';

export interface CircuitBreakerStatus {
  healthy: boolean;
  checks: {
    kalshiWebSocket: boolean;
    cashBalance: boolean;
    tradingHours: boolean;
  };
  errors: string[];
}

/**
 * Circuit breaker for system-level safety checks.
 * Pauses trading if any critical check fails.
 */
export class CircuitBreaker {
  private kalshiWS: KalshiWebSocketClient;
  private restClient: KalshiRESTClient;
  private botRunsRepo: BotRunsRepository;
  private lastCashBalanceCheck: Date | null = null;
  private cachedCashBalance: number | null = null;
  private cashBalanceCacheTTL: number = 60000; // 1 minute

  constructor(
    kalshiWS: KalshiWebSocketClient,
    restClient: KalshiRESTClient,
    botRunsRepo: BotRunsRepository
  ) {
    this.kalshiWS = kalshiWS;
    this.restClient = restClient;
    this.botRunsRepo = botRunsRepo;
  }

  /**
   * Check all circuit breaker conditions.
   */
  async check(): Promise<CircuitBreakerStatus> {
    const errors: string[] = [];
    const checks = {
      kalshiWebSocket: false,
      cashBalance: false,
      tradingHours: false,
    };

    // Check Kalshi WebSocket
    if (this.kalshiWS.isConnected()) {
      checks.kalshiWebSocket = true;
    } else {
      errors.push('Kalshi WebSocket is not connected');
    }

    // Check cash balance
    try {
      const balance = await this.getCashBalance();
      if (balance === null || balance === undefined) {
        errors.push('Cash balance is unavailable');
      } else {
        const config = getConfig();
        if (balance >= config.MIN_CASH_RESERVE) {
          checks.cashBalance = true;
        } else {
          errors.push(`Cash balance $${balance.toFixed(2)} is below minimum reserve $${config.MIN_CASH_RESERVE}`);
        }
      }
    } catch (error) {
      errors.push(`Error checking cash balance: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Check trading hours
    const nowET = new Date();
    if (isWithinTradingHours(nowET)) {
      checks.tradingHours = true;
    } else {
      errors.push('Current time is outside trading hours');
    }

    const healthy = Object.values(checks).every((check) => check === true);

    return {
      healthy,
      checks,
      errors,
    };
  }

  /**
   * Get cached cash balance (with TTL).
   */
  private async getCashBalance(): Promise<number | null> {
    const now = new Date();
    if (
      this.cachedCashBalance !== null &&
      this.lastCashBalanceCheck &&
      now.getTime() - this.lastCashBalanceCheck.getTime() < this.cashBalanceCacheTTL
    ) {
      return this.cachedCashBalance;
    }

    try {
      const balance = await this.restClient.getBalance();
      if (balance && typeof balance.available_balance === 'number') {
        this.cachedCashBalance = balance.available_balance;
        this.lastCashBalanceCheck = now;
        return this.cachedCashBalance;
      } else {
        console.warn('Invalid balance response:', balance);
        return null;
      }
    } catch (error) {
      console.error('Failed to get balance:', error);
      return null;
    }
  }

  /**
   * Check if trading should be paused.
   */
  async shouldPauseTrading(): Promise<boolean> {
    const status = await this.check();
    return !status.healthy;
  }

  /**
   * Check if the next hour should be skipped due to consecutive losing hours.
   * Returns true if consecutive_losing_hours >= 2.
   */
  async shouldSkipHour(botRunId: string): Promise<boolean> {
    const botRun = await this.botRunsRepo.getById(botRunId);
    if (!botRun) {
      return false; // Err on the side of not skipping if bot run not found
    }

    return botRun.consecutive_losing_hours >= 2;
  }

  /**
   * Update consecutive losing hours counter based on hourly P&L.
   * If P&L < 0: increment counter
   * If P&L >= 0: reset counter to 0
   */
  async updateConsecutiveLosingHours(botRunId: string, hourlyPnl: number): Promise<void> {
    const botRun = await this.botRunsRepo.getById(botRunId);
    if (!botRun) {
      return;
    }

    if (hourlyPnl < 0) {
      // Increment consecutive losing hours
      await this.botRunsRepo.update(botRunId, {
        consecutive_losing_hours: botRun.consecutive_losing_hours + 1,
      });
    } else {
      // Reset to 0 if P&L >= 0
      await this.botRunsRepo.update(botRunId, {
        consecutive_losing_hours: 0,
      });
    }
  }
}

