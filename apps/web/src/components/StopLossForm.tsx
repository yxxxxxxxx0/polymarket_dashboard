"use client";

import { LoaderCircle, ShieldCheck, TrendingUp, X, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { post, withProfile } from "@/lib/api";
import { useOrderBook } from "./OrderBookProvider";
import {
  calculateBreakoutPercentage,
  calculateBuyTriggerPrice,
  calculateStopPercentage,
  calculateStopPrice,
  calculateTrailingPercentage,
  calculateTrailingStopPrice,
  formatPrice,
  isProfitLocked,
  referencePriceForTrigger,
  updateHighestPrice,
  updateTrailingStopOnlyUp,
  validateBuyStop,
  validateStopLoss,
  type StopLossTrigger
} from "@/lib/stopLossMath";
import { getAggressiveBreakoutSettings, getAggressiveStopProtectionSettings } from "@/lib/gameTime";
import { clamp, computeEmergencyScore, getEmergencyParams } from "@/lib/emergencyExecutionModel";

export type RuleMode = "STOP_LOSS" | "TRAILING_STOP" | "BREAKOUT_BUY";

type FieldProps = {
  label: string;
  help: string;
  children: ReactNode;
  wide?: boolean;
};

function Field({ label, help, children, wide = false }: FieldProps) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-xs font-semibold text-slate-700">{label}</span>
      <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{help}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ModeButton({ active, icon: Icon, label, onClick }: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-9 items-center justify-center gap-2 rounded text-xs font-semibold ${active ? "bg-ink text-white" : "text-slate-700"}`}
      onClick={onClick}
      type="button"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

type EmergencyHistoryPoint = {
  timestamp: number;
  mid: number;
  spread: number;
  bidDepthNear: number;
  askDepthNear: number;
};

function nearDepth(levels: Array<{ price: number; size: number }>, bestPrice: number | null, side: "bid" | "ask") {
  if (bestPrice === null) return 0;
  return levels
    .filter((level) => side === "bid"
      ? level.price <= bestPrice && level.price >= bestPrice - 0.03
      : level.price >= bestPrice && level.price <= bestPrice + 0.03)
    .reduce((sum, level) => sum + level.size, 0);
}

function snapshotAgo(history: EmergencyHistoryPoint[], secondsAgo: number) {
  if (history.length === 0) return null;
  const target = Date.now() - secondsAgo * 1_000;
  return history.reduce((best, item) => (
    Math.abs(item.timestamp - target) < Math.abs(best.timestamp - target) ? item : best
  ), history[0]);
}

function formatCents(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}c`;
}

export function StopLossForm({ profile, marketId, conditionId, tokenId, outcomeName, initialMode = "STOP_LOSS", gameMinute = 0, gameTimeConfigured = false, onClose, onSaved }: {
  profile?: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcomeName: string;
  initialMode?: RuleMode;
  gameMinute?: number;
  gameTimeConfigured?: boolean;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const [mode, setMode] = useState<RuleMode>(initialMode);
  const [entryPrice, setEntryPrice] = useState("0.60");
  const [currentPrice, setCurrentPrice] = useState("0.56");
  const [stopPrice, setStopPrice] = useState("0.54");
  const [softStopEnabled, setSoftStopEnabled] = useState(false);
  const [softStopPrice, setSoftStopPrice] = useState("");
  const [useOfiConfirmationForHardStop, setUseOfiConfirmationForHardStop] = useState(false);
  const [useOfiConfirmationForSoftStop, setUseOfiConfirmationForSoftStop] = useState(true);
  const [stopPercentage, setStopPercentage] = useState("10");
  const [highestPrice, setHighestPrice] = useState("0.60");
  const [trailingPercentage, setTrailingPercentage] = useState("10");
  const [referencePrice, setReferencePrice] = useState("");
  const [breakoutPercentage, setBreakoutPercentage] = useState("5");
  const [stakeAmount, setStakeAmount] = useState("5");
  const [positionSize, setPositionSize] = useState("1");
  const [maxSellSize, setMaxSellSize] = useState("1");
  const [triggerType, setTriggerType] = useState<StopLossTrigger>("BEST_BID");
  const [executionType, setExecutionType] = useState("MARKETABLE_LIMIT");
  const [slippageLimit, setSlippageLimit] = useState("0.01");
  const [breakevenEnabled, setBreakevenEnabled] = useState(false);
  const [breakevenTriggerPrice, setBreakevenTriggerPrice] = useState("");
  const [breakevenBuffer, setBreakevenBuffer] = useState("0");
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [useBreakoutOfiConfirmation, setUseBreakoutOfiConfirmation] = useState(false);
  const [ofiBuyThreshold, setOfiBuyThreshold] = useState("0.10");
  const [usePriceSlopeConfirmation, setUsePriceSlopeConfirmation] = useState(false);
  const [priceSlopeThreshold, setPriceSlopeThreshold] = useState("0");
  const [maxSpread, setMaxSpread] = useState("0.03");
  const [disableMaxSpread, setDisableMaxSpread] = useState(false);
  const [aggressivePnLProtection, setAggressivePnLProtection] = useState(true);
  const [aggressiveBreakout, setAggressiveBreakout] = useState(true);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [lastEdited, setLastEdited] = useState<"stopPrice" | "stopPercentage" | "trailingStopPrice" | "trailingPercentage" | "buyTriggerPrice" | "breakoutPercentage">("stopPercentage");
  const [emergencyHistory, setEmergencyHistory] = useState<EmergencyHistoryPoint[]>([]);

  const book = useOrderBook(tokenId);
  const livePrice = referencePriceForTrigger(book, triggerType);

  useEffect(() => {
    if (livePrice !== null) setCurrentPrice(formatPrice(livePrice));
  }, [livePrice]);

  useEffect(() => {
    if (!book) return;
    const mid = book.midpoint ?? (book.bestBid !== null && book.bestAsk !== null ? (book.bestBid + book.bestAsk) / 2 : null);
    const spread = book.spread ?? (book.bestBid !== null && book.bestAsk !== null ? book.bestAsk - book.bestBid : null);
    if (mid === null || spread === null || !Number.isFinite(mid) || !Number.isFinite(spread)) return;
    const point = {
      timestamp: Date.now(),
      mid,
      spread,
      bidDepthNear: nearDepth(book.bids, book.bestBid, "bid"),
      askDepthNear: nearDepth(book.asks, book.bestAsk, "ask")
    };
    setEmergencyHistory((history) => [...history, point]
      .filter((item) => Date.now() - item.timestamp <= 30_000)
      .slice(-300));
  }, [book?.lastUpdateTime, book?.bestBid, book?.bestAsk, book?.spread, book?.midpoint]);

  useEffect(() => {
    if (livePrice !== null && !referencePrice) {
      setReferencePrice(formatPrice(livePrice));
    }
    if (livePrice !== null && Number(highestPrice) <= 0) {
      setHighestPrice(formatPrice(livePrice));
    }
  }, [livePrice, mode, referencePrice, highestPrice]);

  useEffect(() => {
    const entry = Number(entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return;

    if (mode === "STOP_LOSS") {
      if (lastEdited === "stopPercentage") {
        const percentage = Number(stopPercentage);
        if (Number.isFinite(percentage)) setStopPrice(formatPrice(calculateStopPrice(entry, percentage)));
      } else if (lastEdited === "stopPrice") {
        const stop = Number(stopPrice);
        if (Number.isFinite(stop)) setStopPercentage(String(calculateStopPercentage(entry, stop)));
      }
    }
  }, [entryPrice, stopPrice, stopPercentage, lastEdited, mode]);

  useEffect(() => {
    if (mode !== "TRAILING_STOP") return;
    const current = Number(currentPrice);
    const highest = Number(highestPrice);
    if (Number.isFinite(current) && current > 0) {
      const nextHighest = updateHighestPrice(highest, current);
      if (nextHighest !== highest) setHighestPrice(formatPrice(nextHighest));
    }
  }, [currentPrice, highestPrice, mode]);

  useEffect(() => {
    if (mode !== "TRAILING_STOP") return;
    const highest = Number(highestPrice);
    if (!Number.isFinite(highest) || highest <= 0) return;

    if (lastEdited === "trailingPercentage") {
      const percentage = Number(trailingPercentage);
      const previousStop = Number(stopPrice);
      if (Number.isFinite(percentage)) {
        setStopPrice(formatPrice(updateTrailingStopOnlyUp(previousStop, highest, percentage)));
      }
    } else if (lastEdited === "trailingStopPrice") {
      const stop = Number(stopPrice);
      if (Number.isFinite(stop)) setTrailingPercentage(String(calculateTrailingPercentage(highest, stop)));
    }
  }, [highestPrice, stopPrice, trailingPercentage, lastEdited, mode]);

  useEffect(() => {
    if (mode !== "BREAKOUT_BUY") return;
    const reference = Number(referencePrice);
    if (!Number.isFinite(reference) || reference <= 0) return;

    if (lastEdited === "breakoutPercentage") {
      const percentage = Number(breakoutPercentage);
      if (Number.isFinite(percentage)) setStopPrice(formatPrice(calculateBuyTriggerPrice(reference, percentage)));
    } else if (lastEdited === "buyTriggerPrice") {
      const trigger = Number(stopPrice);
      if (Number.isFinite(trigger)) setBreakoutPercentage(String(calculateBreakoutPercentage(reference, trigger)));
    }
  }, [referencePrice, stopPrice, breakoutPercentage, lastEdited, mode]);

  const errors = useMemo(() => {
    if (mode === "BREAKOUT_BUY") {
      return validateBuyStop({
        referencePrice: Number(referencePrice),
        currentPrice: currentPrice ? Number(currentPrice) : null,
        triggerPrice: Number(stopPrice),
        breakoutPercentage: Number(breakoutPercentage),
        stakeAmount: Number(stakeAmount),
        slippageLimit: Number(slippageLimit)
      });
    }

    return validateStopLoss({
      entryPrice: Number(entryPrice),
      currentPrice: currentPrice ? Number(currentPrice) : null,
      stopPrice: Number(stopPrice),
      stopPercentage: mode === "TRAILING_STOP" ? Number(trailingPercentage) : Number(stopPercentage),
      positionSize: Number(positionSize),
      maxSellSize: Number(maxSellSize),
      slippageLimit: Number(slippageLimit)
    });
  }, [mode, referencePrice, currentPrice, stopPrice, breakoutPercentage, stakeAmount, slippageLimit, entryPrice, stopPercentage, trailingPercentage, positionSize, maxSellSize]);

  const distanceToStop = Number(currentPrice) - Number(stopPrice);
  const distanceToTrigger = Number(stopPrice) - Number(currentPrice);
  const profitLocked = isProfitLocked(Number(entryPrice), Number(stopPrice));
  const stopPreset = getAggressiveStopProtectionSettings(gameMinute);
  const breakoutPreset = getAggressiveBreakoutSettings(gameMinute);
  const emergencyParams = getEmergencyParams(gameMinute);
  const emergencySide = mode === "BREAKOUT_BUY" ? "ask" : "bid";
  const emergencyMetrics = useMemo(() => {
    const current = emergencyHistory[emergencyHistory.length - 1];
    if (!current) return null;
    const fiveSecondsAgo = snapshotAgo(emergencyHistory, 5) ?? current;
    const tenSecondsAgo = snapshotAgo(emergencyHistory, 10) ?? fiveSecondsAgo;
    const nearDepthNow = emergencySide === "ask" ? current.askDepthNear : current.bidDepthNear;
    const depthSamples = emergencyHistory.map((item) => emergencySide === "ask" ? item.askDepthNear : item.bidDepthNear);
    const normalNearDepth = depthSamples.length > 0
      ? depthSamples.reduce((sum, depth) => sum + depth, 0) / depthSamples.length
      : nearDepthNow;
    const score = computeEmergencyScore({
      midNow: current.mid,
      mid5sAgo: fiveSecondsAgo.mid,
      mid10sAgo: tenSecondsAgo.mid,
      spread: current.spread,
      nearDepthNow,
      normalNearDepth: normalNearDepth || nearDepthNow || 1e-9,
      gameMinute
    });
    return {
      score,
      spread: current.spread,
      priceMove5s: current.mid - fiveSecondsAgo.mid,
      priceMove10s: current.mid - tenSecondsAgo.mid,
      nearDepthNow,
      normalNearDepth,
      depthVacuumScore: clamp(1 - nearDepthNow / Math.max(normalNearDepth || nearDepthNow || 1e-9, 1e-9), 0, 1)
    };
  }, [emergencyHistory, emergencySide, gameMinute]);
  const emergencyStopRows = "0'-75':  slippage 8c,  max spread 12c\n75'-88': slippage 12c, max spread 18c\n88'+:    slippage 22c, max spread 35c\n90'+:    slippage 30c, max spread disabled / 45c fallback";
  const emergencyBreakoutRows = "0'-75':  pre-trigger 1.5c below, slippage 8c,  max spread 12c\n75'-88': pre-trigger 2.5c below, slippage 12c, max spread 18c\n88'+:    pre-trigger 4c below,   slippage 22c, max spread 35c\n90'+:    pre-trigger 4c below,   slippage 30c, max spread disabled";

  function applyGameTimeStopSettings() {
    if (!gameTimeConfigured) {
      setMessage("Set kickoff time before applying game-time stop settings.");
      return;
    }
    setSlippageLimit(String(stopPreset.slippageLimit));
    setMaxSpread(String(stopPreset.maxSpread));
    setDisableMaxSpread(stopPreset.disableMaxSpread);
    setExecutionType("MARKETABLE_LIMIT");
    setTriggerType("BEST_BID");
    setUseOfiConfirmationForHardStop(false);
    setAggressivePnLProtection(true);
    setMessage(`Aggressive PnL Protection applied: ${stopPreset.label}`);
  }

  function applyGameTimeBreakoutSettings() {
    if (!gameTimeConfigured) {
      setMessage("Set kickoff time before applying game-time breakout settings.");
      return;
    }
    setSlippageLimit(String(breakoutPreset.slippageLimit));
    setMaxSpread(String(breakoutPreset.maxSpread));
    setDisableMaxSpread(false);
    setExecutionType("MARKETABLE_LIMIT");
    setTriggerType("BEST_BID");
    setAggressiveBreakout(true);
    setMessage(`Aggressive Breakout Buy applied: ${breakoutPreset.label}`);
  }

  async function save() {
    if (isSaving) return;
    setMessage("");
    if (errors.length > 0) {
      setMessage("Fix the validation errors before saving.");
      return;
    }
    setIsSaving(true);
    try {
      await post(withProfile("/api/stop-loss", profile), {
        ruleType: mode,
        marketId,
        conditionId,
        tokenId,
        outcome: outcomeName,
        outcomeName,
        sideCurrentlyHeld: "BUY",
        positionSize: mode === "BREAKOUT_BUY" ? stakeAmount : positionSize,
        entryPrice: mode === "BREAKOUT_BUY" ? referencePrice : entryPrice,
        currentPrice,
        stopPrice,
        hardStopPrice: mode === "BREAKOUT_BUY" ? undefined : stopPrice,
        softStopPrice: mode !== "BREAKOUT_BUY" && softStopEnabled && softStopPrice ? softStopPrice : undefined,
        useOfiConfirmationForSoftStop: mode !== "BREAKOUT_BUY" ? useOfiConfirmationForSoftStop : undefined,
        useOfiConfirmationForHardStop: mode !== "BREAKOUT_BUY" ? useOfiConfirmationForHardStop : undefined,
        stopPercentage: mode === "STOP_LOSS" ? stopPercentage : undefined,
        highestPriceSinceEntry: mode === "TRAILING_STOP" ? highestPrice : undefined,
        trailingPercentage: mode === "TRAILING_STOP" ? trailingPercentage : undefined,
        referencePrice: mode === "BREAKOUT_BUY" ? referencePrice : undefined,
        breakoutPrice: mode === "BREAKOUT_BUY" ? stopPrice : undefined,
        breakoutReferenceSource: mode === "BREAKOUT_BUY" ? triggerType.toLowerCase() : undefined,
        breakoutSizeUsd: mode === "BREAKOUT_BUY" ? stakeAmount : undefined,
        breakoutPercentage: mode === "BREAKOUT_BUY" ? breakoutPercentage : undefined,
        useOfiConfirmation: mode === "BREAKOUT_BUY" ? useBreakoutOfiConfirmation : undefined,
        ofiBuyThreshold: mode === "BREAKOUT_BUY" ? ofiBuyThreshold : undefined,
        usePriceSlopeConfirmation: mode === "BREAKOUT_BUY" ? usePriceSlopeConfirmation : undefined,
        priceSlopeThreshold: mode === "BREAKOUT_BUY" ? priceSlopeThreshold : undefined,
        maxSpread: maxSpread ? maxSpread : undefined,
        disableMaxSpread,
        aggressivePnLProtection: mode !== "BREAKOUT_BUY" ? aggressivePnLProtection : false,
        aggressiveBreakout: mode === "BREAKOUT_BUY" ? aggressiveBreakout : false,
        emergencyStopEnabled: mode !== "BREAKOUT_BUY" ? aggressivePnLProtection : false,
        emergencyBreakoutEnabled: mode === "BREAKOUT_BUY" ? aggressiveBreakout : false,
        breakevenEnabled: mode === "TRAILING_STOP" ? breakevenEnabled : false,
        breakevenTriggerPrice: mode === "TRAILING_STOP" && breakevenTriggerPrice ? breakevenTriggerPrice : undefined,
        breakevenBuffer: mode === "TRAILING_STOP" ? breakevenBuffer : undefined,
        takeProfitPrice: mode === "TRAILING_STOP" && takeProfitPrice ? takeProfitPrice : undefined,
        triggerType: triggerType.toLowerCase(),
        executionType: executionType.toLowerCase(),
        slippageLimit,
        maxSellSize: mode === "BREAKOUT_BUY" ? stakeAmount : maxSellSize
      });
      onSaved?.(`${title} rule saved`);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }

  const title = mode === "STOP_LOSS" ? "Stop Loss" : mode === "TRAILING_STOP" ? "Trailing Stop" : "Breakout Buy";

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black/30 p-4">
      <div className="mx-auto flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col rounded-md border border-line bg-white">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" /> {title}</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-line bg-panel p-2">
          <ModeButton active={mode === "STOP_LOSS"} icon={ShieldCheck} label="Stop Loss" onClick={() => setMode("STOP_LOSS")} />
          <ModeButton active={mode === "TRAILING_STOP"} icon={TrendingUp} label="Trailing Stop" onClick={() => setMode("TRAILING_STOP")} />
          <ModeButton active={mode === "BREAKOUT_BUY"} icon={Zap} label="Breakout Buy" onClick={() => setMode("BREAKOUT_BUY")} />
        </div>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 sm:grid-cols-2">
          {mode !== "BREAKOUT_BUY" ? (
            <>
              <Field label="Entry price" help="Average fill price for this outcome.">
                <input className="control w-full" value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} />
              </Field>
              <Field label="Current price" help="Live reference price. Updates while the modal is open.">
                <input className="control w-full bg-panel" value={currentPrice} readOnly aria-label="Current price" />
              </Field>
            </>
          ) : (
            <>
              <Field label="Reference price" help="Locked reference price used for the breakout calculation.">
                <input className="control w-full" value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} />
              </Field>
              <Field label="Current price" help="Live reference price. It keeps updating after the reference is locked.">
                <input className="control w-full bg-panel" value={currentPrice} readOnly aria-label="Current price" />
              </Field>
            </>
          )}

          {mode === "TRAILING_STOP" && (
            <Field label="Highest price since entry" help="Updates live upward while the modal is open.">
              <input className="control w-full bg-panel" value={highestPrice} readOnly />
            </Field>
          )}

          <Field label={mode === "BREAKOUT_BUY" ? "Breakout price" : mode === "TRAILING_STOP" ? "Trailing hard stop price" : "Hard stop price"} help="Trigger level for this rule.">
            <input className="control w-full" value={stopPrice} onChange={(event) => {
              setLastEdited(mode === "BREAKOUT_BUY" ? "buyTriggerPrice" : mode === "TRAILING_STOP" ? "trailingStopPrice" : "stopPrice");
              setStopPrice(event.target.value);
            }} />
          </Field>

          <Field label={mode === "BREAKOUT_BUY" ? "Breakout percentage" : mode === "TRAILING_STOP" ? "Trailing percentage" : "Stop percentage"} help="Linked to the trigger price above.">
            <input className="control w-full" value={mode === "BREAKOUT_BUY" ? breakoutPercentage : mode === "TRAILING_STOP" ? trailingPercentage : stopPercentage} onChange={(event) => {
              if (mode === "BREAKOUT_BUY") {
                setLastEdited("breakoutPercentage");
                setBreakoutPercentage(event.target.value);
              } else if (mode === "TRAILING_STOP") {
                setLastEdited("trailingPercentage");
                setTrailingPercentage(event.target.value);
              } else {
                setLastEdited("stopPercentage");
                setStopPercentage(event.target.value);
              }
            }} />
          </Field>

          {mode !== "BREAKOUT_BUY" && (
            <>
              <div className="rounded-md border border-line bg-panel p-3 text-xs sm:col-span-2">
                <div className="mb-2 font-semibold">Aggressive PnL Protection</div>
                <div className="whitespace-pre-line leading-5 text-slate-600">{`Suggested football stop-loss settings:

0'-75':  slippage 5c,  max spread 8c
75'-88': slippage 10c, max spread 15c
88'-90': slippage 18c, max spread 28c
90'+:    slippage 30c, max spread disabled or 40c

Purpose: sell aggressively enough to escape when bids disappear during football gaps.`}</div>
                <button className="secondary-button mt-3 w-full" onClick={applyGameTimeStopSettings} disabled={!gameTimeConfigured} type="button">
                  Apply Game-Time Stop Settings
                </button>
                <div className="mt-2 text-[11px] font-semibold text-slate-500">{gameTimeConfigured ? `Minute ${gameMinute}' preset: ${stopPreset.label}` : "Set kickoff time in Game Time first."}</div>
              </div>
              <div className="rounded-md border border-line bg-panel p-3 text-xs sm:col-span-2">
                <label className="flex items-center gap-2 font-semibold text-slate-800">
                  <input type="checkbox" checked={aggressivePnLProtection} onChange={(event) => setAggressivePnLProtection(event.target.checked)} />
                  Enable emergency stop loss
                </label>
                <div className="mt-2 whitespace-pre-line font-mono leading-5 text-slate-600">{emergencyStopRows}</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <div className="rounded border border-line bg-white p-2">Auto slippage<br /><span className="font-mono font-semibold">{formatCents(emergencyParams.slippage)}</span></div>
                  <div className="rounded border border-line bg-white p-2">Max spread<br /><span className="font-mono font-semibold">{emergencyParams.maxSpread === null ? "disabled / 45c fallback" : formatCents(emergencyParams.maxSpread)}</span></div>
                  <div className="rounded border border-line bg-white p-2">Score threshold<br /><span className="font-mono font-semibold">{emergencyParams.emergencyScoreStop.toFixed(2)}</span></div>
                </div>
                <div className="mt-2 rounded border border-line bg-white p-2 font-mono leading-5 text-slate-600">
                  Emergency score: {emergencyMetrics ? emergencyMetrics.score.toFixed(2) : "-"}<br />
                  Spread: {emergencyMetrics ? formatCents(emergencyMetrics.spread) : "-"} · 5s move: {emergencyMetrics ? formatCents(emergencyMetrics.priceMove5s) : "-"} · 10s move: {emergencyMetrics ? formatCents(emergencyMetrics.priceMove10s) : "-"}<br />
                  Near bid depth: {emergencyMetrics ? emergencyMetrics.nearDepthNow.toFixed(2) : "-"} · Normal: {emergencyMetrics ? emergencyMetrics.normalNearDepth.toFixed(2) : "-"} · Vacuum: {emergencyMetrics ? emergencyMetrics.depthVacuumScore.toFixed(2) : "-"}
                </div>
              </div>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={softStopEnabled} onChange={(event) => setSoftStopEnabled(event.target.checked)} />
                Soft OFI stop
              </label>
              <Field label="Soft stop price" help="Optional earlier stop that may require OFI confirmation.">
                <input className="control w-full" value={softStopPrice} onChange={(event) => setSoftStopPrice(event.target.value)} disabled={!softStopEnabled} />
              </Field>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={useOfiConfirmationForSoftStop} onChange={(event) => setUseOfiConfirmationForSoftStop(event.target.checked)} disabled={!softStopEnabled} />
                Confirm soft stop with OFI
              </label>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={useOfiConfirmationForHardStop} onChange={(event) => setUseOfiConfirmationForHardStop(event.target.checked)} />
                Confirm hard stop with OFI
              </label>
            </>
          )}

          {mode === "BREAKOUT_BUY" ? (
            <>
              <div className="rounded-md border border-line bg-panel p-3 text-xs sm:col-span-2">
                <div className="mb-2 font-semibold">Aggressive Breakout Buy</div>
                <div className="whitespace-pre-line leading-5 text-slate-600">{`Suggested football breakout-buy settings:

0'-75':  slippage 4c,  max spread 6c
75'-88': slippage 8c,  max spread 12c
88'-90': slippage 15c, max spread 22c
90'+:    slippage 25c, max spread 35c

Purpose: chase enough to get filled when asks jump during football breakouts.`}</div>
                <button className="secondary-button mt-3 w-full" onClick={applyGameTimeBreakoutSettings} disabled={!gameTimeConfigured} type="button">
                  Apply Game-Time Breakout Settings
                </button>
                <div className="mt-2 text-[11px] font-semibold text-slate-500">{gameTimeConfigured ? `Minute ${gameMinute}' preset: ${breakoutPreset.label}` : "Set kickoff time in Game Time first."}</div>
              </div>
              <div className="rounded-md border border-line bg-panel p-3 text-xs sm:col-span-2">
                <label className="flex items-center gap-2 font-semibold text-slate-800">
                  <input type="checkbox" checked={aggressiveBreakout} onChange={(event) => setAggressiveBreakout(event.target.checked)} />
                  Enable emergency breakout buy
                </label>
                <div className="mt-2 whitespace-pre-line font-mono leading-5 text-slate-600">{emergencyBreakoutRows}</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <div className="rounded border border-line bg-white p-2">Auto slippage<br /><span className="font-mono font-semibold">{formatCents(emergencyParams.slippage)}</span></div>
                  <div className="rounded border border-line bg-white p-2">Max spread<br /><span className="font-mono font-semibold">{emergencyParams.maxSpread === null ? "disabled" : formatCents(emergencyParams.maxSpread)}</span></div>
                  <div className="rounded border border-line bg-white p-2">Score threshold<br /><span className="font-mono font-semibold">{emergencyParams.emergencyScoreBreakout.toFixed(2)}</span></div>
                </div>
                <div className="mt-2 rounded border border-line bg-white p-2 font-mono leading-5 text-slate-600">
                  Emergency score: {emergencyMetrics ? emergencyMetrics.score.toFixed(2) : "-"}<br />
                  Spread: {emergencyMetrics ? formatCents(emergencyMetrics.spread) : "-"} · 5s move: {emergencyMetrics ? formatCents(emergencyMetrics.priceMove5s) : "-"} · 10s move: {emergencyMetrics ? formatCents(emergencyMetrics.priceMove10s) : "-"}<br />
                  Near ask depth: {emergencyMetrics ? emergencyMetrics.nearDepthNow.toFixed(2) : "-"} · Normal: {emergencyMetrics ? emergencyMetrics.normalNearDepth.toFixed(2) : "-"} · Vacuum: {emergencyMetrics ? emergencyMetrics.depthVacuumScore.toFixed(2) : "-"}
                </div>
              </div>
              <Field label="Stake amount" help="USD amount to use when the breakout triggers.">
                <input className="control w-full" value={stakeAmount} onChange={(event) => setStakeAmount(event.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Position size" help="Total shares/contracts currently held.">
                <input className="control w-full" value={positionSize} onChange={(event) => setPositionSize(event.target.value)} />
              </Field>
              <Field label="Max sell size" help="Largest amount the rule may sell.">
                <input className="control w-full" value={maxSellSize} onChange={(event) => setMaxSellSize(event.target.value)} />
              </Field>
            </>
          )}

          <Field label="Trigger source" help="Which live price the rule watches.">
            <select className="control w-full" value={triggerType} onChange={(event) => setTriggerType(event.target.value as StopLossTrigger)}>
              <option value="BEST_BID">Best bid</option>
              <option value="LAST_TRADE_PRICE">Last trade</option>
              <option value="MIDPOINT_PRICE">Mid price</option>
              <option value="BEST_ASK">Best ask</option>
            </select>
          </Field>

          <Field label="Execution type" help="What the app should do after the trigger fires.">
            <select className="control w-full" value={executionType} onChange={(event) => setExecutionType(event.target.value)}>
              <option value="MARKETABLE_LIMIT">Marketable limit</option>
              <option value="STRICT_LIMIT">Strict limit</option>
              <option value="CANCEL_ONLY">Cancel only</option>
            </select>
          </Field>

          <Field label="Slippage limit" help="Maximum price cushion. Example: 0.01 means one cent." wide>
            <input className="control w-full" value={slippageLimit} onChange={(event) => setSlippageLimit(event.target.value)} />
          </Field>

          <Field label="Max spread" help="Skip execution if best ask minus best bid is wider than this." wide>
            <input className="control w-full" value={maxSpread} onChange={(event) => setMaxSpread(event.target.value)} disabled={disableMaxSpread} />
          </Field>
          <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={disableMaxSpread} onChange={(event) => setDisableMaxSpread(event.target.checked)} />
            Disable max spread check
          </label>

          {mode === "TRAILING_STOP" && (
            <>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={breakevenEnabled} onChange={(event) => setBreakevenEnabled(event.target.checked)} />
                Breakeven
              </label>
              <Field label="Breakeven trigger price" help="Move stop to entry once current price reaches this level.">
                <input className="control w-full" value={breakevenTriggerPrice} onChange={(event) => setBreakevenTriggerPrice(event.target.value)} />
              </Field>
              <Field label="Breakeven buffer" help="Added to entry when breakeven activates. Example: 0.01.">
                <input className="control w-full" value={breakevenBuffer} onChange={(event) => setBreakevenBuffer(event.target.value)} />
              </Field>
              <Field label="Take profit price" help="Optional sell trigger if current price reaches this level.">
                <input className="control w-full" value={takeProfitPrice} onChange={(event) => setTakeProfitPrice(event.target.value)} />
              </Field>
            </>
          )}

          {mode === "BREAKOUT_BUY" && (
            <>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={useBreakoutOfiConfirmation} onChange={(event) => setUseBreakoutOfiConfirmation(event.target.checked)} />
                Confirm breakout with OFI
              </label>
              <Field label="OFI buy threshold" help="Minimum rolling OFI required when OFI confirmation is enabled.">
                <input className="control w-full" value={ofiBuyThreshold} onChange={(event) => setOfiBuyThreshold(event.target.value)} />
              </Field>
              <label className="flex items-center gap-2 rounded-md border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={usePriceSlopeConfirmation} onChange={(event) => setUsePriceSlopeConfirmation(event.target.checked)} />
                Confirm breakout with price slope
              </label>
              <Field label="Price slope threshold" help="Minimum price change per second over recent updates.">
                <input className="control w-full" value={priceSlopeThreshold} onChange={(event) => setPriceSlopeThreshold(event.target.value)} />
              </Field>
            </>
          )}

          <div className="rounded-md border border-line bg-panel p-2 text-xs sm:col-span-2">
            {mode === "STOP_LOSS" && <>Distance to stop: <span className="font-mono">{Number.isFinite(distanceToStop) ? formatPrice(distanceToStop) : "-"}</span></>}
            {mode === "TRAILING_STOP" && <>Profit locked: <span className="font-semibold">{profitLocked ? "Yes" : "No"}</span> · Active stop: <span className="font-mono">{stopPrice}</span></>}
            {mode === "BREAKOUT_BUY" && <>Distance to trigger: <span className="font-mono">{Number.isFinite(distanceToTrigger) ? formatPrice(distanceToTrigger) : "-"}</span> · Status after save: Armed</>}
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-sell/30 bg-sell/5 p-2 text-xs text-sell sm:col-span-2">
              {errors.map((error) => <div key={error}>{error}</div>)}
            </div>
          )}
          {message && <div className="rounded-md bg-panel p-2 text-xs text-sell sm:col-span-2">{message}</div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
          <button className="secondary-button" onClick={onClose} disabled={isSaving}>Cancel</button>
          <button className="primary-button min-w-24" onClick={save} disabled={errors.length > 0 || isSaving}>
            {isSaving ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Saving...</> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
