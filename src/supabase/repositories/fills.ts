import { getSupabaseClient } from '../client.js';

export interface Fill {
  id: string;
  order_id: string;
  kalshi_fill_id: string;
  price: number;
  size: number;
  filled_at: Date;
}

export interface CreateFillParams {
  order_id: string;
  kalshi_fill_id: string;
  price: number;
  size: number;
  filled_at: Date;
}

export class FillsRepository {
  async create(params: CreateFillParams): Promise<Fill> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fills')
      .insert({
        order_id: params.order_id,
        kalshi_fill_id: params.kalshi_fill_id,
        price: params.price,
        size: params.size,
        filled_at: params.filled_at.toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return this.mapToFill(data);
  }

  async createBatch(params: CreateFillParams[]): Promise<Fill[]> {
    const supabase = getSupabaseClient();
    const inserts = params.map((p) => ({
      order_id: p.order_id,
      kalshi_fill_id: p.kalshi_fill_id,
      price: p.price,
      size: p.size,
      filled_at: p.filled_at.toISOString(),
    }));

    const { data, error } = await supabase.from('fills').insert(inserts).select();

    if (error) throw error;
    return data.map((d) => this.mapToFill(d));
  }

  async getByOrderId(orderId: string): Promise<Fill[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fills')
      .select('*')
      .eq('order_id', orderId)
      .order('filled_at', { ascending: true });

    if (error) throw error;
    return data.map((d) => this.mapToFill(d));
  }

  async getByKalshiFillId(kalshiFillId: string): Promise<Fill | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fills')
      .select('*')
      .eq('kalshi_fill_id', kalshiFillId)
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapToFill(data) : null;
  }

  private mapToFill(data: Record<string, unknown>): Fill {
    return {
      id: data.id as string,
      order_id: data.order_id as string,
      kalshi_fill_id: data.kalshi_fill_id as string,
      price: Number(data.price),
      size: Number(data.size),
      filled_at: new Date(data.filled_at as string),
    };
  }
}

