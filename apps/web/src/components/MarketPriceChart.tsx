"use client";

import { LineChart } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderBook } from "@/lib/api";
import { useOrderBooks } from "./OrderBookProvider";

type ChartPoint = {
  timestamp: number;
  value: number | null;
};

const CHART_WINDOW_MS = 2 * 60 * 60 * 1000;
const SERIES_COLORS = ["#0f8b67", "#94a3b8", "#087a5a", "#7c3aed", "#0f766e"];
const WIDTH = 920;
const HEIGHT = 360;
const PLOT_LEFT = 18;
const PLOT_RIGHT = 890;
const PLOT_TOP = 28;
const PLOT_BOTTOM = 286;
const OFI_HEIGHT = 190;
const OFI_PLOT_TOP = 28;
const OFI_PLOT_BOTTOM = 142;

function fmtPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${Math.round(value * 100)}%`;
}

function fmtCurrencyCompact(value: number | null | undefined) {
  if (value === null || value === undefined || value <= 0) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function priceFromBook(book: OrderBook) {
  return book.midpoint ?? book.bestAsk ?? book.bestBid ?? book.lastTradePrice;
}

function pathFor(points: ChartPoint[], min: number, max: number, start: number, end: number, top = PLOT_TOP, bottom = PLOT_BOTTOM) {
  const drawable = points
    .filter((point) => point.value !== null && point.timestamp >= start && point.timestamp <= end)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (drawable.length === 0) return "";
  const span = Math.max(end - start, 1);
  const carried = [
    { timestamp: start, value: drawable[0].value },
    ...drawable,
    { timestamp: end, value: drawable[drawable.length - 1].value }
  ];

  return carried.map((point, index) => {
    const x = PLOT_LEFT + ((point.timestamp - start) / span) * (PLOT_RIGHT - PLOT_LEFT);
    const y = yForValue(Number(point.value), min, max, top, bottom);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function yForValue(value: number, min: number, max: number, top = PLOT_TOP, bottom = PLOT_BOTTOM) {
  const priceSpan = Math.max(max - min, 0.001);
  return top + (1 - ((value - min) / priceSpan)) * (bottom - top);
}

function xLabel(timestamp: number | null) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function MarketPriceChart({ tokenIds, outcomeNames, marketVolume, marketLiquidity }: { tokenIds: string[]; outcomeNames: string[]; marketVolume?: number | null; marketLiquidity?: number | null }) {
  const [seriesPoints, setSeriesPoints] = useState<Record<string, ChartPoint[]>>({});
  const [ofiSeriesPoints, setOfiSeriesPoints] = useState<Record<string, ChartPoint[]>>({});
  const [clock, setClock] = useState(() => Date.now());
  const books = useOrderBooks(tokenIds);
  const lastBookKeys = useRef<Record<string, string>>({});

  useEffect(() => {
    const activeTokenIds = tokenIds.filter(Boolean);
    if (activeTokenIds.length === 0) return;
    setSeriesPoints({});
    setOfiSeriesPoints({});
    lastBookKeys.current = {};
  }, [tokenIds.join("|")]);

  useEffect(() => {
    const now = Date.now();
    const changedBooks = tokenIds
      .map((tokenId) => books[tokenId])
      .filter((book): book is OrderBook => Boolean(book))
      .filter((book) => {
        const key = `${book.lastUpdateTime ?? ""}:${book.bestBid ?? ""}:${book.bestAsk ?? ""}:${book.lastTradePrice ?? ""}:${book.ofi?.rollingOfi30s ?? ""}`;
        if (lastBookKeys.current[book.tokenId] === key) return false;
        lastBookKeys.current[book.tokenId] = key;
        return true;
      });

    if (changedBooks.length === 0) return;
    setSeriesPoints((current) => {
      const next = { ...current };
      changedBooks.forEach((book) => {
        next[book.tokenId] = [
          ...(next[book.tokenId] ?? []).filter((point) => now - point.timestamp <= CHART_WINDOW_MS),
          {
            timestamp: now,
            value: priceFromBook(book)
          }
        ];
      });
      return next;
    });
    setOfiSeriesPoints((current) => {
      const next = { ...current };
      changedBooks.forEach((book) => {
        next[book.tokenId] = [
          ...(next[book.tokenId] ?? []).filter((point) => now - point.timestamp <= CHART_WINDOW_MS),
          {
            timestamp: now,
            value: book.ofi?.rollingOfi30s ?? null
          }
        ];
      });
      return next;
    });
  }, [books, tokenIds]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 2_000);
    return () => window.clearInterval(interval);
  }, []);

  const { min, max, series } = useMemo(() => {
    const minValue = 0;
    const maxValue = 1;
    const end = clock;
    const start = end - CHART_WINDOW_MS;
    return {
      min: minValue,
      max: maxValue,
      series: tokenIds.map((tokenId, index) => {
        const points = seriesPoints[tokenId] ?? [];
        const last = points[points.length - 1]?.value ?? null;
        return {
          tokenId,
          outcomeName: outcomeNames[index] ?? `Outcome ${index + 1}`,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          points,
          path: pathFor(points, minValue, maxValue, start, end),
          last,
          endpointY: last === null ? null : yForValue(last, minValue, maxValue)
        };
      })
    };
  }, [clock, outcomeNames, seriesPoints, tokenIds]);

  const totalSnapshots = series.reduce((sum, item) => sum + item.points.length, 0);
  const startTimestamp = clock - CHART_WINDOW_MS;
  const midTimestamp = startTimestamp + CHART_WINDOW_MS / 2;
  const ofiSeries = useMemo(() => {
    const end = clock;
    const start = end - CHART_WINDOW_MS;
    const visibleValues = tokenIds.flatMap((tokenId) => (
      (ofiSeriesPoints[tokenId] ?? [])
        .filter((point) => point.value !== null && point.timestamp >= start && point.timestamp <= end)
        .map((point) => Math.abs(Number(point.value)))
    ));
    const limit = Math.max(1, ...visibleValues);
    return tokenIds.map((tokenId, index) => {
      const points = ofiSeriesPoints[tokenId] ?? [];
      const last = points[points.length - 1]?.value ?? null;
      return {
        tokenId,
        outcomeName: outcomeNames[index] ?? `Outcome ${index + 1}`,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        points,
        path: pathFor(points, -limit, limit, start, end, OFI_PLOT_TOP, OFI_PLOT_BOTTOM),
        last,
        endpointY: last === null ? null : yForValue(Math.max(-limit, Math.min(limit, last)), -limit, limit, OFI_PLOT_TOP, OFI_PLOT_BOTTOM)
      };
    });
  }, [clock, ofiSeriesPoints, outcomeNames, tokenIds]);
  const ofiSnapshots = ofiSeries.reduce((sum, item) => sum + item.points.length, 0);

  return (
    <section style={{ overflow: "hidden", borderRadius: 6, border: "1px solid #26323c", background: "#12181e", color: "#cbd5e1" }}>
      <div style={{ display: "flex", height: 44, alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #24313b", padding: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>
          <LineChart style={{ width: 16, height: 16 }} />
          Win Probability
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>2h order book midpoint</div>
      </div>
      <div style={{ padding: 0 }}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ display: "block", width: "100%", height: 360, background: "#12181e" }} role="img" aria-label={`${outcomeNames.join(", ")} win probability chart`}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1={PLOT_LEFT}
              x2={PLOT_RIGHT}
              y1={PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP)}
              y2={PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP)}
              stroke="#334554"
              strokeDasharray="1 6"
              strokeWidth="1.2"
            />
          ))}
          {series.map((item) => item.path && (
            <path key={item.tokenId} d={item.path} fill="none" stroke={item.color} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          <g>
            <rect x={PLOT_LEFT + 8} y={PLOT_TOP + 8} width="188" height={Math.max(36, series.length * 24 + 14)} rx="6" fill="#12181e" opacity="0.82" />
            {series.map((item, index) => (
              <g key={`${item.tokenId}-corner-percent`}>
                <circle cx={PLOT_LEFT + 22} cy={PLOT_TOP + 30 + index * 24} r="4" fill={item.color} />
                <text
                  x={PLOT_LEFT + 34}
                  y={PLOT_TOP + 35 + index * 24}
                  fill={item.color}
                  fontSize="14"
                  fontWeight="800"
                  fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
                >
                  {item.outcomeName}: {fmtPercent(item.last)}
                </text>
              </g>
            ))}
          </g>
          {series.map((item) => item.endpointY !== null && (
            <g key={`${item.tokenId}-dot`}>
              <circle cx={PLOT_RIGHT} cy={item.endpointY ?? 0} r="16" fill={item.color} opacity="0.16" />
              <circle cx={PLOT_RIGHT} cy={item.endpointY ?? 0} r="5" fill={item.color} />
            </g>
          ))}
          <text x={PLOT_LEFT} y={PLOT_TOP - 8} fill="#94a3b8" fontSize="12" fontWeight="700" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">100%</text>
          <text x={PLOT_LEFT} y={PLOT_BOTTOM + 16} fill="#94a3b8" fontSize="12" fontWeight="700" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">0%</text>
          <text x={PLOT_LEFT} y={PLOT_BOTTOM + 34} fill="#334155" fontSize="15" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(startTimestamp)}</text>
          <text x={PLOT_LEFT + 310} y={PLOT_BOTTOM + 34} fill="#334155" fontSize="15" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(midTimestamp)}</text>
          <text x={PLOT_LEFT + 615} y={PLOT_BOTTOM + 34} fill="#334155" fontSize="15" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(clock)}</text>
          <text x={PLOT_LEFT} y={HEIGHT - 12} fill="#94a3b8" fontSize="12" fontWeight="800" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">
            Volume: {fmtCurrencyCompact(marketVolume)}  Liquidity: {fmtCurrencyCompact(marketLiquidity)}
          </text>
          {totalSnapshots === 0 && (
            <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fill="#94a3b8" fontSize="14" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">Waiting for order book data</text>
          )}
        </svg>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, borderTop: "1px solid #24313b", padding: "8px 16px", fontSize: 12, color: "#94a3b8" }}>
          {series.map((item) => (
            <span key={item.tokenId}><span style={{ display: "inline-block", width: 20, height: 8, marginRight: 4, borderRadius: 999, backgroundColor: item.color }} />{item.outcomeName}</span>
          ))}
          <span style={{ marginLeft: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>2h window · {totalSnapshots} snapshots</span>
        </div>
        <div style={{ borderTop: "1px solid #24313b" }}>
          <div style={{ display: "flex", height: 38, alignItems: "center", justifyContent: "space-between", padding: "0 16px", fontSize: 12, color: "#94a3b8" }}>
            <span style={{ fontWeight: 700, color: "#e2e8f0" }}>Rolling Standardized OFI</span>
            <span>10m window</span>
          </div>
          <svg viewBox={`0 0 ${WIDTH} ${OFI_HEIGHT}`} style={{ display: "block", width: "100%", height: 190, background: "#12181e" }} role="img" aria-label={`${outcomeNames.join(", ")} rolling standardized OFI chart`}>
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                key={ratio}
                x1={PLOT_LEFT}
                x2={PLOT_RIGHT}
                y1={OFI_PLOT_TOP + ratio * (OFI_PLOT_BOTTOM - OFI_PLOT_TOP)}
                y2={OFI_PLOT_TOP + ratio * (OFI_PLOT_BOTTOM - OFI_PLOT_TOP)}
                stroke="#273846"
                strokeDasharray="1 6"
                strokeWidth="1"
              />
            ))}
            <line
              x1={PLOT_LEFT}
              x2={PLOT_RIGHT}
              y1={yForValue(0, -1, 1, OFI_PLOT_TOP, OFI_PLOT_BOTTOM)}
              y2={yForValue(0, -1, 1, OFI_PLOT_TOP, OFI_PLOT_BOTTOM)}
              stroke="#64748b"
              strokeWidth="1.4"
            />
            {ofiSeries.map((item) => item.path && (
              <path key={`${item.tokenId}-ofi`} d={item.path} fill="none" stroke={item.color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {ofiSeries.map((item) => item.endpointY !== null && (
              <circle key={`${item.tokenId}-ofi-dot`} cx={PLOT_RIGHT} cy={item.endpointY ?? 0} r="4" fill={item.color} />
            ))}
            <text x={PLOT_LEFT} y={OFI_PLOT_TOP - 8} fill="#94a3b8" fontSize="12" fontWeight="700" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">+</text>
            <text x={PLOT_LEFT} y={OFI_PLOT_BOTTOM + 16} fill="#94a3b8" fontSize="12" fontWeight="700" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">-</text>
            <text x={PLOT_LEFT + 6} y={yForValue(0, -1, 1, OFI_PLOT_TOP, OFI_PLOT_BOTTOM) - 5} fill="#94a3b8" fontSize="11" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">0</text>
            {ofiSnapshots === 0 && (
              <text x={WIDTH / 2} y={OFI_HEIGHT / 2} textAnchor="middle" fill="#94a3b8" fontSize="13" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">Waiting for OFI data</text>
            )}
            <text x={PLOT_LEFT} y={OFI_PLOT_BOTTOM + 34} fill="#334155" fontSize="14" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(startTimestamp)}</text>
            <text x={PLOT_LEFT + 310} y={OFI_PLOT_BOTTOM + 34} fill="#334155" fontSize="14" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(midTimestamp)}</text>
            <text x={PLOT_LEFT + 615} y={OFI_PLOT_BOTTOM + 34} fill="#334155" fontSize="14" fontFamily="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">{xLabel(clock)}</text>
          </svg>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, borderTop: "1px solid #24313b", padding: "8px 16px", fontSize: 12, color: "#94a3b8" }}>
            {ofiSeries.map((item) => (
              <span key={`${item.tokenId}-ofi-legend`}>
                <span style={{ display: "inline-block", width: 20, height: 8, marginRight: 4, borderRadius: 999, backgroundColor: item.color }} />
                {item.outcomeName}: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{item.last === null ? "-" : item.last.toFixed(2)}</span>
              </span>
            ))}
            <span style={{ marginLeft: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{ofiSnapshots} snapshots</span>
          </div>
        </div>
      </div>
    </section>
  );
}
