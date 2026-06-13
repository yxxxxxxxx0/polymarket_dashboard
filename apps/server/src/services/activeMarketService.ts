import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";

const activeMarketOutcomeSchema = z.object({
  name: z.string().min(1),
  envKey: z.string().min(1),
  tokenId: z.string().min(1)
});

const activeMarketSchema = z.object({
  marketId: z.string().min(1),
  conditionId: z.string().min(1),
  title: z.string().min(1),
  outcomes: z.array(activeMarketOutcomeSchema).min(2)
});

export type ActiveMarket = z.infer<typeof activeMarketSchema>;

export const DEFAULT_MARKET_PROFILE = "football";

const marketProfileStorage = new AsyncLocalStorage<string>();
const cachedActiveMarkets = new Map<string, ActiveMarket>();
const loadedActiveMarketProfiles = new Set<string>();
const knownMarketProfiles = new Set<string>([DEFAULT_MARKET_PROFILE]);

export function normalizeMarketProfile(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const profile = String(raw ?? DEFAULT_MARKET_PROFILE).trim().toLowerCase();
  if (!profile || profile === "default") return DEFAULT_MARKET_PROFILE;
  if (!/^[a-z0-9-]+$/.test(profile)) throw new HttpError(400, "Invalid market profile.");
  return profile;
}

export function currentMarketProfile() {
  return marketProfileStorage.getStore() ?? DEFAULT_MARKET_PROFILE;
}

export function withMarketProfile<T>(profile: unknown, callback: () => T): T {
  const normalized = normalizeMarketProfile(profile);
  return marketProfileStorage.run(normalized, callback);
}

export function enterMarketProfile(profile: unknown) {
  const normalized = normalizeMarketProfile(profile);
  marketProfileStorage.enterWith(normalized);
}

export function getKnownMarketProfiles() {
  return [...knownMarketProfiles];
}

function repoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(path.join("apps", "server"))) return path.resolve(cwd, "../..");
  return cwd;
}

export function activeMarketPath(profile = currentMarketProfile()) {
  const normalized = normalizeMarketProfile(profile);
  const fileName = normalized === DEFAULT_MARKET_PROFILE ? "active-market.json" : `active-market.${normalized}.json`;
  return path.join(repoRoot(), "config", fileName);
}

function fallbackOutcomes() {
  const candidates = [
    ["POLYMARKET_OUTCOME_1_TOKEN_ID", config.POLYMARKET_OUTCOME_1_TOKEN_ID, config.POLYMARKET_OUTCOME_1_NAME],
    ["POLYMARKET_CANADA_TOKEN_ID", config.POLYMARKET_CANADA_TOKEN_ID, "Canada"],
    ["POLYMARKET_MEXICO_TOKEN_ID", config.POLYMARKET_MEXICO_TOKEN_ID, "Mexico"],
    ["POLYMARKET_USA_TOKEN_ID", process.env.POLYMARKET_USA_TOKEN_ID, "United States"],
    ["POLYMARKET_DRAW_TOKEN_ID", config.POLYMARKET_DRAW_TOKEN_ID, config.POLYMARKET_OUTCOME_2_NAME ?? "Draw"],
    ["POLYMARKET_OUTCOME_2_TOKEN_ID", config.POLYMARKET_OUTCOME_2_TOKEN_ID, config.POLYMARKET_OUTCOME_2_NAME],
    ["POLYMARKET_OUTCOME_3_TOKEN_ID", config.POLYMARKET_OUTCOME_3_TOKEN_ID, config.POLYMARKET_OUTCOME_3_NAME],
    ["POLYMARKET_BOSNIA_TOKEN_ID", config.POLYMARKET_BOSNIA_TOKEN_ID, "Bosnia"],
    ["POLYMARKET_SOUTH_AFRICA_TOKEN_ID", config.POLYMARKET_SOUTH_AFRICA_TOKEN_ID, "South Africa"],
    ["POLYMARKET_PARAGUAY_TOKEN_ID", process.env.POLYMARKET_PARAGUAY_TOKEN_ID, "Paraguay"]
  ];
  const seen = new Set<string>();
  return candidates
    .filter(([, tokenId]) => tokenId && !String(tokenId).startsWith("missing-"))
    .map(([envKey, tokenId, name]) => ({ envKey: String(envKey), tokenId: String(tokenId), name: String(name ?? nameFromEnvKey(String(envKey))) }))
    .filter((outcome) => {
      if (seen.has(outcome.tokenId)) return false;
      seen.add(outcome.tokenId);
      return true;
    });
}

function fallbackActiveMarket(): ActiveMarket {
  return activeMarketSchema.parse({
    marketId: config.POLYMARKET_MARKET_ID,
    conditionId: config.POLYMARKET_CONDITION_ID,
    title: config.POLYMARKET_MARKET_TITLE,
    outcomes: fallbackOutcomes()
  });
}

