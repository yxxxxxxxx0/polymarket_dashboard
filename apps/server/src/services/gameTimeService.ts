import { z } from "zod";
import { getSetting, setSetting } from "./settingsService.js";

export const GAME_TIMEZONE = "Asia/Hong_Kong";
const GAP_MODEL_SETTING_KEY = "gapModelConfig";

const gameTimeSchema = z.object({
  marketId: z.string(),
  kickoffTimeIso: z.string(),
  timezone: z.string().default(GAME_TIMEZONE),
  paused: z.boolean().default(false),
  pausedGameMinute: z.number().int().min(0).nullable().default(null),
  phase: z.enum(["FIRST_HALF", "HALF_TIME", "SECOND_HALF"]).default("FIRST_HALF"),
  secondHalfStartedAtIso: z.string().nullable().default(null)
});

export type GameTimeSetting = z.output<typeof gameTimeSchema>;

const gapTierSchema = z.object({
  startMinute: z.number().min(0),
  label: z.string(),
  slippageCents: z.number().min(0),
  maxSpreadCents: z.number().min(0),
  disableMaxSpread: z.boolean().default(false),
  lateAddCents: z.number()
});

const directionalGapModelSchema = z.object({
  minSlippageCents: z.number().min(0),
  maxSlippageCents: z.number().min(0),
  spreadCoefficient: z.number().min(0),
  moveCoefficient: z.number().min(0),
  thinDepthThresholdShares: z.number().min(0),
  thinDepthAddCents: z.number().min(0),
  extremePriceLow: z.number().min(0).max(1),
  extremePriceHigh: z.number().min(0).max(1),
  extremePriceAddCents: z.number().min(0),
  tiers: z.array(gapTierSchema).min(1)
});

const gapModelConfigSchema = z.object({
  breakout: directionalGapModelSchema,
  stopLoss: directionalGapModelSchema
});

export type GapModelConfig = z.infer<typeof gapModelConfigSchema>;
export type DirectionalGapModel = z.infer<typeof directionalGapModelSchema>;

export const DEFAULT_GAP_MODEL_CONFIG: GapModelConfig = {
  breakout: {
    minSlippageCents: 1,
    maxSlippageCents: 25,
    spreadCoefficient: 1.2,
    moveCoefficient: 0.30,
    thinDepthThresholdShares: 100,
    thinDepthAddCents: 4,
    extremePriceLow: 0.08,
    extremePriceHigh: 0.92,
    extremePriceAddCents: 1,
    tiers: [
      { startMinute: 0, label: "0'-75': breakout slippage 4c, max spread 6c", slippageCents: 4, maxSpreadCents: 6, disableMaxSpread: false, lateAddCents: 0 },
      { startMinute: 75, label: "75'-88': breakout slippage 8c, max spread 12c", slippageCents: 8, maxSpreadCents: 12, disableMaxSpread: false, lateAddCents: 1 },
      { startMinute: 88, label: "88'-90': breakout slippage 15c, max spread 22c", slippageCents: 15, maxSpreadCents: 22, disableMaxSpread: false, lateAddCents: 3 },
      { startMinute: 90, label: "90'+: breakout slippage 25c, max spread 35c", slippageCents: 25, maxSpreadCents: 35, disableMaxSpread: false, lateAddCents: 7 }
    ]
  },
  stopLoss: {
    minSlippageCents: 1,
    maxSlippageCents: 30,
    spreadCoefficient: 1.6,
    moveCoefficient: 0.10,
    thinDepthThresholdShares: 100,
    thinDepthAddCents: 3,
    extremePriceLow: 0.08,
    extremePriceHigh: 0.92,
    extremePriceAddCents: 2,
    tiers: [
      { startMinute: 0, label: "0'-75': stop slippage 5c, max spread 8c", slippageCents: 5, maxSpreadCents: 8, disableMaxSpread: false, lateAddCents: 1 },
      { startMinute: 75, label: "75'-88': stop slippage 10c, max spread 15c", slippageCents: 10, maxSpreadCents: 15, disableMaxSpread: false, lateAddCents: 1 },
      { startMinute: 88, label: "88'-90': stop slippage 18c, max spread 28c", slippageCents: 18, maxSpreadCents: 28, disableMaxSpread: false, lateAddCents: 3 },
      { startMinute: 90, label: "90'+: stop slippage 30c, max spread disabled or 40c", slippageCents: 30, maxSpreadCents: 40, disableMaxSpread: true, lateAddCents: 8 }
    ]
  }
};

