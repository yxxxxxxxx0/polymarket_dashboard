import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../lib/http.js";
import { DEFAULT_MARKET_PROFILE, normalizeMarketProfile, type ActiveMarket, parseActiveMarketFromEnvText } from "./activeMarketService.js";

export type MarketLibraryEntry = ActiveMarket & {
  sourceIndex: number;
};

function repoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(path.join("apps", "server"))) return path.resolve(cwd, "../..");
  return cwd;
}

function matchesPath(profile?: string) {
  const normalized = normalizeMarketProfile(profile);
  const fileName = normalized === DEFAULT_MARKET_PROFILE ? "matches" : `matches.${normalized}`;
  return path.resolve(repoRoot(), "..", fileName);
}

function extractTopLevelBlocks(text: string) {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function asciiSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase();
}

function envKeyForOutcome(name: string, used: Set<string>) {
  const base = asciiSlug(name || "OUTCOME") || "OUTCOME";
  let key = `POLYMARKET_${base}_TOKEN_ID`;
  let suffix = 2;
  while (used.has(key)) {
    key = `POLYMARKET_${base}_${suffix}_TOKEN_ID`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

function outcomeNameFromQuestion(question: string) {
  const drawMatch = question.match(/end in a draw/i);
  if (drawMatch) return "Draw";
  const winMatch = question.match(/^Will\s+(.+?)\s+win\b/i);
  if (winMatch) return winMatch[1].trim();
  return question.replace(/^Will\s+/i, "").replace(/\?$/, "").trim();
}

function cleanOutcomeName(market: Record<string, unknown>) {
  const groupTitle = stringValue(market.groupItemTitle);
  if (/^draw\s*\(/i.test(groupTitle)) return "Draw";
  if (groupTitle) return groupTitle;
  return outcomeNameFromQuestion(stringValue(market.question));
}

function parseClobTokenIds(value: unknown) {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => stringValue(item)).filter(Boolean);
}

function parseJsonMarketObject(raw: Record<string, unknown>): ActiveMarket {
  const markets = Array.isArray(raw.markets) ? raw.markets.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  const marketId = stringValue(raw.id);
  const conditionId = stringValue(raw.negRiskMarketID) || stringValue(raw.conditionId) || stringValue(markets[0]?.negRiskMarketID);
  const title = stringValue(raw.title) || stringValue(raw.question);

  if (!marketId) throw new HttpError(400, "Market JSON is missing id.");
  if (!conditionId) throw new HttpError(400, "Market JSON is missing negRiskMarketID or conditionId.");
  if (!title) throw new HttpError(400, "Market JSON is missing title.");

  const usedKeys = new Set<string>();
  const outcomes = markets
    .map((market, index) => {
      const tokenId = parseClobTokenIds(market.clobTokenIds)[0];
      const name = cleanOutcomeName(market);
      const order = Number(market.groupItemThreshold ?? index);
      return tokenId ? { name, tokenId, order } : null;
    })
    .filter((item): item is { name: string; tokenId: string; order: number } => Boolean(item))
    .sort((a, b) => a.order - b.order)
    .map((item) => ({
      name: item.name,
      envKey: envKeyForOutcome(item.name, usedKeys),
      tokenId: item.tokenId
    }));

  if (outcomes.length === 0) {
    const names = parseJsonValue(raw.outcomes);
    const tokens = parseClobTokenIds(raw.clobTokenIds);
    if (Array.isArray(names) && tokens.length > 0) {
      names.forEach((name, index) => {
        const tokenId = tokens[index];
        if (!tokenId) return;
        const outcomeName = stringValue(name) || `Outcome ${index + 1}`;
        outcomes.push({
          name: outcomeName,
          envKey: envKeyForOutcome(outcomeName, usedKeys),
          tokenId
        });
      });
    }
  }

  if (outcomes.length < 2) throw new HttpError(400, "Market JSON must include at least two outcomes with clobTokenIds.");
  return { marketId, conditionId, title, outcomes };
}

export function parseMarketText(text: string): ActiveMarket {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, "Market text is required.");

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Market JSON must be one object.");
    return parseJsonMarketObject(parsed as Record<string, unknown>);
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }

  const envText = trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : trimmed;
  return parseActiveMarketFromEnvText(envText);
}

async function readMarketLibrary(profile?: string) {
  return readFile(matchesPath(profile), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function listMarketLibrary(profile?: string): Promise<MarketLibraryEntry[]> {
  const raw = await readMarketLibrary(profile);
  return extractTopLevelBlocks(raw)
    .map((block, index) => {
      try {
        return { ...parseMarketText(block), sourceIndex: index };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is MarketLibraryEntry => Boolean(entry));
}

export async function findMarketLibraryEntry(marketId: string, profile?: string) {
  const entries = await listMarketLibrary(profile);
  const entry = entries.find((item) => item.marketId === marketId);
  if (!entry) throw new HttpError(404, `Market ${marketId} was not found in matches.`);
  return entry;
}

export function activeMarketToEnvBlock(market: ActiveMarket) {
  const lines = [
    "{",
    `    POLYMARKET_MARKET_ID=${market.marketId}`,
    "",
    "    # Shared neg-risk market ID for this event",
    `    POLYMARKET_CONDITION_ID=${market.conditionId}`,
    "",
    ...market.outcomes.map((outcome) => `    ${outcome.envKey}=${outcome.tokenId}`),
    "",
    `    POLYMARKET_MARKET_TITLE=${market.title}`,
    "}"
  ];
  return lines.join("\n");
}

export async function appendMarketToLibrary(text: string, profile?: string) {
  const market = parseMarketText(text);
  const current = await readMarketLibrary(profile);
  const keptBlocks = extractTopLevelBlocks(current).filter((block) => {
    try {
      return parseMarketText(block).marketId !== market.marketId;
    } catch {
      return true;
    }
  });
  await writeFile(matchesPath(profile), `${[...keptBlocks, activeMarketToEnvBlock(market)].join("\n\n")}\n`);
  return market;
}

export async function removeMarketFromLibrary(marketId: string, profile?: string) {
  const current = await readMarketLibrary(profile);
  const blocks = extractTopLevelBlocks(current);
  let removed: ActiveMarket | null = null;
  const keptBlocks = blocks.filter((block) => {
    try {
      const market = parseMarketText(block);
      if (market.marketId === marketId) {
        removed = market;
        return false;
      }
    } catch {
      return true;
    }
    return true;
  });
  if (!removed) throw new HttpError(404, `Market ${marketId} was not found in matches.`);
  await writeFile(matchesPath(profile), keptBlocks.length > 0 ? `${keptBlocks.join("\n\n")}\n` : "");
  return removed;
}
