import { getSupabaseClient } from '../client.js';

export interface Order {
  id: string;
  hour_session_id: string;
  trade_plan_id: string | null;
  kalshi_order_id: string;
  contract_id: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  limit_price: number;
  size: number;
  dollars_spent: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  placed_at: Date;
  filled_at: Date | null;
}

export interface CreateOrderParams {
  hour_session_id: string;
  trade_plan_id?: string;
  kalshi_order_id: string;
  contract_id: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  limit_price: number;
  size: number;
  dollars_spent: number;
}

export interface UpdateOrderParams {
  status?: 'pending' | 'filled' | 'cancelled' | 'rejected';
  filled_at?: Date;
}

export class OrdersRepository {
  async create(params: CreateOrderParams): Promise<Order> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .insert({
        hour_session_id: params.hour_session_id,
        trade_plan_id: params.trade_plan_id || null,
        kalshi_order_id: params.kalshi_order_id,
        contract_id: params.contract_id,
        side: params.side,
        action: params.action,
        limit_price: params.limit_price,
        size: params.size,
        dollars_spent: params.dollars_spent,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToOrder(data);
  }

  async update(id: string, params: UpdateOrderParams): Promise<Order> {
    const supabase = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (params.status !== undefined) updateData.status = params.status;
    if (params.filled_at !== undefined) updateData.filled_at = params.filled_at.toISOString();

    const { data, error } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return this.mapToOrder(data);
  }

  async getByKalshiOrderId(kalshiOrderId: string): Promise<Order | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('kalshi_order_id', kalshiOrderId)
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapToOrder(data) : null;
  }

  async getByHourSession(hourSessionId: string): Promise<Order[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('hour_session_id', hourSessionId)
      .order('placed_at', { ascending: false });

    if (error) throw error;
    return data.map((d) => this.mapToOrder(d));
  }

  async getOpenOrders(hourSessionId: string): Promise<Order[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('hour_session_id', hourSessionId)
      .eq('status', 'pending')
      .order('placed_at', { ascending: false });

    if (error) throw error;
    return data.map((d) => this.mapToOrder(d));
  }

  private mapToOrder(data: Record<string, unknown>): Order {
    return {
      id: data.id as string,
      hour_session_id: data.hour_session_id as string,
      trade_plan_id: (data.trade_plan_id as string) || null,
      kalshi_order_id: data.kalshi_order_id as string,
      contract_id: data.contract_id as string,
      side: data.side as 'YES' | 'NO',
      action: data.action as 'BUY' | 'SELL',
      limit_price: Number(data.limit_price),
      size: Number(data.size),
      dollars_spent: Number(data.dollars_spent),
      status: data.status as 'pending' | 'filled' | 'cancelled' | 'rejected',
      placed_at: new Date(data.placed_at as string),
      filled_at: data.filled_at ? new Date(data.filled_at as string) : null,
    };
  }
}