function gameTimeKey(marketId: string) {
  return `gameTime:${marketId}`;
}

export function normalizeGapModelConfig(value: unknown): GapModelConfig {
  const parsed = gapModelConfigSchema.parse(value);
  return {
    breakout: { ...parsed.breakout, tiers: [...parsed.breakout.tiers].sort((a, b) => a.startMinute - b.startMinute) },
    stopLoss: { ...parsed.stopLoss, tiers: [...parsed.stopLoss.tiers].sort((a, b) => a.startMinute - b.startMinute) }
  };
}

export async function getGapModelConfig(): Promise<GapModelConfig> {
  const raw = await getSetting(GAP_MODEL_SETTING_KEY, "");
  if (!raw) return DEFAULT_GAP_MODEL_CONFIG;
  try {
    return normalizeGapModelConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_GAP_MODEL_CONFIG;
  }
}

export async function setGapModelConfig(value: unknown): Promise<GapModelConfig> {
  const parsed = normalizeGapModelConfig(value);
  await setSetting(GAP_MODEL_SETTING_KEY, JSON.stringify(parsed));
  return parsed;
}

export function tierForGameMinute(model: DirectionalGapModel, gameMinute: number) {
  return [...model.tiers].sort((a, b) => a.startMinute - b.startMinute).reduce((selected, tier) => (
    gameMinute >= tier.startMinute ? tier : selected
  ), model.tiers[0]);
}

export function estimateGapByGameMinute(gameMinute: number): number {
  const earlyGoalWindow = 0.11 * Math.exp(-Math.pow((gameMinute - 10) / 7, 2));
  const firstHalfRepriceWindow = 0.09 * Math.exp(-Math.pow((gameMinute - 32) / 6, 2));
  const lateGameWindow = 0.30 / (1 + Math.exp(-(gameMinute - 88) / 6));
  return 0.02 + earlyGoalWindow + firstHalfRepriceWindow + lateGameWindow;
}

export function getAggressiveStopProtectionSettings(gameMinute: number) {
  const tier = tierForGameMinute(DEFAULT_GAP_MODEL_CONFIG.stopLoss, gameMinute);
  return { slippageLimit: tier.slippageCents / 100, maxSpread: tier.maxSpreadCents / 100, disableMaxSpread: tier.disableMaxSpread, label: tier.label };
}

export function getAggressiveBreakoutSettings(gameMinute: number) {
  const tier = tierForGameMinute(DEFAULT_GAP_MODEL_CONFIG.breakout, gameMinute);
  return { slippageLimit: tier.slippageCents / 100, maxSpread: tier.maxSpreadCents / 100, disableMaxSpread: tier.disableMaxSpread, label: tier.label };
}

export function getGameMinute(kickoffTimeIso: string, now = new Date()): number {
  const kickoff = new Date(kickoffTimeIso);
  const diffMs = now.getTime() - kickoff.getTime();
  if (!Number.isFinite(kickoff.getTime()) || diffMs < 0) return 0;
  return Math.floor(diffMs / 60_000);
}

function currentMinuteForSetting(setting: GameTimeSetting, now = new Date()) {
  if (setting.paused && setting.pausedGameMinute !== null) return setting.pausedGameMinute;
  if (setting.phase === "SECOND_HALF" && setting.secondHalfStartedAtIso) {
    return Math.max(45, 45 + getGameMinute(setting.secondHalfStartedAtIso, now));
  }
  return Math.min(45, getGameMinute(setting.kickoffTimeIso, now));
}

