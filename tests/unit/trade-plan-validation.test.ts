import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlanValidator } from '../../src/strategy/plan-validator.js';
import { KalshiWebSocketClient } from '../../src/kalshi/websocket-client.js';
import { KalshiRESTClient } from '../../src/kalshi/rest-client.js';
import type { TradePlan } from '../../src/openai/schemas.js';

// Mock dependencies
vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    ENTRY_PRICE_MIN: 0.80,
    ENTRY_PRICE_MAX: 0.90,
    STOP_LOSS_PRICE: 0.70,
    TRADING_START_HOUR: 8,
    TRADING_END_HOUR: 24,
  }),
}})););

vi.mock('../../src/engine/session-manager.js', () => ({
  isWithinTradingHours: () => true,
}));

describe('Trade Plan Validation', () => {
  let validator: PlanValidator;
  let mockWSClient: KalshiWebSocketClient;
  let mockRESTClient: KalshiRESTClient;

  beforeEach(() => {
    mockWSClient = {
      isConnected: () => true,
      getOrderBook: vi.fn(() => ({ contract_id: 'TEST-YES', yes_bids: [], yes_asks: [] })),
    } as unknown as KalshiWebSocketClient;

    mockRESTClient = {} as KalshiRESTClient;

    validator = new PlanValidator(mockWSClient, mockRESTClient);
  });

  it('should accept valid ENTER plan', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      side: 'YES',
      contract_id: 'TEST-YES',
      entry_limit_price: 0.85,
      dollars_to_spend: 100,
      stop_loss_price: 0.70,
      rationale: 'Test trade',
      confidence: 0.8,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should accept SKIP plan', async () => {
    const plan: TradePlan = {
      action: 'SKIP',
      stop_loss_price: 0.70,
      rationale: 'Market conditions not favorable',
      confidence: 0.5,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(true);
  });

  it('should reject plan with entry price below minimum', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      side: 'YES',
      contract_id: 'TEST-YES',
      entry_limit_price: 0.75, // Below 0.80
      dollars_to_spend: 100,
      stop_loss_price: 0.70,
      rationale: 'Test trade',
      confidence: 0.8,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('outside allowed range'))).toBe(true);
  });

  it('should reject plan with entry price above maximum', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      side: 'YES',
      contract_id: 'TEST-YES',
      entry_limit_price: 0.95, // Above 0.90
      dollars_to_spend: 100,
      stop_loss_price: 0.70,
      rationale: 'Test trade',
      confidence: 0.8,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('outside allowed range'))).toBe(true);
  });

  it('should reject plan with wrong stop loss price', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      side: 'YES',
      contract_id: 'TEST-YES',
      entry_limit_price: 0.85,
      dollars_to_spend: 100,
      stop_loss_price: 0.65, // Wrong
      rationale: 'Test trade',
      confidence: 0.8,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not match configured value'))).toBe(true);
  });

  it('should reject plan exceeding remaining capital', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      side: 'YES',
      contract_id: 'TEST-YES',
      entry_limit_price: 0.85,
      dollars_to_spend: 300, // Exceeds 200
      stop_loss_price: 0.70,
      rationale: 'Test trade',
      confidence: 0.8,
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds remaining hourly capital'))).toBe(true);
  });

  it('should reject plan missing required fields for ENTER', async () => {
    const plan: TradePlan = {
      action: 'ENTER',
      stop_loss_price: 0.70,
      rationale: 'Test trade',
      confidence: 0.8,
      // Missing: side, contract_id, entry_limit_price, dollars_to_spend
    };

    const result = await validator.validate(plan, 200);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

