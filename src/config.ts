import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  // Kalshi
  KALSHI_API_KEY: z.string().min(1),
  KALSHI_PRIVATE_KEY: z.string().min(1),
  KALSHI_API_BASE_URL: z.string().url().default('https://demo-api.kalshi.co/trade-api/v2'),
  KALSHI_WS_URL: z.string().url().default('wss://demo-api.kalshi.co/trade-api/ws/v2'),

  // Kraken
  KRAKEN_WS_URL: z.string().url().default('wss://ws.kraken.com/v2'),
  KRAKEN_REST_URL: z.string().url().default('https://api.kraken.com/0/public'),

  // Trading Configuration
  TRADING_START_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  TRADING_END_HOUR: z.coerce.number().int().min(0).max(24).default(24),
  ENTRY_WINDOW_MINUTES: z.coerce.number().int().positive().default(20),
  ENTRY_PRICE_MIN: z.coerce.number().min(0).max(1).default(0.80),
  ENTRY_PRICE_MAX: z.coerce.number().min(0).max(1).default(0.90),
  STOP_LOSS_PRICE: z.coerce.number().min(0).max(1).default(0.70),
  TAKE_PROFIT_PRICE: z.coerce.number().min(0).max(1).default(0.96),
  HOURLY_CAP_PERCENT: z.coerce.number().min(0).max(100).default(25),
  HOURLY_LOSS_CAP_PERCENT: z.coerce.number().min(0).max(100).default(15),
  MAX_TRADES_PER_HOUR: z.coerce.number().int().positive().default(3),
  STOP_LOSS_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(45),

  // Risk Limits
  MAX_POSITION_SIZE: z.coerce.number().positive().default(1000),
  MIN_CASH_RESERVE: z.coerce.number().nonnegative().default(100),
});

export type Config = z.infer<typeof configSchema>;

let config: Config | null = null;

export function getConfig(): Config {
  if (config) {
    return config;
  }

  const rawEnv = process.env;
  const result = configSchema.safeParse(rawEnv);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  config = result.data;
  return config;
}

