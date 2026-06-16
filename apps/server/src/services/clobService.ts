import {
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize
} from "@polymarket/clob-client-v2";
import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { balanceSignatureType, config, orderSignatureType } from "../config.js";
import { HttpError } from "../lib/http.js";
import { fetchWithTimeout, withTimeout } from "../lib/timeout.js";
import { createLimiter } from "../lib/concurrency.js";
import { getCachedOrderBook, hasFreshOrderBook, subscribeTokens, updateCachedOrderBook } from "./orderbookCache.js";
import { assertConfiguredMarket, assertConfiguredToken } from "./singleMarketService.js";
import type { OrderBook } from "../types/domain.js";

let balanceClientPromise: Promise<ClobClient> | null = null;
let tradingClientPromise: Promise<ClobClient> | null = null;
const orderbookFetchLimiter = createLimiter(config.ORDERBOOK_FETCH_CONCURRENCY);

export type LiveOrderResponse = {
  success?: boolean;
  error?: string;
  errorMsg?: string;
  status?: string | number;
  orderID?: string;
  transactionsHashes?: string[];
  tradeIDs?: string[];
  takingAmount?: string;
  makingAmount?: string;
};

export function assertLiveOrderAccepted(response: LiveOrderResponse): LiveOrderResponse {
  if (response.error || response.success === false) {
    throw new HttpError(400, response.errorMsg || response.error || "Polymarket rejected the order");
  }

  if (!response.orderID) {
    throw new HttpError(502, `Polymarket did not return an order id: ${JSON.stringify(response)}`);
  }

  return response;
}

function credentialsFromEnv(): ApiKeyCreds | undefined {
  if (!config.POLYMARKET_API_KEY || !config.POLYMARKET_API_SECRET || !config.POLYMARKET_API_PASSPHRASE) {
    return undefined;
  }

  return {
    key: config.POLYMARKET_API_KEY,
    secret: config.POLYMARKET_API_SECRET,
    passphrase: config.POLYMARKET_API_PASSPHRASE
  };
}

async function buildClobClient(signatureType: number): Promise<ClobClient> {
  if (!config.PRIVATE_KEY) {
    throw new HttpError(400, "PRIVATE_KEY is required for live trading");
  }

  const account = privateKeyToAccount(config.PRIVATE_KEY as `0x${string}`);
  const signer = createWalletClient({ account, transport: http(config.POLYGON_RPC_URL) });
  const creds = credentialsFromEnv()
    ?? await withTimeout(
      () => new ClobClient({ host: config.POLYMARKET_CLOB_HOST, chain: 137, signer }).createOrDeriveApiKey(),
      config.POLYMARKET_FETCH_TIMEOUT_MS,
      "Polymarket API key derivation"
    );

  return new ClobClient({
    host: config.POLYMARKET_CLOB_HOST,
    chain: 137,
    signer,
    creds,
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: config.DEPOSIT_WALLET_ADDRESS,
    throwOnError: true
  });
}

export async function getBalanceClobClient(): Promise<ClobClient> {
  if (!balanceClientPromise) {
    balanceClientPromise = buildClobClient(balanceSignatureType);
  }
  return balanceClientPromise;
}

export async function getTradingClobClient(): Promise<ClobClient> {
  if (!tradingClientPromise) {
    tradingClientPromise = buildClobClient(orderSignatureType);
  }
  return tradingClientPromise;
}

export async function getClobClient(): Promise<ClobClient> {
  return getTradingClobClient();
}

