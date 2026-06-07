import crypto from 'crypto';
import { getConfig } from '../config.js';
import type {
  KalshiMarket,
  KalshiOrder,
  KalshiPortfolioBalance,
  CreateOrderParams,
} from './types.js';

/**
 * REST client for Kalshi API with RSA-PSS authentication.
 */
export class KalshiRESTClient {
  private apiKey: string;
  private privateKey: crypto.KeyObject;
  private baseUrl: string;

  constructor() {
    const config = getConfig();
    this.apiKey = config.KALSHI_API_KEY;
    this.baseUrl = config.KALSHI_API_BASE_URL;

    // Parse private key
    try {
      this.privateKey = crypto.createPrivateKey({
        key: config.KALSHI_PRIVATE_KEY,
        format: 'pem',
      });
    } catch (error) {
      throw new Error(`Invalid Kalshi private key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate authentication headers using RSA-PSS signing.
   * Follows official Kalshi JavaScript documentation exactly.
   */
  private generateAuthHeaders(method: string, fullPath: string): Record<string, string> {
    const timestamp = Date.now().toString();
    const pathWithoutQuery = fullPath.split('?')[0];
    const msgString = timestamp + method + pathWithoutQuery;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(msgString);
    sign.end();
    
    const signature = sign.sign({
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });

    return {
      'KALSHI-ACCESS-KEY': this.apiKey,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make authenticated request to Kalshi API.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Extract the base path from baseUrl (e.g., /trade-api/v2 from https://demo-api.kalshi.co/trade-api/v2)
    const baseUrlObj = new URL(this.baseUrl);
    const fullPath = `${baseUrlObj.pathname}${path}`;
    const headers = this.generateAuthHeaders(method, fullPath);

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get portfolio balance.
   */
  async getBalance(): Promise<KalshiPortfolioBalance> {
    const response = await this.request<{ balance: number; portfolio_value: number }>(
      'GET',
      '/portfolio/balance'
    );
    return { 
      balance: response.balance,
      available_balance: response.balance, 
      portfolio_value: response.portfolio_value 
    };
  }

  /**
   * Get markets (with optional filters).
   */
  async getMarkets(params?: {
    ticker?: string;
    series_ticker?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
    const queryParams = new URLSearchParams();
    if (params?.ticker) queryParams.append('ticker', params.ticker);
    if (params?.series_ticker) queryParams.append('series_ticker', params.series_ticker);
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.cursor) queryParams.append('cursor', params.cursor);

    const path = `/markets${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    return this.request<{ markets: KalshiMarket[]; cursor?: string }>('GET', path);
  }

  /**
   * Place an order.
   */
  async createOrder(params: CreateOrderParams): Promise<KalshiOrder> {
    const response = await this.request<{ order: KalshiOrder }>('POST', '/orders', {
      contract_id: params.contract_id,
      side: params.side,
      action: params.action,
      limit_price: params.limit_price,
      size: params.size,
    });
    return response.order;
  }

  /**
   * Get order by ID.
   */
  async getOrder(orderId: string): Promise<KalshiOrder> {
    const response = await this.request<{ order: KalshiOrder }>('GET', `/orders/${orderId}`);
    return response.order;
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/orders/${orderId}`);
  }

  /**
   * Get all orders (with optional filters).
   */
  async getOrders(params?: {
    contract_id?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ orders: KalshiOrder[]; cursor?: string }> {
    const queryParams = new URLSearchParams();
    if (params?.contract_id) queryParams.append('contract_id', params.contract_id);
    if (params?.status) queryParams.append('status', params.status);
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.cursor) queryParams.append('cursor', params.cursor);

    const path = `/orders${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    return this.request<{ orders: KalshiOrder[]; cursor?: string }>('GET', path);
  }
}
