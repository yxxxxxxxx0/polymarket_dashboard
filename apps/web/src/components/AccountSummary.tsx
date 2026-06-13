"use client";

import { useAccount } from "./AccountProvider";

function formatCurrency(value: number | null) {
  if (value !== null && value > 1_000_000_000) return "Unlimited";
  return value === null ? "Unavailable" : `$${value.toFixed(2)}`;
}

export function AccountSummary() {
  const { account } = useAccount();
  const positionPnl = account?.unrealizedPnl ?? null;
  const netPnl = account?.netPnl ?? null;
  const positionPnlClass = positionPnl === null
    ? "border-line bg-panel text-slate-600"
    : positionPnl > 0
      ? "border-buy/30 bg-buy/10 text-buy"
      : positionPnl < 0
        ? "border-sell/30 bg-sell/10 text-sell"
        : "border-line bg-panel text-slate-600";
  const netPnlClass = netPnl === null
    ? "border-line bg-panel text-slate-600"
    : netPnl > 0
      ? "border-buy/30 bg-buy/10 text-buy"
      : netPnl < 0
        ? "border-sell/30 bg-sell/10 text-sell"
        : "border-line bg-panel text-slate-600";
  const signedPositionPnl = positionPnl === null ? "Unavailable" : `${positionPnl >= 0 ? "+" : ""}${formatCurrency(positionPnl)}`;
  const signedNetPnl = netPnl === null ? "Unavailable" : `${netPnl >= 0 ? "+" : ""}${formatCurrency(netPnl)}`;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-600">
      <span className={`rounded-md border px-2 py-1 font-semibold ${positionPnlClass}`}>Position PnL: {signedPositionPnl}</span>
      <span className={`rounded-md border px-2 py-1 font-semibold ${netPnlClass}`}>Net PnL: {signedNetPnl}</span>
      <span className="rounded-md bg-panel px-2 py-1">Cash: {formatCurrency(account?.cash ?? null)}</span>
      <span className="rounded-md bg-panel px-2 py-1">Portfolio Value: {formatCurrency(account?.accountValue ?? null)}</span>
    </div>
  );
}
