"use client";

import { Ban, CheckCircle2, Power, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, post, withProfile, type AccountPositionSummary } from "@/lib/api";
import { useAccount } from "./AccountProvider";

type AnyRow = Record<string, unknown>;

function cell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function cents(value: number) {
  const centsValue = value * 100;
  return `${Number.isInteger(centsValue) ? centsValue.toFixed(0) : centsValue.toFixed(1)}¢`;
}

function PositionLedger({ positions }: { positions: AccountPositionSummary[] }) {
  return (
    <section className="overflow-hidden rounded-md border border-slate-800 bg-[#111820] text-slate-100">
      <div className="overflow-x-auto">
        <div className="grid min-w-[920px] grid-cols-[1.1fr_1.8fr_0.7fr_0.9fr_0.9fr_1.2fr] border-b border-slate-800 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          <div>Type</div>
          <div>Outcome</div>
          <div>Avg</div>
          <div>Cost</div>
          <div>To Win</div>
          <div>Current</div>
        </div>
        {positions.length === 0 ? (
          <div className="px-4 py-5 text-sm text-slate-400">No live or paper positions for this market.</div>
        ) : (
          positions.map((position) => {
            const cost = position.entryPrice * position.size;
            const toWin = position.expectedPayoutIfWins ?? position.size;
            const current = position.markPrice * position.size;
            const pnl = position.unrealizedPnl;
            const pnlClass = pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-rose-400" : "text-slate-100";
            return (
              <div key={position.id} className="grid min-w-[920px] grid-cols-[1.1fr_1.8fr_0.7fr_0.9fr_0.9fr_1.2fr] items-center border-b border-slate-900 px-4 py-4 text-lg last:border-b-0">
                <div>Moneyline</div>
                <div>
                  <span className="inline-flex h-9 items-center overflow-hidden rounded-md bg-slate-700/80 text-sm font-semibold text-slate-200">
                    <span className="px-3">{position.outcomeName.toUpperCase()} {position.side === "BUY" ? "YES" : "NO"}</span>
                    <span className="h-full border-l border-slate-500 px-3 py-2 font-mono">{Math.round(position.size)}</span>
                  </span>
                </div>
                <div>{cents(position.entryPrice)}</div>
                <div>{money(cost)}</div>
                <div>{money(toWin)}</div>
                <div className={`font-semibold ${pnlClass}`}>{money(current)} ({pnl >= 0 ? "+" : ""}{money(pnl)})</div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export function PositionsView() {
  const { account, refreshAccount } = useAccount();
  const outcomeRows = (account?.outcomes ?? []).map((outcome) => ({
    outcomeName: outcome.outcomeName,
    buyPrice: outcome.buyPrice === null ? null : outcome.buyPrice.toFixed(3),
    cashAvailable: outcome.cashAvailable === null ? null : outcome.cashAvailable.toFixed(2),
    sharesCanBuy: outcome.sharesCanBuy === null ? null : outcome.sharesCanBuy.toFixed(2),
    expectedPayoutIfWins: outcome.expectedPayoutIfWins === null ? null : outcome.expectedPayoutIfWins.toFixed(2),
    expectedProfitIfWins: outcome.expectedProfitIfWins === null ? null : outcome.expectedProfitIfWins.toFixed(2)
  }));
  return (
    <section className="space-y-4">
      <DataTable
        title="Account Buying Power"
        rows={outcomeRows}
        columns={["outcomeName", "buyPrice", "cashAvailable", "sharesCanBuy", "expectedPayoutIfWins", "expectedProfitIfWins"]}
      />
      <button className="secondary-button" onClick={() => refreshAccount()}><RefreshCw className="h-4 w-4" /> Refresh</button>
      <PositionLedger positions={account?.positions ?? []} />
    </section>
  );
}

export function OrdersView({ profile }: { profile?: string }) {
  const [rows, setRows] = useState<AnyRow[]>([]);
  const refresh = () => api<AnyRow[]>(withProfile("/api/open-orders", profile)).then(setRows).catch(() => undefined);
  useEffect(() => {
    refresh();
  }, []);
  return (
    <section className="space-y-3">
      <button className="secondary-button" onClick={refresh}><RefreshCw className="h-4 w-4" /> Refresh</button>
      <DataTable title="Open Orders" rows={rows} columns={["id", "outcomeName", "side", "price", "size", "remainingSize", "status", "tradeMode"]} />
    </section>
  );
}

export function StopLossView({ profile, refreshKey = 0, title = "Stop / Trail / Breakout Rules" }: { profile?: string; refreshKey?: number; title?: string }) {
  const [rows, setRows] = useState<AnyRow[]>([]);
  const [clearing, setClearing] = useState(false);
  const refresh = () => api<AnyRow[]>(withProfile("/api/stop-loss", profile)).then(setRows).catch(() => undefined);
  useEffect(() => {
    refresh();
  }, [refreshKey]);

  async function toggle(id: string, enabled: boolean) {
    await post(withProfile(`/api/stop-loss/${id}/${enabled ? "disable" : "enable"}`, profile), {});
    refresh();
  }

  async function clearAll() {
    if (rows.length === 0 || clearing) return;
    const confirmed = window.confirm("Clear all stop loss, trailing stop, and breakout buy rules for the active market?");
    if (!confirmed) return;
    setClearing(true);
    try {
      await api(withProfile("/api/stop-loss", profile), { method: "DELETE" });
      setRows([]);
    } finally {
      setClearing(false);
      refresh();
    }
  }

  return (
    <section className="rounded-md border border-line bg-white">
      <div className="flex h-11 items-center justify-between border-b border-line px-3">
        <div className="text-sm font-semibold">{title}</div>
        <div className="flex items-center gap-2">
          <button className="secondary-button h-8 px-2 text-xs" disabled={rows.length === 0 || clearing} onClick={clearAll} type="button">
            <Trash2 className="h-4 w-4" />
            {clearing ? "Clearing..." : "Clear All"}
          </button>
          <button className="icon-button" onClick={refresh} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1600px] border-collapse">
          <thead className="table-head">
            <tr>
              {["Type", "Outcome", "Sequence", "Parent", "Children", "Trigger", "Current", "Hard", "Soft", "Active", "Distance", "Trail %", "Slip", "Max Spread", "Game Min", "Status", "Enabled", "Actions"].map((name) => (
                <th key={name} className="px-3 py-2">{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="table-cell text-slate-500" colSpan={18}>No stop, trailing, or breakout rules yet.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={String(row.id)}>
                <td className="table-cell">{cell(row.ruleType)}</td>
                <td className="table-cell">{cell(row.outcomeName)}</td>
                <td className="table-cell font-mono text-[11px]">{cell(row.strategySequenceId)}</td>
                <td className="table-cell font-mono text-[11px]">{cell(row.parentRuleId)}</td>
                <td className="table-cell font-mono text-[11px]">{cell(row.childRuleIds)}</td>
                <td className="table-cell">{cell(row.triggerType)}</td>
                <td className="table-cell">{cell(row.currentPrice)}</td>
                <td className="table-cell">{cell(row.hardStopPrice)}</td>
                <td className="table-cell">{cell(row.softStopPrice)}</td>
                <td className="table-cell">{cell(row.activeStopPrice ?? row.stopPrice)}</td>
                <td className="table-cell">{cell(row.ruleType === "BREAKOUT_BUY" || row.ruleType === "BUY_STOP" ? row.distanceToTrigger : row.distanceToStop)}</td>
                <td className="table-cell">{cell(row.trailingPercentage)}</td>
                <td className="table-cell" title={cell(row.effectiveRiskLabel)}>{cell(row.effectiveSlippageLimit ?? row.slippageLimit)}</td>
                <td className="table-cell" title={cell(row.effectiveRiskLabel)}>{row.effectiveDisableMaxSpread ? "Disabled" : cell(row.effectiveMaxSpread ?? row.maxSpread)}</td>
                <td className="table-cell">{row.gameMinute === null || row.gameMinute === undefined ? "-" : `${cell(row.gameMinute)}'`}</td>
                <td className="table-cell">{cell(row.displayStatus ?? row.status)}</td>
                <td className="table-cell">{row.enabled ? <CheckCircle2 className="h-4 w-4 text-buy" /> : <Ban className="h-4 w-4 text-slate-400" />}</td>
                <td className="table-cell">
                  <button className="icon-button" onClick={() => toggle(String(row.id), Boolean(row.enabled))} aria-label="Toggle" disabled={row.displayStatus === "inactive_waiting_for_parent"}>
                    <Power className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DataTable({ title, rows, columns }: { title: string; rows: AnyRow[]; columns: string[] }) {
  return (
    <section className="rounded-md border border-line bg-white">
      <div className="h-11 border-b border-line px-3 py-3 text-sm font-semibold">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead className="table-head">
            <tr>{columns.map((column) => <th className="px-3 py-2" key={column}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {columns.map((column) => <td className="table-cell" key={column}>{cell(row[column])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
