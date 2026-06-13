import type { OrderBook } from "../types/domain.js";

export type OfiObservation = {
  timestamp: number;
  rawOfi: number;
  bidDepth: number;
  askDepth: number;
  bestBid: number | null;
  bestAsk: number | null;
};

export type RollingOfiConfig = {
  windowSeconds: number;
  strongBuyThreshold: number;
  buyThreshold: number;
  sellThreshold: number;
  strongSellThreshold: number;
};

export type OfiState = {
  rawOfi: number;
  rollingRawOfi: number;
  rollingOfi: number;
  windowSeconds: number;
  signal: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
  observations: OfiObservation[];
};

export type OfiWindowState = {
  rollingRawOfi: number;
  rollingOfi: number;
  windowSeconds: number;
  signal: OfiState["signal"];
};

const EPSILON = 1e-9;

function levelDepth(book: OrderBook, side: "bids" | "asks") {
  return book[side].slice(0, 10).reduce((sum, level) => sum + level.size, 0);
}

export function calculateRawOfi(previous: OrderBook | null, next: OrderBook) {
  if (!previous) return 0;

  const prevBid = previous.bids[0];
  const nextBid = next.bids[0];
  const prevAsk = previous.asks[0];
  const nextAsk = next.asks[0];

  if (!prevBid || !nextBid || !prevAsk || !nextAsk) return 0;

  const bidFlow =
    (nextBid.price >= prevBid.price ? nextBid.size : 0)
    - (nextBid.price <= prevBid.price ? prevBid.size : 0);
  const askFlow =
    (nextAsk.price <= prevAsk.price ? nextAsk.size : 0)
    - (nextAsk.price >= prevAsk.price ? prevAsk.size : 0);

  return bidFlow - askFlow;
}

export function trimOfiObservations(observations: OfiObservation[], now: number, windowSeconds: number) {
  const minTimestamp = now - windowSeconds * 1000;
  return observations.filter((observation) => observation.timestamp >= minTimestamp);
}

export function classifyRollingOfi(value: number, config: RollingOfiConfig): OfiState["signal"] {
  if (value >= config.strongBuyThreshold) return "Strong Buy Flow";
  if (value >= config.buyThreshold) return "Buy Flow";
  if (value <= config.strongSellThreshold) return "Strong Sell Flow";
  if (value <= config.sellThreshold) return "Sell Flow";
  return "Neutral";
}

export function calculateRollingOfi(observations: OfiObservation[], config: RollingOfiConfig) {
  const rollingRawOfi = observations.reduce((sum, observation) => sum + observation.rawOfi, 0);
  const denominator = observations.reduce((sum, observation) => sum + Math.abs(observation.rawOfi), 0);
  const rollingOfi = denominator > EPSILON ? rollingRawOfi / denominator : 0;

  return {
    rollingRawOfi,
    rollingOfi,
    signal: classifyRollingOfi(rollingOfi, config)
  };
}

export function calculateRollingOfiWindow(
  observations: OfiObservation[],
  now: number,
  config: RollingOfiConfig
): OfiWindowState {
  const windowObservations = trimOfiObservations(observations, now, config.windowSeconds);
  const rolling = calculateRollingOfi(windowObservations, config);
  return {
    ...rolling,
    windowSeconds: config.windowSeconds
  };
}

export function appendOfiObservation(input: {
  previous: OrderBook | null;
  next: OrderBook;
  observations: OfiObservation[];
  now?: number;
  config: RollingOfiConfig;
}): OfiState {
  const now = input.now ?? Date.now();
  const rawOfi = calculateRawOfi(input.previous, input.next);
  const observation: OfiObservation = {
    timestamp: now,
    rawOfi,
    bidDepth: levelDepth(input.next, "bids"),
    askDepth: levelDepth(input.next, "asks"),
    bestBid: input.next.bestBid,
    bestAsk: input.next.bestAsk
  };
  const observations = trimOfiObservations([...input.observations, observation], now, input.config.windowSeconds);
  const rolling = calculateRollingOfi(observations, input.config);

  return {
    rawOfi,
    ...rolling,
    windowSeconds: input.config.windowSeconds,
    signal: rolling.signal,
    observations
  };
}
