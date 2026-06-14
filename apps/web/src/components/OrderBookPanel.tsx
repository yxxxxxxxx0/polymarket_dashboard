"use client";

import { Activity } from "lucide-react";
import { useOrderBook } from "./OrderBookProvider";

function fmt(value: number | null | undefined, digits = 3) {
  return value === null || value === undefined ? "-" : value.toFixed(digits);
}

function fmtCompact(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function levelVolume(level: { price: number; size: number }) {
  return level.price * level.size;
}

export function OrderBookPanel({ tokenId }: { tokenId: string }) {
  const book = useOrderBook(tokenId);
  const signal30s = book?.ofi?.signal30s ?? "Neutral";
  const signal2m = book?.ofi?.signal2m ?? "Neutral";
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const bidVolume = bids.reduce((sum, level) => sum + levelVolume(level), 0);
  const askVolume = asks.reduce((sum, level) => sum + levelVolume(level), 0);

  return (
    <section className="rounded-md border border-line bg-white">
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4" />
          Order Book
        </div>
        <div className="font-mono text-xs text-slate-500">{book?.lastUpdateTime ?? "waiting"}</div>
      </div>
      <div className="grid grid-cols-4 gap-px border-b border-line bg-line text-center">
        {[
          ["Bid", fmt(book?.bestBid)],
          ["Ask", fmt(book?.bestAsk)],
          ["Spread", fmt(book?.spread)],
          ["Mid", fmt(book?.midpoint)]
        ].map(([label, value]) => (
          <div key={label} className="bg-white p-3">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="font-mono text-sm font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2">
        <div>
          <div className="table-head grid grid-cols-[3.75rem_minmax(4.75rem,1fr)_minmax(4.75rem,1fr)] px-2 py-2 text-[11px]">
            <span>Bid ({bids.length})</span>
            <span className="text-right">Size</span>
            <span className="text-right">Vol {fmtCompact(bidVolume)}</span>
          </div>
          <div className="max-h-[640px] overflow-y-auto">
            {bids.map((level) => (
              <div key={`b-${level.price}`} className="grid grid-cols-[3.75rem_minmax(4.75rem,1fr)_minmax(4.75rem,1fr)] px-2 py-1.5 font-mono text-xs">
                <span className="text-buy">{fmt(level.price)}</span>
                <span className="text-right">{fmt(level.size, 2)}</span>
                <span className="text-right">{fmt(levelVolume(level), 2)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="border-l border-line">
          <div className="table-head grid grid-cols-[3.75rem_minmax(4.75rem,1fr)_minmax(4.75rem,1fr)] px-2 py-2 text-[11px]">
            <span>Ask ({asks.length})</span>
            <span className="text-right">Size</span>
            <span className="text-right">Vol {fmtCompact(askVolume)}</span>
          </div>
          <div className="max-h-[640px] overflow-y-auto">
            {asks.map((level) => (
              <div key={`a-${level.price}`} className="grid grid-cols-[3.75rem_minmax(4.75rem,1fr)_minmax(4.75rem,1fr)] px-2 py-1.5 font-mono text-xs">
                <span className="text-sell">{fmt(level.price)}</span>
                <span className="text-right">{fmt(level.size, 2)}</span>
                <span className="text-right">{fmt(levelVolume(level), 2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="border-t border-line px-3 py-2 text-xs text-slate-600">
        Depth imbalance: <span className="font-mono">{fmt(book?.depthImbalance)}</span>
      </div>
      <div className="grid grid-cols-5 gap-px border-t border-line bg-line text-center">
        <div className="bg-white p-3">
          <div className="text-xs text-slate-500">Raw OFI</div>
          <div className="font-mono text-sm font-semibold">{fmt(book?.ofi?.rawOfi, 2)}</div>
        </div>
        <div className="bg-white p-3">
          <div className="text-xs text-slate-500">OFI 10m</div>
          <div className="font-mono text-sm font-semibold">{fmt(book?.ofi?.rollingOfi30s, 2)}</div>
        </div>
        <div className="bg-white p-3">
          <div className="text-xs text-slate-500">Signal 10m</div>
          <div className={`text-sm font-semibold ${signal30s.includes("Buy") ? "text-buy" : signal30s.includes("Sell") ? "text-sell" : "text-slate-700"}`}>
            {signal30s}
          </div>
        </div>
        <div className="bg-white p-3">
          <div className="text-xs text-slate-500">OFI 2m</div>
          <div className="font-mono text-sm font-semibold">{fmt(book?.ofi?.rollingOfi2m, 2)}</div>
        </div>
        <div className="bg-white p-3">
          <div className="text-xs text-slate-500">Signal 2m</div>
          <div className={`text-sm font-semibold ${signal2m.includes("Buy") ? "text-buy" : signal2m.includes("Sell") ? "text-sell" : "text-slate-700"}`}>
            {signal2m}
          </div>
        </div>
      </div>
    </section>
  );
}
