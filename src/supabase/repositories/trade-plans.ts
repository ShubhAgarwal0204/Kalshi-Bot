import { getSupabaseClient } from '../client.js';

export interface TradePlan {
  id: string;
  hour_session_id: string;
  openai_response: Record<string, unknown>;
  action: 'ENTER' | 'SKIP';
  side: 'YES' | 'NO' | null;
  contract_id: string | null;
  entry_limit_price: number | null;
  dollars_to_spend: number | null;
  stop_loss_price: number;
  rationale: string;
  confidence: number;
  validation_status: 'pending' | 'valid' | 'rejected';
  validation_errors: Record<string, unknown> | null;
  plan_type: 'A' | 'B' | null;
  created_at: Date;
}

export interface CreateTradePlanParams {
  hour_session_id: string;
  openai_response: Record<string, unknown>;
  action: 'ENTER' | 'SKIP';
  side?: 'YES' | 'NO';
  contract_id?: string;
  entry_limit_price?: number;
  dollars_to_spend?: number;
  stop_loss_price: number;
  rationale: string;
  confidence: number;
  plan_type?: 'A' | 'B';
}

export interface UpdateTradePlanParams {
  validation_status?: 'pending' | 'valid' | 'rejected';
  validation_errors?: Record<string, unknown>;
}

export class TradePlansRepository {
  async create(params: CreateTradePlanParams): Promise<TradePlan> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trade_plans')
      .insert({
        hour_session_id: params.hour_session_id,
        openai_response: params.openai_response,
        action: params.action,
        side: params.side || null,
        contract_id: params.contract_id || null,
        entry_limit_price: params.entry_limit_price || null,
        dollars_to_spend: params.dollars_to_spend || null,
        stop_loss_price: params.stop_loss_price,
        rationale: params.rationale,
        confidence: params.confidence,
        plan_type: params.plan_type || null,
        validation_status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToTradePlan(data);
  }

  async update(id: string, params: UpdateTradePlanParams): Promise<TradePlan> {
    const supabase = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (params.validation_status !== undefined) updateData.validation_status = params.validation_status;
    if (params.validation_errors !== undefined) updateData.validation_errors = params.validation_errors;

    const { data, error } = await supabase
      .from('trade_plans')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return this.mapToTradePlan(data);
  }

  async getById(id: string): Promise<TradePlan | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('trade_plans').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return this.mapToTradePlan(data);
  }

  async getByHourSession(hourSessionId: string): Promise<TradePlan[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trade_plans')
      .select('*')
      .eq('hour_session_id', hourSessionId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data.map((d) => this.mapToTradePlan(d));
  }

  private mapToTradePlan(data: Record<string, unknown>): TradePlan {
    return {
      id: data.id as string,
      hour_session_id: data.hour_session_id as string,
      openai_response: data.openai_response as Record<string, unknown>,
      action: data.action as 'ENTER' | 'SKIP',
      side: (data.side as 'YES' | 'NO' | null) || null,
      contract_id: (data.contract_id as string) || null,
      entry_limit_price: data.entry_limit_price ? Number(data.entry_limit_price) : null,
      dollars_to_spend: data.dollars_to_spend ? Number(data.dollars_to_spend) : null,
      stop_loss_price: Number(data.stop_loss_price),
      rationale: data.rationale as string,
      confidence: Number(data.confidence),
      validation_status: data.validation_status as 'pending' | 'valid' | 'rejected',
      validation_errors: (data.validation_errors as Record<string, unknown>) || null,
      plan_type: (data.plan_type as 'A' | 'B' | null) || null,
      created_at: new Date(data.created_at as string),
    };
  }
}

