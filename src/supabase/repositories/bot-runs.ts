import { getSupabaseClient } from '../client.js';

export interface BotRun {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  status: 'running' | 'stopped' | 'error';
  initial_cash: number;
  final_cash: number | null;
  consecutive_losing_hours: number;
}

export interface CreateBotRunParams {
  initial_cash: number;
}

export interface UpdateBotRunParams {
  ended_at?: Date;
  status?: 'running' | 'stopped' | 'error';
  final_cash?: number;
  consecutive_losing_hours?: number;
}

export class BotRunsRepository {
  async create(params: CreateBotRunParams): Promise<BotRun> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('bot_runs')
      .insert({
        status: 'running',
        initial_cash: params.initial_cash,
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToBotRun(data);
  }

  async update(id: string, params: UpdateBotRunParams): Promise<BotRun> {
    const supabase = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (params.ended_at !== undefined) updateData.ended_at = params.ended_at.toISOString();
    if (params.status !== undefined) updateData.status = params.status;
    if (params.final_cash !== undefined) updateData.final_cash = params.final_cash;
    if (params.consecutive_losing_hours !== undefined) updateData.consecutive_losing_hours = params.consecutive_losing_hours;

    const { data, error } = await supabase
      .from('bot_runs')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return this.mapToBotRun(data);
  }

  async getById(id: string): Promise<BotRun | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('bot_runs').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return this.mapToBotRun(data);
  }

  async getActiveRun(): Promise<BotRun | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('bot_runs')
      .select('*')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapToBotRun(data) : null;
  }

  private mapToBotRun(data: Record<string, unknown>): BotRun {
    return {
      id: data.id as string,
      started_at: new Date(data.started_at as string),
      ended_at: data.ended_at ? new Date(data.ended_at as string) : null,
      status: data.status as 'running' | 'stopped' | 'error',
      initial_cash: Number(data.initial_cash),
      final_cash: data.final_cash ? Number(data.final_cash) : null,
      consecutive_losing_hours: Number(data.consecutive_losing_hours || 0),
    };
  }
}

