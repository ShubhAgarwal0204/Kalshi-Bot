import { utcToZonedTime } from 'date-fns-tz';
import { getConfig } from './config.js';

// Supabase
import { BotRunsRepository } from './supabase/repositories/bot-runs.js';
import { HourSessionsRepository } from './supabase/repositories/hour-sessions.js';
import { OrdersRepository } from './supabase/repositories/orders.js';
import { FillsRepository } from './supabase/repositories/fills.js';
import { TradePlansRepository } from './supabase/repositories/trade-plans.js';
import { TradeAnalysesRepository } from './supabase/repositories/trade-analyses.js';

// Kalshi
import { KalshiRESTClient } from './kalshi/rest-client.js';
import { KalshiWebSocketClient } from './kalshi/websocket-client.js';
import { MarketDiscovery } from './kalshi/market-discovery.js';

// OpenAI
import { DecisionAdvisor } from './openai/decision-advisor.js';
import { PostTradeAnalyst } from './openai/post-trade-analyst.js';

// Strategy & Risk
import { CandidateSelector } from './strategy/candidate-selector.js';
import { PlanValidator } from './strategy/plan-validator.js';
import { PlanManager } from './strategy/plan-manager.js';
import { ExposureManager } from './risk/exposure-manager.js';
import { PositionMonitor } from './risk/position-monitor.js';
import { HourlyLossManager } from './risk/hourly-loss-manager.js';
import { CircuitBreaker } from './risk/circuit-breaker.js';

// Engine
import { TradingStateMachine } from './engine/state-machine.js';
import {
  SessionManager,
  getNextMarketHour,
  isInEntryWindow,
  isWithinTradingHours,
  isInIgnoreEarlyPhase,
  isInScanPlanPhase,
  isInTradeActivePhase,
  isInSellOnlyPhase,
} from './engine/session-manager.js';

// Market Data
import { KrakenBTCFeed } from './market/krakenBtcFeed.js';
import { KrakenOHLC } from './market/krakenOhlc.js';
import { computeBTCFeatures } from './market/btc-features.js';

// Shadow Trading
import { ShadowTradesRepository } from './supabase/repositories/shadow-trades.js';

const ET_TIMEZONE = 'America/New_York';
const MAIN_LOOP_INTERVAL_MS = 5000; // Check every 5 seconds

/**
 * Main trading bot orchestrator.
 */
class TradingBot {
  private config = getConfig();
  
  // Repositories
  private botRunsRepo: BotRunsRepository;
  private hourSessionsRepo: HourSessionsRepository;
  private ordersRepo: OrdersRepository;
  private fillsRepo: FillsRepository;
  private tradePlansRepo: TradePlansRepository;
  private tradeAnalysesRepo: TradeAnalysesRepository;
  private shadowTradesRepo: ShadowTradesRepository;

  // Clients
  private kalshiREST: KalshiRESTClient;
  private kalshiWS: KalshiWebSocketClient;
  private marketDiscovery: MarketDiscovery;

  // Components
  private decisionAdvisor: DecisionAdvisor;
  private postTradeAnalyst: PostTradeAnalyst;
  private candidateSelector: CandidateSelector;
  private planValidator: PlanValidator;
  private planManager: PlanManager;
  private exposureManager: ExposureManager;
  private positionMonitor: PositionMonitor;
  private hourlyLossManager: HourlyLossManager;
  private circuitBreaker: CircuitBreaker;
  private stateMachine: TradingStateMachine;
  private sessionManager: SessionManager;

  // Market Data
  private krakenBTCFeed: KrakenBTCFeed;
  private krakenOHLC: KrakenOHLC;

  private botRunId: string | null = null;
  private isRunning: boolean = false;
  private mainLoopTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize repositories
    this.botRunsRepo = new BotRunsRepository();
    this.hourSessionsRepo = new HourSessionsRepository();
    this.ordersRepo = new OrdersRepository();
    this.fillsRepo = new FillsRepository();
    this.tradePlansRepo = new TradePlansRepository();
    this.tradeAnalysesRepo = new TradeAnalysesRepository();
    this.shadowTradesRepo = new ShadowTradesRepository();

    // Initialize clients
    this.kalshiREST = new KalshiRESTClient();
    this.kalshiWS = new KalshiWebSocketClient();
    this.marketDiscovery = new MarketDiscovery(this.kalshiREST);

    // Initialize market data
    this.krakenBTCFeed = new KrakenBTCFeed();
    this.krakenOHLC = new KrakenOHLC();

