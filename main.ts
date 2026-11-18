/**
 * Strategy: Hybrid two-tier dip-buy on CBBTC 1-minute bars (Version 3).
 * - Core Entry: Close drops >=100bps from 60-bar high and bounces >=5bps off 10-bar low (core bounce >= 5 bps, was 10), 100% of equity.
 * - Core Exit: +120bps take-profit, -150bps trailing drawdown from peak, or 480-bar timeout.
 * - Fallback Entry: After 300 bars without a trade, drop >=70bps from 30-bar high (fallback dip >= 70 bps, was 50), 25% of cash.
 * - Fallback Exit: +60bps take-profit, -60bps trailing drawdown, or 240-bar timeout.
 * - Cutoff: No new entries after bar 1300.
 */
import { runBars } from './vendor/makefun-bars.ts';

interface Tranche {
  id: number;
  qty: bigint;
  entry: bigint;
  entryBar: number;
  peak: bigint;
  tp: bigint;
  trail: bigint;
  timeout: number;
}

interface PendingBuy {
  clientId: string;
  tp: bigint;
  trail: bigint;
  timeout: number;
}

interface PendingSell {
  clientId: string;
  trancheIds: number[];
}

const closes: bigint[] = [];
let tranches: Tranche[] = [];
let nextTrancheId = 0;
let orderCounter = 0;
let lastTradeBar = 0;
let pendingBuy: PendingBuy | null = null;
let pendingSell: PendingSell | null = null;

await runBars({
  onBatch(state, batch) {
    const bar = state.latest.get('CBBTC');
    if (!bar) return [];

    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > 300) {
      closes.shift();
    }

    // FIRST: process batch.fills
    if (batch.fills && batch.fills.length > 0) {
      for (const fill of batch.fills) {
        if (fill.status === 'filled') {
          lastTradeBar = state.seq;
        }
        if (fill.side === 'buy' && pendingBuy !== null && fill.client_id === pendingBuy.clientId) {
          if (fill.status === 'filled') {
            tranches.push({
              id: nextTrancheId++,
              qty: BigInt(fill.qty),
              entry: BigInt(fill.price),
              entryBar: fill.fill_bar,
              peak: BigInt(fill.price),
              tp: pendingBuy.tp,
              trail: pendingBuy.trail,
              timeout: pendingBuy.timeout,
            });
          }
        }
        if (fill.side === 'sell' && pendingSell !== null && fill.client_id === pendingSell.clientId) {
          if (fill.status === 'filled') {
            const removeIds = new Set(pendingSell.trancheIds);
            tranches = tranches.filter(t => !removeIds.has(t.id));
          }
        }
      }
    }
    pendingBuy = null;
    pendingSell = null;

    // EXITS (per tranche, only if tranches is non-empty)
    if (tranches.length > 0) {
      const markedIds: number[] = [];
      let sellQty = 0n;

      for (const t of tranches) {
        if (close > t.peak) {
          t.peak = close;
        }
        const pnlBps = (close - t.entry) * 10000n / t.entry;
        const trailBps = (t.peak - close) * 10000n / t.peak;
        if (pnlBps >= t.tp || trailBps >= t.trail || (state.seq - t.entryBar) >= t.timeout) {
          markedIds.push(t.id);
          sellQty += t.qty;
        }
      }

      if (markedIds.length > 0 && sellQty > 0n) {
        const clientId = 'o' + (++orderCounter);
        pendingSell = { clientId, trancheIds: markedIds };
        return [{
          side: 'sell',
          symbol: 'CBBTC',
          qty: sellQty,
          max_slippage_bps: 200,
          client_id: clientId,
        }];
      }
    }

    // ENTRIES (only if state.seq <= 1300)
    if (state.seq <= 1300) {
      let high60 = 0n;
      if (closes.length >= 60) {
        const last60 = closes.slice(-60);
        high60 = last60.reduce((max, c) => (c > max ? c : max), last60[0]!);
      }

      let high30 = 0n;
      if (closes.length >= 30) {
        const last30 = closes.slice(-30);
        high30 = last30.reduce((max, c) => (c > max ? c : max), last30[0]!);
      }

      let low10 = 0n;
      if (closes.length >= 10) {
        const last10 = closes.slice(-10);
        low10 = last10.reduce((min, c) => (c < min ? c : min), last10[0]!);
      }

      const dip60Bps = closes.length >= 60 ? (high60 - close) * 10000n / high60 : 0n;
      const dip30Bps = closes.length >= 30 ? (high30 - close) * 10000n / high30 : 0n;
      const bounceBps = closes.length >= 10 ? (close - low10) * 10000n / low10 : 0n;

      const pos = state.positions.get('CBBTC');
      const posQty = pos ? pos.qty : 0n;
      const posValue = posQty > 0n ? state.value('CBBTC', posQty) : 0n;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units ?? 1_000_000n);

      // CORE entry
      if (closes.length >= 60 && dip60Bps >= 100n && bounceBps >= 5n && posValue < state.equity) {
        const notional = state.cash;
        if (notional >= minNotional && state.weightRoom('CBBTC') >= minNotional) {
          const clientId = 'o' + (++orderCounter);
          pendingBuy = { clientId, tp: 120n, trail: 150n, timeout: 480 };
          return [{
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: notional,
            max_slippage_bps: 200,
            client_id: clientId,
          }];
        }
      }

      // FALLBACK entry
      if (posQty === 0n && (state.seq - lastTradeBar) >= 300 && closes.length >= 30 && dip30Bps >= 70n && bounceBps >= 10n) {
        const notional = (state.cash * 25n) / 100n;
        if (notional >= minNotional && state.weightRoom('CBBTC') >= minNotional) {
          const clientId = 'o' + (++orderCounter);
          pendingBuy = { clientId, tp: 60n, trail: 60n, timeout: 240 };
          return [{
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: notional,
            max_slippage_bps: 200,
            client_id: clientId,
          }];
        }
      }
    }

    return [];
  }
});
