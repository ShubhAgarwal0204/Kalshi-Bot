import { utcToZonedTime } from 'date-fns-tz';
import { getConfig } from '../config.js';
import { HourSessionsRepository, type HourSessionState } from '../supabase/repositories/hour-sessions.js';
import { BotRunsRepository } from '../supabase/repositories/bot-runs.js';
import type { KalshiMarket } from '../kalshi/types.js';

const ET_TIMEZONE = 'America/New_York';

/**
 * Check if current time is within trading hours (ET).
 */
export function isWithinTradingHours(date: Date): boolean {
  const config = getConfig();
  const etDate = utcToZonedTime(date, ET_TIMEZONE);
  const hour = etDate.getHours();

  // Trading hours: 8 AM - 12 AM (midnight = 24)
  if (config.TRADING_END_HOUR === 24) {
    return hour >= config.TRADING_START_HOUR;
  } else {
    return hour >= config.TRADING_START_HOUR && hour < config.TRADING_END_HOUR;
  }
}

/**
 * Get the next market hour (resolution time) for a given time.
 */
export function getNextMarketHour(date: Date): Date {
  const etDate = utcToZonedTime(date, ET_TIMEZONE);
  const nextHour = new Date(etDate);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  return nextHour;
}

/**
 * Get the entry window start time for a market hour.
 */
export function getEntryWindowStart(marketHour: Date): Date {
  const config = getConfig();
  const entryWindowStart = new Date(marketHour);
  entryWindowStart.setMinutes(entryWindowStart.getMinutes() - config.ENTRY_WINDOW_MINUTES);
  return entryWindowStart;
}

/**
 * Check if we're currently in the entry window for a market hour.
 */
export function isInEntryWindow(marketHour: Date, currentTime: Date): boolean {
  const entryWindowStart = getEntryWindowStart(marketHour);
  return currentTime >= entryWindowStart && currentTime < marketHour;
}

/**
 * Get minutes remaining until market hour resolution.
 */
function getMinutesUntilMarketHour(marketHour: Date, currentTime: Date): number {
  const diffMs = marketHour.getTime() - currentTime.getTime();
  return Math.floor(diffMs / (1000 * 60));
}

/**
 * Check if we're in Phase A: IGNORE_EARLY (00:00-00:30)
 * First 30 minutes of the hour - no trading, passive BTC tracking only.
 */
export function isInIgnoreEarlyPhase(marketHour: Date, currentTime: Date): boolean {
  const minutesRemaining = getMinutesUntilMarketHour(marketHour, currentTime);
  return minutesRemaining > 30 && minutesRemaining <= 60;
}

/**
 * Check if we're in Phase B: SCAN_PLAN (00:30-00:40)
 * Market scanning and Plan A/B preparation, no trading yet.
 */
export function isInScanPlanPhase(marketHour: Date, currentTime: Date): boolean {
  const minutesRemaining = getMinutesUntilMarketHour(marketHour, currentTime);
  return minutesRemaining > 20 && minutesRemaining <= 30;
}

/**
 * Check if we're in Phase C: TRADE_ACTIVE (00:40-00:58:30)
 * Active trading window - can enter positions.
 */
export function isInTradeActivePhase(marketHour: Date, currentTime: Date): boolean {
  const minutesRemaining = getMinutesUntilMarketHour(marketHour, currentTime);
  const secondsRemaining = Math.floor((marketHour.getTime() - currentTime.getTime()) / 1000);
  // Between 20 minutes and 90 seconds remaining
  return minutesRemaining >= 1 && secondsRemaining > 90;
}

/**
 * Check if we're in Phase D: SELL_ONLY (00:58:30-01:00)
 * Last 90 seconds - exit-only mode, no new entries.
 */
export function isInSellOnlyPhase(marketHour: Date, currentTime: Date): boolean {
  const secondsRemaining = Math.floor((marketHour.getTime() - currentTime.getTime()) / 1000);
  return secondsRemaining > 0 && secondsRemaining <= 90;
}

/**
 * Session manager for hourly trading sessions.
 */
export class SessionManager {
  private hourSessionsRepo: HourSessionsRepository;

  constructor(hourSessionsRepo: HourSessionsRepository, _botRunsRepo: BotRunsRepository) {
    this.hourSessionsRepo = hourSessionsRepo;
    // botRunsRepo kept in constructor for future use
  }

  /**
   * Get or create hour session for the current/next market hour.
   */
  async getOrCreateHourSession(
    botRunId: string,
    market: KalshiMarket,
    cashAtStart: number,
    isSkipHour?: boolean,
    sizeMultiplier?: number
  ): Promise<string> {
    const marketHour = new Date(market.expiration_time);
    
    // Check if session already exists
    const existing = await this.hourSessionsRepo.getByMarketHour(marketHour);
    if (existing) {
      return existing.id;
    }

    // Create new session
    const config = getConfig();
    const entryWindowStart = getEntryWindowStart(marketHour);
    const maxSpendAllowed = cashAtStart * (config.HOURLY_CAP_PERCENT / 100);

    const session = await this.hourSessionsRepo.create({
      bot_run_id: botRunId,
      market_hour: marketHour,
      entry_window_start: entryWindowStart,
      cash_at_start: cashAtStart,
      max_spend_allowed: maxSpendAllowed,
      is_skip_hour: isSkipHour || false,
      size_multiplier: sizeMultiplier || 1.0,
    });

    return session.id;
  }

  /**
   * Get active hour sessions.
   */
  async getActiveSessions(): Promise<string[]> {
    const sessions = await this.hourSessionsRepo.getActiveSessions();
    return sessions.map((s) => s.id);
  }

  /**
   * Update session state.
   */
  async updateState(sessionId: string, state: HourSessionState): Promise<void> {
    await this.hourSessionsRepo.update(sessionId, { state });
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string) {
    return this.hourSessionsRepo.getById(sessionId);
  }

  /**
   * Get trades count for a session.
   */
  async getTradesCount(sessionId: string): Promise<number> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    return session?.trades_count || 0;
  }

  /**
   * Increment trades count for a session.
   */
  async incrementTradesCount(sessionId: string): Promise<void> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      throw new Error('Hour session not found');
    }

    await this.hourSessionsRepo.update(sessionId, {
      trades_count: session.trades_count + 1,
    });
  }

  /**
   * Check if session is in cooldown period.
   */
  async isInCooldown(sessionId: string): Promise<boolean> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session || !session.cooldown_until) {
      return false;
    }

    return new Date() < session.cooldown_until;
  }

  /**
   * Check if session can place a new trade (not at max trades and not in cooldown).
   */
  async canPlaceTrade(sessionId: string): Promise<{ allowed: boolean; reason?: string }> {
    const config = getConfig();
    const session = await this.hourSessionsRepo.getById(sessionId);
    if (!session) {
      return { allowed: false, reason: 'Hour session not found' };
    }

    // Check max trades per hour
    if (session.trades_count >= config.MAX_TRADES_PER_HOUR) {
      return {
        allowed: false,
        reason: `Max trades per hour (${config.MAX_TRADES_PER_HOUR}) reached`,
      };
    }

    // Check cooldown
    if (session.cooldown_until && new Date() < session.cooldown_until) {
      const remainingSeconds = Math.ceil(
        (session.cooldown_until.getTime() - Date.now()) / 1000
      );
      return {
        allowed: false,
        reason: `In cooldown period (${remainingSeconds}s remaining)`,
      };
    }

    return { allowed: true };
  }
}

