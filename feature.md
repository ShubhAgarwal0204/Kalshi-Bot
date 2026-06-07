# Feature Documentation

This document tracks features and updates to the Kalshi Trading Bot.

## Core Features

### WebSocket-First Architecture

The bot uses WebSockets as the primary data source for speed:
- **Kalshi WebSocket**: Real-time market data (order books, order updates, fills)
- **REST API**: Used only for authentication, bootstrap, and order placement

**Usage**: WebSocket connection is established automatically on bot start. The bot handles reconnections with exponential backoff.

### OpenAI Integration

OpenAI serves as an advisory "brain" with strict constraints:

#### Decision Advisor (Pre-Trade)
- Called during `TRADE_ACTIVE` phase (00:40-00:58:30)
- **Enhanced Input**:
  - Current time, market info, contract candidates, constraints
  - **BTC Data**: Real-time price, 24h/7d/30d hourly candles, computed features (trend, volatility, momentum)
  - **Trade History**: Last 24 trades with win rate, streaks, patterns
- Output: Trade plan (ENTER/SKIP) with rationale and confidence
- **Validation**: All recommendations are validated against hard constraints before execution
- Considers BTC conditions and recent trading patterns in recommendations

#### Post-Trade Analyst
- Called after each hour completes
- Input: Trade outcomes, P/L
- Output: Structured analysis (what worked, what didn't, suggestions)
- **Note**: Suggestions are informational only - code enforces all rules

**Usage**: OpenAI recommendations are advisory only. The bot validates all plans and rejects invalid ones.

### Risk Management

#### Exposure Manager
- Tracks cash spent per hour session
- Enforces 25% cash cap per hour (configurable)
- Applies size reduction multiplier based on losses (100% → 70% → 50%)
- Atomic updates to prevent race conditions

**Usage**: Automatically checks before each trade and records spend after execution. Size multiplier is applied to remaining capacity.

#### Hourly Loss Manager
- Tracks realized losses per hour session
- Calculates `max_trade_budget = 0.25 * portfolio_cash`
- Calculates `hourly_loss_cap = 0.15 * max_trade_budget`
- Enforces hard stop: trading stops for the hour if loss cap breached
- Records losses from filled sell orders

**Usage**: Automatically checks before each trade entry. Trading is blocked if hourly loss cap is breached.

#### Max Trades & Cooldown
- **Max Trades**: Enforces maximum 3 entries per hour (configurable)
- **Cooldown**: 45-second cooldown after stop-loss execution (configurable)
- Tracks `trades_count` per session
- Tracks `cooldown_until` timestamp per session

**Usage**: Automatically checked before each trade entry. Cooldown prevents immediate re-entry after stop-loss.

#### Size Reduction After Losses
- Reduces entry sizing within the same hour after losses:
  - After 0 losses: 100% of max trade budget
  - After 1 loss: 70% of max trade budget
  - After 2+ losses: 50% of max trade budget
- Tracks `size_multiplier` per session
- Applied to `getRemainingCapacity()` calculation

**Usage**: Automatically applied when calculating remaining capacity. Updated after each losing trade.

#### Hybrid Hour-to-Hour Sizing Reset
- At end of each hour, computes net P&L
- If hourly P&L >= 0: Reset size multiplier to 100% for next hour
- If hourly P&L < 0: Carry forward reduced size multiplier to next hour
- Prevents rapid size increases after losses

**Usage**: Automatically handled when creating new hour sessions. Previous hour's P&L determines starting multiplier.

#### Position Monitor (Stop-Loss & Take-Profit)
- Monitors all open positions for both stop-loss and take-profit triggers
- **Stop-Loss**: Triggers immediate sell if exit price ≤ 0.70 (configurable)
- **Take-Profit**: Triggers immediate sell if exit price ≥ 0.96 (configurable)
- During SELL_ONLY phase: TP only triggers if price ≥ 0.96 and < 0.99
- Cancels pending buy orders when stop-loss triggers
- Sets 45-second cooldown after stop-loss execution

**Usage**: Runs continuously during trading hours. Positions are automatically registered when orders are placed.

#### Circuit Breaker
- System-level safety checks:
  - Kalshi WebSocket connection health
  - Cash balance sufficiency
  - Trading hours validation
  - API rate limits
- Pauses trading if any check fails
- **Skip Hour Logic**: After 2 consecutive losing hours, next hour becomes a skip hour
- Tracks `consecutive_losing_hours` in `bot_runs` table
- Resets counter when hourly P&L >= 0

**Usage**: Checked before each main loop iteration. Trading is paused if unhealthy. Skip hours are automatically triggered after losing streaks.

### State Machine & 4-Phase Schedule

Persistent state machine for hourly trading sessions with time-based phases:

**States**:
- `IDLE` → `WAIT_ENTRY_WINDOW` → `IGNORE_EARLY` → `SCAN_PLAN` → `BUILD_CANDIDATES` → `OPENAI_RECOMMENDATION` → `VALIDATE_PLAN` → `PLACING_BUY` → `TRADE_ACTIVE` → `IN_POSITION` → `PLACING_SELL` → `SELL_ONLY` → `SKIP_HOUR_OBSERVE` → `COOLDOWN` → `DONE`

**4-Phase Schedule per Hour (ET)**:
- **Phase A (00:00-00:30)**: `IGNORE_EARLY` - No trading, passive BTC tracking only
- **Phase B (00:30-00:40)**: `SCAN_PLAN` - Market scanning and Plan A/B preparation, no trading
- **Phase C (00:40-00:58:30)**: `TRADE_ACTIVE` - Active trading window, can enter positions
- **Phase D (00:58:30-01:00)**: `SELL_ONLY` - Exit-only mode, no new entries

**Persistence**: All state is stored in Supabase `hour_sessions` table. Bot can safely restart and resume from any state.

**Usage**: Phase transitions are handled automatically based on time. State transitions are validated and logged.

### Market Discovery

Automatically finds KXBTCD hourly markets:
- Filters by series ticker `KXBTCD`
- Matches markets by resolution hour
- Handles multiple markets per hour (selects closest to target time)

**Usage**: Called automatically when approaching entry window. Market data subscriptions are managed automatically.

### Candidate Selection & Entry Eligibility

Filters contracts meeting entry criteria:
- **Entry Eligibility**: Executable ask in [0.75, 0.85] OR last traded price > 0.85 and ≤ 0.90
- Sorts by spread (lower = better)
- Provides candidates to OpenAI for ranking

**Usage**: Called during `BUILD_CANDIDATES` or `SCAN_PLAN` state. Results are passed to OpenAI decision advisor.

### Plan A / Plan B System

Dual-plan system for anticipating reversals:

#### Plan A (Primary)
- Primary intended trade (side + strike)
- Selected from candidates based on best spread/entry price
- Monitored for warning band (price 0.71-0.79)

#### Plan B (Contingency)
- Opposite side trade prepared in advance
- Armed only when both conditions met (Option C logic):
  1. Plan A price in warning band (0.71-0.79)
  2. Kalshi price action supports continued move (weakening consistent with flip)
  3. BTC direction/pattern supports Plan B direction
- Prevents flipping on noise

**Usage**: Plans are built during `SCAN_PLAN` phase. Plan B arming is checked during `TRADE_ACTIVE` phase. Both plans stored with `plan_type` ('A' or 'B') in `trade_plans` table.

### Plan Validation

Deterministic validation of OpenAI trade plans:
- Entry price range check
- Entry eligibility check (0.75-0.85 OR last trade > 0.85 and ≤ 0.90)
- Stop-loss price validation
- Capital limit enforcement (with size multiplier applied)
- Max trades per hour check (≤ 3)
- Cooldown period check
- Hourly loss cap check
- Contract existence and liveliness
- Feed staleness check (< 5 seconds)
- Trading hours validation

**Usage**: All OpenAI recommendations are validated before execution. Invalid plans are rejected and logged.

### BTC Market Data Integration

Real-time BTC/USD price streaming and historical data from Kraken:

#### Kraken BTC Feed (WebSocket)
- Streams real-time BTC/USD ticker from Kraken WebSocket v2
- Maintains current price in memory
- Rolling buffer of last 300 ticks (~5 minutes of history)
- Automatic reconnection with exponential backoff
- Event-driven price updates

**Usage**: Initialize with `initializeBTCFeed()` at bot startup. Access current price via `getBTCFeed().getCurrentPrice()`.

#### Kraken OHLC Client (REST)
- Fetches hourly OHLC candles from Kraken REST API
- Supports 24h, 7d, and 30d history
- In-memory caching (60s TTL) to prevent excessive API calls
- Automatic retries with exponential backoff
- AbortController timeouts (10s)

**Usage**: Call `getCandles24h()`, `getCandles7d()`, or `getCandles30d()` as needed. Cache is managed automatically.

### Skip Hour Shadow Trading

When circuit breaker triggers (2 consecutive losing hours), the next hour becomes a skip hour:

**Skip Hour Behavior**:
- **NO TRADING**: No orders placed, no sizing, no exposure
- **Full Analysis**: Still scans markets, builds Plan A/B, calls OpenAI
- **Shadow Logging**: Logs "would-have-traded" decisions to `shadow_trades` table
- **Outcome Comparison**: After hour ends, compares shadow decisions to actual market outcomes
- **Learning**: Uses skip hour data to refine AI prompting for next hour

**Usage**: Automatically triggered by circuit breaker. Shadow trades are logged with Plan A/B type, OpenAI analysis, and would-have P&L.

### Trade Evaluation System

AI-powered trade evaluation based on BTC market conditions and past trading performance:

#### Trade Judge
- Evaluates candidate trades before execution
- Considers:
  - Current BTC price and recent movement (1h/4h/24h changes)
  - BTC volatility and trend analysis
  - Past 24 trades performance (win rate, PnL, streaks)
  - Correlation between trade outcomes and BTC direction
- Returns structured evaluation:
  - `verdict`: "GOOD", "BAD", or "UNCLEAR"
  - `confidence`: 0-1 scale
  - `reasons`: List of supporting factors
  - `risk_flags`: List of concerns
  - `suggested_action`: "PROCEED", "SKIP", "REDUCE_SIZE", or "WAIT"

**Usage**: Call `evaluateCandidateTrade(candidate)` with a `CandidateTrade` object. Returns `EvalResult` with evaluation.

**Integration**: Can be called before placing trades in `handleOpenAIRecommendation()` or `handleValidatePlan()` methods to add an additional layer of risk assessment.

#### Feature Engineering
- Computes BTC features:
  - Current price, 1h/4h/24h percentage changes
  - 24h realized volatility (std dev of hourly returns)
  - Trend proxy (linear regression slope of last 12 hourly closes)
- Computes trade statistics:
  - Win rate, average PnL, average entry price
  - Top 3 market tickers by frequency
  - Current win/loss streak
  - Correlation between trade outcomes and BTC direction

**Usage**: Features are computed automatically by the evaluation system. No direct usage needed.

#### Kalshi Trades Repository
- Accesses `kalshi_trades` table in Supabase
- Retrieves last N trades ordered by `created_at DESC`
- Maps database records to TypeScript interfaces

**Usage**: Call `getLastTrades(24)` to get last 24 trades. Used internally by the evaluation system.

**Note**: The `kalshi_trades` table must be populated separately (via migration script or by aggregating from `orders` + `fills` tables).

## Configuration

All configuration via environment variables (see `env.template`):

- **Trading Hours**: `TRADING_START_HOUR`, `TRADING_END_HOUR`
- **Entry Window**: `ENTRY_WINDOW_MINUTES`
- **Price Constraints**: `ENTRY_PRICE_MIN`, `ENTRY_PRICE_MAX`, `STOP_LOSS_PRICE`, `TAKE_PROFIT_PRICE`
- **Risk Limits**: `HOURLY_CAP_PERCENT`, `HOURLY_LOSS_CAP_PERCENT`, `MAX_TRADES_PER_HOUR`, `MAX_POSITION_SIZE`, `MIN_CASH_RESERVE`
- **Cooldown**: `STOP_LOSS_COOLDOWN_SECONDS`
- **Kraken**: `KRAKEN_WS_URL` (default: `wss://ws.kraken.com/v2`), `KRAKEN_REST_URL` (default: `https://api.kraken.com/0/public`)

## Database Schema

All state persisted in Supabase Postgres:

- `bot_runs`: Bot execution sessions (includes `consecutive_losing_hours`)
- `hour_sessions`: Hourly trading sessions with state (includes `is_skip_hour`, `trades_count`, `realized_losses`, `cooldown_until`, `size_multiplier`)
- `trade_plans`: OpenAI recommendations with validation status (includes `plan_type` for Plan A/B)
- `orders`: All orders placed
- `fills`: Order fills
- `trade_analyses`: Post-trade OpenAI analyses
- `shadow_trades`: Skip hour shadow trading decisions and outcomes
- `kalshi_trades`: Completed trades with outcomes (for trade evaluation system)

See `src/supabase/schema.sql` for full schema. See `src/supabase/migrations/` for migration files.

## Error Handling

- **Single Trade Failures**: Don't crash bot, log and continue
- **WebSocket Disconnections**: Automatic reconnection with exponential backoff
- **API Errors**: Logged, circuit breaker may pause trading
- **Validation Failures**: Plans rejected, logged, bot continues to next opportunity

## Performance

- **Database Queries**: Indexed for fast lookups
- **Main Loop**: Runs every 5 seconds, non-blocking
- **WebSocket Updates**: Processed asynchronously

## Future Enhancements

Potential improvements:
- Multiple position management strategies
- Enhanced post-trade analysis
- Performance metrics and reporting
- Additional market data sources

