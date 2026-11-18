/**
 * Strategy: Dual-tier pullback and bounce trading strategy on CBBTC 1-minute bars (Version 4).
 * - Primary Entry: Triggers when the price drops >=100 bps from the 60-bar peak and rebounds >=5 bps off the 10-bar trough, deploying 100% of available equity.
 * - Primary Exit: Target +120 bps take-profit, -150 bps trailing drawdown from peak price, or 480-bar max holding timeout.
 * - Secondary Entry: Activated after 300 bars of inactivity when position is zero, requiring a >=70 bps dip from the 30-bar peak and >=10 bps rebound off the 10-bar trough, allocating 25% of cash.
 * - Secondary Exit: Target +60 bps take-profit, -60 bps trailing drawdown, or 240-bar max holding timeout.
 * - Cutoff Rule: No new positions initiated after bar 1300.
 */
import { runBars } from './vendor/makefun-bars.ts';

interface ActiveHolding {
  id: number;
  qty: bigint;
  entryPrice: bigint;
  entryBarNumber: number;
  peakPrice: bigint;
  takeProfitBps: bigint;
  trailingBps: bigint;
  timeoutBars: number;
}

interface PendingBuyIntent {
  identifier: string;
  takeProfitBps: bigint;
  trailingBps: bigint;
  timeoutBars: number;
}

interface PendingSellIntent {
  identifier: string;
  holdingIds: number[];
}

const priceHistory: bigint[] = [];
let activeHoldings: ActiveHolding[] = [];
let nextHoldingId = 0;
let sequenceOrderCount = 0;
let lastExecutionBar = 0;
let pendingBuyIntent: PendingBuyIntent | null = null;
let pendingSellIntent: PendingSellIntent | null = null;

function computeWindowStats(closes: bigint[]) {
  let high60 = 0n;
  if (closes.length >= 60) {
    const slice60 = closes.slice(-60);
    high60 = slice60.reduce((m, val) => (val > m ? val : m), slice60[0]!);
  }

  let high30 = 0n;
  if (closes.length >= 30) {
    const slice30 = closes.slice(-30);
    high30 = slice30.reduce((m, val) => (val > m ? val : m), slice30[0]!);
  }

  let low10 = 0n;
  if (closes.length >= 10) {
    const slice10 = closes.slice(-10);
    low10 = slice10.reduce((m, val) => (val < m ? val : m), slice10[0]!);
  }

  return { high60, high30, low10 };
}

function evaluateExitOrders(holdings: ActiveHolding[], currentClose: bigint, currentSeq: number) {
  const targetIds: number[] = [];
  let totalSellQty = 0n;

  for (const holding of holdings) {
    if (currentClose > holding.peakPrice) {
      holding.peakPrice = currentClose;
    }
    const profitBps = (currentClose - holding.entryPrice) * 10000n / holding.entryPrice;
    const drawdownBps = (holding.peakPrice - currentClose) * 10000n / holding.peakPrice;

    if (profitBps >= holding.takeProfitBps || drawdownBps >= holding.trailingBps || (currentSeq - holding.entryBarNumber) >= holding.timeoutBars) {
      targetIds.push(holding.id);
      totalSellQty += holding.qty;
    }
  }

  return { targetIds, totalSellQty };
}

await runBars({
  onBatch(state, batch) {
    const barData = state.latest.get('CBBTC');
    if (!barData) return [];

    const currentClose = BigInt(barData.c);
    priceHistory.push(currentClose);
    if (priceHistory.length > 300) {
      priceHistory.shift();
    }

    // 1. Process incoming execution fills first
    if (batch.fills && batch.fills.length > 0) {
      for (const fill of batch.fills) {
        if (fill.status === 'filled') {
          lastExecutionBar = state.seq;
        }
        if (fill.side === 'buy' && pendingBuyIntent !== null && fill.client_id === pendingBuyIntent.identifier) {
          if (fill.status === 'filled') {
            activeHoldings.push({
              id: nextHoldingId++,
              qty: BigInt(fill.qty),
              entryPrice: BigInt(fill.price),
              entryBarNumber: fill.fill_bar,
              peakPrice: BigInt(fill.price),
              takeProfitBps: pendingBuyIntent.takeProfitBps,
              trailingBps: pendingBuyIntent.trailingBps,
              timeoutBars: pendingBuyIntent.timeoutBars,
            });
          }
        }
        if (fill.side === 'sell' && pendingSellIntent !== null && fill.client_id === pendingSellIntent.identifier) {
          if (fill.status === 'filled') {
            const removedIdsSet = new Set(pendingSellIntent.holdingIds);
            activeHoldings = activeHoldings.filter(h => !removedIdsSet.has(h.id));
          }
        }
      }
    }
    pendingBuyIntent = null;
    pendingSellIntent = null;

    // 2. Evaluate exit conditions for all active holdings
    if (activeHoldings.length > 0) {
      const { targetIds, totalSellQty } = evaluateExitOrders(activeHoldings, currentClose, state.seq);

      if (targetIds.length > 0 && totalSellQty > 0n) {
        const clientId = 'o' + (++sequenceOrderCount);
        pendingSellIntent = { identifier: clientId, holdingIds: targetIds };
        return [{
          side: 'sell',
          symbol: 'CBBTC',
          qty: totalSellQty,
          max_slippage_bps: 200,
          client_id: clientId,
        }];
      }
    }

    // 3. Evaluate entry conditions (only when bar sequence is within allowed limit)
    if (state.seq <= 1300) {
      const stats = computeWindowStats(priceHistory);
      const dip60Bps = priceHistory.length >= 60 ? (stats.high60 - currentClose) * 10000n / stats.high60 : 0n;
      const dip30Bps = priceHistory.length >= 30 ? (stats.high30 - currentClose) * 10000n / stats.high30 : 0n;
      const bounceBps = priceHistory.length >= 10 ? (currentClose - stats.low10) * 10000n / stats.low10 : 0n;

      const positionRecord = state.positions.get('CBBTC');
      const positionQty = positionRecord ? positionRecord.qty : 0n;
      const positionVal = positionQty > 0n ? state.value('CBBTC', positionQty) : 0n;
      const minimumNotionalThreshold = BigInt(state.hello.fees.min_notional_quote_units ?? 1_000_000n);

      // Core entry evaluation
      if (priceHistory.length >= 60 && dip60Bps >= 100n && bounceBps >= 5n && positionVal < state.equity) {
        const allocationAmount = state.cash;
        if (allocationAmount >= minimumNotionalThreshold && state.weightRoom('CBBTC') >= minimumNotionalThreshold) {
          const clientId = 'o' + (++sequenceOrderCount);
          pendingBuyIntent = { identifier: clientId, takeProfitBps: 120n, trailingBps: 150n, timeoutBars: 480 };
          return [{
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: allocationAmount,
            max_slippage_bps: 200,
            client_id: clientId,
          }];
        }
      }

      // Fallback entry evaluation
      if (positionQty === 0n && (state.seq - lastExecutionBar) >= 300 && priceHistory.length >= 30 && dip30Bps >= 70n && bounceBps >= 10n) {
        const allocationAmount = (state.cash * 25n) / 100n;
        if (allocationAmount >= minimumNotionalThreshold && state.weightRoom('CBBTC') >= minimumNotionalThreshold) {
          const clientId = 'o' + (++sequenceOrderCount);
          pendingBuyIntent = { identifier: clientId, takeProfitBps: 60n, trailingBps: 60n, timeoutBars: 240 };
          return [{
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: allocationAmount,
            max_slippage_bps: 200,
            client_id: clientId,
          }];
        }
      }
    }

    return [];
  }
});
