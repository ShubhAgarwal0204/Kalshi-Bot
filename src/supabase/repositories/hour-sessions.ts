import { getSupabaseClient } from '../client.js';

export type HourSessionState =
  | 'IDLE'
  | 'WAIT_ENTRY_WINDOW'
  | 'IGNORE_EARLY'
  | 'SCAN_PLAN'
  | 'BUILD_CANDIDATES'
  | 'OPENAI_RECOMMENDATION'
  | 'VALIDATE_PLAN'
  | 'PLACING_BUY'
  | 'TRADE_ACTIVE'
  | 'IN_POSITION'
  | 'PLACING_SELL'
  | 'SELL_ONLY'
  | 'SKIP_HOUR_OBSERVE'
  | 'COOLDOWN'
  | 'DONE';

export interface HourSession {
  id: string;
  bot_run_id: string;
  market_hour: Date;
  state: HourSessionState;
  entry_window_start: Date;
  cash_at_start: number;
  cash_spent: number;
  max_spend_allowed: number;
  is_skip_hour: boolean;
  trades_count: number;
  realized_losses: number;
  cooldown_until: Date | null;
  size_multiplier: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHourSessionParams {
  bot_run_id: string;
  market_hour: Date;
  entry_window_start: Date;
  cash_at_start: number;
  max_spend_allowed: number;
  is_skip_hour?: boolean;
  size_multiplier?: number;
}

export interface UpdateHourSessionParams {
  state?: HourSessionState;
  cash_spent?: number;
  trades_count?: number;
  realized_losses?: number;
  cooldown_until?: Date | null;
  size_multiplier?: number;
  is_skip_hour?: boolean;
}

export class HourSessionsRepository {
  async create(params: CreateHourSessionParams): Promise<HourSession> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('hour_sessions')
      .insert({
        bot_run_id: params.bot_run_id,
        market_hour: params.market_hour.toISOString(),
        state: 'WAIT_ENTRY_WINDOW',
        entry_window_start: params.entry_window_start.toISOString(),
        cash_at_start: params.cash_at_start,
        cash_spent: 0,
        max_spend_allowed: params.max_spend_allowed,
        is_skip_hour: params.is_skip_hour || false,
        trades_count: 0,
        realized_losses: 0,
        size_multiplier: params.size_multiplier || 1.0,
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToHourSession(data);
  }

  async update(id: string, params: UpdateHourSessionParams): Promise<HourSession> {
    const supabase = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (params.state !== undefined) updateData.state = params.state;
    if (params.cash_spent !== undefined) updateData.cash_spent = params.cash_spent;
    if (params.trades_count !== undefined) updateData.trades_count = params.trades_count;
    if (params.realized_losses !== undefined) updateData.realized_losses = params.realized_losses;
    if (params.cooldown_until !== undefined) {
      updateData.cooldown_until = params.cooldown_until ? params.cooldown_until.toISOString() : null;
    }
    if (params.size_multiplier !== undefined) updateData.size_multiplier = params.size_multiplier;
    if (params.is_skip_hour !== undefined) updateData.is_skip_hour = params.is_skip_hour;

    const { data, error } = await supabase
      .from('hour_sessions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return this.mapToHourSession(data);
  }

  async getById(id: string): Promise<HourSession | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('hour_sessions').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return this.mapToHourSession(data);
  }

  async getActiveSessions(): Promise<HourSession[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('hour_sessions')
      .select('*')
      .neq('state', 'DONE')
      .order('market_hour', { ascending: true });

    if (error) throw error;
    return data.map((d) => this.mapToHourSession(d));
  }

  async getByMarketHour(marketHour: Date): Promise<HourSession | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('hour_sessions')
      .select('*')
      .eq('market_hour', marketHour.toISOString())
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapToHourSession(data) : null;
  }

  private mapToHourSession(data: Record<string, unknown>): HourSession {
    return {
      id: data.id as string,
      bot_run_id: data.bot_run_id as string,
      market_hour: new Date(data.market_hour as string),
      state: data.state as HourSessionState,
      entry_window_start: new Date(data.entry_window_start as string),
      cash_at_start: Number(data.cash_at_start),
      cash_spent: Number(data.cash_spent),
      max_spend_allowed: Number(data.max_spend_allowed),
      is_skip_hour: Boolean(data.is_skip_hour),
      trades_count: Number(data.trades_count || 0),
      realized_losses: Number(data.realized_losses || 0),
      cooldown_until: data.cooldown_until ? new Date(data.cooldown_until as string) : null,
      size_multiplier: Number(data.size_multiplier || 1.0),
      created_at: new Date(data.created_at as string),
      updated_at: new Date(data.updated_at as string),
    };
  }
}

