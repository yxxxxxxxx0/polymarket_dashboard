"use client";

import { WalletCards } from "lucide-react";
import { useAccount } from "./AccountProvider";

function money(value: number | null | undefined) {
  if (value !== null && value !== undefined && value > 1_000_000_000) return "Unlimited";
  return value === null || value === undefined ? "Unavailable" : `$${value.toFixed(2)}`;
}

function shares(value: number | null | undefined) {
  return value === null || value === undefined ? "Unavailable" : value.toFixed(2);
}

export function BuyingPowerSummary({ tokenId }: { tokenId: string }) {
  const { account, error } = useAccount();
  const outcome = account?.outcomes.find((item) => item.tokenId === tokenId);
  const balanceLabel = account?.balance.available
    ? "Live balance"
    : account?.balance.error ?? error ?? "Balance unavailable";

  return (
    <section className="rounded-md border border-line bg-white">
      <div className="flex h-11 items-center gap-2 border-b border-line px-3 text-sm font-semibold">
        <WalletCards className="h-4 w-4" />
        Account / Buying Power
      </div>
      <div className="grid grid-cols-2 gap-px bg-line text-sm">
        {[
          ["Cash", money(account?.cash)],
          ["Allowance", money(account?.allowance)],
          ["Buy price", outcome?.buyPrice === null || outcome?.buyPrice === undefined ? "-" : outcome.buyPrice.toFixed(3)],
          ["Shares can buy", shares(outcome?.sharesCanBuy)],
          ["Payout if wins", money(outcome?.expectedPayoutIfWins)],
          ["Profit if wins", money(outcome?.expectedProfitIfWins)]
        ].map(([label, value]) => (
          <div key={label} className="bg-white p-3">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="font-mono font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-3 py-2 text-xs text-slate-500">{balanceLabel}</div>
    </section>
  );
}
