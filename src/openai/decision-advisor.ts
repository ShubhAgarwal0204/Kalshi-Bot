import OpenAI from 'openai';
import { getConfig } from '../config.js';
import { generateDecisionAdvisorPrompt } from './prompts.js';
import { TradePlanSchema, type DecisionAdvisorInput, type TradePlan } from './schemas.js';

/**
 * Decision advisor using OpenAI Responses API.
 * Provides trade recommendations during the entry window.
 */
export class DecisionAdvisor {
  private openai: OpenAI;

  constructor() {
    const config = getConfig();
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL,
    });
  }

  /**
   * Get trade recommendation from OpenAI.
   */
  async getRecommendation(input: DecisionAdvisorInput): Promise<TradePlan> {
    const config = getConfig();
    const prompt = generateDecisionAdvisorPrompt(input);

    try {
      // Use Responses API (structured outputs)
      const response = await this.openai.chat.completions.create({
        model: config.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a trading advisor. Provide recommendations in JSON format matching the required schema. All recommendations must respect hard constraints.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trade_plan',
            description: 'Trade plan recommendation',
            schema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['ENTER', 'SKIP'],
                  description: 'Action to take',
                },
                side: {
                  type: 'string',
                  enum: ['YES', 'NO'],
                  description: 'Contract side (required if action is ENTER)',
                },
                contract_id: {
                  type: 'string',
                  description: 'Contract ID (required if action is ENTER)',
                },
                entry_limit_price: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Entry limit price (required if action is ENTER)',
                },
                dollars_to_spend: {
                  type: 'number',
                  minimum: 0,
                  description: 'Dollars to spend (required if action is ENTER)',
                },
                stop_loss_price: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Stop loss price (always required)',
                },
                rationale: {
                  type: 'string',
                  description: 'Explanation of the recommendation',
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Confidence level (0-1)',
                },
              },
              required: ['action', 'stop_loss_price', 'rationale', 'confidence'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.3, // Lower temperature for more consistent outputs
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const parsed = JSON.parse(content);
      const validated = TradePlanSchema.parse(parsed);

      return validated;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI decision advisor error: ${error.message}`);
      }
      throw error;
    }
  }
}

