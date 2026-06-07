/**
 * Example usage of the BTC market data and trade evaluation system.
 * 
 * This file demonstrates how to:
 * 1. Initialize the Kraken BTC feed
 * 2. Wait for connection
 * 3. Evaluate a candidate trade
 * 4. Log results
 */

import { initializeBTCFeed, evaluateCandidateTrade, getBTCFeed } from './evaluateCandidateTrade.js';
import type { CandidateTrade } from './types.js';

async function main() {
  console.log('Starting BTC Market Data + Trade Evaluation Example...');

  try {
    // Initialize BTC feed
    console.log('Initializing Kraken BTC feed...');
    const feed = await initializeBTCFeed();

    // Wait for price update (feed should connect and start receiving data)
    console.log('Waiting for BTC price feed...');
    await new Promise<void>((resolve) => {
      const checkPrice = () => {
        const price = feed.getCurrentPrice();
        if (price !== null) {
          console.log(`BTC feed connected. Current price: $${price.toFixed(2)}`);
          resolve();
        } else {
          setTimeout(checkPrice, 1000);
        }
      };
      checkPrice();
    });

    // Wait a bit more to ensure we have some data
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Example candidate trade
    const candidate: CandidateTrade = {
      market_ticker: 'KXBTCD-EXAMPLE',
      side: 'YES',
      intended_entry_price: 0.85,
      size: 100,
      metadata: {
        example: true,
      },
    };

    console.log('\nEvaluating candidate trade...');
    console.log(`Market: ${candidate.market_ticker}`);
    console.log(`Side: ${candidate.side}`);
    console.log(`Intended entry: ${candidate.intended_entry_price}`);

    // Evaluate the candidate trade
    const result = await evaluateCandidateTrade(candidate);

    // Log results
    console.log('\n=== Evaluation Result ===');
    console.log(`Verdict: ${result.verdict}`);
    console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
    console.log(`Suggested Action: ${result.suggested_action}`);
    console.log(`\nReasons:`);
    result.reasons.forEach((reason, i) => {
      console.log(`  ${i + 1}. ${reason}`);
    });
    console.log(`\nRisk Flags:`);
    if (result.risk_flags.length > 0) {
      result.risk_flags.forEach((flag, i) => {
        console.log(`  ${i + 1}. ${flag}`);
      });
    } else {
      console.log('  None');
    }
    if (result.notes_for_logs) {
      console.log(`\nNotes: ${result.notes_for_logs}`);
    }

    console.log('\nExample completed successfully!');
  } catch (error) {
    console.error('Error in example:', error);
    process.exit(1);
  }
}

// Run example if this file is executed directly
// Usage: tsx src/analysis/index.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('index.ts')) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

