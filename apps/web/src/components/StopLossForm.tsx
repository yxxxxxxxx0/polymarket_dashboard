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

export function StopLossForm({ profile, marketId, conditionId, tokenId, outcomeName, initialMode = "STOP_LOSS", onClose, onSaved }: {
  profile?: string;
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcomeName: string;
  initialMode?: RuleMode;
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
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [lastEdited, setLastEdited] = useState<"stopPrice" | "stopPercentage" | "trailingStopPrice" | "trailingPercentage" | "buyTriggerPrice" | "breakoutPercentage">("stopPercentage");

  const livePrice = referencePriceForTrigger(useOrderBook(tokenId), triggerType);

  useEffect(() => {
    if (livePrice !== null) setCurrentPrice(formatPrice(livePrice));
  }, [livePrice]);

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
        maxSpread: mode === "BREAKOUT_BUY" && maxSpread ? maxSpread : undefined,
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
            <Field label="Stake amount" help="USD amount to use when the breakout triggers.">
              <input className="control w-full" value={stakeAmount} onChange={(event) => setStakeAmount(event.target.value)} />
            </Field>
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
              <Field label="Max spread" help="Skip breakout buys if best ask minus best bid is wider than this.">
                <input className="control w-full" value={maxSpread} onChange={(event) => setMaxSpread(event.target.value)} />
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
