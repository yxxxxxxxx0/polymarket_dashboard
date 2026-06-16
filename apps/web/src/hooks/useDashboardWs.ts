"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { dashboardWsUrl, type MarketStats, type OrderBook } from "@/lib/api";

type DashboardMessage = { type?: string; [key: string]: unknown };

function isOrderBook(value: unknown): value is OrderBook {
  return Boolean(value && typeof value === "object" && "tokenId" in value && typeof (value as { tokenId?: unknown }).tokenId === "string");
}

function isMarketStatsMessage(value: DashboardMessage): value is DashboardMessage & MarketStats {
  return value.type === "market_stats" && typeof value.marketId === "string" && typeof value.updatedAt === "string";
}

type DashboardWsOptions = {
  profile?: string;
  tokenIds?: string[];
  marketStats?: boolean;
};

type DashboardWsState = {
  connected: boolean;
  lastUpdateAt: number | null;
  books: Record<string, OrderBook | undefined>;
  marketStats: MarketStats | null;
  error: string | null;
};

function uniqueTokens(tokenIds: string[]) {
  return [...new Set(tokenIds.filter(Boolean))];
}

export function useDashboardWs({ profile = "football", tokenIds = [], marketStats = false }: DashboardWsOptions): DashboardWsState {
  const tokens = useMemo(() => uniqueTokens(tokenIds), [tokenIds.join("|")]);
  const [connected, setConnected] = useState(false);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [books, setBooks] = useState<Record<string, OrderBook | undefined>>({});
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  useEffect(() => {
    let closed = false;
    setBooks({});
    setStats(null);
    setError(null);

    function clearReconnect() {
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    }

    function sendSubscriptions(ws: WebSocket) {
      if (tokens.length > 0) {
        ws.send(JSON.stringify({ type: "subscribe_orderbook", tokenIds: tokens, profile }));
      }
      if (marketStats) {
        ws.send(JSON.stringify({ type: "subscribe_market_stats", profile }));
      }
    }

    function connect() {
      clearReconnect();
      const ws = new WebSocket(dashboardWsUrl("/ws/dashboard"));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        sendSubscriptions(ws);
      };

      ws.onmessage = (event) => {
        let message: DashboardMessage;
        try {
          message = JSON.parse(event.data) as DashboardMessage;
        } catch {
          return;
        }
        setLastUpdateAt(Date.now());
        if (message.type === "orderbook" && isOrderBook(message.book)) {
          const book = message.book;
          setBooks((current) => ({ ...current, [book.tokenId]: book }));
          return;
        }
        if (isMarketStatsMessage(message)) {
          setStats(message);
          return;
        }
        if (message.type === "error") {
          setError(typeof message.message === "string" ? message.message : "Dashboard WebSocket error");
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) reconnectTimer.current = window.setTimeout(connect, 1_000);
      };

      ws.onerror = () => {
        setError("Dashboard WebSocket connection error");
        ws.close();
      };
    }

    connect();

    return () => {
      closed = true;
      clearReconnect();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [profile, marketStats, tokens.join("|")]);

  return { connected, lastUpdateAt, books, marketStats: stats, error };
}
