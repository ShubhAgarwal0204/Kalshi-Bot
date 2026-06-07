# Environment Variables Setup

Create a `.env` file in the project root with the following variables:

```bash
# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1

# Kalshi
KALSHI_API_KEY=your_kalshi_api_key
KALSHI_PRIVATE_KEY=your_rsa_private_key_pem_format
KALSHI_API_BASE_URL=https://trading-api.kalshi.com
KALSHI_WS_URL=wss://ws-api.kalshi.com/trade-api/v2/ws

# Kraken (for BTC market data)
KRAKEN_WS_URL=wss://ws.kraken.com/v2
KRAKEN_REST_URL=https://api.kraken.com/0/public

# Trading Configuration
TRADING_START_HOUR=8
TRADING_END_HOUR=24
ENTRY_WINDOW_MINUTES=20
ENTRY_PRICE_MIN=0.80
ENTRY_PRICE_MAX=0.90
STOP_LOSS_PRICE=0.70
TAKE_PROFIT_PRICE=0.96
HOURLY_CAP_PERCENT=25
HOURLY_LOSS_CAP_PERCENT=15
MAX_TRADES_PER_HOUR=3
STOP_LOSS_COOLDOWN_SECONDS=45

# Risk Limits
MAX_POSITION_SIZE=1000
MIN_CASH_RESERVE=100
```

## Getting Credentials

### Supabase
1. Create a project at https://supabase.com
2. Go to Project Settings > API
3. Copy the Project URL and Service Role Key

### Kalshi
1. Log in to your Kalshi account
2. Go to API Settings
3. Generate API key and RSA private key
4. Save the private key in PEM format

**Important for Private Key in .env:**
- The private key must be properly formatted with newlines
- Option 1: Use escaped newlines: `KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"`
- Option 2: Use a multi-line string (some .env parsers support this)
- The key should have proper line breaks (64 characters per line in the base64 section)
- Make sure there are no extra spaces or characters

### OpenAI
1. Get API key from https://platform.openai.com/api-keys
2. Choose appropriate model (gpt-4o-mini recommended for cost efficiency)

## Security Notes

- Never commit `.env` file to version control
- Use service role key for Supabase (server-side only)
- Keep RSA private key secure
- Rotate API keys regularly

