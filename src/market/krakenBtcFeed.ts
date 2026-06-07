import WebSocket from 'ws';
import { getConfig } from '../config.js';

/**
 * Tick data from Kraken WebSocket.
 */
export interface KrakenTick {
  price: number;
  timestamp: number; // Unix timestamp in milliseconds
}

/**
 * Event handlers for Kraken BTC feed.
 */
export interface KrakenBTCFeedEvents {
  priceUpdate: (price: number) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * WebSocket client for Kraken BTC/USD ticker feed.
 * Maintains current price and rolling buffer of recent ticks.
 */
export class KrakenBTCFeed {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionallyClosed: boolean = false;
  private eventHandlers: Partial<KrakenBTCFeedEvents> = {};
  
  private currentPrice: number | null = null;
  private tickBuffer: KrakenTick[] = [];
  private readonly maxBufferSize = 300; // Last 300 ticks

  /**
   * Register event handlers.
   */
  on<K extends keyof KrakenBTCFeedEvents>(event: K, handler: KrakenBTCFeedEvents[K]): void {
    this.eventHandlers[event] = handler;
  }

  /**
   * Connect to Kraken WebSocket and subscribe to BTC/USD ticker.
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isIntentionallyClosed = false;
    const config = getConfig();

    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(config.KRAKEN_WS_URL);
        let connectionTimeout: NodeJS.Timeout;

        ws.on('open', () => {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.ws = ws;
          
          // Subscribe to BTC/USD ticker
          ws.send(
            JSON.stringify({
              method: 'subscribe',
              params: {
                channel: 'ticker',
                symbol: 'XBT/USD',
              },
            })
          );

          this.eventHandlers.connected?.();
          resolve();
        });

        ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing Kraken WebSocket message:', error);
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
            reject(new Error('Kraken WebSocket connection timeout'));
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
   * Handle incoming WebSocket messages.
   */
  private handleMessage(message: any): void {
    // Kraken WebSocket v2 ticker format
    // Message structure: { channel: 'ticker', data: [...] }
    if (message.channel === 'ticker' && message.data) {
      const tickerData = Array.isArray(message.data) ? message.data[0] : message.data;
      
      // Extract last price from ticker data
      // Kraken ticker format: [channelID, { a: [ask], b: [bid], c: [last trade], ... }]
      if (tickerData && typeof tickerData === 'object') {
        // Try to get last trade price from 'c' field (last trade closed)
        const lastTrade = tickerData.c;
        if (Array.isArray(lastTrade) && lastTrade.length > 0) {
          const price = parseFloat(lastTrade[0]);
          if (!isNaN(price) && price > 0) {
            this.updatePrice(price);
          }
        }
        // Fallback to mid price if last trade not available
        else if (tickerData.a && tickerData.b) {
          const ask = parseFloat(Array.isArray(tickerData.a) ? tickerData.a[0] : tickerData.a);
          const bid = parseFloat(Array.isArray(tickerData.b) ? tickerData.b[0] : tickerData.b);
          if (!isNaN(ask) && !isNaN(bid) && ask > 0 && bid > 0) {
            const midPrice = (ask + bid) / 2;
            this.updatePrice(midPrice);
          }
        }
      }
    }
  }

  /**
   * Update current price and tick buffer.
   */
  private updatePrice(price: number): void {
    const now = Date.now();
    this.currentPrice = price;
    
    // Add to buffer
    this.tickBuffer.push({
      price,
      timestamp: now,
    });

    // Maintain buffer size
    if (this.tickBuffer.length > this.maxBufferSize) {
      this.tickBuffer.shift();
    }

    this.eventHandlers.priceUpdate?.(price);
  }

  /**
   * Get current BTC price.
   */
  getCurrentPrice(): number | null {
    return this.currentPrice;
  }

  /**
   * Get recent ticks from buffer.
   */
  getRecentTicks(limit: number = 300): KrakenTick[] {
    return this.tickBuffer.slice(-limit);
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.isIntentionallyClosed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max Kraken WebSocket reconnection attempts reached');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      console.log(`Reconnecting Kraken WebSocket (attempt ${this.reconnectAttempts})...`);
      this.connect().catch((error) => {
        console.error('Kraken WebSocket reconnection failed:', error);
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
    this.tickBuffer = [];
    this.currentPrice = null;
  }

  /**
   * Check if WebSocket is connected.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

