import OpenAI from 'openai';
import { getConfig } from '../config.js';
import { generatePostTradeAnalysisPrompt } from './prompts.js';
import { TradeAnalysisSchema, type PostTradeAnalysisInput, type TradeAnalysis } from './schemas.js';

/**
 * Post-trade analyst using OpenAI Responses API.
 * Analyzes trading results after each hour.
 */
export class PostTradeAnalyst {
  private openai: OpenAI;

  constructor() {
    const config = getConfig();
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL,
    });
  }

  /**
   * Get post-trade analysis from OpenAI.
   */
  async analyze(input: PostTradeAnalysisInput): Promise<TradeAnalysis> {
    const config = getConfig();
    const prompt = generatePostTradeAnalysisPrompt(input);

    try {
      const response = await this.openai.chat.completions.create({
        model: config.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a post-trade analyst. Provide structured analysis in JSON format matching the required schema.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trade_analysis',
            description: 'Post-trade analysis',
            schema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: 'Brief overview of what happened',
                },
                what_worked: {
                  type: 'string',
                  description: 'Successful aspects of trading decisions',
                },
                what_didnt_work: {
                  type: 'string',
                  description: 'Areas for improvement',
                },
                suggestions: {
                  type: 'string',
                  description: 'Actionable recommendations (informational only)',
                },
              },
              required: ['summary', 'what_worked', 'what_didnt_work', 'suggestions'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.5,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const parsed = JSON.parse(content);
      const validated = TradeAnalysisSchema.parse(parsed);

      return validated;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenAI post-trade analyst error: ${error.message}`);
      }
      throw error;
    }
  }
}

