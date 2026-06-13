export type PriceLevel = {
  price: number;
  size: number;
};

export type OfiSummary = {
  rawOfi: number;
  rollingRawOfi30s: number;
  rollingOfi30s: number;
  signal30s: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
  rollingRawOfi2m: number;
  rollingOfi2m: number;
  signal2m: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
  windows: {
    "30s": {
      rollingRawOfi: number;
      rollingOfi: number;
      windowSeconds: number;
      signal: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
    };
    "2m": {
      rollingRawOfi: number;
      rollingOfi: number;
      windowSeconds: number;
      signal: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
    };
  };
};

export type OrderBook = {
  tokenId: string;
  market?: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  depthImbalance: number | null;
  lastTradePrice: number | null;
  lastUpdateTime: string | null;
  ofi?: OfiSummary;
};

export type MarketSummary = {
  id: string;
  conditionId?: string;
  slug?: string;
  title: string;
  event?: string;
  outcomes: string[];
  tokenIds: string[];
  volume: number;
  liquidity: number;
  endDate?: string;
  active: boolean;
  closed: boolean;
  category?: string;
  raw: unknown;
};

export type GeoblockResult = {
  blocked: boolean;
  closeOnly: boolean;
  canOpen: boolean;
  canClose: boolean;
  country?: string;
  region?: string;
  ip?: string;
};
