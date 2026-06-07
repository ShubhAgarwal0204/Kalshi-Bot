import OpenAI from 'openai';
import { getConfig } from '../config.js';
import type { CandidateTrade, EvalResult, BTCFeatures, TradeStats, Candle } from './types.js';

/**
 * OpenAI judge for evaluating candidate trades based on BTC data and trade history.
 */
export class OpenAIJudge {
  private openai: OpenAI;
  private lastCallTime: number = 0;
  private readonly minCallInterval = 1000; // Minimum 1 second between calls

  constructor() {
    const config = getConfig();
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL,
    });
  }

  /**
   * Evaluate a candidate trade using OpenAI.
   */
  async evaluate(
    candidate: CandidateTrade,
    btcFeatures: BTCFeatures,
    tradeStats: TradeStats,
    candles24h: Candle[],
    candles7d: Candle[],
    candles30d: Candle[]
  ): Promise<EvalResult> {
    // Rate limiting
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    if (timeSinceLastCall < this.minCallInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minCallInterval - timeSinceLastCall));
    }
    this.lastCallTime = Date.now();

    const config = getConfig();
    const prompt = this.generatePrompt(candidate, btcFeatures, tradeStats, candles24h, candles7d, candles30d);

    try {
      // Use Promise.race for timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('OpenAI API timeout')), 30000); // 30s timeout
      });

      const apiCall = this.openai.chat.completions.create({
        model: config.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a conservative risk assistant for an automated trading bot. Your role is to evaluate candidate trades based on BTC market conditions and past trading performance. You must be cautious and prioritize capital preservation. Output must be strict JSON matching the required schema.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'eval_result',
            description: 'Trade evaluation result',
            schema: {
              type: 'object',
              properties: {
                verdict: {
                  type: 'string',
                  enum: ['GOOD', 'BAD', 'UNCLEAR'],
                  description: 'Overall verdict on the trade',
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Confidence level in the evaluation (0-1)',
                },
                reasons: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of reasons supporting the verdict',
                },
                risk_flags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of risk factors or concerns',
                },
                suggested_action: {
                  type: 'string',
                  enum: ['PROCEED', 'SKIP', 'REDUCE_SIZE', 'WAIT'],
                  description: 'Recommended action',
                },
                notes_for_logs: {
                  type: 'string',
                  description: 'Optional notes for logging purposes',
                },
              },
              required: ['verdict', 'confidence', 'reasons', 'risk_flags', 'suggested_action'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.3, // Lower temperature for more consistent outputs
      });

      const response = await Promise.race([apiCall, timeoutPromise]);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const parsed = this.parseJSONResponse(content);
      return this.validateEvalResult(parsed);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('OpenAI API timeout');
      }
      throw new Error(`OpenAI judge error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate prompt for OpenAI evaluation.
   */
  private generatePrompt(
    candidate: CandidateTrade,
    btcFeatures: BTCFeatures,
    tradeStats: TradeStats,
    candles24h: Candle[],
    candles7d: Candle[],
    candles30d: Candle[]
  ): string {
    // Summarize candles (don't dump all 720 points)
    const summarizeCandles = (candles: Candle[], label: string): string => {
      if (candles.length === 0) return `${label}: No data available`;
      const closes = candles.map((c) => c.c);
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const last24 = candles.slice(-24);
      const last24Closes = last24.map((c) => c.c);
      return `${label}:
- Total candles: ${candles.length}
- Price range: $${min.toFixed(2)} - $${max.toFixed(2)}
- Last 24 closes: ${last24Closes.map((c) => c.toFixed(2)).join(', ')}`;
    };

    return `Evaluate this candidate trade based on BTC market conditions and past trading performance.

Candidate Trade:
- Market ticker: ${candidate.market_ticker}
- Side: ${candidate.side}
- Intended entry price: ${candidate.intended_entry_price?.toFixed(3) || 'N/A'}
- Size: ${candidate.size}
- Metadata: ${JSON.stringify(candidate.metadata || {})}

BTC Market Features:
- Current price: $${btcFeatures.current_price.toFixed(2)}
- 1h change: ${btcFeatures.change_1h_pct.toFixed(2)}%
- 4h change: ${btcFeatures.change_4h_pct.toFixed(2)}%
- 24h change: ${btcFeatures.change_24h_pct.toFixed(2)}%
- 24h volatility: ${btcFeatures.volatility_24h.toFixed(4)}
- Trend slope (last 12h): ${btcFeatures.trend_slope.toFixed(4)}

Past Trading Performance (last 24 trades):
- Win rate: ${(tradeStats.win_rate * 100).toFixed(1)}%
- Average PnL: $${tradeStats.avg_pnl.toFixed(2)}
- Average entry price: $${tradeStats.avg_entry_price.toFixed(3)}
- Top markets: ${tradeStats.top_markets.map((m) => `${m.ticker} (${m.count})`).join(', ')}
- Current streak: ${tradeStats.current_streak.type} (${tradeStats.current_streak.count})
- BTC correlation: ${tradeStats.btc_correlation.toFixed(3)}

BTC Price History:
${summarizeCandles(candles24h, '24h')}
${summarizeCandles(candles7d, '7d')}
${summarizeCandles(candles30d, '30d')}

Your Task:
Analyze this candidate trade considering:
1. Current BTC price movement and volatility
2. Recent trading performance and win rate
3. Correlation between past trades and BTC direction
4. Current market conditions and trends

Provide a conservative evaluation with:
- verdict: "GOOD" if conditions are favorable, "BAD" if risky, "UNCLEAR" if insufficient data
- confidence: 0-1 scale
- reasons: List key factors supporting your verdict
- risk_flags: List any concerns or red flags
- suggested_action: "PROCEED", "SKIP", "REDUCE_SIZE", or "WAIT"
- notes_for_logs: Optional context for logging

Be conservative - prioritize capital preservation over potential gains.`;
  }

  /**
   * Parse JSON response, handling cases where model returns non-JSON.
   */
  private parseJSONResponse(content: string): any {
    // Try direct JSON parse first
    try {
      return JSON.parse(content);
    } catch {
      // Try to extract JSON block
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          // Fall through to error
        }
      }
      throw new Error('Failed to parse JSON from OpenAI response');
    }
  }

  /**
   * Validate and normalize EvalResult.
   */
  private validateEvalResult(parsed: any): EvalResult {
    // Basic validation
    if (!parsed.verdict || !['GOOD', 'BAD', 'UNCLEAR'].includes(parsed.verdict)) {
      throw new Error('Invalid verdict in OpenAI response');
    }
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
      throw new Error('Invalid confidence in OpenAI response');
    }
    if (!Array.isArray(parsed.reasons)) {
      throw new Error('Invalid reasons in OpenAI response');
    }
    if (!Array.isArray(parsed.risk_flags)) {
      throw new Error('Invalid risk_flags in OpenAI response');
    }
    if (!parsed.suggested_action || !['PROCEED', 'SKIP', 'REDUCE_SIZE', 'WAIT'].includes(parsed.suggested_action)) {
      throw new Error('Invalid suggested_action in OpenAI response');
    }

    return {
      verdict: parsed.verdict as 'GOOD' | 'BAD' | 'UNCLEAR',
      confidence: parsed.confidence,
      reasons: parsed.reasons,
      risk_flags: parsed.risk_flags,
      suggested_action: parsed.suggested_action as 'PROCEED' | 'SKIP' | 'REDUCE_SIZE' | 'WAIT',
      notes_for_logs: parsed.notes_for_logs,
    };
  }
}

