import type { ContractCandidate } from './candidate-selector.js';
import type { KalshiMarket } from '../kalshi/types.js';
import type { BTCFeatures } from '../market/btc-features.js';

export interface Plan {
  type: 'A' | 'B';
  candidate: ContractCandidate;
  armed: boolean;
  armedAt?: Date;
}

/**
 * Manages Plan A (primary) and Plan B (contingency) trading plans.
 * Plan B is armed when Plan A weakens into warning band AND signals align.
 */
export class PlanManager {
  private planA: Plan | null = null;
  private planB: Plan | null = null;

  /**
   * Build Plan A (primary intended trade) from candidates.
   * Selects the best candidate (lowest spread, best entry price).
   */
  buildPlanA(candidates: ContractCandidate[]): Plan | null {
    if (candidates.length === 0) {
      return null;
    }

    // Select best candidate (already sorted by spread)
    const bestCandidate = candidates[0];

    this.planA = {
      type: 'A',
      candidate: bestCandidate,
      armed: false,
    };

    return this.planA;
  }

  /**
   * Build Plan B (opposite contingency trade) from candidates.
   * Selects the opposite side of Plan A if available.
   */
  buildPlanB(candidates: ContractCandidate[], planA: Plan | null): Plan | null {
    if (!planA || candidates.length === 0) {
      return null;
    }

    // Find opposite side candidate
    const oppositeSide = planA.candidate.side === 'YES' ? 'NO' : 'YES';
    const oppositeCandidate = candidates.find((c) => c.side === oppositeSide);

    if (!oppositeCandidate) {
      return null;
    }

    this.planB = {
      type: 'B',
      candidate: oppositeCandidate,
      armed: false,
    };

    return this.planB;
  }

  /**
   * Check if contract price is in warning band (0.71-0.79).
   * This indicates the currently favored side is weakening.
   */
  checkWarningBand(contractPrice: number | null): boolean {
    if (contractPrice === null) {
      return false;
    }
    return contractPrice >= 0.71 && contractPrice <= 0.79;
  }

  /**
   * Check if Plan B should be armed (Option C logic).
   * Plan B is armed only when BOTH:
   * 1. Kalshi price action supports continued move (weakening/strengthening consistent with flip)
   * 2. BTC direction/pattern supports the same direction
   */
  armPlanB(
    planA: Plan | null,
    planB: Plan | null,
    kalshiData: {
      planAPrice: number | null;
      planBPrice: number | null;
      planAPriceTrend: 'weakening' | 'strengthening' | 'stable';
    },
    btcData: BTCFeatures | null
  ): boolean {
    if (!planA || !planB) {
      return false;
    }

    // Check if Plan A is in warning band
    if (!this.checkWarningBand(kalshiData.planAPrice)) {
      return false;
    }

    // Check Kalshi price action: Plan A should be weakening (price decreasing for YES, increasing for NO)
    const kalshiSupportsFlip = this.checkKalshiPriceActionSupportsFlip(
      planA.candidate.side,
      kalshiData.planAPriceTrend
    );

    if (!kalshiSupportsFlip) {
      return false;
    }

    // Check BTC direction: BTC should support Plan B direction
    const btcSupportsPlanB = this.checkBTCSupportsPlanB(planB, btcData);

    // Arm Plan B only if both conditions are met
    return kalshiSupportsFlip && btcSupportsPlanB;
  }

  /**
   * Check if Kalshi price action supports a flip to Plan B.
   * For YES positions: weakening means price decreasing (supports flip to NO)
   * For NO positions: weakening means price increasing (supports flip to YES)
   */
  private checkKalshiPriceActionSupportsFlip(
    planASide: 'YES' | 'NO',
    priceTrend: 'weakening' | 'strengthening' | 'stable'
  ): boolean {
    // If Plan A is YES and weakening (price down), that supports flip to NO
    // If Plan A is NO and weakening (price up), that supports flip to YES
    return priceTrend === 'weakening';
  }

  /**
   * Check if BTC direction/pattern supports Plan B.
   * Uses BTC trend and momentum to determine if Plan B direction is supported.
   */
  private checkBTCSupportsPlanB(planB: Plan, btcData: BTCFeatures | null): boolean {
    if (!btcData || btcData.trendSlope === null) {
      // If no BTC data, err on the side of caution (don't arm)
      return false;
    }

    // Plan B is NO: BTC should be trending down or stable (supports "price below strike")
    // Plan B is YES: BTC should be trending up or stable (supports "price above strike")
    if (planB.candidate.side === 'NO') {
      // For NO positions, BTC trending down or stable supports it
      return btcData.trendSlope <= 0;
    } else {
      // For YES positions, BTC trending up or stable supports it
      return btcData.trendSlope >= 0;
    }
  }

  /**
   * Get current Plan A.
   */
  getPlanA(): Plan | null {
    return this.planA;
  }

  /**
   * Get current Plan B.
   */
  getPlanB(): Plan | null {
    return this.planB;
  }

  /**
   * Set Plan B as armed.
   */
  setPlanBArmed(): void {
    if (this.planB) {
      this.planB.armed = true;
      this.planB.armedAt = new Date();
    }
  }

  /**
   * Clear both plans (for new hour).
   */
  clearPlans(): void {
    this.planA = null;
    this.planB = null;
  }
}

