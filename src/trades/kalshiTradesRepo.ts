import { getSupabaseClient } from '../supabase/client.js';
import type { KalshiTrade } from '../analysis/types.js';

/**
 * Repository for accessing Kalshi trades from Supabase.
 */
export class KalshiTradesRepository {
  /**
   * Get last N trades ordered by created_at DESC.
   */
  async getLastTrades(limit: number = 24): Promise<KalshiTrade[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('kalshi_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch Kalshi trades: ${error.message}`);
    }

    return (data || []).map((d) => this.mapToKalshiTrade(d));
  }

  /**
   * Map database record to KalshiTrade interface.
   */
  private mapToKalshiTrade(data: Record<string, unknown>): KalshiTrade {
    return {
      id: data.id as string,
      created_at: new Date(data.created_at as string),
      market_ticker: data.market_ticker as string,
      side: data.side as string,
      entry_price: Number(data.entry_price),
      size: Number(data.size),
      status: data.status as 'WON' | 'LOST' | 'OPEN' | 'CANCELLED' | 'SETTLED',
      exit_price: data.exit_price !== null ? Number(data.exit_price) : null,
      pnl: data.pnl !== null ? Number(data.pnl) : null,
      metadata: (data.metadata as Record<string, any>) || null,
    };
  }
}

