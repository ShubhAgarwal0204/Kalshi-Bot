import { getSupabaseClient } from '../client.js';

export interface ShadowTrade {
  id: string;
  hour_session_id: string;
  plan_type: 'A' | 'B';
  contract_id: string;
  side: 'YES' | 'NO';
  entry_price: number;
  openai_response: Record<string, unknown>;
  would_have_pnl: number | null;
  actual_settlement_price: number | null;
  created_at: Date;
}

export interface CreateShadowTradeParams {
  hour_session_id: string;
  plan_type: 'A' | 'B';
  contract_id: string;
  side: 'YES' | 'NO';
  entry_price: number;
  openai_response: Record<string, unknown>;
  would_have_pnl?: number | null;
  actual_settlement_price?: number | null;
}

export interface UpdateShadowTradeParams {
  would_have_pnl?: number | null;
  actual_settlement_price?: number | null;
}

export class ShadowTradesRepository {
  async create(params: CreateShadowTradeParams): Promise<ShadowTrade> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('shadow_trades')
      .insert({
        hour_session_id: params.hour_session_id,
        plan_type: params.plan_type,
        contract_id: params.contract_id,
        side: params.side,
        entry_price: params.entry_price,
        openai_response: params.openai_response,
        would_have_pnl: params.would_have_pnl || null,
        actual_settlement_price: params.actual_settlement_price || null,
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToShadowTrade(data);
  }

  async update(id: string, params: UpdateShadowTradeParams): Promise<ShadowTrade> {
    const supabase = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (params.would_have_pnl !== undefined) updateData.would_have_pnl = params.would_have_pnl;
    if (params.actual_settlement_price !== undefined) updateData.actual_settlement_price = params.actual_settlement_price;

    const { data, error } = await supabase
      .from('shadow_trades')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return this.mapToShadowTrade(data);
  }

  async getByHourSession(hourSessionId: string): Promise<ShadowTrade[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('shadow_trades')
      .select('*')
      .eq('hour_session_id', hourSessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data.map((d) => this.mapToShadowTrade(d));
  }

  private mapToShadowTrade(data: Record<string, unknown>): ShadowTrade {
    return {
      id: data.id as string,
      hour_session_id: data.hour_session_id as string,
      plan_type: data.plan_type as 'A' | 'B',
      contract_id: data.contract_id as string,
      side: data.side as 'YES' | 'NO',
      entry_price: Number(data.entry_price),
      openai_response: data.openai_response as Record<string, unknown>,
      would_have_pnl: data.would_have_pnl ? Number(data.would_have_pnl) : null,
      actual_settlement_price: data.actual_settlement_price ? Number(data.actual_settlement_price) : null,
      created_at: new Date(data.created_at as string),
    };
  }
}

