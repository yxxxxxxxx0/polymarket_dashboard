export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function estimateEmergencyGap(gameMinute: number): number {
  const earlyGoalWindow = 0.12 * Math.exp(-Math.pow((gameMinute - 10) / 7, 2));
  const firstHalfWindow = 0.09 * Math.exp(-Math.pow((gameMinute - 32) / 8, 2));
  const lateGameWindow = 0.14 * Math.exp(-Math.pow((gameMinute - 82) / 7, 2));
  const stoppageWindow = gameMinute >= 88 ? 0.20 + 0.04 * Math.max(0, gameMinute - 88) : 0;
  const base = 0.05;

  return Math.min(0.75, base + earlyGoalWindow + firstHalfWindow + lateGameWindow + stoppageWindow);
}

export function getEmergencyParams(gameMinute: number) {
  if (gameMinute >= 90) {
    return {
      slippage: 0.30,
      maxSpread: null,
      emergencyScoreStop: 0.60,
      emergencyScoreBreakout: 0.65
    };
  }

  if (gameMinute >= 88) {
    return {
      slippage: 0.22,
      maxSpread: 0.35,
      emergencyScoreStop: 0.60,
      emergencyScoreBreakout: 0.68
    };
  }

  if (gameMinute >= 75) {
    return {
      slippage: 0.12,
      maxSpread: 0.18,
      emergencyScoreStop: 0.65,
      emergencyScoreBreakout: 0.70
    };
  }

  return {
    slippage: 0.08,
    maxSpread: 0.12,
    emergencyScoreStop: 0.70,
    emergencyScoreBreakout: 0.75
  };
}

export function computeEmergencyScore(params: {
  midNow: number;
  mid5sAgo: number;
  mid10sAgo: number;
  spread: number;
  nearDepthNow: number;
  normalNearDepth: number;
  gameMinute: number;
}): number {
  const emergencyGap = estimateEmergencyGap(params.gameMinute);
  const maxAllowedSpread = getEmergencyParams(params.gameMinute).maxSpread ?? 0.45;

  const priceShockScore = clamp(Math.abs(params.midNow - params.mid10sAgo) / emergencyGap, 0, 1);
  const spreadShockScore = clamp(params.spread / maxAllowedSpread, 0, 1);
  const depthVacuumScore = clamp(1 - params.nearDepthNow / Math.max(params.normalNearDepth, 1e-9), 0, 1);
  const velocityGap = emergencyGap * 0.55;
  const velocityScore = clamp(Math.abs(params.midNow - params.mid5sAgo) / velocityGap, 0, 1);

  return (
    0.35 * priceShockScore
    + 0.25 * spreadShockScore
    + 0.25 * depthVacuumScore
    + 0.15 * velocityScore
  );
}

export function shouldEmergencyStopLoss(params: {
  entryPrice: number;
  stopPrice: number;
  triggerReference: number;
  emergencyScore: number;
  gameMinute: number;
}): boolean {
  const emergencyParams = getEmergencyParams(params.gameMinute);
  const preStopBuffer = params.gameMinute >= 88 ? 0.03 : params.gameMinute >= 75 ? 0.02 : 0.015;
  const emergencyPreStop = params.stopPrice + preStopBuffer;

  return (
    params.triggerReference <= params.stopPrice
    || (
      params.triggerReference <= emergencyPreStop
      && params.emergencyScore >= emergencyParams.emergencyScoreStop
    )
  );
}

export function shouldEmergencyBreakoutBuy(params: {
  breakoutTrigger: number;
  triggerReference: number;
  triggerReference5sAgo: number;
  emergencyScore: number;
  gameMinute: number;
}): boolean {
  const emergencyParams = getEmergencyParams(params.gameMinute);
  const preBreakoutBuffer = params.gameMinute >= 88 ? 0.04 : params.gameMinute >= 75 ? 0.025 : 0.015;
  const emergencyPreBreakout = params.breakoutTrigger - preBreakoutBuffer;
  const priceRising = params.triggerReference > params.triggerReference5sAgo;

  return (
    params.triggerReference >= params.breakoutTrigger
    || (
      params.triggerReference >= emergencyPreBreakout
      && priceRising
      && params.emergencyScore >= emergencyParams.emergencyScoreBreakout
    )
  );
}

export function emergencySellLimit(bestBid: number, gameMinute: number): number {
  const { slippage } = getEmergencyParams(gameMinute);
  return Math.max(0.01, bestBid - slippage);
}

export function emergencyBuyLimit(bestAsk: number, gameMinute: number): number {
  const { slippage } = getEmergencyParams(gameMinute);
  return Math.min(0.99, bestAsk + slippage);
}
