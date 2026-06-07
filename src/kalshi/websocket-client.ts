import WebSocket from 'ws';
import crypto from 'crypto';
import { getConfig } from '../config.js';
import type {
  KalshiOrderBook,
  KalshiOrder,
  KalshiFill,
  KalshiWebSocketMessage,
} from './types.js';

export interface KalshiWebSocketEvents {
  orderBook: (orderBook: KalshiOrderBook) => void;
  orderUpdate: (order: KalshiOrder) => void;
  fill: (fill: KalshiFill) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * WebSocket client for Kalshi market data and order updates.
 */
export class KalshiWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionallyClosed: boolean = false;
  private eventHandlers: Partial<KalshiWebSocketEvents> = {};
  private subscribedContracts: Set<string> = new Set();
  private orderBookCache: Map<string, KalshiOrderBook> = new Map();

  /**
   * Register event handlers.
   */
  on<K extends keyof KalshiWebSocketEvents>(event: K, handler: KalshiWebSocketEvents[K]): void {
    this.eventHandlers[event] = handler;
  }

  /**
   * Generate authentication headers for WebSocket connection using RSA-PSS signing.
   * Follows official Kalshi JavaScript documentation exactly.
   */
  private generateAuthHeaders(): Record<string, string> {
    const config = getConfig();
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = '/trade-api/ws/v2';
    const msgString = timestamp + method + path;

    // Sign using the exact method from Kalshi's official JavaScript docs
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(msgString);
    sign.end();
    
    const signature = sign.sign({
      key: config.KALSHI_PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });

    return {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': config.KALSHI_API_KEY,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  }

  /**
   * Connect to Kalshi WebSocket with retry logic for transient errors.
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isIntentionallyClosed = false;
    const config = getConfig();
    const maxRetries = 5;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        await this.attemptConnection(config.KALSHI_WS_URL);
        return; // Connection successful
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('503') && retryCount < maxRetries - 1) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
          console.log(`WebSocket 503 error, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Attempt a single WebSocket connection.
   */
  private attemptConnection(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        // Generate authentication headers
        const authHeaders = this.generateAuthHeaders();
        
        const ws = new WebSocket(wsUrl, {
          headers: authHeaders,
        });
        let connectionTimeout: NodeJS.Timeout;

        ws.on('open', () => {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.ws = ws;
          this.eventHandlers.connected?.();

          // Re-subscribe to previously subscribed contracts
          for (const contractId of this.subscribedContracts) {
            this.subscribeToOrderBook(contractId);
          }

          resolve();
        });

        ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString()) as KalshiWebSocketMessage;
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        });

        ws.on('error', (error: Error) => {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          this.eventHandlers.error?.(error);
          if (!this.isIntentionallyClosed) {
            this.scheduleReconnect();
          }
          // Only reject if we haven't resolved yet (connection failed before opening)
          if (this.ws !== ws) {
            reject(error);
          }
        });

        ws.on('close', () => {
          this.ws = null;
          this.eventHandlers.disconnected?.();
          if (!this.isIntentionallyClosed) {
            this.scheduleReconnect();
          }
        });

        // Set a timeout for connection (10 seconds)
        connectionTimeout = setTimeout(() => {
          if (this.ws !== ws) {
            ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventHandlers.error?.(err);
        this.scheduleReconnect();
        reject(err);
      }
    });
  }

  /**
   * Subscribe to order book updates for a contract.
   */
  subscribeToOrderBook(contractId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subscribedContracts.add(contractId);
      return;
    }

    // Send subscription message (format depends on Kalshi WS API)
    // Example structure:
    this.ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel: 'orderbook',
        contract_id: contractId,
      })
    );

    this.subscribedContracts.add(contractId);
  }

  /**
   * Unsubscribe from order book updates for a contract.
   */
  unsubscribeFromOrderBook(contractId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subscribedContracts.delete(contractId);
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: 'unsubscribe',
        channel: 'orderbook',
        contract_id: contractId,
      })
    );

    this.subscribedContracts.delete(contractId);
    this.orderBookCache.delete(contractId);
  }

  /**
   * Get cached order book for a contract.
   */
  getOrderBook(contractId: string): KalshiOrderBook | null {
    return this.orderBookCache.get(contractId) || null;
  }

  /**
   * Get best bid/ask for a contract.
   */
  getBestBidAsk(contractId: string, side: 'YES' | 'NO'): { bid: number | null; ask: number | null } {
    const orderBook = this.orderBookCache.get(contractId);
    if (!orderBook) {
      return { bid: null, ask: null };
    }

    if (side === 'YES') {
      const bestBid = orderBook.yes_bids.length > 0 ? orderBook.yes_bids[0].price : null;
      const bestAsk = orderBook.yes_asks.length > 0 ? orderBook.yes_asks[0].price : null;
      return { bid: bestBid, ask: bestAsk };
    } else {
      const bestBid = orderBook.no_bids.length > 0 ? orderBook.no_bids[0].price : null;
      const bestAsk = orderBook.no_asks.length > 0 ? orderBook.no_asks[0].price : null;
      return { bid: bestBid, ask: bestAsk };
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private handleMessage(message: KalshiWebSocketMessage): void {
    switch (message.type) {
      case 'orderbook':
        this.handleOrderBookUpdate(message.data as KalshiOrderBook);
        break;
      case 'order':
        this.handleOrderUpdate(message.data as KalshiOrder);
        break;
      case 'fill':
        this.handleFill(message.data as KalshiFill);
        break;
      default:
        // Unknown message type, ignore
        break;
    }
  }

  private handleOrderBookUpdate(orderBook: KalshiOrderBook): void {
    this.orderBookCache.set(orderBook.contract_id, orderBook);
    this.eventHandlers.orderBook?.(orderBook);
  }

  private handleOrderUpdate(order: KalshiOrder): void {
    this.eventHandlers.orderUpdate?.(order);
  }

  private handleFill(fill: KalshiFill): void {
    this.eventHandlers.fill?.(fill);
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isIntentionallyClosed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      console.log(`Reconnecting Kalshi WebSocket (attempt ${this.reconnectAttempts})...`);
      this.connect().catch((error) => {
        console.error('Reconnection failed:', error);
      });
    }, this.reconnectDelay);
  }

  /**
   * Disconnect from WebSocket.
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedContracts.clear();
    this.orderBookCache.clear();
  }

  /**
   * Check if WebSocket is connected.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

