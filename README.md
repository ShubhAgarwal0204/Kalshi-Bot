# Kalshi Trading Bot

Production-grade automated trading bot for Kalshi KXBTCD hourly "Bitcoin price above/below" prediction markets. The bot operates as a state machine that processes hourly markets during specific time windows, using AI-assisted decision making with strict deterministic validation and comprehensive risk management.

## Table of Contents

- [Overview](#overview)
- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Integrations](#integrations)
- [Trade Decision Flow](#trade-decision-flow)
- [Position Monitoring](#position-monitoring)
- [Risk Management](#risk-management)
- [State Machine & Phases](#state-machine--phases)
- [Setup](#setup)
- [Configuration](#configuration)
- [Database Schema](#database-schema)
- [Development](#development)
- [Error Handling](#error-handling)
- [Important Notes](#important-notes)

## Overview

This bot trades Kalshi's KXBTCD hourly markets, which are binary prediction markets that resolve based on Bitcoin's price at the top of each hour. The bot:

- **Operates during trading hours** (8 AM - 12 AM ET by default)
- **Trades only during the final 20 minutes** before market resolution (entry window)
- **Uses AI recommendations** from OpenAI, but validates all decisions deterministically
- **Manages risk** through exposure caps, stop-losses, take-profits, and circuit breakers
- **Persists all state** to Supabase PostgreSQL for safe restarts
- **Monitors positions** continuously for exit triggers
- **Handles multiple trades per hour** within capital limits

## What It Does

### Market Type

The bot trades **KXBTCD hourly markets** on Kalshi. These are binary contracts that ask: "Will Bitcoin's price be above/below a strike price at the top of the hour?"

Each market has two contracts:

- **YES contract**: Pays $1 if Bitcoin is above the strike at resolution
- **NO contract**: Pays $1 if Bitcoin is below the strike at resolution

### Trading Strategy

1. **Market Discovery**: Automatically finds the current hour's KXBTCD market
2. **Candidate Selection**: Identifies contracts with entry prices in the eligible range (0.75-0.85 or last trade 0.85-0.90)
3. **AI Recommendation**: Gets trade recommendation from OpenAI based on:
   - Current market conditions (spreads, prices)
   - Bitcoin price data (real-time and historical)
   - Recent trading history (win rate, streaks, patterns)
   - Risk constraints
4. **Validation**: Validates AI recommendation against hard constraints
5. **Execution**: Places buy orders if valid, monitors positions
6. **Exit Management**: Automatically exits via stop-loss (≤0.70) or take-profit (≥0.96)
7. **Post-Trade Analysis**: Analyzes results after each hour with OpenAI

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Trading Bot (main.ts)                     │
│                  Main Loop (every 5 seconds)                │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
│  Kalshi API    │  │  Supabase DB    │  │  OpenAI API    │
│  (REST + WS)   │  │  (PostgreSQL)    │  │  (GPT-4o-mini) │
└────────────────┘  └─────────────────┘  └────────────────┘
        │                   │                   │
┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
│  Kraken API    │  │  State Machine │  │  Risk Managers  │
│  (BTC Data)    │  │  (Sessions)    │  │  (Exposure/SL)  │
└────────────────┘  └────────────────┘  └────────────────┘
```

### Core Components

1. **Session Manager**: Manages hourly trading sessions, tracks state, enforces limits
2. **State Machine**: Handles state transitions for each hourly session
3. **Market Discovery**: Finds and subscribes to relevant Kalshi markets
4. **Candidate Selector**: Filters contracts meeting entry criteria
5. **Decision Advisor**: Gets AI recommendations from OpenAI
6. **Plan Validator**: Validates AI recommendations deterministically
7. **Exposure Manager**: Tracks and limits capital usage per hour
8. **Position Monitor**: Monitors open positions for stop-loss/take-profit triggers
9. **Circuit Breaker**: System-level safety checks
10. **Post-Trade Analyst**: Analyzes completed hours with AI

### Key Design Principles

- **WebSocket-First**: Real-time data via WebSockets, REST only for orders/auth
- **State Persistence**: All state in database, survives restarts
- **Deterministic Validation**: AI is advisory only, code enforces all rules
- **Fail-Safe**: Multiple layers of risk management and circuit breakers
- **Event-Driven**: WebSocket updates trigger position monitoring

## How It Works

### Main Loop Flow

The bot runs a main loop every 5 seconds that:

1. **Checks Circuit Breaker**: Verifies system health (WebSocket, cash, trading hours)
2. **Validates Trading Hours**: Only processes during configured hours (default: 8 AM - 12 AM ET)
3. **Processes Active Sessions**: For each active hourly session:
   - Handles phase transitions based on time
   - Processes current state (e.g., BUILD_CANDIDATES, VALIDATE_PLAN, etc.)
4. **Checks for New Sessions**: Creates new hour session when approaching entry window
5. **Monitors Positions**: Checks stop-losses and take-profits for all open positions

### Hourly Session Lifecycle

Each hour follows this lifecycle:

1. **Session Creation** (~1 minute before entry window)

   - Bot discovers market for the hour
   - Creates `hour_sessions` record with initial state
   - Subscribes to market order books via WebSocket

2. **Phase A: IGNORE_EARLY** (00:00-00:30)

   - First 30 minutes of the hour
   - No trading, passive BTC tracking only
   - State: `IGNORE_EARLY`

3. **Phase B: SCAN_PLAN** (00:30-00:40)

   - Market scanning and Plan A/B preparation
   - Builds candidate list, prepares primary and contingency plans
   - No trading yet
   - State: `SCAN_PLAN`

4. **Phase C: TRADE_ACTIVE** (00:40-00:58:30)

   - Active trading window (18.5 minutes)
   - Can enter positions, place buy orders
   - States: `BUILD_CANDIDATES` → `OPENAI_RECOMMENDATION` → `VALIDATE_PLAN` → `PLACING_BUY` → `IN_POSITION` → `TRADE_ACTIVE` (can loop for multiple trades)

5. **Phase D: SELL_ONLY** (00:58:30-01:00)

   - Final 90 seconds before resolution
   - Exit-only mode, no new entries
   - State: `SELL_ONLY`

6. **Completion** (after resolution)
   - State: `DONE`
   - Post-trade analysis runs
   - P&L calculated and recorded

### State Transitions

The bot uses a state machine with these states:

- `IDLE` → Initial state
- `WAIT_ENTRY_WINDOW` → Waiting for entry window to start
- `IGNORE_EARLY` → Phase A: No trading
- `SCAN_PLAN` → Phase B: Market scanning
- `BUILD_CANDIDATES` → Finding eligible contracts
- `OPENAI_RECOMMENDATION` → Getting AI recommendation
- `VALIDATE_PLAN` → Validating AI plan
- `PLACING_BUY` → Executing buy order
- `TRADE_ACTIVE` → Can place new trades
- `IN_POSITION` → Has open position(s)
- `PLACING_SELL` → Executing sell order
- `SELL_ONLY` → Phase D: Exit-only mode
- `SKIP_HOUR_OBSERVE` → Skip hour (shadow trading)
- `COOLDOWN` → Cooldown after stop-loss
- `DONE` → Hour complete

## Integrations

### Kalshi API

**Purpose**: Trading platform for binary prediction markets

**Components**:

- **REST Client** (`kalshi/rest-client.ts`):
  - Authentication (RSA-signed requests)
  - Order placement (BUY/SELL)
  - Order cancellation
  - Balance queries
  - Market discovery queries
- **WebSocket Client** (`kalshi/websocket-client.ts`):
  - Real-time order book updates
  - Order status updates
  - Fill notifications
  - Automatic reconnection with exponential backoff

**Usage**:

- WebSocket is primary data source (fastest updates)
- REST used only for authentication, orders, and initial market queries
- All order books cached in memory for fast lookups

**Configuration**:

- `KALSHI_API_KEY`: Your Kalshi API key
- `KALSHI_PRIVATE_KEY`: RSA private key (PEM format) for request signing
- `KALSHI_API_BASE_URL`: REST API endpoint (default: `https://trading-api.kalshi.com/trade-api/v2`)
- `KALSHI_WS_URL`: WebSocket endpoint (default: `wss://api.elections.kalshi.com/trade-api/ws/v2`)

### Supabase (PostgreSQL)

**Purpose**: Persistent state storage and trade history

**What's Stored**:

- `bot_runs`: Bot execution sessions (tracks consecutive losing hours)
- `hour_sessions`: Hourly trading sessions with state, cash, limits
- `trade_plans`: OpenAI recommendations with validation status
- `orders`: All orders placed (BUY/SELL)
- `fills`: Order fills (partial fills tracked)
- `trade_analyses`: Post-trade OpenAI analyses
- `shadow_trades`: Skip hour shadow trading decisions

**Why Supabase**:

- State persistence: Bot can restart and resume from any state
- Audit trail: All decisions and trades recorded
- Analytics: Historical data for analysis and AI input
- Reliability: PostgreSQL with ACID guarantees

**Configuration**:

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key (bypasses RLS)

**Schema**: See `src/supabase/schema.sql` for full schema. Run migrations before first use.

### OpenAI API

**Purpose**: AI-powered trade recommendations and analysis

**Components**:

- **Decision Advisor** (`openai/decision-advisor.ts`):
  - Pre-trade recommendations
  - Input: Market data, BTC features, trade history, constraints
  - Output: Trade plan (ENTER/SKIP) with rationale and confidence
  - Uses structured outputs (JSON schema) for reliability
- **Post-Trade Analyst** (`openai/post-trade-analyst.ts`):
  - Post-hour analysis
  - Input: Trade outcomes, P/L
  - Output: What worked, what didn't, suggestions

**Important**: OpenAI is **advisory only**. All recommendations are validated deterministically before execution. Invalid plans are rejected.

**Configuration**:

- `OPENAI_API_KEY`: Your OpenAI API key
- `OPENAI_MODEL`: Model to use (default: `gpt-4o-mini`)
- `OPENAI_BASE_URL`: API endpoint (default: `https://api.openai.com/v1`)

### Kraken API

**Purpose**: Real-time Bitcoin price data for market analysis

**Components**:

- **Kraken BTC Feed** (`market/krakenBtcFeed.ts`):
  - WebSocket stream of BTC/USD ticker
  - Maintains current price in memory
  - Rolling buffer of last 300 ticks (~5 minutes)
- **Kraken OHLC Client** (`market/krakenOhlc.ts`):
  - REST API for historical hourly candles
  - Supports 24h, 7d, 30d history
  - In-memory caching (60s TTL)

**Usage**:

- BTC price data fed to OpenAI for context
- Features computed: price changes (1h/4h/24h), volatility, trend slope
- Used in trade decision making

**Configuration**:

- `KRAKEN_WS_URL`: WebSocket endpoint (default: `wss://ws.kraken.com/v2`)
- `KRAKEN_REST_URL`: REST API endpoint (default: `https://api.kraken.com/0/public`)

## Trade Decision Flow

### Step-by-Step Process

1. **Market Discovery** (`kalshi/market-discovery.ts`)

   - Queries Kalshi REST API for KXBTCD markets
   - Filters by resolution hour (matches target hour)
   - Selects closest matching market
   - Subscribes to order books via WebSocket

2. **Candidate Selection** (`strategy/candidate-selector.ts`)

   - Gets order book data from WebSocket cache
   - Filters contracts by entry eligibility:
     - Executable ask price in [0.75, 0.85] **OR**
     - Last traded price > 0.85 and ≤ 0.90
   - Sorts by spread (lower = better)
   - Returns candidate list

3. **Plan Building** (`strategy/plan-manager.ts`)

   - **Plan A (Primary)**: Best candidate based on spread/entry price
   - **Plan B (Contingency)**: Opposite side trade, prepared for reversals
   - Plans stored with `plan_type` ('A' or 'B') in database

4. **AI Recommendation** (`openai/decision-advisor.ts`)

   - Prepares input with:
     - Current time, market resolution time
     - Candidate contracts (prices, spreads)
     - Remaining hourly capital
     - Constraints (entry price range, stop-loss, max spend)
     - BTC features (price, changes, volatility, trend)
     - Trade history (win rate, streaks, recent trades)
   - Calls OpenAI with structured prompt
   - Returns trade plan: `ENTER` (with contract, side, price, size) or `SKIP`

5. **Plan Validation** (`strategy/plan-validator.ts`)

   - **Deterministic validation** (all checks must pass):
     - Action is ENTER or SKIP
     - Required fields present (contract_id, side, entry_limit_price, dollars_to_spend)
     - Entry price in range [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX]
     - Stop-loss price matches configured value
     - Dollars to spend ≤ remaining hourly capital
     - Contract exists and has live order book data
     - Feed data not stale (< 5 seconds old)
     - WebSocket connected
     - Within trading hours
   - If valid: Plan marked `valid`, proceed to execution
   - If invalid: Plan marked `rejected`, errors logged, try again or skip

6. **Risk Checks** (before execution)

   - **Exposure Manager**: Can spend requested amount? (checks hourly cap, size multiplier)
   - **Max Trades**: Under limit? (default: 3 per hour)
   - **Cooldown**: Not in cooldown period? (45s after stop-loss)
   - **Hourly Loss Cap**: Not breached? (15% of max trade budget)
   - All checks must pass

7. **Order Execution** (`main.ts` → `handlePlacingBuy`)
   - Calculates contract size: `floor(dollars_to_spend / entry_limit_price)`
   - Places limit buy order via Kalshi REST API
   - Records order in database
   - Records spend in exposure manager
   - Increments trades count
   - Registers position for monitoring
   - Transitions to `IN_POSITION` state

### Plan A / Plan B System

The bot uses a dual-plan system:

- **Plan A**: Primary intended trade (selected from candidates)
- **Plan B**: Contingency trade (opposite side, prepared for reversals)

Plans are built during `SCAN_PLAN` phase (00:30-00:40). Plan B can be armed during `TRADE_ACTIVE` phase if:

- Plan A price enters warning band (0.71-0.79)
- Market conditions support reversal
- BTC direction supports Plan B

This prevents flipping on noise while allowing strategic reversals.

## Position Monitoring

### Continuous Monitoring

The bot monitors all open positions every 5 seconds via `PositionMonitor` (`risk/position-monitor.ts`):

1. **Gets Current Prices**: Queries WebSocket cache for best bid/ask
2. **Calculates Exit Price**:
   - YES positions: best bid (what you can sell for)
   - NO positions: best ask (what you can sell for)
3. **Checks Triggers**: Compares exit price to stop-loss and take-profit thresholds

### Stop-Loss Monitoring

**Trigger**: Exit price ≤ `STOP_LOSS_PRICE` (default: 0.70)

**Execution** (`executeStopLoss`):

1. Cancels any pending buy orders for the contract
2. Places market sell order at current exit price
3. Records order in database
4. Sets cooldown period (45 seconds by default)
5. Removes position from monitoring

**Purpose**: Limits losses on bad trades

### Take-Profit Monitoring

**Trigger**: Exit price ≥ `TAKE_PROFIT_PRICE` (default: 0.96)

**Special Rules**:

- **Normal Phase**: Triggers if price ≥ 0.96
- **SELL_ONLY Phase**: Only triggers if price ≥ 0.96 **and** < 0.99 (avoids selling too early near resolution)

**Execution** (`executeTakeProfit`):

1. Places market sell order at current exit price
2. Records order in database
3. Removes position from monitoring

**Purpose**: Locks in profits on winning trades

### Position Registration

Positions are automatically registered when buy orders are placed:

- Contract ID, side, entry price, size stored in memory
- Monitored until closed or hour ends
- WebSocket updates trigger price checks

## Risk Management

The bot has multiple layers of risk management:

### 1. Exposure Manager (`risk/exposure-manager.ts`)

**Purpose**: Limits capital usage per hour

**Mechanism**:

- Tracks `cash_spent` per hour session
- Calculates `max_spend_allowed = cash_at_start * HOURLY_CAP_PERCENT / 100` (default: 25%)
- Applies `size_multiplier` to remaining capacity (reduces after losses)
- Atomic updates prevent race conditions

**Size Multiplier**:

- After 0 losses: 100% of max trade budget
- After 1 loss: 70% of max trade budget
- After 2+ losses: 50% of max trade budget

**Hour-to-Hour Reset**:

- If hourly P&L ≥ 0: Reset multiplier to 100% for next hour
- If hourly P&L < 0: Carry forward reduced multiplier to next hour

**Usage**: Checked before each trade entry. Records spend after execution.

### 2. Hourly Loss Manager (`risk/hourly-loss-manager.ts`)

**Purpose**: Hard stop on hourly losses

**Mechanism**:

- Tracks `realized_losses` per hour session (from filled sell orders)
- Calculates `max_trade_budget = 0.25 * portfolio_cash`
- Calculates `hourly_loss_cap = 0.15 * max_trade_budget` (default: 15%)
- If `realized_losses >= hourly_loss_cap`: Trading stops for the hour

**Usage**: Checked before each trade entry. Trading blocked if cap breached.

### 3. Max Trades & Cooldown (`engine/session-manager.ts`)

**Max Trades**:

- Enforces maximum entries per hour (default: 3)
- Tracks `trades_count` per session
- Blocks new entries if limit reached

**Cooldown**:

- 45-second cooldown after stop-loss execution (configurable)
- Tracks `cooldown_until` timestamp per session
- Prevents immediate re-entry after stop-loss

**Usage**: Checked before each trade entry via `canPlaceTrade()`.

### 4. Position Monitor (Stop-Loss & Take-Profit)

See [Position Monitoring](#position-monitoring) section above.

### 5. Circuit Breaker (`risk/circuit-breaker.ts`)

**Purpose**: System-level safety checks

**Checks**:

- **WebSocket Health**: Connection alive and receiving updates?
- **Cash Balance**: Sufficient cash available?
- **Trading Hours**: Within configured hours?
- **API Rate Limits**: Not exceeding limits?

**Actions**:

- If any check fails: Trading paused, errors logged
- **Skip Hour Logic**: After 2 consecutive losing hours, next hour becomes skip hour (shadow trading only)

**Usage**: Checked before each main loop iteration. Trading paused if unhealthy.

### 6. Plan Validation

See [Trade Decision Flow](#trade-decision-flow) section. All AI recommendations validated deterministically.

### 7. Entry Price Constraints

- Entry price must be in [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX] (default: [0.80, 0.90])
- Entry eligibility: Executable ask in [0.75, 0.85] OR last trade > 0.85 and ≤ 0.90
- Enforced in candidate selection and plan validation

### 8. Stop-Loss Price

- Fixed at `STOP_LOSS_PRICE` (default: 0.70)
- Enforced in plan validation (AI cannot change it)
- Monitored continuously for all positions

## State Machine & Phases

### State Machine

The bot uses a persistent state machine (`engine/state-machine.ts`) where each hourly session has a state stored in the database. States survive restarts.

**Valid State Transitions**:

```
IDLE → WAIT_ENTRY_WINDOW → IGNORE_EARLY → SCAN_PLAN → BUILD_CANDIDATES
  → OPENAI_RECOMMENDATION → VALIDATE_PLAN → PLACING_BUY → IN_POSITION
  → TRADE_ACTIVE (can loop) → SELL_ONLY → DONE

Alternative paths:
- SKIP_HOUR_OBSERVE (skip hours)
- COOLDOWN (after stop-loss)
- PLACING_SELL (exit orders)
```

### 4-Phase Schedule

Each hour follows a strict 4-phase schedule (all times ET, relative to market resolution):

**Phase A: IGNORE_EARLY** (00:00-00:30)

- First 30 minutes
- No trading, passive BTC tracking only
- State: `IGNORE_EARLY`

**Phase B: SCAN_PLAN** (00:30-00:40)

- 10-minute window
- Market scanning, candidate selection, Plan A/B preparation
- No trading yet
- State: `SCAN_PLAN`

**Phase C: TRADE_ACTIVE** (00:40-00:58:30)

- 18.5-minute active trading window
- Can enter positions, place buy orders
- Multiple trades allowed (up to MAX_TRADES_PER_HOUR)
- States: `BUILD_CANDIDATES`, `OPENAI_RECOMMENDATION`, `VALIDATE_PLAN`, `PLACING_BUY`, `IN_POSITION`, `TRADE_ACTIVE`

**Phase D: SELL_ONLY** (00:58:30-01:00)

- Final 90 seconds before resolution
- Exit-only mode, no new entries
- Take-profit only triggers if price ≥ 0.96 and < 0.99
- State: `SELL_ONLY`

### Skip Hours

When circuit breaker triggers (2 consecutive losing hours), the next hour becomes a skip hour:

- **State**: `SKIP_HOUR_OBSERVE`
- **Behavior**:
  - NO TRADING: No orders placed, no sizing, no exposure
  - Full Analysis: Still scans markets, builds Plan A/B, calls OpenAI
  - Shadow Logging: Logs "would-have-traded" decisions to `shadow_trades` table
  - Outcome Comparison: After hour ends, compares shadow decisions to actual market outcomes

## Setup

### Prerequisites

- **Node.js 18+**: Runtime environment
- **Supabase Account**: PostgreSQL database
- **Kalshi Account**: Trading account with API credentials
- **OpenAI Account**: API key for AI recommendations
- **Kraken Account**: (Optional, uses public endpoints)

### Installation

1. **Clone the repository**:

```bash
git clone <repository-url>
cd kalshibot
```

2. **Install dependencies**:

```bash
npm install
```

3. **Set up environment variables**:

```bash
cp env.template .env
# Edit .env with your credentials
```

Required variables (see `env.template` for full list):

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `KALSHI_API_KEY`: Kalshi API key
- `KALSHI_PRIVATE_KEY`: RSA private key (PEM format)
- `OPENAI_API_KEY`: OpenAI API key

4. **Set up Supabase database**:

   - Create a new Supabase project
   - Run migrations using one of these methods:
     ```bash
     npm run db:migrate
     ```
     This will generate a `migrations.sql` file with all schema and migrations combined.
     - **Option A**: Copy the SQL from `migrations.sql` and run it in the Supabase SQL Editor
     - **Option B**: Use Supabase CLI: `supabase db push`
     - **Option C**: Use psql: `psql $DATABASE_URL < migrations.sql`

   Alternatively, manually run:

   - The SQL schema from `src/supabase/schema.sql`
   - Any migrations from `src/supabase/migrations/` in order

5. **Build the project**:

```bash
npm run build
```

6. **Run the bot**:

```bash
npm start
```

### Development Mode

Run with hot reload:

```bash
npm run dev
```

## Configuration

All configuration via environment variables (see `env.template`):

### Trading Hours

- `TRADING_START_HOUR`: Start of trading day (ET), default: 8 (8 AM)
- `TRADING_END_HOUR`: End of trading day (ET), default: 24 (midnight)

### Entry Window

- `ENTRY_WINDOW_MINUTES`: Minutes before resolution to enter trades, default: 20

### Price Constraints

- `ENTRY_PRICE_MIN`: Minimum entry price, default: 0.80
- `ENTRY_PRICE_MAX`: Maximum entry price, default: 0.90
- `STOP_LOSS_PRICE`: Stop-loss trigger price, default: 0.70
- `TAKE_PROFIT_PRICE`: Take-profit trigger price, default: 0.96

### Risk Limits

- `HOURLY_CAP_PERCENT`: Maximum percentage of cash to spend per hour, default: 25
- `HOURLY_LOSS_CAP_PERCENT`: Maximum percentage of hourly budget that can be lost before stopping, default: 15
- `MAX_TRADES_PER_HOUR`: Maximum entries per hour, default: 3
- `MAX_POSITION_SIZE`: Maximum position size in contracts, default: 1000
- `MIN_CASH_RESERVE`: Minimum cash to keep in account, default: 100

### Cooldown

- `STOP_LOSS_COOLDOWN_SECONDS`: Cooldown period after stop-loss (seconds), default: 45

### API Endpoints

- `KALSHI_API_BASE_URL`: Kalshi REST API endpoint
- `KALSHI_WS_URL`: Kalshi WebSocket endpoint
- `KRAKEN_WS_URL`: Kraken WebSocket endpoint
- `KRAKEN_REST_URL`: Kraken REST API endpoint
- `OPENAI_BASE_URL`: OpenAI API endpoint
- `OPENAI_MODEL`: OpenAI model to use, default: `gpt-4o-mini`

## Database Schema

### Core Tables

**`bot_runs`**: Bot execution sessions

- `id`: UUID primary key
- `started_at`, `ended_at`: Timestamps
- `status`: 'running', 'stopped', 'error'
- `initial_cash`, `final_cash`: Cash tracking
- `consecutive_losing_hours`: Counter for skip hour logic

**`hour_sessions`**: Hourly trading sessions

- `id`: UUID primary key
- `bot_run_id`: Foreign key to `bot_runs`
- `market_hour`: Resolution time (ET)
- `state`: Current state machine state
- `entry_window_start`: When entry window begins
- `cash_at_start`, `cash_spent`: Capital tracking
- `max_spend_allowed`: Hourly cap
- `is_skip_hour`: Skip hour flag
- `trades_count`: Number of entries this hour
- `realized_losses`: Losses from filled sells
- `cooldown_until`: Cooldown expiration
- `size_multiplier`: Size reduction multiplier

**`trade_plans`**: OpenAI recommendations

- `id`: UUID primary key
- `hour_session_id`: Foreign key to `hour_sessions`
- `openai_response`: Full OpenAI response (JSONB)
- `action`: 'ENTER' or 'SKIP'
- `side`: 'YES' or 'NO' (if ENTER)
- `contract_id`, `entry_limit_price`, `dollars_to_spend`: Trade details
- `stop_loss_price`: Stop-loss price
- `rationale`, `confidence`: AI reasoning
- `validation_status`: 'pending', 'valid', 'rejected'
- `validation_errors`: Validation errors (if rejected)
- `plan_type`: 'A' or 'B' (for Plan A/B system)

**`orders`**: All orders placed

- `id`: UUID primary key
- `hour_session_id`: Foreign key to `hour_sessions`
- `trade_plan_id`: Foreign key to `trade_plans` (nullable)
- `kalshi_order_id`: Kalshi's order ID (unique)
- `contract_id`, `side`: Contract details
- `action`: 'BUY' or 'SELL'
- `limit_price`, `size`: Order details
- `dollars_spent`: Capital used
- `status`: 'pending', 'filled', 'cancelled', 'rejected'
- `placed_at`, `filled_at`: Timestamps

**`fills`**: Order fills (partial fills tracked)

- `id`: UUID primary key
- `order_id`: Foreign key to `orders`
- `kalshi_fill_id`: Kalshi's fill ID (unique)
- `price`, `size`: Fill details
- `filled_at`: Timestamp

**`trade_analyses`**: Post-trade OpenAI analyses

- `id`: UUID primary key
- `hour_session_id`: Foreign key to `hour_sessions`
- `openai_analysis`: Full OpenAI response (JSONB)
- `summary`, `what_worked`, `what_didnt_work`, `suggestions`: Analysis fields

**`shadow_trades`**: Skip hour shadow trading

- `id`: UUID primary key
- `hour_session_id`: Foreign key to `hour_sessions`
- `plan_type`: 'A' or 'B'
- `contract_id`, `side`, `entry_price`: Would-have trade details
- `openai_response`: OpenAI analysis (JSONB)
- `would_have_pnl`: Calculated P&L if traded
- `actual_settlement_price`: Actual market settlement price

See `src/supabase/schema.sql` for full schema with indexes and constraints.

## Development

### Project Structure

```
src/
  kalshi/          # Kalshi API clients (REST + WebSocket)
  supabase/        # Database client and repositories
  openai/          # OpenAI integration (Decision Advisor, Post-Trade Analyst)
  strategy/        # Trading strategy (Candidate Selector, Plan Validator, Plan Manager)
  risk/            # Risk management (Exposure Manager, Position Monitor, Circuit Breaker, etc.)
  engine/          # State machine and session management
  market/          # Market data (Kraken BTC feed, OHLC client)
  main.ts          # Entry point and main loop
tests/
  unit/            # Unit tests
```

### Running Tests

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

### Key Files to Understand

- **`src/main.ts`**: Main bot orchestrator, main loop, state handlers
- **`src/engine/session-manager.ts`**: Session lifecycle, phase transitions
- **`src/engine/state-machine.ts`**: State machine logic
- **`src/strategy/candidate-selector.ts`**: Entry eligibility filtering
- **`src/strategy/plan-validator.ts`**: Deterministic validation
- **`src/risk/position-monitor.ts`**: Stop-loss/take-profit monitoring
- **`src/risk/exposure-manager.ts`**: Capital limits
- **`src/kalshi/websocket-client.ts`**: Real-time market data
- **`src/openai/decision-advisor.ts`**: AI recommendations

### Database Migrations

Generate combined migration SQL:

```bash
npm run db:migrate
# or
npm run db:push
```

This creates a `migrations.sql` file with all schema and migrations combined. Then apply it using one of these methods:

- **Supabase Dashboard**: Copy SQL to SQL Editor and run it
- **Supabase CLI**: `supabase db push` (if CLI is installed)
- **psql**: `psql $DATABASE_URL < migrations.sql`

## Error Handling

### Single Trade Failures

- Don't crash bot, log error and continue
- Invalid plans rejected, logged, bot continues
- Order failures logged, state updated

### WebSocket Disconnections

- Automatic reconnection with exponential backoff
- State preserved in database
- Bot continues processing when reconnected

### API Errors

- Logged with context
- Circuit breaker may pause trading if critical
- Retries with backoff for transient errors

### Validation Failures

- Plans rejected with detailed errors
- Errors logged to `trade_plans.validation_errors`
- Bot continues to next opportunity

### Database Errors

- Critical: Bot may pause trading
- Non-critical: Logged, retried
- State consistency maintained via transactions

## Important Notes

### OpenAI is Advisory Only

- All recommendations validated deterministically
- Invalid plans rejected regardless of AI confidence
- Code enforces all risk, sizing, timing, and execution rules
- AI cannot override hard constraints

### State Persistence

- All state stored in Supabase PostgreSQL
- Bot can restart and resume from any state
- No in-memory-only state (except WebSocket caches)
- Safe to restart at any time

### Trading Hours

- Bot only trades during configured hours (default: 8 AM - 12 AM ET)
- Outside hours: Bot idles, no processing
- Phase transitions based on ET timezone

### Multiple Trades Per Hour

- Bot can execute multiple trades within hourly capital limit
- Each trade validated independently
- Max trades per hour enforced (default: 3)
- Size multiplier reduces capacity after losses

### WebSocket-First Architecture

- Real-time data via WebSocket (fastest)
- REST API used only for:
  - Authentication
  - Order placement
  - Initial market queries
- Order books cached in memory for fast lookups

### Timezone Handling

- All times in ET (America/New_York timezone)
- Market hours calculated in ET
- Phase transitions based on ET time
- Database stores UTC timestamps

### Skip Hours

- After 2 consecutive losing hours, next hour is skip hour
- Shadow trading: Full analysis, no real orders
- Used for learning and avoiding overtrading

## License

MIT
