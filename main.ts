/**
 * Strategy: Dip-buy mean-reversion on CBBTC 1-minute bars.
 * - Entry: Close drops >=100bps from 120-bar high and bounces >=10bps off 10-bar low.
 * - Exit: +180bps take-profit, -150bps trailing drawdown from peak, or 480-bar timeout.
 * - Cooldown: 30-bar cooldown after exit.
 * - Allocation: 100% of cash per entry, long only ($1,000 paper capital).
 */
import { runBars } from './vendor/makefun-bars.ts';

const closes: bigint[] = [];
let entryPrice: bigint | null = null;
let entryBarSeq = -1;
let peakSinceEntry: bigint | null = null;
let lastExitBarSeq = -999;

await runBars({
  onBatch(state) {
    const bar = state.latest.get('CBBTC');
    if (!bar) return [];

    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > 300) {
      closes.shift();
    }

    const pos = state.positions.get('CBBTC');
    const hasPos = pos !== undefined && pos.qty > 0n;

    if (hasPos) {
      if (entryPrice === null) {
        entryPrice = close;
        entryBarSeq = state.seq;
        peakSinceEntry = close;
      } else {
        if (peakSinceEntry === null || close > peakSinceEntry) {
          peakSinceEntry = close;
        }
      }
    } else {
      entryPrice = null;
      entryBarSeq = -1;
      peakSinceEntry = null;
    }

    // EXIT
    if (hasPos && entryPrice !== null && peakSinceEntry !== null) {
      const pnlBps = (close - entryPrice) * 10000n / entryPrice;
      const trailBps = (peakSinceEntry - close) * 10000n / peakSinceEntry;
      const timeoutReached = (state.seq - entryBarSeq) >= 480;

      if (pnlBps >= 180n || trailBps >= 150n || timeoutReached) {
        entryPrice = null;
        peakSinceEntry = null;
        lastExitBarSeq = state.seq;
        return [{
          side: 'sell',
          symbol: 'CBBTC',
          qty: pos.qty,
          max_slippage_bps: 200
        }];
      }
    }

    // ENTRY
    if (!hasPos && closes.length >= 120 && (state.seq - lastExitBarSeq) >= 30) {
      const last120 = closes.slice(-120);
      const high120 = last120.reduce((max, c) => (c > max ? c : max), last120[0]!);
      const dropBps = (high120 - close) * 10000n / high120;

      const last10 = closes.slice(-10);
      const low10 = last10.reduce((min, c) => (c < min ? c : min), last10[0]!);
      const bounceBps = (close - low10) * 10000n / low10;

      if (dropBps >= 100n && bounceBps >= 10n) {
        const cashToUse = (state.cash * 100n) / 100n;
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units ?? 1_000_000n);
        if (cashToUse >= minNotional && state.weightRoom('CBBTC') >= minNotional) {
          return [{
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: cashToUse,
            max_slippage_bps: 200
          }];
        }
      }
    }

    return [];
  }
});