export function getGameStatus(kickoffTimeIso: string, now = new Date()) {
  const kickoff = new Date(kickoffTimeIso);
  if (!Number.isFinite(kickoff.getTime()) || now.getTime() < kickoff.getTime()) return "Waiting for kickoff";
  const minute = getGameMinute(kickoffTimeIso, now);
  return minute >= 120 ? "Finished" : "Live";
}

function statusForSetting(setting: GameTimeSetting, gameMinute: number, now = new Date()) {
  const kickoff = new Date(setting.kickoffTimeIso);
  if (!Number.isFinite(kickoff.getTime()) || now.getTime() < kickoff.getTime()) return "Waiting for kickoff";
  if (setting.paused) return "Paused";
  if (setting.phase === "SECOND_HALF") return gameMinute >= 120 ? "Finished" : "Second half";
  if (gameMinute >= 45) return "Half-time";
  return "First half";
}

export async function getMarketGameTime(marketId: string): Promise<(GameTimeSetting & { gameMinute: number; status: string; estimatedGap: number }) | null> {
  const raw = await getSetting(gameTimeKey(marketId), "");
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = gameTimeSchema.safeParse(value);
  if (!parsed.success) return null;
  const gameMinute = currentMinuteForSetting(parsed.data);
  return {
    ...parsed.data,
    gameMinute,
    phase: parsed.data.phase === "FIRST_HALF" && gameMinute >= 45 && !parsed.data.paused ? "HALF_TIME" : parsed.data.phase,
    status: statusForSetting(parsed.data, gameMinute),
    estimatedGap: estimateGapByGameMinute(gameMinute)
  };
}

export async function setMarketGameTime(input: z.input<typeof gameTimeSchema>) {
  const parsed = gameTimeSchema.parse({ ...input, paused: false, pausedGameMinute: null, phase: "FIRST_HALF", secondHalfStartedAtIso: null });
  await setSetting(gameTimeKey(parsed.marketId), JSON.stringify(parsed));
  return getMarketGameTime(parsed.marketId);
}

export async function pauseMarketGameTime(marketId: string) {
  const setting = await getMarketGameTime(marketId);
  if (!setting?.kickoffTimeIso) return null;
  const next = gameTimeSchema.parse({
    ...setting,
    paused: true,
    pausedGameMinute: setting.gameMinute
  });
  await setSetting(gameTimeKey(marketId), JSON.stringify(next));
  return getMarketGameTime(marketId);
}

export async function resumeMarketGameTime(marketId: string) {
  const setting = await getMarketGameTime(marketId);
  if (!setting?.kickoffTimeIso) return null;
  const gameMinute = setting.pausedGameMinute ?? setting.gameMinute;
  const nextKickoff = new Date(Date.now() - Math.min(gameMinute, 45) * 60_000).toISOString();
  const nextSecondHalfStartedAtIso = setting.phase === "SECOND_HALF"
    ? new Date(Date.now() - Math.max(0, gameMinute - 45) * 60_000).toISOString()
    : setting.secondHalfStartedAtIso;
  const next = gameTimeSchema.parse({
    ...setting,
    kickoffTimeIso: nextKickoff,
    secondHalfStartedAtIso: nextSecondHalfStartedAtIso,
    paused: false,
    pausedGameMinute: null
  });
  await setSetting(gameTimeKey(marketId), JSON.stringify(next));
  return getMarketGameTime(marketId);
}

export async function startSecondHalf(marketId: string) {
  const setting = await getMarketGameTime(marketId);
  if (!setting?.kickoffTimeIso) return null;
  const next = gameTimeSchema.parse({
    ...setting,
    phase: "SECOND_HALF",
    secondHalfStartedAtIso: new Date().toISOString(),
    paused: false,
    pausedGameMinute: null
  });
  await setSetting(gameTimeKey(marketId), JSON.stringify(next));
  return getMarketGameTime(marketId);
}
