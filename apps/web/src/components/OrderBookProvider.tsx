"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { OrderBook } from "@/lib/api";
import { useDashboardWs } from "@/hooks/useDashboardWs";

type OrderBookContextValue = {
  books: Record<string, OrderBook | undefined>;
  connected: boolean;
  lastUpdateAt: number | null;
  error: string | null;
};

const OrderBookContext = createContext<OrderBookContextValue>({ books: {}, connected: false, lastUpdateAt: null, error: null });

function uniqueTokens(tokenIds: string[]) {
  return [...new Set(tokenIds.filter(Boolean))];
}

export function OrderBookProvider({ tokenIds, profile, children }: { tokenIds: string[]; profile?: string; children: ReactNode }) {
  const tokens = useMemo(() => uniqueTokens(tokenIds), [tokenIds.join("|")]);
  const { books, connected, lastUpdateAt, error } = useDashboardWs({ tokenIds: tokens, profile });
  const value = useMemo(() => ({ books, connected, lastUpdateAt, error }), [books, connected, lastUpdateAt, error]);
  return <OrderBookContext.Provider value={value}>{children}</OrderBookContext.Provider>;
}

export function useOrderBook(tokenId: string) {
  return useContext(OrderBookContext).books[tokenId] ?? null;
}

export function useOrderBooks(tokenIds: string[]) {
  const { books } = useContext(OrderBookContext);
  return useMemo(
    () => Object.fromEntries(tokenIds.filter(Boolean).map((tokenId) => [tokenId, books[tokenId] ?? null])) as Record<string, OrderBook | null>,
    [books, tokenIds.join("|")]
  );
}

export function useOrderBookConnection() {
  const { connected, lastUpdateAt, error } = useContext(OrderBookContext);
  return { connected, lastUpdateAt, error };
}
