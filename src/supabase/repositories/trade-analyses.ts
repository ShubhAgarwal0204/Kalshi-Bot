import { getSupabaseClient } from '../client.js';

export interface TradeAnalysis {
  id: string;
  hour_session_id: string;
  openai_analysis: Record<string, unknown>;
  summary: string;
  what_worked: string;
  what_didnt_work: string;
  suggestions: string;
  created_at: Date;
}

export interface CreateTradeAnalysisParams {
  hour_session_id: string;
  openai_analysis: Record<string, unknown>;
  summary: string;
  what_worked: string;
  what_didnt_work: string;
  suggestions: string;
}

export class TradeAnalysesRepository {
  async create(params: CreateTradeAnalysisParams): Promise<TradeAnalysis> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trade_analyses')
      .insert({
        hour_session_id: params.hour_session_id,
        openai_analysis: params.openai_analysis,
        summary: params.summary,
        what_worked: params.what_worked,
        what_didnt_work: params.what_didnt_work,
        suggestions: params.suggestions,
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToTradeAnalysis(data);
  }

  async getByHourSession(hourSessionId: string): Promise<TradeAnalysis | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('trade_analyses')
      .select('*')
      .eq('hour_session_id', hourSessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapToTradeAnalysis(data) : null;
  }

  private mapToTradeAnalysis(data: Record<string, unknown>): TradeAnalysis {
    return {
      id: data.id as string,
      hour_session_id: data.hour_session_id as string,
      openai_analysis: data.openai_analysis as Record<string, unknown>,
      summary: data.summary as string,
      what_worked: data.what_worked as string,
      what_didnt_work: data.what_didnt_work as string,
      suggestions: data.suggestions as string,
      created_at: new Date(data.created_at as string),
    };
  }
}

