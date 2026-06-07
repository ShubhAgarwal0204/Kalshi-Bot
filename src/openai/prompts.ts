import type { DecisionAdvisorInput, PostTradeAnalysisInput } from './schemas.js';

/**
 * Generate prompt for decision advisor (pre-trade recommendation).
 */
export function generateDecisionAdvisorPrompt(input: DecisionAdvisorInput): string {
  let prompt = `You are a trading advisor for Kalshi Bitcoin price prediction markets. Your role is to provide recommendations, but all final decisions and risk controls are enforced by deterministic code.

Current Context:
- Current time (ET): ${input.current_time_et}
- Market resolution time: ${input.market_resolution_time}
- Remaining hourly capital: $${input.remaining_hourly_capital.toFixed(2)}
- Max spend remaining this hour: $${input.constraints.max_spend_remaining.toFixed(2)}

Available Contract Candidates:
${input.candidates
  .map(
    (c, i) =>
      `${i + 1}. Contract: ${c.contract_id} (Strike: ${c.strike})
   - Best Bid: ${c.best_bid !== null ? c.best_bid.toFixed(3) : 'N/A'}
   - Best Ask: ${c.best_ask !== null ? c.best_ask.toFixed(3) : 'N/A'}
   - Spread: ${c.spread.toFixed(3)}`
  )
  .join('\n')}`;

  // Add BTC market data if available
  if (input.btcFeatures) {
    const btc = input.btcFeatures;
    prompt += `\n\nBTC Market Data:
- Current Price: ${btc.currentPrice !== null ? `$${btc.currentPrice.toFixed(2)}` : 'N/A'}
- 1h Change: ${btc.change1h !== null ? `${btc.change1h.toFixed(2)}%` : 'N/A'}
- 4h Change: ${btc.change4h !== null ? `${btc.change4h.toFixed(2)}%` : 'N/A'}
- 24h Change: ${btc.change24h !== null ? `${btc.change24h.toFixed(2)}%` : 'N/A'}
- 24h Volatility: ${btc.volatility24h !== null ? `${(btc.volatility24h * 100).toFixed(2)}%` : 'N/A'}
- Trend Slope: ${btc.trendSlope !== null ? `${btc.trendSlope.toFixed(2)} (price change per hour)` : 'N/A'}`;
  }

  // Add trade history if available
  if (input.tradeHistory) {
    const history = input.tradeHistory;
    prompt += `\n\nRecent Trading Performance (Last 24 Trades):
- Win Rate: ${(history.winRate * 100).toFixed(1)}%
- Average P&L: $${history.avgPnl.toFixed(2)}
- Average Entry Price: $${history.avgEntryPrice.toFixed(3)}
- Current Streak: ${history.currentStreak.type} (${history.currentStreak.count} trades)
- Top Markets: ${history.topMarkets.map((m) => `${m.ticker} (${m.count})`).join(', ')}`;

    if (history.recentTrades.length > 0) {
      prompt += `\n\nRecent Trades:
${history.recentTrades.slice(0, 10).map((t, i) => 
  `${i + 1}. ${t.side} ${t.market_ticker} @ $${t.entry_price.toFixed(3)} → ${t.exit_price !== null ? `$${t.exit_price.toFixed(3)}` : 'open'} (P&L: ${t.pnl !== null ? `$${t.pnl.toFixed(2)}` : 'N/A'})`
).join('\n')}`;
    }

    prompt += `\n\nConsider: What conditions are we losing in lately? What patterns emerge from recent wins vs losses?`;
  }

  prompt += `\n\nHard Constraints (MUST be respected):
- Entry price must be between ${input.constraints.entry_price_range[0]} and ${input.constraints.entry_price_range[1]}
- Stop loss price: ${input.constraints.stop_loss_price}
- Maximum spend remaining: $${input.constraints.max_spend_remaining.toFixed(2)}
- Only one market (current hour only)

Your Task:
Analyze the market conditions, BTC data, trading history, and available contracts. Provide a recommendation to either ENTER a trade or SKIP this opportunity.

Consider:
- How does current BTC momentum/trend align with the candidate trades?
- What patterns from recent trading history suggest about current market conditions?
- Are we in conditions where we've been losing recently?

If recommending ENTER:
- Specify the contract_id and side (YES or NO)
- Suggest an entry_limit_price within the allowed range [${input.constraints.entry_price_range[0]}, ${input.constraints.entry_price_range[1]}]
- Suggest dollars_to_spend (must not exceed remaining capital)
- Set stop_loss_price to ${input.constraints.stop_loss_price}
- Provide a clear rationale explaining your reasoning, including how BTC data and trade history influenced your decision
- Provide confidence level (0-1)

If recommending SKIP:
- Set action to "SKIP"
- Set stop_loss_price to ${input.constraints.stop_loss_price} (required field)
- Provide rationale explaining why to skip, including concerns about BTC conditions or recent trading patterns
- Provide confidence level (0-1)

Remember: Your recommendation will be validated against hard constraints. Invalid recommendations will be rejected.`;

  return prompt;
}

/**
 * Generate prompt for post-trade analysis.
 */
export function generatePostTradeAnalysisPrompt(input: PostTradeAnalysisInput): string {
  return `You are a post-trade analyst reviewing the results of a trading hour on Kalshi Bitcoin markets.

Hour Session Summary:
- Market hour: ${input.market_hour}
- Cash at start: $${input.cash_at_start.toFixed(2)}
- Cash at end: $${input.cash_at_end.toFixed(2)}
- Total P/L: $${input.total_pnl.toFixed(2)} (${((input.total_pnl / input.cash_at_start) * 100).toFixed(2)}%)

Trades Executed:
${input.trades_executed
  .map(
    (t, i) =>
      `${i + 1}. ${t.side} ${t.contract_id}
   - Entry: $${t.entry_price.toFixed(3)}
   - Exit: ${t.exit_price !== null ? `$${t.exit_price.toFixed(3)}` : 'N/A (open/settled)'}
   - Spent: $${t.dollars_spent.toFixed(2)}
   - P/L: $${t.pnl.toFixed(2)}
   - Status: ${t.status}`
  )
  .join('\n')}

Your Task:
Provide a structured analysis of this trading hour:
1. Summary: Brief overview of what happened
2. What worked: Identify successful aspects of the trading decisions
3. What didn't work: Identify areas for improvement
4. Suggestions: Actionable recommendations for future trading (informational only - code will enforce all rules)

Be specific and data-driven in your analysis.`;
}