export async function getActiveMarket(options: { force?: boolean; profile?: string } = {}): Promise<ActiveMarket> {
  const profile = normalizeMarketProfile(options.profile ?? currentMarketProfile());
  knownMarketProfiles.add(profile);
  if (!options.force && loadedActiveMarketProfiles.has(profile) && cachedActiveMarkets.has(profile)) return cachedActiveMarkets.get(profile) as ActiveMarket;
  try {
    const raw = await readFile(activeMarketPath(profile), "utf8");
    cachedActiveMarkets.set(profile, activeMarketSchema.parse(JSON.parse(raw)));
    loadedActiveMarketProfiles.add(profile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cachedActiveMarkets.set(profile, fallbackActiveMarket());
      await saveActiveMarket(cachedActiveMarkets.get(profile) as ActiveMarket, profile);
    } else if (error instanceof z.ZodError) {
      throw new HttpError(500, `Invalid active-market.json: ${error.errors.map((item) => item.message).join(", ")}`);
    } else {
      throw error;
    }
  }
  return cachedActiveMarkets.get(profile) as ActiveMarket;
}

export function currentActiveMarket(profile = currentMarketProfile()): ActiveMarket {
  const normalized = normalizeMarketProfile(profile);
  knownMarketProfiles.add(normalized);
  if (!cachedActiveMarkets.has(normalized)) {
    try {
      const raw = readFileSync(activeMarketPath(normalized), "utf8");
      cachedActiveMarkets.set(normalized, activeMarketSchema.parse(JSON.parse(raw)));
      loadedActiveMarketProfiles.add(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cachedActiveMarkets.set(normalized, fallbackActiveMarket());
    }
  }
  return cachedActiveMarkets.get(normalized) as ActiveMarket;
}

export async function saveActiveMarket(market: ActiveMarket, profile = currentMarketProfile()): Promise<ActiveMarket> {
  const normalized = normalizeMarketProfile(profile);
  const parsed = activeMarketSchema.parse(market);
  await mkdir(path.dirname(activeMarketPath(normalized)), { recursive: true });
  await writeFile(activeMarketPath(normalized), `${JSON.stringify(parsed, null, 2)}\n`);
  cachedActiveMarkets.set(normalized, parsed);
  loadedActiveMarketProfiles.add(normalized);
  knownMarketProfiles.add(normalized);
  return parsed;
}

function parseEnvText(envText: string) {
  const values = new Map<string, string>();
  for (const rawLine of envText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function titleCase(value: string) {
  return value.toLowerCase().split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function nameFromEnvKey(envKey: string) {
  const raw = envKey.replace(/^POLYMARKET_/, "").replace(/_TOKEN_ID$/, "").replace(/_/g, " ");
  const aliases: Record<string, string> = {
    DRAW: "Draw",
    USA: "United States",
    US: "United States",
    BOSNIA: "Bosnia",
    PARAGUAY: "Paraguay",
    CANADA: "Canada"
  };
  return aliases[raw.replace(/\s+/g, "_").toUpperCase()] ?? titleCase(raw);
}

export function parseActiveMarketFromEnvText(envText: string): ActiveMarket {
  const values = parseEnvText(envText);
  const marketId = values.get("POLYMARKET_MARKET_ID")?.trim();
  const conditionId = values.get("POLYMARKET_CONDITION_ID")?.trim();
  const title = values.get("POLYMARKET_MARKET_TITLE")?.trim();

  if (!marketId) throw new HttpError(400, "POLYMARKET_MARKET_ID is required.");
  if (!conditionId) throw new HttpError(400, "POLYMARKET_CONDITION_ID is required.");
  if (!title) throw new HttpError(400, "POLYMARKET_MARKET_TITLE is required.");

  const outcomes = [...values.entries()]
    .filter(([key]) => /^POLYMARKET_.+_TOKEN_ID$/.test(key))
    .filter(([key]) => !/^POLYMARKET_OUTCOME_\d+_TOKEN_ID$/.test(key))
    .map(([envKey, tokenId]) => ({
      name: nameFromEnvKey(envKey),
      envKey,
      tokenId: tokenId.trim()
    }))
    .filter((outcome) => outcome.tokenId.length > 0);

  if (outcomes.length < 2) throw new HttpError(400, "At least two non-empty POLYMARKET_*_TOKEN_ID values are required.");

  const emptyTokenKey = [...values.entries()].find(([key, value]) => /^POLYMARKET_.+_TOKEN_ID$/.test(key) && value.trim().length === 0)?.[0];
  if (emptyTokenKey) throw new HttpError(400, `${emptyTokenKey} cannot be empty.`);

  return activeMarketSchema.parse({ marketId, conditionId, title, outcomes });
}

export async function activeMarketFromEnvText(envText: string, profile = currentMarketProfile()): Promise<ActiveMarket> {
  return saveActiveMarket(parseActiveMarketFromEnvText(envText), profile);
}
