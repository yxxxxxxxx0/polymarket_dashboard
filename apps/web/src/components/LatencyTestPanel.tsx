"use client";

import { Loader2, TimerReset } from "lucide-react";
import { useState } from "react";
import { API_BASE, post, withProfile } from "@/lib/api";
import { useAccount } from "./AccountProvider";

function ms(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(2)} ms`;
}

function fixed(value: number | null | undefined, digits = 4) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function friendlyError(error: unknown) {
  if (!(error instanceof Error)) return "Latency test failed";
  if (error.message === "Failed to fetch") return `Cannot reach the dashboard API at ${API_BASE || "the current web origin"}.`;
  return error.message;
}

type LatencyStage = {
  name: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
};

type LatencyTestResponse = {
  ok: true;
  tokenId: string;
  side: "BUY";
  usdAmount: number;
  bestAsk: number;
  limitPrice: number;
  size: number;
  orderType: string;
  orderID?: string;
  totalMs: number;
  stages: LatencyStage[];
  response?: {
    success?: boolean;
    status?: string | number;
    takingAmount?: string;
    makingAmount?: string;
    tradeIDs?: string[];
  };
};

export function LatencyTestPanel({ profile, marketId, tokenId, outcomeName }: {
  profile?: string;
  marketId: string;
  tokenId: string;
  outcomeName?: string;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LatencyTestResponse | null>(null);
  const [error, setError] = useState("");
  const [usdAmount, setUsdAmount] = useState("1");
  const [slippageCents, setSlippageCents] = useState("2");
  const { refreshAccount } = useAccount();

  async function runTest() {
    if (running) return;
    const amount = Number(usdAmount);
    const slip = Number(slippageCents);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5) {
      setError("Test amount must be between $0.01 and $5.00.");
      return;
    }
    if (!Number.isFinite(slip) || slip <= 0 || slip > 20) {
      setError("Slippage buffer must be between 0.01¢ and 20¢.");
      return;
    }
    const confirmed = window.confirm(
      `This will place a real LIVE marketable BUY of about $${amount.toFixed(2)} on ${outcomeName ?? "this outcome"}. Continue?`
    );
    if (!confirmed) return;

    setRunning(true);
    setError("");
    setResult(null);
    try {
      const value = await post<LatencyTestResponse>(withProfile("/api/orders/latency-test/buy", profile), {
        marketId,
        tokenId,
        usdAmount: amount,
        slippageCents: slip,
        tradeMode: "LIVE",
        confirmSpendOneDollar: true
      });
      setResult(value);
      void refreshAccount({ force: true });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-md border border-line bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Live $1 latency test</h2>
          <p className="mt-1 text-xs text-slate-500">
            Places a real marketable buy, then reports orderbook, signing, submit, and lookup latency.
          </p>
        </div>
        <TimerReset className="h-5 w-5 text-slate-500" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs font-semibold text-slate-600">
          Amount USD
          <input
            className="control mt-1 w-full"
            inputMode="decimal"
            max="5"
            min="0.01"
            onChange={(event) => setUsdAmount(event.target.value)}
            step="0.01"
            type="number"
            value={usdAmount}
          />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          Slippage buffer, ¢
          <input
            className="control mt-1 w-full"
            inputMode="decimal"
            max="20"
            min="0.01"
            onChange={(event) => setSlippageCents(event.target.value)}
            step="0.01"
            type="number"
            value={slippageCents}
          />
        </label>
      </div>

      <button className="primary-button mt-3 w-full" disabled={running} onClick={runTest} type="button">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <TimerReset className="h-4 w-4" />}
        {running ? "Running latency test..." : "Run live buy latency test"}
      </button>

      <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
        This spends real money. It requires LIVE mode, ENABLE_LIVE_TRADING=true, enough USDC, and a valid API key/private key.
      </div>

      {error && <div className="mt-2 rounded-md bg-sell/10 p-2 text-xs font-semibold text-sell">{error}</div>}

      {result && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line text-xs">
            <div className="bg-white p-2">
              <div className="text-slate-500">Total path</div>
              <div className="font-mono font-semibold">{ms(result.totalMs)}</div>
            </div>
            <div className="bg-white p-2">
              <div className="text-slate-500">Order type</div>
              <div className="font-mono font-semibold">{result.orderType}</div>
            </div>
            <div className="bg-white p-2">
              <div className="text-slate-500">Best ask</div>
              <div className="font-mono font-semibold">{fixed(result.bestAsk, 3)}</div>
            </div>
            <div className="bg-white p-2">
              <div className="text-slate-500">Limit price</div>
              <div className="font-mono font-semibold">{fixed(result.limitPrice, 3)}</div>
            </div>
            <div className="bg-white p-2">
              <div className="text-slate-500">Approx shares</div>
              <div className="font-mono font-semibold">{fixed(result.size, 6)}</div>
            </div>
            <div className="bg-white p-2">
              <div className="text-slate-500">Order ID</div>
              <div className="break-all font-mono font-semibold">{result.orderID ?? "—"}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel text-left text-slate-500">
                <tr>
                  <th className="p-2 font-semibold">Stage</th>
                  <th className="p-2 text-right font-semibold">Latency</th>
                </tr>
              </thead>
              <tbody>
                {result.stages.map((stage) => (
                  <tr className="border-t border-line" key={`${stage.name}-${stage.startedAtMs}`}>
                    <td className="p-2">{stage.name}</td>
                    <td className="p-2 text-right font-mono">{ms(stage.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md bg-panel p-2 text-xs text-slate-600">
            Fill evidence: {result.response?.tradeIDs?.length ? `${result.response.tradeIDs.length} trade id(s)` : "no trade id returned"}
            {result.response?.status !== undefined ? ` · status ${result.response.status}` : ""}
          </div>
        </div>
      )}
    </section>
  );
}
