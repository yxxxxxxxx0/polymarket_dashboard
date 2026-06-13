"use client";

import { Briefcase } from "lucide-react";
import { useAccount } from "./AccountProvider";
import { useOrderBook } from "./OrderBookProvider";

function fmt(value: number | null | undefined, digits = 3) {
  return value === null || value === undefined ? "-" : value.toFixed(digits);
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function cents(value: number) {
  const centsValue = value * 100;
  return `${Number.isInteger(centsValue) ? centsValue.toFixed(0) : centsValue.toFixed(1)}¢`;
}

export function PositionSummary({ tokenId }: { tokenId: string }) {
  const { account } = useAccount();
  const position = account?.positions.find((item) => item.tokenId === tokenId) ?? account?.positions[0];
  const displayTokenId = position?.tokenId ?? tokenId;
  const book = useOrderBook(displayTokenId);

  const markPrice = position?.side === "SELL"
    ? book?.bestAsk ?? book?.midpoint ?? position?.markPrice ?? null
    : book?.bestBid ?? book?.midpoint ?? position?.markPrice ?? null;
  const activePnl = position && markPrice !== null
    ? (position.side === "SELL" ? position.entryPrice - markPrice : markPrice - position.entryPrice) * position.size
    : null;
  const activePnlPercent = position && markPrice !== null && position.entryPrice > 0
    ? (position.side === "SELL" ? position.entryPrice - markPrice : markPrice - position.entryPrice) / position.entryPrice
    : null;
  const pnlClass = activePnl === null
    ? "text-slate-100"
    : activePnl > 0
      ? "text-emerald-400"
      : activePnl < 0
        ? "text-rose-400"
        : "text-slate-100";
  return (
    <section className="overflow-hidden rounded-md border border-slate-800 bg-[#111820] text-slate-100">
      <div className="flex h-11 items-center gap-2 border-b border-slate-800 px-3 text-sm font-semibold">
        <Briefcase className="h-4 w-4" />
        Position
      </div>
      {!position ? (
        <div className="px-3 py-4 text-sm text-slate-400">No position for this outcome.</div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[720px] grid-cols-[1fr_1.5fr_0.7fr_0.9fr_0.9fr_1.2fr] border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <div>Type</div>
            <div>Outcome</div>
            <div>Avg</div>
            <div>Cost</div>
            <div>To Win</div>
            <div>Current</div>
          </div>
          <div className="grid min-w-[720px] grid-cols-[1fr_1.5fr_0.7fr_0.9fr_0.9fr_1.2fr] items-center px-3 py-4 text-base">
            <div>Moneyline</div>
            <div>
              <span className="inline-flex h-8 items-center overflow-hidden rounded-md bg-slate-700/80 text-xs font-semibold text-slate-200">
                <span className="px-2">{position.outcomeName.toUpperCase()} {position.side === "BUY" ? "YES" : "NO"}</span>
                <span className="h-full border-l border-slate-500 px-2 py-1.5 font-mono">{Math.round(position.size)}</span>
              </span>
            </div>
            <div>{cents(position.entryPrice)}</div>
            <div>{money(position.entryPrice * position.size)}</div>
            <div>{money(position.expectedPayoutIfWins ?? position.size)}</div>
            <div className={`font-semibold ${pnlClass}`}>
              {markPrice === null ? "-" : money(markPrice * position.size)} {activePnl === null ? "" : `(${activePnl >= 0 ? "+" : ""}${money(activePnl)})`}
            </div>
          </div>
          <div className="border-t border-slate-800 px-3 py-2 text-xs text-slate-400">
            Mark: <span className="font-mono">{fmt(markPrice)}</span>
            <span className="px-2">·</span>
            PnL: <span className={`font-mono ${pnlClass}`}>{activePnl === null ? "-" : money(activePnl)}</span>
            <span className="px-2">·</span>
            PnL %: <span className={`font-mono ${pnlClass}`}>{activePnlPercent === null ? "-" : `${(activePnlPercent * 100).toFixed(2)}%`}</span>
          </div>
        </div>
      )}
    </section>
  );
}
