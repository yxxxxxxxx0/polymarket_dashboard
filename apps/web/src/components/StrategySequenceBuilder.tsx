"use client";

import { ArrowRight, LoaderCircle, ShieldCheck, TrendingUp, X, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { post, withProfile } from "@/lib/api";
import { useOrderBook } from "./OrderBookProvider";
import { formatPrice, referencePriceForTrigger, type StopLossTrigger } from "@/lib/stopLossMath";
import { getAggressiveBreakoutSettings, getAggressiveStopProtectionSettings } from "@/lib/gameTime";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function StepHeader({ index, icon: Icon, title, status }: { index: number; icon: LucideIcon; title: string; status: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-3 py-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-ink text-xs text-white">{index}</span>
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <span className="rounded border border-line bg-panel px-2 py-1 text-[11px] font-semibold uppercase text-slate-600">{status}</span>
    </div>
  );
}

export function StrategySequenceBuilder({ profile, marketId, conditionId, tokenId, outcomeName, gameMinute = 0, gameTimeConfigured = false, onClose, onSaved }: {
  profile?: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcomeName: string;
  gameMinute?: number;
  gameTimeConfigured?: boolean;
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const [triggerType, setTriggerType] = useState<StopLossTrigger>("BEST_BID");
  const [referencePrice, setReferencePrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("0.60");
  const [stakeAmount, setStakeAmount] = useState("5");
  const [buySlippage, setBuySlippage] = useState("0.01");
  const [maxSpread, setMaxSpread] = useState("0.03");
  const [disableBreakoutMaxSpread, setDisableBreakoutMaxSpread] = useState(false);
  const [aggressiveBreakout, setAggressiveBreakout] = useState(true);
  const [activationCondition, setActivationCondition] = useState<"FULL_FILL_ONLY" | "PARTIAL_FILL_ALLOWED" | "MIN_FILLED_SHARES">("PARTIAL_FILL_ALLOWED");
  const [minFilledShares, setMinFilledShares] = useState("1");
  const [cancelAfterSeconds, setCancelAfterSeconds] = useState("3");
  const [stopEnabled, setStopEnabled] = useState(true);
  const [stopMode, setStopMode] = useState<"percent" | "price">("percent");
  const [stopPercentage, setStopPercentage] = useState("8");
  const [stopPrice, setStopPrice] = useState("0.52");
  const [stopSlippage, setStopSlippage] = useState("0.01");
  const [stopMaxSpread, setStopMaxSpread] = useState("0.10");
  const [disableStopMaxSpread, setDisableStopMaxSpread] = useState(false);
  const [aggressiveStopProtection, setAggressiveStopProtection] = useState(true);
  const [trailEnabled, setTrailEnabled] = useState(true);
  const [trailPercentage, setTrailPercentage] = useState("10");
  const [trailActivationPrice, setTrailActivationPrice] = useState("");
  const [trailSlippage, setTrailSlippage] = useState("0.01");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const book = useOrderBook(tokenId);
  const livePrice = referencePriceForTrigger(book, triggerType);
  const stopPreset = getAggressiveStopProtectionSettings(gameMinute);
  const breakoutPreset = getAggressiveBreakoutSettings(gameMinute);

  useEffect(() => {
    if (livePrice !== null && !referencePrice) {
      setReferencePrice(formatPrice(livePrice));
      setTriggerPrice(formatPrice(Math.min(0.99, livePrice + 0.03)));
    }
  }, [livePrice, referencePrice]);

  const errors = useMemo(() => {
    const next: string[] = [];
    const trigger = Number(triggerPrice);
    const stake = Number(stakeAmount);
    const spread = Number(maxSpread);
    const minFill = Number(minFilledShares);
    const timeout = Number(cancelAfterSeconds);
    if (!Number.isFinite(trigger) || trigger <= 0 || trigger >= 1) next.push("Breakout trigger must be between 0 and 1.");
    if (!Number.isFinite(stake) || stake <= 0) next.push("Stake amount must be positive.");
    if (!disableBreakoutMaxSpread && maxSpread && (!Number.isFinite(spread) || spread < 0 || spread >= 1)) next.push("Max spread must be between 0 and 1.");
    if (activationCondition === "MIN_FILLED_SHARES" && (!Number.isFinite(minFill) || minFill <= 0)) next.push("Minimum filled shares must be positive.");
    if (cancelAfterSeconds && (!Number.isFinite(timeout) || timeout <= 0)) next.push("Cancel timeout must be positive.");
    if (!stopEnabled && !trailEnabled) next.push("Choose at least one child rule.");
    if (stopEnabled) {
      const value = stopMode === "percent" ? Number(stopPercentage) : Number(stopPrice);
      if (!Number.isFinite(value) || value <= 0) next.push("Stop loss value must be positive.");
      if (stopMode === "price" && value >= 1) next.push("Stop loss price must be below 1.");
    }
    if (trailEnabled) {
      const value = Number(trailPercentage);
      if (!Number.isFinite(value) || value <= 0) next.push("Trail percentage must be positive.");
    }
    return next;
  }, [triggerPrice, stakeAmount, maxSpread, disableBreakoutMaxSpread, activationCondition, minFilledShares, cancelAfterSeconds, stopEnabled, trailEnabled, stopMode, stopPercentage, stopPrice, trailPercentage]);

  function applyGameTimeBreakoutSettings() {
    if (!gameTimeConfigured) {
      setMessage("Set kickoff time before applying game-time breakout settings.");
      return;
    }
    setBuySlippage(String(breakoutPreset.slippageLimit));
    setMaxSpread(String(breakoutPreset.maxSpread));
    setDisableBreakoutMaxSpread(false);
    setTriggerType("BEST_BID");
    setAggressiveBreakout(true);
    setMessage(`Aggressive Breakout Buy applied: ${breakoutPreset.label}`);
  }

  function applyGameTimeStopSettings() {
    if (!gameTimeConfigured) {
      setMessage("Set kickoff time before applying game-time stop settings.");
      return;
    }
    setStopSlippage(String(stopPreset.slippageLimit));
    setStopMaxSpread(String(stopPreset.maxSpread));
    setDisableStopMaxSpread(stopPreset.disableMaxSpread);
    setAggressiveStopProtection(true);
    setMessage(`Aggressive PnL Protection applied: ${stopPreset.label}`);
  }

  const preview = useMemo(() => {
    const trigger = Number(triggerPrice);
    const slippage = Number(buySlippage);
    const stake = Number(stakeAmount);
    const bestAsk = book?.bestAsk ?? null;
    const baseAsk = bestAsk ?? trigger;
    const maxBuyPrice = Math.min(0.99, Math.max(trigger || 0, (baseAsk || 0) + (Number.isFinite(slippage) ? slippage : 0)));
    const estimatedShares = maxBuyPrice > 0 && Number.isFinite(stake) ? stake / maxBuyPrice : 0;
    const stopLossEstimate = stopMode === "price"
      ? Number(stopPrice)
      : maxBuyPrice * (1 - Number(stopPercentage) / 100);
    const trailingDistance = maxBuyPrice * (Number(trailPercentage) / 100);
    return {
      maxBuyPrice,
      estimatedShares,
      stopLossEstimate,
      trailingDistance
    };
  }, [book?.bestAsk, triggerPrice, buySlippage, stakeAmount, stopMode, stopPrice, stopPercentage, trailPercentage]);

  async function save() {
    if (isSaving) return;
    setMessage("");
    if (errors.length > 0) {
      setMessage("Fix the validation errors before saving.");
      return;
    }
    setIsSaving(true);
    try {
      await post(withProfile("/api/strategy-sequences", profile), {
        breakout: {
          marketId,
          conditionId,
          tokenId,
          outcomeName,
          referencePrice: referencePrice ? Number(referencePrice) : undefined,
          triggerPrice: Number(triggerPrice),
          stakeAmount: Number(stakeAmount),
          triggerType: triggerType.toLowerCase(),
          executionType: "marketable_limit",
          slippageLimit: Number(buySlippage),
          maxSpread: !disableBreakoutMaxSpread && maxSpread ? Number(maxSpread) : undefined,
          disableMaxSpread: disableBreakoutMaxSpread,
          aggressiveBreakout,
          activationCondition,
          minFilledShares: activationCondition === "MIN_FILLED_SHARES" ? Number(minFilledShares) : undefined,
          cancelAfterSeconds: cancelAfterSeconds ? Number(cancelAfterSeconds) : undefined
        },
        stopLoss: stopEnabled ? {
          enabled: true,
          stopPercentage: stopMode === "percent" ? Number(stopPercentage) : undefined,
          stopPrice: stopMode === "price" ? Number(stopPrice) : undefined,
          executionType: "marketable_limit",
          slippageLimit: Number(stopSlippage),
          maxSpread: !disableStopMaxSpread && stopMaxSpread ? Number(stopMaxSpread) : undefined,
          disableMaxSpread: disableStopMaxSpread,
          aggressivePnLProtection: aggressiveStopProtection
        } : { enabled: false },
        trailingStop: trailEnabled ? {
          enabled: true,
          trailingPercentage: Number(trailPercentage),
          activationPrice: trailActivationPrice ? Number(trailActivationPrice) : undefined,
          executionType: "marketable_limit",
          slippageLimit: Number(trailSlippage)
        } : { enabled: false }
      });
      onSaved?.("Strategy sequence saved");
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-black/30 p-4">
      <div className="mx-auto flex max-h-[calc(100vh-2rem)] max-w-3xl flex-col rounded-md border border-line bg-white">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><ArrowRight className="h-4 w-4" /> Strategy Sequence</div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <section className="rounded-md border border-line">
            <StepHeader index={1} icon={Zap} title="Create breakout buy" status="active" />
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <Field label="Outcome"><input className="control w-full bg-panel" value={outcomeName} readOnly /></Field>
              <Field label="Trigger source">
                <select className="control w-full" value={triggerType} onChange={(event) => setTriggerType(event.target.value as StopLossTrigger)}>
                  <option value="BEST_BID">Best bid</option>
                  <option value="LAST_TRADE_PRICE">Last trade</option>
                  <option value="MIDPOINT_PRICE">Mid price</option>
                  <option value="BEST_ASK">Best ask</option>
                </select>
              </Field>
              <Field label="Reference price"><input className="control w-full" value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} /></Field>
              <Field label="Breakout trigger"><input className="control w-full" value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} /></Field>
              <Field label="Stake amount"><input className="control w-full" value={stakeAmount} onChange={(event) => setStakeAmount(event.target.value)} /></Field>
              <Field label="Buy slippage"><input className="control w-full" value={buySlippage} onChange={(event) => setBuySlippage(event.target.value)} /></Field>
              <Field label="Max spread allowed"><input className="control w-full" value={maxSpread} onChange={(event) => setMaxSpread(event.target.value)} disabled={disableBreakoutMaxSpread} /></Field>
              <label className="flex items-center gap-2 rounded border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={disableBreakoutMaxSpread} onChange={(event) => setDisableBreakoutMaxSpread(event.target.checked)} /> Disable max spread
              </label>
              <Field label="Activate children when">
                <select className="control w-full" value={activationCondition} onChange={(event) => setActivationCondition(event.target.value as typeof activationCondition)}>
                  <option value="FULL_FILL_ONLY">Full fill only</option>
                  <option value="PARTIAL_FILL_ALLOWED">Partial fill allowed</option>
                  <option value="MIN_FILLED_SHARES">Minimum filled shares</option>
                </select>
              </Field>
              {activationCondition === "MIN_FILLED_SHARES" && (
                <Field label="Minimum filled shares"><input className="control w-full" value={minFilledShares} onChange={(event) => setMinFilledShares(event.target.value)} /></Field>
              )}
              <Field label="Cancel if not filled after seconds"><input className="control w-full" value={cancelAfterSeconds} onChange={(event) => setCancelAfterSeconds(event.target.value)} /></Field>
              <div className="rounded border border-line bg-panel p-3 text-xs sm:col-span-2">
                <label className="mb-2 flex items-center gap-2 font-semibold">
                  <input type="checkbox" checked={aggressiveBreakout} onChange={(event) => setAggressiveBreakout(event.target.checked)} />
                  Enable emergency breakout buy
                </label>
                <div className="whitespace-pre-line leading-5 text-slate-600">{`Suggested football breakout-buy settings:

0'-75':  slippage 4c,  max spread 6c
75'-88': slippage 8c,  max spread 12c
88'-90': slippage 15c, max spread 22c
90'+:    slippage 25c, max spread 35c

Purpose: chase enough to get filled when asks jump during football breakouts.`}</div>
                <div className="mt-2 whitespace-pre-line font-mono leading-5 text-slate-600">{`Emergency stress model:
0'-75':  pre-trigger 1.5c below, slippage 8c,  max spread 12c
75'-88': pre-trigger 2.5c below, slippage 12c, max spread 18c
88'+:    pre-trigger 4c below,   slippage 22c, max spread 35c
90'+:    pre-trigger 4c below,   slippage 30c, max spread disabled`}</div>
                <button className="secondary-button mt-3 w-full" onClick={applyGameTimeBreakoutSettings} disabled={!gameTimeConfigured} type="button">Apply Game-Time Breakout Settings</button>
                <div className="mt-2 text-[11px] font-semibold text-slate-500">{gameTimeConfigured ? `Minute ${gameMinute}' preset: ${breakoutPreset.label}` : "Set kickoff time in Game Time first."}</div>
              </div>
            </div>
          </section>
          <section className="rounded-md border border-line">
            <StepHeader index={2} icon={ShieldCheck} title="After filled, activate stop loss" status={stopEnabled ? "waiting" : "off"} />
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={stopEnabled} onChange={(event) => setStopEnabled(event.target.checked)} /> Stop loss
              </label>
              <Field label="Stop mode">
                <select className="control w-full" value={stopMode} onChange={(event) => setStopMode(event.target.value as "percent" | "price")} disabled={!stopEnabled}>
                  <option value="percent">Percent below entry</option>
                  <option value="price">Trigger price</option>
                </select>
              </Field>
              {stopMode === "percent" ? (
                <Field label="Stop percentage"><input className="control w-full" value={stopPercentage} onChange={(event) => setStopPercentage(event.target.value)} disabled={!stopEnabled} /></Field>
              ) : (
                <Field label="Stop trigger"><input className="control w-full" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} disabled={!stopEnabled} /></Field>
              )}
              <Field label="Sell slippage"><input className="control w-full" value={stopSlippage} onChange={(event) => setStopSlippage(event.target.value)} disabled={!stopEnabled} /></Field>
              <Field label="Max spread"><input className="control w-full" value={stopMaxSpread} onChange={(event) => setStopMaxSpread(event.target.value)} disabled={!stopEnabled || disableStopMaxSpread} /></Field>
              <label className="flex items-center gap-2 rounded border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={disableStopMaxSpread} onChange={(event) => setDisableStopMaxSpread(event.target.checked)} disabled={!stopEnabled} /> Disable max spread
              </label>
              <div className="rounded border border-line bg-panel p-3 text-xs sm:col-span-2">
                <label className="mb-2 flex items-center gap-2 font-semibold">
                  <input type="checkbox" checked={aggressiveStopProtection} onChange={(event) => setAggressiveStopProtection(event.target.checked)} disabled={!stopEnabled} />
                  Enable emergency stop loss
                </label>
                <div className="whitespace-pre-line leading-5 text-slate-600">{`Suggested football stop-loss settings:

0'-75':  slippage 5c,  max spread 8c
75'-88': slippage 10c, max spread 15c
88'-90': slippage 18c, max spread 28c
90'+:    slippage 30c, max spread disabled or 40c

Purpose: sell aggressively enough to escape when bids disappear during football gaps.`}</div>
                <div className="mt-2 whitespace-pre-line font-mono leading-5 text-slate-600">{`Emergency stress model:
0'-75':  slippage 8c,  max spread 12c
75'-88': slippage 12c, max spread 18c
88'+:    slippage 22c, max spread 35c
90'+:    slippage 30c, max spread disabled / 45c fallback`}</div>
                <button className="secondary-button mt-3 w-full" onClick={applyGameTimeStopSettings} disabled={!stopEnabled || !gameTimeConfigured} type="button">Apply Game-Time Stop Settings</button>
                <div className="mt-2 text-[11px] font-semibold text-slate-500">{gameTimeConfigured ? `Minute ${gameMinute}' preset: ${stopPreset.label}` : "Set kickoff time in Game Time first."}</div>
              </div>
            </div>
          </section>
          <section className="rounded-md border border-line bg-panel p-3">
            <div className="mb-2 text-sm font-semibold">Risk Preview</div>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div>Breakout trigger: <span className="font-mono">{triggerPrice || "-"}</span></div>
              <div>Max buy price: <span className="font-mono">{Number.isFinite(preview.maxBuyPrice) ? preview.maxBuyPrice.toFixed(3) : "-"}</span></div>
              <div>Estimated shares: <span className="font-mono">{Number.isFinite(preview.estimatedShares) ? preview.estimatedShares.toFixed(2) : "-"}</span></div>
              <div>Estimated stop loss: <span className="font-mono">{Number.isFinite(preview.stopLossEstimate) ? preview.stopLossEstimate.toFixed(3) : "-"}</span></div>
              <div>Trailing stop distance: <span className="font-mono">{Number.isFinite(preview.trailingDistance) ? preview.trailingDistance.toFixed(3) : "-"}</span></div>
            </div>
          </section>
          <section className="rounded-md border border-line bg-white p-3">
            <div className="mb-2 text-sm font-semibold">Sequence Timeline</div>
            <div className="grid gap-2 text-[11px] font-semibold uppercase text-slate-600 sm:grid-cols-6">
              {["waiting", "submitted", "filled", "exits active", "one exit filled", "sequence complete"].map((step, index) => (
                <div key={step} className={`rounded border px-2 py-2 text-center ${index === 0 ? "border-ink bg-ink text-white" : "border-line bg-panel"}`}>
                  {step}
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-md border border-line">
            <StepHeader index={3} icon={TrendingUp} title="After filled, activate trailing stop" status={trailEnabled ? "waiting" : "off"} />
            <div className="grid gap-3 p-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded border border-line bg-panel p-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={trailEnabled} onChange={(event) => setTrailEnabled(event.target.checked)} /> Trailing stop
              </label>
              <Field label="Trail percentage"><input className="control w-full" value={trailPercentage} onChange={(event) => setTrailPercentage(event.target.value)} disabled={!trailEnabled} /></Field>
              <Field label="Activation price"><input className="control w-full" value={trailActivationPrice} onChange={(event) => setTrailActivationPrice(event.target.value)} disabled={!trailEnabled} /></Field>
              <Field label="Sell slippage"><input className="control w-full" value={trailSlippage} onChange={(event) => setTrailSlippage(event.target.value)} disabled={!trailEnabled} /></Field>
            </div>
          </section>
          {errors.length > 0 && <div className="rounded-md border border-sell/30 bg-sell/5 p-2 text-xs text-sell">{errors.map((error) => <div key={error}>{error}</div>)}</div>}
          {message && <div className="rounded-md bg-panel p-2 text-xs text-sell">{message}</div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
          <button className="secondary-button" onClick={onClose} disabled={isSaving}>Cancel</button>
          <button className="primary-button min-w-32" onClick={save} disabled={errors.length > 0 || isSaving}>
            {isSaving ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Saving...</> : "Save Sequence"}
          </button>
        </div>
      </div>
    </div>
  );
}
