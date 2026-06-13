"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, streamUrl, UI_REFRESH_MS, withProfile, type OrderBook } from "@/lib/api";

type OrderBookContextValue = {
  books: Record<string, OrderBook | undefined>;
};

const OrderBookContext = createContext<OrderBookContextValue>({ books: {} });

function uniqueTokens(tokenIds: string[]) {
  return [...new Set(tokenIds.filter(Boolean))];
}

export function OrderBookProvider({ tokenIds, profile, children }: { tokenIds: string[]; profile?: string; children: ReactNode }) {
  const tokens = useMemo(() => uniqueTokens(tokenIds), [tokenIds.join("|")]);
  const [books, setBooks] = useState<Record<string, OrderBook | undefined>>({});

  useEffect(() => {
    if (tokens.length === 0) {
      setBooks({});
      return;
    }

    setBooks({});
    const updateBook = (book: OrderBook) => {
      setBooks((current) => ({ ...current, [book.tokenId]: book }));
    };

    const loadBooks = () => {
      tokens.forEach((tokenId) => {
        api<OrderBook>(withProfile(`/api/orderbook/${tokenId}`, profile)).then(updateBook).catch(() => undefined);
      });
    };

    loadBooks();
    const poll = window.setInterval(loadBooks, UI_REFRESH_MS);
    const sources = tokens.map((tokenId) => {
      const source = new EventSource(streamUrl(`/api/stream/orderbook?tokenId=${encodeURIComponent(tokenId)}`, profile));
      source.onmessage = (event) => updateBook(JSON.parse(event.data) as OrderBook);
      return source;
    });

    return () => {
      window.clearInterval(poll);
      sources.forEach((source) => source.close());
    };
  }, [profile, tokens.join("|")]);

  const value = useMemo(() => ({ books }), [books]);
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