    // Initialize components
    this.decisionAdvisor = new DecisionAdvisor();
    this.postTradeAnalyst = new PostTradeAnalyst();
    this.candidateSelector = new CandidateSelector(this.kalshiWS);
    this.planValidator = new PlanValidator(this.kalshiWS, this.kalshiREST);
    this.planManager = new PlanManager();
    this.exposureManager = new ExposureManager(this.hourSessionsRepo, this.ordersRepo, this.fillsRepo);
    this.positionMonitor = new PositionMonitor(this.kalshiWS, this.kalshiREST, this.ordersRepo, this.hourSessionsRepo);
    this.hourlyLossManager = new HourlyLossManager(this.hourSessionsRepo);
    this.circuitBreaker = new CircuitBreaker(this.kalshiWS, this.kalshiREST, this.botRunsRepo);
    this.stateMachine = new TradingStateMachine(this.hourSessionsRepo);
    this.sessionManager = new SessionManager(this.hourSessionsRepo, this.botRunsRepo);

    // Setup WebSocket event handlers
    this.setupWebSocketHandlers();
  }

  /**
   * Setup WebSocket event handlers.
   */
  private setupWebSocketHandlers(): void {
    // Kalshi WebSocket handlers
    this.kalshiWS.on('orderBook', (orderBook) => {
      this.planValidator.updateFeedTimestamp(orderBook.contract_id);
    });

    this.kalshiWS.on('orderUpdate', async (order) => {
      const dbOrder = await this.ordersRepo.getByKalshiOrderId(order.order_id);
      if (dbOrder) {
        await this.ordersRepo.update(dbOrder.id, {
          status: order.status as 'pending' | 'filled' | 'cancelled' | 'rejected',
          filled_at: order.filled_time ? new Date(order.filled_time) : undefined,
        });
      }
    });

    this.kalshiWS.on('fill', async (fill) => {
      const dbOrder = await this.ordersRepo.getByKalshiOrderId(fill.order_id);
      if (dbOrder) {
        const existingFill = await this.fillsRepo.getByKalshiFillId(fill.fill_id);
        if (!existingFill) {
          await this.fillsRepo.create({
            order_id: dbOrder.id,
            kalshi_fill_id: fill.fill_id,
            price: fill.price,
            size: fill.size,
            filled_at: new Date(fill.filled_time),
          });
        }
      }
    });

  }

  /**
   * Start the bot.
   */
  async start(): Promise<void> {
    console.log('Starting Kalshi Trading Bot...');

    // Try to connect WebSocket (optional - will use REST API fallback if unavailable)
    console.log('Connecting to Kalshi WebSocket...');
    try {
      await this.kalshiWS.connect();
      console.log('✅ Kalshi WebSocket connected');
    } catch (error) {
      console.warn('⚠️ Kalshi WebSocket unavailable, using REST API fallback');
      console.warn(`   Error: ${error instanceof Error ? error.message : error}`);
    }

    // Connect to Kraken BTC feed
    console.log('Connecting to Kraken BTC feed...');
    try {
      await this.krakenBTCFeed.connect();
      console.log('✅ Kraken BTC feed connected');
    } catch (error) {
      console.warn('⚠️ Kraken BTC feed unavailable');
      console.warn(`   Error: ${error instanceof Error ? error.message : error}`);
    }

    // Verify REST API works (required)
    console.log('Verifying Kalshi REST API...');
    try {
      const balance = await this.kalshiREST.getBalance();
      console.log(`✅ Kalshi REST API working - Balance: $${(balance.available_balance / 100).toFixed(2)}`);
    } catch (error) {
      throw new Error(`Fatal: Kalshi REST API not working: ${error instanceof Error ? error.message : error}`);
    }

    // Skip circuit breaker WebSocket check if WebSocket is not connected
    if (!this.kalshiWS.isConnected()) {
      console.log('⚠️ Running in REST-only mode (WebSocket unavailable)');
    }

    // Get or create bot run
    let botRun = await this.botRunsRepo.getActiveRun();
    if (!botRun) {
      const balance = await this.kalshiREST.getBalance();
      botRun = await this.botRunsRepo.create({
        initial_cash: balance.available_balance,
      });
    }
    this.botRunId = botRun.id;

    console.log(`Bot run started: ${this.botRunId}`);

    // Load active sessions and resume
    await this.resumeActiveSessions();

    // Start main loop
    this.isRunning = true;
    this.mainLoop();

    // Setup graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Resume active sessions from database.
   */
  private async resumeActiveSessions(): Promise<void> {
    const activeSessions = await this.sessionManager.getActiveSessions();
    console.log(`Resuming ${activeSessions.length} active session(s)`);

    for (const sessionId of activeSessions) {
      const session = await this.sessionManager.getSession(sessionId);
      if (session) {
        // Re-subscribe to market data if needed
        // This will be handled by the state machine processing
      }
    }
  }

  /**
   * Main trading loop.
   */
  private async mainLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);

      // Check circuit breaker
      const shouldPause = await this.circuitBreaker.shouldPauseTrading();
      if (shouldPause) {
        console.warn('Trading paused due to circuit breaker');
        this.scheduleNextLoop();
        return;
      }

      // Only process during trading hours
      if (!isWithinTradingHours(nowET)) {
        this.scheduleNextLoop();
        return;
      }

      // Process active sessions
      const activeSessions = await this.sessionManager.getActiveSessions();
      for (const sessionId of activeSessions) {
        await this.processSession(sessionId);
      }

      // Check for new hour sessions
      await this.checkForNewHourSession();

      // Check stop losses and take profits
      await this.checkStopLosses();
      await this.checkTakeProfits();

    } catch (error) {
      console.error('Error in main loop:', error);
    }

    this.scheduleNextLoop();
  }

  /**
   * Schedule next main loop iteration.
   */
  private scheduleNextLoop(): void {
    if (this.mainLoopTimer) {
      clearTimeout(this.mainLoopTimer);
    }
    this.mainLoopTimer = setTimeout(() => this.mainLoop(), MAIN_LOOP_INTERVAL_MS);
  }

  /**
   * Check for new hour session to create.
   */
  private async checkForNewHourSession(): Promise<void> {
    if (!this.botRunId) return;

    const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);
    const nextMarketHour = getNextMarketHour(nowET);
    const entryWindowStart = new Date(nextMarketHour);
    entryWindowStart.setMinutes(entryWindowStart.getMinutes() - this.config.ENTRY_WINDOW_MINUTES);

    // Check if we're approaching entry window
    const timeUntilEntryWindow = entryWindowStart.getTime() - nowET.getTime();
    if (timeUntilEntryWindow > 60000) {
      return; // More than 1 minute away
    }

    // Check if session already exists
    const existing = await this.hourSessionsRepo.getByMarketHour(nextMarketHour);
    if (existing) {
      return;
    }

    // Find market for this hour
    const market = await this.marketDiscovery.findCurrentHourMarket(nextMarketHour);
    if (!market) {
      console.warn(`No market found for hour ${nextMarketHour.toISOString()}`);
      return;
    }

    // Check if we should skip this hour
    const shouldSkip = await this.circuitBreaker.shouldSkipHour(this.botRunId);

    // Get cash balance
    const balance = await this.kalshiREST.getBalance();

    // Check previous hour's P&L for size multiplier
    const marketHourDate = typeof market.expiration_time === 'string' 
      ? new Date(market.expiration_time)
      : market.expiration_time;
    const previousSession = await this.hourSessionsRepo.getByMarketHour(
      new Date(marketHourDate.getTime() - 60 * 60 * 1000)
    );
    let sizeMultiplier = 1.0;
    if (previousSession) {
      const previousPnl = await this.calculateHourlyPnl(previousSession.id);
      if (previousPnl < 0) {
        // Carry forward reduced sizing
        sizeMultiplier = previousSession.size_multiplier;
      } else {
        // Reset to normal
        sizeMultiplier = 1.0;
      }
    }

    // Create session
    const sessionId = await this.sessionManager.getOrCreateHourSession(
      this.botRunId,
      market,
      balance.available_balance,
      shouldSkip,
      sizeMultiplier
    );

    console.log(`Created hour session ${sessionId} for market ${market.ticker}`);

    // Subscribe to market data
    this.candidateSelector.subscribeToMarket(market);
  }

  /**
   * Process a trading session.
   * Handles phase transitions and state machine updates.
   */
  private async processSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);

    // Handle phase transitions based on time
    await this.handlePhaseTransitions(sessionId, session, nowET);

    // Process current state
    switch (session.state) {
      case 'IDLE':
        // Initial state, will transition based on phase
        break;

      case 'WAIT_ENTRY_WINDOW':
        if (isInEntryWindow(session.market_hour, nowET)) {
          await this.stateMachine.transition(sessionId, 'BUILD_CANDIDATES');
        }
        break;

      case 'IGNORE_EARLY':
        // Passive BTC tracking only, no trading
        // Phase transition handled by handlePhaseTransitions
        break;

      case 'SCAN_PLAN':
        await this.handleScanPlan(sessionId);
        break;

      case 'SKIP_HOUR_OBSERVE':
        await this.handleSkipHourObserve(sessionId);
        break;

      case 'BUILD_CANDIDATES':
        await this.handleBuildCandidates(sessionId);
        break;

      case 'OPENAI_RECOMMENDATION':
        await this.handleOpenAIRecommendation(sessionId);
        break;

      case 'VALIDATE_PLAN':
        await this.handleValidatePlan(sessionId);
        break;

      case 'PLACING_BUY':
        await this.handlePlacingBuy(sessionId);
        break;

      case 'TRADE_ACTIVE':
        await this.handleTradeActive(sessionId);
        break;

      case 'IN_POSITION':
        // Monitor positions, check stop losses and take profits
        break;

      case 'PLACING_SELL':
        await this.handlePlacingSell(sessionId);
        break;

      case 'SELL_ONLY':
        // Exit-only mode, no new entries
        break;

      case 'COOLDOWN':
        // Cooldown period after stop-loss, check if expired
        const canPlace = await this.sessionManager.canPlaceTrade(sessionId);
        if (canPlace.allowed) {
          await this.stateMachine.transition(sessionId, 'TRADE_ACTIVE');
        }
        break;

      case 'DONE':
        // Session complete, run post-trade analysis if not done
        await this.handleDone(sessionId);
        break;
    }
  }

  /**
   * Handle phase transitions based on time.
   */
  private async handlePhaseTransitions(
    sessionId: string,
    session: Awaited<ReturnType<typeof this.sessionManager.getSession>>,
    nowET: Date
  ): Promise<void> {
    if (!session) return;

    // Skip hour: stay in SKIP_HOUR_OBSERVE
    if (session.is_skip_hour) {
      if (session.state !== 'SKIP_HOUR_OBSERVE' && session.state !== 'DONE') {
        await this.stateMachine.transition(sessionId, 'SKIP_HOUR_OBSERVE');
      }
      return;
    }

    // Check current phase and transition accordingly
    if (isInIgnoreEarlyPhase(session.market_hour, nowET)) {
      if (session.state !== 'IGNORE_EARLY' && session.state !== 'SCAN_PLAN' && session.state !== 'TRADE_ACTIVE') {
        await this.stateMachine.transition(sessionId, 'IGNORE_EARLY');
      }
    } else if (isInScanPlanPhase(session.market_hour, nowET)) {
      if (session.state !== 'SCAN_PLAN' && session.state !== 'TRADE_ACTIVE') {
        await this.stateMachine.transition(sessionId, 'SCAN_PLAN');
      }
    } else if (isInTradeActivePhase(session.market_hour, nowET)) {
      if (session.state !== 'TRADE_ACTIVE' && session.state !== 'IN_POSITION' && session.state !== 'COOLDOWN') {
        await this.stateMachine.transition(sessionId, 'TRADE_ACTIVE');
      }
    } else if (isInSellOnlyPhase(session.market_hour, nowET)) {
      if (session.state !== 'SELL_ONLY' && session.state !== 'DONE') {
        await this.stateMachine.transition(sessionId, 'SELL_ONLY');
      }
    } else if (nowET >= session.market_hour) {
      // Hour has ended
      if (session.state !== 'DONE') {
        await this.stateMachine.transition(sessionId, 'DONE');
      }
    }
  }

  /**
   * Handle SCAN_PLAN phase (00:30-00:40).
   * Build Plan A and Plan B, but don't trade yet.
   */
  private async handleScanPlan(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Find market
    const market = await this.marketDiscovery.findCurrentHourMarket(session.market_hour);
    if (!market) {
      return;
    }

    // Find candidates
    const candidates = this.candidateSelector.findCandidates(market);
    if (candidates.length === 0) {
      return;
    }

    // Build Plan A and Plan B
    const planA = this.planManager.buildPlanA(candidates);
    const planB = this.planManager.buildPlanB(candidates, planA);

    console.log(`Plan A: ${planA?.candidate.contract_id} ${planA?.candidate.side}`);
    if (planB) {
      console.log(`Plan B: ${planB.candidate.contract_id} ${planB.candidate.side}`);
    }
  }

  /**
   * Handle SKIP_HOUR_OBSERVE state.
   * Shadow trading: scan, plan, analyze, but don't place real orders.
   */
  private async handleSkipHourObserve(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Find market
    const market = await this.marketDiscovery.findCurrentHourMarket(session.market_hour);
    if (!market) {
      return;
    }

    // Find candidates
    const candidates = this.candidateSelector.findCandidates(market);
    if (candidates.length === 0) {
      return;
    }

    // Build Plan A and Plan B
    const planA = this.planManager.buildPlanA(candidates);
    const planB = this.planManager.buildPlanB(candidates, planA);

    // Get BTC data and trade history for OpenAI
    const btcPrice = this.krakenBTCFeed.getCurrentPrice();
    const btcCandles24h = await this.krakenOHLC.getCandles24h();
    const btcFeatures = computeBTCFeatures(btcCandles24h, btcPrice);

    // Get trade history (simplified for now)
    const tradeHistory = await this.getTradeHistory(24);

    // Call OpenAI for shadow analysis
    if (planA && tradeHistory) {
      const shadowPlan = await this.getShadowTradePlan(sessionId, planA.candidate, btcFeatures, tradeHistory);
      await this.shadowTradesRepo.create({
        hour_session_id: sessionId,
        plan_type: 'A',
        contract_id: planA.candidate.contract_id,
        side: planA.candidate.side,
        entry_price: planA.candidate.entry_price || 0,
        openai_response: shadowPlan as unknown as Record<string, unknown>,
      });
    }

    if (planB && tradeHistory) {
      const shadowPlan = await this.getShadowTradePlan(sessionId, planB.candidate, btcFeatures, tradeHistory);
      await this.shadowTradesRepo.create({
        hour_session_id: sessionId,
        plan_type: 'B',
        contract_id: planB.candidate.contract_id,
        side: planB.candidate.side,
        entry_price: planB.candidate.entry_price || 0,
        openai_response: shadowPlan as unknown as Record<string, unknown>,
      });
    }
  }

  /**
   * Handle TRADE_ACTIVE phase (00:40-00:58:30).
   * Can place new entries if conditions are met.
   */
  private async handleTradeActive(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Check if we can place a trade
    const canPlace = await this.sessionManager.canPlaceTrade(sessionId);
    if (!canPlace.allowed) {
      return; // Max trades reached or in cooldown
    }

    // Check hourly loss cap
    const lossCapBreached = await this.hourlyLossManager.isLossCapBreached(sessionId);
    if (lossCapBreached) {
      console.log(`Hourly loss cap breached for session ${sessionId}`);
      return;
    }

    // If we have a valid plan, try to execute it
    const plans = await this.tradePlansRepo.getByHourSession(sessionId);
    const validPlan = plans.find((p) => p.validation_status === 'valid' && p.action === 'ENTER');
    if (validPlan) {
      await this.stateMachine.transition(sessionId, 'PLACING_BUY');
    } else if (session.state === 'TRADE_ACTIVE') {
      // Try to get a new recommendation
      await this.stateMachine.transition(sessionId, 'OPENAI_RECOMMENDATION');
    }
  }

  /**
   * Handle BUILD_CANDIDATES state.
   */
  private async handleBuildCandidates(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Find market
    const market = await this.marketDiscovery.findCurrentHourMarket(session.market_hour);
    if (!market) {
      await this.stateMachine.transition(sessionId, 'DONE');
      return;
    }

    // Find candidates
    const candidates = this.candidateSelector.findCandidates(market);

    if (candidates.length === 0) {
      console.log(`No candidates found for session ${sessionId}`);
      await this.stateMachine.transition(sessionId, 'DONE');
      return;
    }

    await this.stateMachine.transition(sessionId, 'OPENAI_RECOMMENDATION');
  }

  /**
   * Handle OPENAI_RECOMMENDATION state.
   */
  private async handleOpenAIRecommendation(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Find market and candidates
    const market = await this.marketDiscovery.findCurrentHourMarket(session.market_hour);
    if (!market) {
      await this.stateMachine.transition(sessionId, 'DONE');
      return;
    }

    const candidates = this.candidateSelector.findCandidates(market);
    if (candidates.length === 0) {
      await this.stateMachine.transition(sessionId, 'DONE');
      return;
    }

    // Get remaining capital
    const remainingCapital = await this.exposureManager.getRemainingCapacity(sessionId);

    // Get BTC data
    const btcPrice = this.krakenBTCFeed.getCurrentPrice();
    const btcCandles24h = await this.krakenOHLC.getCandles24h();
    const btcFeatures = computeBTCFeatures(btcCandles24h, btcPrice);

    // Get trade history
    const tradeHistory = await this.getTradeHistory(24);

    // Prepare input for OpenAI
    const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);

    const decisionInput = {
      current_time_et: nowET.toISOString(),
      market_resolution_time: session.market_hour.toISOString(),
      candidates: candidates.map((c) => ({
        contract_id: c.contract_id,
        strike: c.strike,
        best_bid: c.best_bid,
        best_ask: c.best_ask,
        spread: c.spread,
      })),
      remaining_hourly_capital: remainingCapital,
      constraints: {
        entry_price_range: [this.config.ENTRY_PRICE_MIN, this.config.ENTRY_PRICE_MAX] as [number, number],
        stop_loss_price: this.config.STOP_LOSS_PRICE,
        max_spend_remaining: remainingCapital,
      },
      btcFeatures: btcFeatures.currentPrice !== null ? {
        currentPrice: btcFeatures.currentPrice,
        price1hAgo: btcFeatures.price1hAgo,
        price4hAgo: btcFeatures.price4hAgo,
        price24hAgo: btcFeatures.price24hAgo,
        change1h: btcFeatures.change1h,
        change4h: btcFeatures.change4h,
        change24h: btcFeatures.change24h,
        volatility24h: btcFeatures.volatility24h,
        trendSlope: btcFeatures.trendSlope,
      } : undefined,
      tradeHistory: tradeHistory ? {
        winRate: tradeHistory.winRate,
        avgPnl: tradeHistory.avgPnl,
        avgEntryPrice: tradeHistory.avgEntryPrice,
        topMarkets: tradeHistory.topMarkets,
        currentStreak: tradeHistory.currentStreak,
        recentTrades: tradeHistory.recentTrades,
      } : undefined,
    };

    // Get recommendation from OpenAI
    const tradePlan = await this.decisionAdvisor.getRecommendation(decisionInput);

    // Save trade plan
    await this.tradePlansRepo.create({
      hour_session_id: sessionId,
      openai_response: tradePlan as unknown as Record<string, unknown>,
      action: tradePlan.action,
      side: tradePlan.side,
      contract_id: tradePlan.contract_id,
      entry_limit_price: tradePlan.entry_limit_price,
      dollars_to_spend: tradePlan.dollars_to_spend,
      stop_loss_price: tradePlan.stop_loss_price,
      rationale: tradePlan.rationale,
      confidence: tradePlan.confidence,
    });

    await this.stateMachine.transition(sessionId, 'VALIDATE_PLAN');
  }

  /**
   * Handle VALIDATE_PLAN state.
   */
  private async handleValidatePlan(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Get latest trade plan
    const plans = await this.tradePlansRepo.getByHourSession(sessionId);
    const latestPlan = plans[0];
    if (!latestPlan || latestPlan.validation_status !== 'pending') {
      // Try OpenAI again or skip
      await this.stateMachine.transition(sessionId, 'OPENAI_RECOMMENDATION');
      return;
    }

    const remainingCapital = await this.exposureManager.getRemainingCapacity(sessionId);

    // Validate plan
    const validation = await this.planValidator.validate(
      {
        action: latestPlan.action,
        side: latestPlan.side || undefined,
        contract_id: latestPlan.contract_id || undefined,
        entry_limit_price: latestPlan.entry_limit_price || undefined,
        dollars_to_spend: latestPlan.dollars_to_spend || undefined,
        stop_loss_price: latestPlan.stop_loss_price,
        rationale: latestPlan.rationale,
        confidence: latestPlan.confidence,
      },
      remainingCapital
    );

    if (validation.valid) {
      await this.tradePlansRepo.update(latestPlan.id, {
        validation_status: 'valid',
      });
      await this.stateMachine.transition(sessionId, 'PLACING_BUY');
    } else {
      await this.tradePlansRepo.update(latestPlan.id, {
        validation_status: 'rejected',
        validation_errors: { errors: validation.errors },
      });
      // Try again or skip
      await this.stateMachine.transition(sessionId, 'OPENAI_RECOMMENDATION');
    }
  }

  /**
   * Handle PLACING_BUY state.
   */
  private async handlePlacingBuy(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    // Get validated trade plan
    const plans = await this.tradePlansRepo.getByHourSession(sessionId);
    const validPlan = plans.find((p) => p.validation_status === 'valid' && p.action === 'ENTER');
    if (!validPlan || !validPlan.contract_id || !validPlan.entry_limit_price || !validPlan.dollars_to_spend || !validPlan.side) {
      await this.stateMachine.transition(sessionId, 'DONE');
      return;
    }

    // Check if we can place a trade (max trades, cooldown)
    const canPlace = await this.sessionManager.canPlaceTrade(sessionId);
    if (!canPlace.allowed) {
      console.warn(`Cannot place trade for session ${sessionId}: ${canPlace.reason}`);
      await this.stateMachine.transition(sessionId, 'TRADE_ACTIVE');
      return;
    }

    // Check hourly loss cap
    const lossCapBreached = await this.hourlyLossManager.isLossCapBreached(sessionId);
    if (lossCapBreached) {
      console.warn(`Hourly loss cap breached for session ${sessionId}`);
      await this.stateMachine.transition(sessionId, 'TRADE_ACTIVE');
      return;
    }

    // Check exposure
    const canSpend = await this.exposureManager.canSpend(sessionId, validPlan.dollars_to_spend);
    if (!canSpend.allowed) {
      console.warn(`Cannot spend for session ${sessionId}: ${canSpend.reason}`);
      await this.stateMachine.transition(sessionId, 'TRADE_ACTIVE');
      return;
    }

    // Calculate size (contracts)
    const size = Math.floor(validPlan.dollars_to_spend / validPlan.entry_limit_price);

    // Place order
    try {
      const kalshiOrder = await this.kalshiREST.createOrder({
        contract_id: validPlan.contract_id,
        side: validPlan.side,
        action: 'BUY',
        limit_price: validPlan.entry_limit_price,
        size,
      });

      // Record order
      const dbOrder = await this.ordersRepo.create({
        hour_session_id: sessionId,
        trade_plan_id: validPlan.id,
        kalshi_order_id: kalshiOrder.order_id,
        contract_id: validPlan.contract_id,
        side: validPlan.side,
        action: 'BUY',
        limit_price: validPlan.entry_limit_price,
        size,
        dollars_spent: validPlan.dollars_to_spend,
      });

      // Record spend
      await this.exposureManager.recordSpend(sessionId, validPlan.dollars_to_spend);

      // Increment trades count
      await this.sessionManager.incrementTradesCount(sessionId);

      // Register position for monitoring
      this.positionMonitor.registerPosition({
        contract_id: validPlan.contract_id,
        side: validPlan.side,
        order_id: dbOrder.id,
        hour_session_id: sessionId,
        entry_price: validPlan.entry_limit_price,
        size,
      });

      await this.stateMachine.transition(sessionId, 'IN_POSITION');
    } catch (error) {
      console.error(`Error placing buy order for session ${sessionId}:`, error);
      await this.stateMachine.transition(sessionId, 'DONE');
    }
  }

  /**
   * Handle PLACING_SELL state.
   */
  private async handlePlacingSell(sessionId: string): Promise<void> {
    // Check order status and transition accordingly
    const orders = await this.ordersRepo.getByHourSession(sessionId);
    const openOrders = orders.filter((o) => o.status === 'pending' && o.action === 'SELL');

    if (openOrders.length === 0) {
      await this.stateMachine.transition(sessionId, 'DONE');
    }
  }

  /**
   * Handle DONE state.
   */
  private async handleDone(sessionId: string): Promise<void> {
    // Check if analysis already done
    const analysis = await this.tradeAnalysesRepo.getByHourSession(sessionId);
    if (analysis) {
      return;
    }

    // Run post-trade analysis
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return;

    const orders = await this.ordersRepo.getByHourSession(sessionId);
    const fills = await Promise.all(orders.map((o) => this.fillsRepo.getByOrderId(o.id))).then((f) => f.flat());

    // Calculate P/L
    let totalPnl = 0;
    const tradesExecuted = orders.map((order) => {
      const orderFills = fills.filter((f) => f.order_id === order.id);
      const avgPrice = orderFills.length > 0
        ? orderFills.reduce((sum, f) => sum + f.price * f.size, 0) / orderFills.reduce((sum, f) => sum + f.size, 0)
        : order.limit_price;
      const pnl = order.action === 'BUY' ? (1 - avgPrice) * order.size : (avgPrice - 0) * order.size;
      totalPnl += pnl - order.dollars_spent;

      return {
        contract_id: order.contract_id,
        side: order.side,
        entry_price: order.limit_price,
        exit_price: order.status === 'filled' ? avgPrice : null,
        dollars_spent: order.dollars_spent,
        pnl,
        status: (order.status === 'filled' ? 'closed' : order.status === 'pending' ? 'open' : 'settled') as 'open' | 'closed' | 'settled',
      };
    });

    const analysisInput = {
      hour_session_id: sessionId,
      market_hour: session.market_hour.toISOString(),
      trades_executed: tradesExecuted,
      total_pnl: totalPnl,
      cash_at_start: session.cash_at_start,
      cash_at_end: session.cash_at_start + totalPnl,
    };

    const analysisResult = await this.postTradeAnalyst.analyze(analysisInput);

    await this.tradeAnalysesRepo.create({
      hour_session_id: sessionId,
      openai_analysis: analysisResult as unknown as Record<string, unknown>,
      summary: analysisResult.summary,
      what_worked: analysisResult.what_worked,
      what_didnt_work: analysisResult.what_didnt_work,
      suggestions: analysisResult.suggestions,
    });

    // Update circuit breaker with hourly P&L
    if (this.botRunId) {
      await this.circuitBreaker.updateConsecutiveLosingHours(this.botRunId, totalPnl);
    }
  }

  /**
   * Calculate hourly P&L for a session.
   */
  private async calculateHourlyPnl(sessionId: string): Promise<number> {
    const orders = await this.ordersRepo.getByHourSession(sessionId);
    const fills = await Promise.all(orders.map((o) => this.fillsRepo.getByOrderId(o.id))).then((f) => f.flat());

    let totalPnl = 0;
    for (const order of orders) {
      const orderFills = fills.filter((f) => f.order_id === order.id);
      if (orderFills.length === 0) continue;

      const avgPrice = orderFills.reduce((sum, f) => sum + f.price * f.size, 0) / orderFills.reduce((sum, f) => sum + f.size, 0);
      
      if (order.action === 'BUY') {
        // Find corresponding sell order
        const sellOrders = orders.filter(
          (o) => o.contract_id === order.contract_id && o.side === order.side && o.action === 'SELL'
        );
        if (sellOrders.length > 0) {
          const sellOrder = sellOrders[0];
          const sellFills = fills.filter((f) => f.order_id === sellOrder.id);
          if (sellFills.length > 0) {
            const sellAvgPrice = sellFills.reduce((sum, f) => sum + f.price * f.size, 0) / sellFills.reduce((sum, f) => sum + f.size, 0);
            const pnl = order.side === 'YES' 
              ? (sellAvgPrice - avgPrice) * order.size
              : (avgPrice - sellAvgPrice) * order.size;
            totalPnl += pnl;
          }
        }
      }
    }

    return totalPnl;
  }

  /**
   * Get trade history for OpenAI input.
   */
  private async getTradeHistory(_limit: number): Promise<{
    winRate: number;
    avgPnl: number;
    avgEntryPrice: number;
    topMarkets: Array<{ ticker: string; count: number }>;
    currentStreak: { type: 'WIN' | 'LOSS' | 'NONE'; count: number };
    recentTrades: Array<{
      market_ticker: string;
      side: string;
      entry_price: number;
      exit_price: number | null;
      pnl: number | null;
      result?: 'WON' | 'LOST' | 'OPEN' | 'SETTLED';
    }>;
  } | null> {
    // For now, return simplified structure
    // TODO: Implement proper trade history query from kalshi_trades table
    
    return {
      winRate: 0.5,
      avgPnl: 0,
      avgEntryPrice: 0.85,
      topMarkets: [],
      currentStreak: { type: 'NONE', count: 0 },
      recentTrades: [],
    };
  }

  /**
   * Get shadow trade plan from OpenAI (for skip hours).
   */
  private async getShadowTradePlan(
    sessionId: string,
    candidate: { contract_id: string; side: 'YES' | 'NO'; strike: string; best_bid: number | null; best_ask: number | null; spread: number; entry_price: number | null },
    btcFeatures: ReturnType<typeof computeBTCFeatures>,
    tradeHistory: Awaited<ReturnType<typeof this.getTradeHistory>>
  ): Promise<unknown> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) return {};

    const remainingCapital = await this.exposureManager.getRemainingCapacity(sessionId);
    const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);

    const decisionInput = {
      current_time_et: nowET.toISOString(),
      market_resolution_time: session.market_hour.toISOString(),
      candidates: [{
        contract_id: candidate.contract_id,
        strike: candidate.strike,
        best_bid: candidate.best_bid,
        best_ask: candidate.best_ask,
        spread: candidate.spread,
      }],
      remaining_hourly_capital: remainingCapital,
      constraints: {
        entry_price_range: [this.config.ENTRY_PRICE_MIN, this.config.ENTRY_PRICE_MAX] as [number, number],
        stop_loss_price: this.config.STOP_LOSS_PRICE,
        max_spend_remaining: remainingCapital,
      },
      btcFeatures: btcFeatures.currentPrice !== null ? {
        currentPrice: btcFeatures.currentPrice,
        price1hAgo: btcFeatures.price1hAgo,
        price4hAgo: btcFeatures.price4hAgo,
        price24hAgo: btcFeatures.price24hAgo,
        change1h: btcFeatures.change1h,
        change4h: btcFeatures.change4h,
        change24h: btcFeatures.change24h,
        volatility24h: btcFeatures.volatility24h,
        trendSlope: btcFeatures.trendSlope,
      } : undefined,
      tradeHistory: tradeHistory || undefined,
    };

    return await this.decisionAdvisor.getRecommendation(decisionInput);
  }

  /**
   * Check stop losses for all positions.
   */
  private async checkStopLosses(): Promise<void> {
    const triggered = await this.positionMonitor.checkStopLosses();
    for (const contractId of triggered) {
      try {
        await this.positionMonitor.executeStopLoss(contractId);
      } catch (error) {
        console.error(`Error executing stop-loss for ${contractId}:`, error);
      }
    }
  }

  /**
   * Check take profits for all positions.
   */
  private async checkTakeProfits(): Promise<void> {
    // Check if we're in SELL_ONLY phase for any active session
    const activeSessions = await this.sessionManager.getActiveSessions();
    let isSellOnlyPhase = false;

    for (const sessionId of activeSessions) {
      const session = await this.sessionManager.getSession(sessionId);
      if (session) {
        const nowET = utcToZonedTime(new Date(), ET_TIMEZONE);
        if (isInSellOnlyPhase(session.market_hour, nowET)) {
          isSellOnlyPhase = true;
          break;
        }
      }
    }

    const triggered = await this.positionMonitor.checkTakeProfit(isSellOnlyPhase);
    for (const contractId of triggered) {
      try {
        await this.positionMonitor.executeTakeProfit(contractId);
      } catch (error) {
        console.error(`Error executing take-profit for ${contractId}:`, error);
      }
    }
  }

  /**
   * Shutdown gracefully.
   */
  private async shutdown(): Promise<void> {
    console.log('Shutting down...');
    this.isRunning = false;

    if (this.mainLoopTimer) {
      clearTimeout(this.mainLoopTimer);
    }

    this.kalshiWS.disconnect();
    this.krakenBTCFeed.disconnect();

    if (this.botRunId) {
      await this.botRunsRepo.update(this.botRunId, {
        status: 'stopped',
        ended_at: new Date(),
      });
    }

    process.exit(0);
  }
}

// Start bot
const bot = new TradingBot();
bot.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
