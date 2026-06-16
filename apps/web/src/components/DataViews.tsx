"use client";

import { Ban, CheckCircle2, Power, RefreshCw, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
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

function shortId(value: unknown) {
  if (typeof value !== "string" || value.length < 8) return cell(value);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function relationshipKind(row: AnyRow) {
  if (!row.strategySequenceId) return "single";
  if (row.parentRuleId) return "child";
  const childIds = Array.isArray(row.childRuleIds) ? row.childRuleIds : [];
  if (childIds.length > 0) return "parent";
  return "sequence";
}

const relationshipPalette = [
  {
    wrap: "border-sky-300 bg-sky-50 text-sky-800",
    label: "bg-sky-600 text-white",
    chip: "border-sky-300 bg-white/80 text-sky-800"
  },
  {
    wrap: "border-violet-300 bg-violet-50 text-violet-800",
    label: "bg-violet-600 text-white",
    chip: "border-violet-300 bg-white/80 text-violet-800"
  },
  {
    wrap: "border-amber-300 bg-amber-50 text-amber-800",
    label: "bg-amber-500 text-white",
    chip: "border-amber-300 bg-white/80 text-amber-800"
  },
  {
    wrap: "border-emerald-300 bg-emerald-50 text-emerald-800",
    label: "bg-emerald-600 text-white",
    chip: "border-emerald-300 bg-white/80 text-emerald-800"
  },
  {
    wrap: "border-rose-300 bg-rose-50 text-rose-800",
    label: "bg-rose-600 text-white",
    chip: "border-rose-300 bg-white/80 text-rose-800"
  },
  {
    wrap: "border-cyan-300 bg-cyan-50 text-cyan-800",
    label: "bg-cyan-600 text-white",
    chip: "border-cyan-300 bg-white/80 text-cyan-800"
  }
];

const singleRelationshipStyle = {
  wrap: "border-slate-200 bg-slate-50 text-slate-600",
  label: "bg-slate-200 text-slate-700",
  chip: "border-slate-200 bg-white text-slate-600"
};

function stablePaletteIndex(value: unknown) {
  const text = typeof value === "string" ? value : cell(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash % relationshipPalette.length;
}

function relationshipGroupKey(row: AnyRow) {
  return typeof row.strategySequenceId === "string" && row.strategySequenceId
    ? row.strategySequenceId
    : `single:${cell(row.id)}`;
}

function RelationshipBadge({ row }: { row: AnyRow }) {
  const kind = relationshipKind(row);
  const childIds = Array.isArray(row.childRuleIds) ? row.childRuleIds : [];
  const color = row.strategySequenceId ? relationshipPalette[stablePaletteIndex(row.strategySequenceId)] : singleRelationshipStyle;
  const copy = {
    single: {
      title: "Single rule",
      detail: "No sequence"
    },
    sequence: {
      title: "Sequence rule",
      detail: `Seq ${shortId(row.strategySequenceId)}`
    },
    parent: {
      title: "Parent breakout",
      detail: `${cell(row.outcomeName)} / ${childIds.length} ${childIds.length === 1 ? "child" : "children"}`
    },
    child: {
      title: "Child exit",
      detail: `${cell(row.outcomeName)} / Parent ${shortId(row.parentRuleId)}`
    }
  }[kind];

  return (
    <div className={`inline-flex min-w-52 flex-col gap-1 rounded-md border px-2 py-1.5 ${color.wrap}`} title={`Sequence: ${cell(row.strategySequenceId)} | Parent: ${cell(row.parentRuleId)} | Children: ${childIds.map(shortId).join(", ") || "-"}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${color.label}`}>{kind}</span>
        <span className="text-xs font-bold">{copy.title}</span>
      </div>
      <div className="text-[11px] font-semibold opacity-80">{copy.detail}</div>
      {kind === "parent" && childIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {childIds.map((id) => (
            <span key={String(id)} className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${color.chip}`}>
              child {shortId(id)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function latestRuleMessage(row: AnyRow) {
  const logs = Array.isArray(row.triggerLogs) ? row.triggerLogs : [];
  const latest = logs.find((log) => typeof log === "object" && log !== null) as Record<string, unknown> | undefined;
  return latest?.message ?? "-";
}

function statusRank(row: AnyRow) {
  const status = String(row.displayStatus ?? row.status ?? "").toLowerCase();
  const enabled = row.enabled !== false;
  if (!enabled || status === "cancelled" || status === "disabled" || status === "failed") return 5;
  if (status === "active" || status === "pending" || status === "inactive_waiting_for_parent") return 0;
  if (status === "order_submitted" || status === "submitted" || status === "triggering") return 2;
  if (status === "filled" || status === "triggered") return 4;
  return 3;
}

function relationshipRoleRank(row: AnyRow) {
  const kind = relationshipKind(row);
  if (kind === "parent") return 0;
  if (kind === "child") return 1;
  if (kind === "sequence") return 2;
  return 3;
}

function sortStopRows(rows: AnyRow[]) {
  const groupRanks = new Map<string, number>();
  rows.forEach((row) => {
    const key = relationshipGroupKey(row);
    groupRanks.set(key, Math.min(groupRanks.get(key) ?? 99, statusRank(row)));
  });

  return [...rows].sort((a, b) => {
    const aKey = relationshipGroupKey(a);
    const bKey = relationshipGroupKey(b);
    const rankDiff = (groupRanks.get(aKey) ?? 99) - (groupRanks.get(bKey) ?? 99);
    if (rankDiff !== 0) return rankDiff;
    const groupDiff = aKey.localeCompare(bKey);
    if (groupDiff !== 0) return groupDiff;
    const roleDiff = relationshipRoleRank(a) - relationshipRoleRank(b);
    if (roleDiff !== 0) return roleDiff;
    const statusDiff = statusRank(a) - statusRank(b);
    if (statusDiff !== 0) return statusDiff;
    return cell(a.createdAt).localeCompare(cell(b.createdAt));
  });
}

function finishedInactiveDividerIndex(rows: AnyRow[]) {
  const groupRanks = new Map<string, number>();
  rows.forEach((row) => {
    const key = relationshipGroupKey(row);
    groupRanks.set(key, Math.min(groupRanks.get(key) ?? 99, statusRank(row)));
  });
  return rows.findIndex((row) => (groupRanks.get(relationshipGroupKey(row)) ?? 99) >= 4);
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
  const sortedRows = useMemo(() => sortStopRows(rows), [rows]);
  const dividerIndex = useMemo(() => finishedInactiveDividerIndex(sortedRows), [sortedRows]);
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
        <table className="w-full min-w-[2380px] border-collapse">
          <thead className="table-head">
            <tr>
              {["Type", "Outcome", "Relationship", "Trigger", "Trigger Px", "Threshold", "Bid", "Ask", "Spread", "Age", "Stale", "Current", "Hard", "Soft", "Active", "Distance", "Trail %", "Slip", "Max Spread", "Emergency", "Breakeven", "Last Limit", "Last Attempt", "Blocked", "Retries", "Game Min", "Status", "Enabled", "Actions"].map((name) => (
                <th key={name} className="px-3 py-2">{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="table-cell text-slate-500" colSpan={29}>No stop, trailing, or breakout rules yet.</td>
              </tr>
            )}
            {sortedRows.map((row, index) => (
              <Fragment key={String(row.id)}>
                {index === dividerIndex && (
                  <tr key="finished-inactive-divider">
                    <td className="border-y-2 border-ink bg-slate-100 px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-700" colSpan={29}>
                      Finished / inactive orders
                    </td>
                  </tr>
                )}
                <tr key={String(row.id)}>
                  <td className="table-cell">{cell(row.ruleType)}</td>
                  <td className="table-cell">{cell(row.outcomeName)}</td>
                  <td className="table-cell text-xs font-semibold"><RelationshipBadge row={row} /></td>
                  <td className="table-cell">{cell(row.triggerSource ?? row.triggerType)}</td>
                  <td className="table-cell">{cell(row.triggerPrice)}</td>
                  <td className="table-cell">{cell(row.triggerThreshold)}</td>
                  <td className="table-cell">{cell(row.bestBid)}</td>
                  <td className="table-cell">{cell(row.bestAsk)}</td>
                  <td className="table-cell">{cell(row.spread)}</td>
                  <td className="table-cell">{row.orderbookAgeMs === null || row.orderbookAgeMs === undefined ? "-" : `${cell(row.orderbookAgeMs)}ms`}</td>
                  <td className="table-cell">{row.orderbookStale ? "Stale" : "Fresh"}</td>
                  <td className="table-cell">{cell(row.currentPrice)}</td>
                  <td className="table-cell">{cell(row.hardStopPrice)}</td>
                  <td className="table-cell">{cell(row.softStopPrice)}</td>
                  <td className="table-cell">{cell(row.activeStopPrice ?? row.stopPrice)}</td>
                  <td className="table-cell">{cell(row.ruleType === "BREAKOUT_BUY" || row.ruleType === "BUY_STOP" ? row.distanceToTrigger : row.distanceToStop)}</td>
                  <td className="table-cell">{cell(row.trailingPercentage)}</td>
                  <td className="table-cell" title={cell(row.effectiveRiskLabel)}>{cell(row.effectiveSlippageLimit ?? row.slippageLimit)}</td>
                  <td className="table-cell" title={cell(row.effectiveRiskLabel)}>{row.effectiveDisableMaxSpread ? "Disabled" : cell(row.effectiveMaxSpread ?? row.maxSpread)}</td>
                  <td className="table-cell">{row.emergencyMode ? "On" : "Off"}</td>
                  <td className="table-cell">{row.breakevenActivated ? "Activated" : row.breakevenEnabled ? "Armed" : "-"}</td>
                  <td className="table-cell">{cell(row.lastLimitPrice)}</td>
                  <td className="table-cell">{cell(row.lastExecutionAttempt)}</td>
                  <td className="table-cell max-w-72 truncate text-xs" title={cell(row.lastBlockedReason ?? latestRuleMessage(row))}>{cell(row.lastBlockedReason ?? latestRuleMessage(row))}</td>
                  <td className="table-cell">{cell(row.retryCount)}</td>
                  <td className="table-cell">{row.gameMinute === null || row.gameMinute === undefined ? "-" : `${cell(row.gameMinute)}'`}</td>
                  <td className="table-cell">{cell(row.displayStatus ?? row.status)}</td>
                  <td className="table-cell">{row.enabled ? <CheckCircle2 className="h-4 w-4 text-buy" /> : <Ban className="h-4 w-4 text-slate-400" />}</td>
                  <td className="table-cell">
                    <button className="icon-button" onClick={() => toggle(String(row.id), Boolean(row.enabled))} aria-label="Toggle" disabled={row.displayStatus === "inactive_waiting_for_parent"}>
                      <Power className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              </Fragment>
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