async function withSecondPrecisionTimestamp<T>(fn: () => Promise<T>) {
  const originalNow = Date.now;
  Date.now = () => Math.floor(originalNow() / 1_000);
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

export async function fetchOrderBook(tokenId: string, options: { force?: boolean; maxAgeMs?: number } = {}): Promise<OrderBook> {
  assertConfiguredToken(tokenId);
  subscribeTokens([tokenId]);
  if (!options.force && hasFreshOrderBook(tokenId, options.maxAgeMs ?? config.ORDERBOOK_REFRESH_MS)) {
    return getCachedOrderBook(tokenId);
  }
  try {
    const response = await orderbookFetchLimiter(() => fetchWithTimeout(`${config.POLYMARKET_CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`, {
        headers: { accept: "application/json" },
        cache: "no-store"
      }, config.POLYMARKET_ORDERBOOK_TIMEOUT_MS)
    );
    if (!response.ok) throw new Error(`Order book request failed with status ${response.status}`);
    const raw = await response.json() as { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[]; market?: string; asset_id?: string; timestamp?: string; hash?: string };
    const book = getCachedOrderBook(tokenId);
    const next = {
      ...book,
      market: raw.market ?? book.market,
      bids: Array.isArray(raw?.bids) ? raw.bids.map((level: { price: string; size: string }) => ({
        price: Number(level.price),
        size: Number(level.size)
      })) : book.bids,
      asks: Array.isArray(raw?.asks) ? raw.asks.map((level: { price: string; size: string }) => ({
        price: Number(level.price),
        size: Number(level.size)
      })) : book.asks,
      lastUpdateTime: new Date().toISOString()
    };
    const bids = [...next.bids].sort((a, b) => b.price - a.price);
    const asks = [...next.asks].sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const bidDepth = bids.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
    const askDepth = asks.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
    return updateCachedOrderBook({
      ...next,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      midpoint: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      depthImbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null
    });
  } catch {
    return getCachedOrderBook(tokenId);
  }
}

export async function createLiveOrder(input: {
  marketId?: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  tickSize?: TickSize;
  negRisk?: boolean;
}): Promise<LiveOrderResponse> {
  assertConfiguredMarket(input.marketId);
  assertConfiguredToken(input.tokenId);
  const client = await getTradingClobClient();
  const userOrder = {
    tokenID: input.tokenId,
    price: input.price,
    size: input.size,
    side: input.side === "BUY" ? Side.BUY : Side.SELL
  };
  const orderOptions = {
    tickSize: input.tickSize ?? "0.01",
    ...(input.negRisk === undefined ? {} : { negRisk: input.negRisk })
  };
  const response = orderSignatureType === 3
    ? await withTimeout(
      async () => client.postOrder(await withSecondPrecisionTimestamp(() => client.createOrder(userOrder, orderOptions)), OrderType.GTC) as Promise<LiveOrderResponse>,
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket order submit"
    )
    : await withTimeout(
      () => client.createAndPostOrder(userOrder, orderOptions, OrderType.GTC) as Promise<LiveOrderResponse>,
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket order submit"
    );

  return assertLiveOrderAccepted(response);
}

export async function cancelLiveOrder(orderId: string) {
  const client = await getTradingClobClient();
  return withTimeout(() => client.cancelOrder({ orderID: orderId }), config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS, "Polymarket order cancel");
}

export async function cancelLiveMarketOrders(marketId: string) {
  assertConfiguredMarket(marketId);
  const client = await getTradingClobClient();
  if (typeof (client as unknown as { cancelMarketOrders?: unknown }).cancelMarketOrders === "function") {
    return withTimeout(
      () => (client as unknown as { cancelMarketOrders: (market: string) => Promise<unknown> }).cancelMarketOrders(marketId),
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket market order cancel"
    );
  }
  const orders = await withTimeout(() => client.getOpenOrders(), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket open orders");
  const ids = (Array.isArray(orders) ? orders : [])
    .filter((order: { market?: string; marketId?: string }) => order.market === marketId || order.marketId === marketId)
    .map((order: { id?: string; orderID?: string }) => order.id ?? order.orderID)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return { cancelled: 0 };
  const cancelOrders = (client as unknown as { cancelOrders?: (ids: string[]) => Promise<unknown> }).cancelOrders;
  return cancelOrders ? withTimeout(() => cancelOrders(ids), config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS, "Polymarket order cancel batch") : undefined;
}

export async function getLiveOpenOrders() {
  const client = await getTradingClobClient();
  return withTimeout(() => client.getOpenOrders(), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket open orders");
}

export async function getLiveOrder(orderId: string) {
  const client = await getTradingClobClient();
  return withTimeout(() => client.getOrder(orderId), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket order lookup");
}

export async function getLiveTrades(params?: { id?: string; maker_address?: string; market?: string; asset_id?: string; before?: string; after?: string }) {
  const client = await getTradingClobClient();
  return withTimeout(() => client.getTrades(params), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket trades");
}
