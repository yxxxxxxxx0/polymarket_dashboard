import { config } from "../config.js";

const cache = new Map<string, { expiresAt: number; value: { volume: number; liquidity: number; raw: unknown } | null }>();

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataFromRaw(raw: Record<string, unknown>) {
  return {
    volume: numeric(raw.volumeNum) || numeric(raw.volumeClob) || numeric(raw.volume),
    liquidity: numeric(raw.liquidityNum) || numeric(raw.liquidityClob) || numeric(raw.liquidity),
    raw
  };
}

async function fetchGamma(pathname: string) {
  const response = await fetch(`https://gamma-api.polymarket.com${pathname}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Market metadata request failed with status ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

export async function fetchMarketMetadata(marketId: string) {
  const cached = cache.get(marketId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const raw = await fetchGamma(`/events/${encodeURIComponent(marketId)}`).catch(() => fetchGamma(`/markets/${encodeURIComponent(marketId)}`));
    const value = metadataFromRaw(raw);
    cache.set(marketId, { expiresAt: Date.now() + config.MARKET_STATS_REFRESH_MS, value });
    return value;
  } catch {
    cache.set(marketId, { expiresAt: Date.now() + config.MARKET_STATS_REFRESH_MS, value: null });
    return null;
  }
}
