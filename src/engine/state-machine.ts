import { HourSessionsRepository, type HourSessionState } from '../supabase/repositories/hour-sessions.js';

export type State = HourSessionState;

/**
 * State machine for hourly trading sessions.
 * States persist to database to survive restarts.
 */
export class TradingStateMachine {
  private hourSessionsRepo: HourSessionsRepository;

  constructor(hourSessionsRepo: HourSessionsRepository) {
    this.hourSessionsRepo = hourSessionsRepo;
  }

  /**
   * Get current state for a session.
   */
  async getState(sessionId: string): Promise<State | null> {
    const session = await this.hourSessionsRepo.getById(sessionId);
    return session?.state || null;
  }

  /**
   * Transition to a new state.
   */
  async transition(sessionId: string, newState: State): Promise<void> {
    await this.hourSessionsRepo.update(sessionId, { state: newState });
  }

  /**
   * Check if a transition is valid.
   */
  isValidTransition(currentState: State, newState: State): boolean {
    const validTransitions: Record<State, State[]> = {
      IDLE: ['WAIT_ENTRY_WINDOW', 'IGNORE_EARLY', 'SKIP_HOUR_OBSERVE'],
      WAIT_ENTRY_WINDOW: ['BUILD_CANDIDATES', 'IGNORE_EARLY', 'SCAN_PLAN', 'SKIP_HOUR_OBSERVE', 'DONE'],
      IGNORE_EARLY: ['SCAN_PLAN', 'SKIP_HOUR_OBSERVE', 'DONE'],
      SCAN_PLAN: ['TRADE_ACTIVE', 'SKIP_HOUR_OBSERVE', 'BUILD_CANDIDATES', 'DONE'],
      BUILD_CANDIDATES: ['OPENAI_RECOMMENDATION', 'SCAN_PLAN', 'DONE'],
      OPENAI_RECOMMENDATION: ['VALIDATE_PLAN', 'SCAN_PLAN', 'DONE'],
      VALIDATE_PLAN: ['PLACING_BUY', 'OPENAI_RECOMMENDATION', 'SCAN_PLAN', 'TRADE_ACTIVE', 'DONE'],
      PLACING_BUY: ['IN_POSITION', 'TRADE_ACTIVE', 'COOLDOWN', 'DONE'],
      TRADE_ACTIVE: ['SELL_ONLY', 'COOLDOWN', 'PLACING_BUY', 'IN_POSITION', 'DONE'],
      IN_POSITION: ['PLACING_SELL', 'TRADE_ACTIVE', 'SELL_ONLY', 'DONE'],
      PLACING_SELL: ['DONE', 'IN_POSITION', 'TRADE_ACTIVE', 'SELL_ONLY'],
      SELL_ONLY: ['DONE'],
      SKIP_HOUR_OBSERVE: ['DONE'],
      COOLDOWN: ['TRADE_ACTIVE', 'SELL_ONLY', 'DONE'],
      DONE: [],
    };

    return validTransitions[currentState]?.includes(newState) ?? false;
  }

  /**
   * Transition with validation.
   */
  async transitionWithValidation(sessionId: string, newState: State): Promise<boolean> {
    const currentState = await this.getState(sessionId);
    if (!currentState) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.isValidTransition(currentState, newState)) {
      console.warn(`Invalid transition from ${currentState} to ${newState}`);
      return false;
    }

    await this.transition(sessionId, newState);
    return true;
  }
}

