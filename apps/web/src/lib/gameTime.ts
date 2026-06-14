export const GAME_TIMEZONE = "Asia/Hong_Kong";

const DEFAULT_BREAKOUT_TIERS = [
  { startMinute: 0, label: "0'-75': breakout slippage 4c, max spread 6c", slippageCents: 4, maxSpreadCents: 6, disableMaxSpread: false },
  { startMinute: 75, label: "75'-88': breakout slippage 8c, max spread 12c", slippageCents: 8, maxSpreadCents: 12, disableMaxSpread: false },
  { startMinute: 88, label: "88'-90': breakout slippage 15c, max spread 22c", slippageCents: 15, maxSpreadCents: 22, disableMaxSpread: false },
  { startMinute: 90, label: "90'+: breakout slippage 25c, max spread 35c", slippageCents: 25, maxSpreadCents: 35, disableMaxSpread: false }
];

const DEFAULT_STOP_TIERS = [
  { startMinute: 0, label: "0'-75': stop slippage 5c, max spread 8c", slippageCents: 5, maxSpreadCents: 8, disableMaxSpread: false },
  { startMinute: 75, label: "75'-88': stop slippage 10c, max spread 15c", slippageCents: 10, maxSpreadCents: 15, disableMaxSpread: false },
  { startMinute: 88, label: "88'-90': stop slippage 18c, max spread 28c", slippageCents: 18, maxSpreadCents: 28, disableMaxSpread: false },
  { startMinute: 90, label: "90'+: stop slippage 30c, max spread disabled or 40c", slippageCents: 30, maxSpreadCents: 40, disableMaxSpread: true }
];

function tierForGameMinute<T extends { startMinute: number }>(tiers: T[], gameMinute: number): T {
  return [...tiers].sort((a, b) => a.startMinute - b.startMinute).reduce((selected, tier) => (
    gameMinute >= tier.startMinute ? tier : selected
  ), tiers[0]);
}

export function estimateGapByGameMinute(gameMinute: number): number {
  const earlyGoalWindow = 0.11 * Math.exp(-Math.pow((gameMinute - 10) / 7, 2));
  const firstHalfRepriceWindow = 0.09 * Math.exp(-Math.pow((gameMinute - 32) / 6, 2));
  const lateGameWindow = 0.30 / (1 + Math.exp(-(gameMinute - 88) / 6));
  return 0.02 + earlyGoalWindow + firstHalfRepriceWindow + lateGameWindow;
}

export function getAggressiveStopProtectionSettings(gameMinute: number) {
  const tier = tierForGameMinute(DEFAULT_STOP_TIERS, gameMinute);
  return { slippageLimit: tier.slippageCents / 100, maxSpread: tier.maxSpreadCents / 100, disableMaxSpread: tier.disableMaxSpread, label: tier.label };
}

export function getAggressiveBreakoutSettings(gameMinute: number) {
  const tier = tierForGameMinute(DEFAULT_BREAKOUT_TIERS, gameMinute);
  return { slippageLimit: tier.slippageCents / 100, maxSpread: tier.maxSpreadCents / 100, disableMaxSpread: tier.disableMaxSpread, label: tier.label };
}

export function getGameMinute(kickoffTimeIso: string, now = new Date()): number {
  const kickoff = new Date(kickoffTimeIso);
  const diffMs = now.getTime() - kickoff.getTime();
  if (!Number.isFinite(kickoff.getTime()) || diffMs < 0) return 0;
  return Math.floor(diffMs / 60_000);
}

export function getGameStatus(kickoffTimeIso: string, now = new Date()) {
  const kickoff = new Date(kickoffTimeIso);
  if (!Number.isFinite(kickoff.getTime()) || now.getTime() < kickoff.getTime()) return "Waiting for kickoff";
  return getGameMinute(kickoffTimeIso, now) >= 120 ? "Finished" : "Live";
}

export function hktLocalToIso(date: string, time: string) {
  if (!date || !time) return "";
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

export function isoToHktInputParts(iso: string | null | undefined) {
  if (!iso) return { date: "", time: "" };
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: GAME_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
