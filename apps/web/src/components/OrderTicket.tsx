"use client";

import { Loader2, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { API_BASE, api, post, withProfile } from "@/lib/api";
import { useAccount } from "./AccountProvider";
import { useOrderBook } from "./OrderBookProvider";

function fmtPrice(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "0.50" : value.toFixed(3);
}

function fmtShares(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "0" : value.toString();
}

function money(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "Unavailable" : `$${value.toFixed(2)}`;
}

function friendlyError(error: unknown, context?: { side: "buy" | "sell" }) {
  if (!(error instanceof Error)) return "Order failed";
  if (error.message === "Failed to fetch") return `Cannot reach the dashboard API at ${API_BASE || "the current web origin"}.`;
  const clobBalanceMatch = error.message.match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
  if (clobBalanceMatch) {
    const balance = Number(clobBalanceMatch[1]) / 1_000_000;
    const orderAmount = Number(clobBalanceMatch[2]) / 1_000_000;
    if (Number.isFinite(balance) && Number.isFinite(orderAmount)) {
      if (context?.side === "sell") {
        return `Sell size ${orderAmount.toFixed(6)} shares exceeds available shares ${balance.toFixed(6)}.`;
      }
      if (context?.side === "buy") {
        return `Buy amount $${orderAmount.toFixed(2)} exceeds spendable USDC $${balance.toFixed(2)}.`;
      }
      return `Order amount ${orderAmount.toFixed(6)} exceeds available balance ${balance.toFixed(6)}.`;
    }
  }
  return error.message;
}

type OrderSubmitResponse = {
  paper?: boolean;
  live?: boolean;
  exchangeOrderId?: string;
  order?: {
    id?: string;
    exchangeOrderId?: string | null;
  };
};

type TradingModeResponse = {
  tradeMode: "PAPER" | "LIVE";
  liveTradingAllowedByEnv: boolean;
  geo?: {
    blocked: boolean;
    closeOnly: boolean;
    canOpen: boolean;
    canClose: boolean;
    country?: string;
  };
};

export function OrderTicket({ profile, marketId, conditionId, tokenId, outcomeName }: {
  profile?: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcomeName?: string;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("0.50");
  const [size, setSize] = useState("1");
  const [tradeMode, setTradeMode] = useState<"PAPER" | "LIVE">("PAPER");
  const [message, setMessage] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "processing">("idle");
  const [notification, setNotification] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const book = useOrderBook(tokenId);
  const [tradingSettings, setTradingSettings] = useState<TradingModeResponse | null>(null);
  const { account, refreshAccount } = useAccount();

  useEffect(() => {
    api<TradingModeResponse>("/api/settings/trading-mode")
      .then((value) => {
        setTradeMode(value.tradeMode);
        setTradingSettings(value);
      })
      .catch(() => undefined);
  }, []);

  const currentPrice = useMemo(() => {
    if (!book) return null;
    if (side === "buy") return book.bestAsk ?? book.midpoint ?? book.bestBid ?? book.lastTradePrice;
    return book.bestBid ?? book.midpoint ?? book.bestAsk ?? book.lastTradePrice;
  }, [book, side]);

  const maxBuyNotional = useMemo(() => {
    const limits = [account?.cash, account?.allowance]
      .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value >= 0);
    return limits.length === 0 ? null : Math.min(...limits);
  }, [account?.allowance, account?.cash]);

  const maxSharesCanBuy = useMemo(() => {
    const outcome = account?.outcomes.find((item) => item.tokenId === tokenId);
    if (currentPrice && currentPrice > 0 && maxBuyNotional !== null) return maxBuyNotional / currentPrice;
    if (outcome?.sharesCanBuy !== null && outcome?.sharesCanBuy !== undefined) return outcome.sharesCanBuy;
    return null;
  }, [account?.outcomes, currentPrice, maxBuyNotional, tokenId]);

  const defaultSize = useMemo(() => {
    if (maxSharesCanBuy === null || maxSharesCanBuy === undefined || !Number.isFinite(maxSharesCanBuy)) return 0;
    return Math.max(0, Math.floor(maxSharesCanBuy) * 0.5);
  }, [maxSharesCanBuy]);

  const sellableShares = useMemo(() => {
    const matchingPositions = account?.positions.filter((position) => (
      position.tokenId === tokenId
      && position.side === "BUY"
      && Number.isFinite(position.size)
      && position.size > 0
    )) ?? [];
    const total = matchingPositions.reduce((sum, position) => sum + position.size, 0);
    return Number.isFinite(total) && total > 0 ? total : 0;
  }, [account?.positions, tokenId]);

  const defaultTicketSize = useMemo(() => (
    side === "sell" ? sellableShares : defaultSize
  ), [defaultSize, sellableShares, side]);

  useEffect(() => {
    setPrice(fmtPrice(currentPrice));
  }, [currentPrice]);

  useEffect(() => {
    setSize(fmtShares(defaultTicketSize));
  }, [defaultTicketSize]);

  const notional = Number(price) * Number(size);
  const numericPrice = Number(price);
  const isSubmitting = submitState !== "idle";
  const wouldCrossSpread = side === "buy"
    ? book?.bestAsk !== null && book?.bestAsk !== undefined && Number.isFinite(numericPrice) && numericPrice >= book.bestAsk
    : book?.bestBid !== null && book?.bestBid !== undefined && Number.isFinite(numericPrice) && numericPrice <= book.bestBid;
  const submitDisabledReason = useMemo(() => {
    if (!tokenId) return "Missing token";
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) return "Enter a valid price";
    if (!Number.isFinite(Number(size)) || Number(size) <= 0) return "Enter a valid size";
    if (!Number.isFinite(notional) || notional <= 0) return "Order amount must be greater than zero";
    if (tradeMode === "LIVE") {
      if (!tradingSettings?.liveTradingAllowedByEnv) return "Live trading is disabled in .env";
      if (side === "buy" && tradingSettings.geo && !tradingSettings.geo.canOpen) {
        return tradingSettings.geo.closeOnly ? "This location is close-only; buys are disabled" : "This location cannot open positions";
      }
      if (side === "sell" && tradingSettings.geo && !tradingSettings.geo.canClose) return "This location cannot close positions";
      if (side === "buy" && account?.cash !== null && account?.cash !== undefined && account.cash <= 0) return "Live cash balance is zero";
      if (side === "buy" && account?.allowance !== null && account?.allowance !== undefined && account.allowance <= 0) return "USDC allowance is zero";
      if (side === "buy" && account?.cash !== null && account?.cash !== undefined && Number.isFinite(account.cash) && notional > account.cash + 1e-9) {
        return `Order amount ${money(notional)} exceeds cash balance ${money(account.cash)}`;
      }
      if (side === "buy" && account?.allowance !== null && account?.allowance !== undefined && Number.isFinite(account.allowance) && notional > account.allowance + 1e-9) {
        return `Order amount ${money(notional)} exceeds USDC allowance ${money(account.allowance)}`;
      }
    }
    return "";
  }, [account, notional, price, side, size, tokenId, tradeMode, tradingSettings]);
  const maxTicketShares = side === "sell" ? sellableShares : maxSharesCanBuy;
  const integerMaxShares = maxTicketShares === null || maxTicketShares === undefined || !Number.isFinite(maxTicketShares)
    ? null
    : Math.floor(maxTicketShares);

  useEffect(() => {
    if (!notification) return;
    const timeout = window.setTimeout(() => setNotification(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notification]);

  async function changeMode(next: "PAPER" | "LIVE") {
    setTradeMode(next);
    await post<TradingModeResponse>("/api/settings/trading-mode", { tradeMode: next }).then((value) => {
      setTradeMode(value.tradeMode);
      setTradingSettings(value);
    }).catch((error) => {
      const text = friendlyError(error, { side });
      setMessage(text);
      setNotification({ kind: "error", text });
      setTradeMode("PAPER");
    });
  }

  async function submit() {
    if (isSubmitting) return;
    setMessage("");
    setNotification(null);
    if (submitDisabledReason) {
      setMessage(submitDisabledReason);
      setNotification({ kind: "error", text: submitDisabledReason });
      return;
    }
    setSubmitState("loading");
    try {
      setSubmitState("processing");
      const path = side === "buy" ? "/api/orders/buy" : "/api/orders/sell";
      const response = await post<OrderSubmitResponse>(withProfile(path, profile), { marketId, conditionId, tokenId, outcomeName, price, size, tradeMode });
      refreshAccount({ force: true });
      const orderId = response.exchangeOrderId ?? response.order?.exchangeOrderId ?? response.order?.id;
      const text = `${tradeMode === "LIVE" ? "Live" : "Paper"} ${side === "buy" ? "buy" : "sell"} order submitted for ${size} ${outcomeName ?? "shares"} at ${price}${orderId ? ` (${orderId})` : ""}.`;
      setMessage("");
      setNotification({ kind: "success", text });
    } catch (error) {
      const text = friendlyError(error, { side });
      setMessage(text);
      setNotification({ kind: "error", text });
    } finally {
      setSubmitState("idle");
    }
  }

  function setPriceToBest() {
    const next = side === "buy" ? book?.bestAsk : book?.bestBid;
    if (next !== null && next !== undefined) setPrice(fmtPrice(next));
  }

  function setPriceToCross() {
    const next = side === "buy"
      ? book?.bestAsk === null || book?.bestAsk === undefined ? null : Math.min(0.99, book.bestAsk + 0.01)
      : book?.bestBid === null || book?.bestBid === undefined ? null : Math.max(0.01, book.bestBid - 0.01);
    if (next !== null) setPrice(fmtPrice(next));
  }

  function setSizeToMax() {
    setSize(fmtShares(side === "sell" ? sellableShares : defaultSize));
  }

  return (
    <section className="rounded-md border border-line bg-white">
      <div className="h-11 border-b border-line px-3 py-3 text-sm font-semibold">Order Ticket</div>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 rounded-md border border-line bg-panel p-1">
          <button className={`h-8 rounded ${side === "buy" ? "bg-buy text-white" : ""}`} onClick={() => setSide("buy")}>Buy</button>
          <button className={`h-8 rounded ${side === "sell" ? "bg-sell text-white" : ""}`} onClick={() => setSide("sell")}>Sell</button>
        </div>
        <div className="grid grid-cols-2 rounded-md border border-line bg-panel p-1">
          <button className={`h-8 rounded ${tradeMode === "PAPER" ? "bg-ink text-white" : ""}`} onClick={() => changeMode("PAPER")}>Paper</button>
          <button className={`h-8 rounded ${tradeMode === "LIVE" ? "bg-warn text-white" : ""}`} onClick={() => changeMode("LIVE")}>Live</button>
        </div>
        <label className="block text-xs text-slate-600">
          Price
          <input className="control mt-1 w-full" value={price} onChange={(event) => setPrice(event.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button className="secondary-button h-8 text-xs" onClick={setPriceToBest} type="button">
            {side === "buy" ? "Best Ask" : "Best Bid"}
          </button>
          <button className="primary-button h-8 text-xs" onClick={setPriceToCross} type="button">
            Cross Spread
          </button>
        </div>
        <label className="block text-xs text-slate-600">
          Size
          <input className="control mt-1 w-full" value={size} onChange={(event) => setSize(event.target.value)} />
        </label>
        <button className="secondary-button h-8 w-full text-xs" onClick={setSizeToMax} type="button">
          {side === "sell" ? "Sell All Shares" : "Use Default Size"}
        </button>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line text-xs">
          <div className="bg-white p-2">
            <div className="text-slate-500">{side === "sell" ? "Sellable shares" : "Max shares"}</div>
            <div className="font-mono font-semibold">{integerMaxShares === null ? "Unavailable" : integerMaxShares.toString()}</div>
          </div>
          <div className="bg-white p-2">
            <div className="text-slate-500">Ticket amount</div>
            <div className="font-mono font-semibold">{money(Number.isFinite(notional) ? notional : null)}</div>
          </div>
          <div className="col-span-2 bg-white p-2 text-slate-500">
            {Number.isFinite(numericPrice) && book ? (wouldCrossSpread ? "Crossing price" : "Resting price") : "Waiting for live spread"}
          </div>
        </div>
        <button className="primary-button w-full" onClick={submit} disabled={isSubmitting || Boolean(submitDisabledReason)}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {submitState === "loading" ? "Loading..." : submitState === "processing" ? "Processing..." : "Submit"}
        </button>
        {submitDisabledReason && <div className="rounded-md bg-panel p-2 text-xs text-slate-600">{submitDisabledReason}</div>}
        {isSubmitting && <div className="rounded-md bg-panel p-2 text-xs text-slate-600">Sending order to the backend...</div>}
        {message && <div className="rounded-md bg-panel p-2 text-xs">{message}</div>}
      </div>
      {notification && (
        <div className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-md border px-4 py-3 text-sm shadow-lg ${notification.kind === "success" ? "border-buy/30 bg-buy text-white" : "border-sell/30 bg-sell text-white"}`}>
          <div className="font-semibold">{notification.kind === "success" ? "Order submitted" : "Order failed"}</div>
          <div className="mt-1 text-xs opacity-90">{notification.text}</div>
        </div>
      )}
    </section>
  );
}
