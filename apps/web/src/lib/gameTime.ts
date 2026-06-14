export const GAME_TIMEZONE = "Asia/Hong_Kong";

export function estimateGapByGameMinute(gameMinute: number): number {
  const earlyGoalWindow = 0.11 * Math.exp(-Math.pow((gameMinute - 10) / 7, 2));
  const firstHalfRepriceWindow = 0.09 * Math.exp(-Math.pow((gameMinute - 32) / 6, 2));
  const lateGameWindow = 0.30 / (1 + Math.exp(-(gameMinute - 88) / 6));
  return 0.02 + earlyGoalWindow + firstHalfRepriceWindow + lateGameWindow;
}

export function getAggressiveStopProtectionSettings(gameMinute: number) {
  if (gameMinute >= 90) {
    return { slippageLimit: 0.25, maxSpread: 0.40, disableMaxSpread: true, label: "90'+: slippage 25c, max spread disabled or 40c" };
  }
  if (gameMinute >= 88) {
    return { slippageLimit: 0.20, maxSpread: 0.35, disableMaxSpread: false, label: "88'+: slippage 20c, max spread 35c" };
  }
  if (gameMinute >= 75) {
    return { slippageLimit: 0.10, maxSpread: 0.15, disableMaxSpread: false, label: "75'-88': slippage 10c, max spread 15c" };
  }
  return { slippageLimit: 0.06, maxSpread: 0.10, disableMaxSpread: false, label: "0'-75': slippage 6c, max spread 10c" };
}

export function getAggressiveBreakoutSettings(gameMinute: number) {
  if (gameMinute >= 90) {
    return { slippageLimit: 0.15, maxSpread: 0.30, disableMaxSpread: false, label: "90'+: breakout slippage 15c, max spread 30c" };
  }
  if (gameMinute >= 88) {
    return { slippageLimit: 0.12, maxSpread: 0.25, disableMaxSpread: false, label: "88'+: breakout slippage 12c, max spread 25c" };
  }
  if (gameMinute >= 75) {
    return { slippageLimit: 0.08, maxSpread: 0.15, disableMaxSpread: false, label: "75'-88': breakout slippage 8c, max spread 15c" };
  }
  return { slippageLimit: 0.06, maxSpread: 0.10, disableMaxSpread: false, label: "0'-75': breakout slippage 6c, max spread 10c" };
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
