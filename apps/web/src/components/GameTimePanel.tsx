"use client";

import { Clock, Pause, Play, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type GameTimeSetting, type GapModelConfig } from "@/lib/api";
import { GAME_TIMEZONE, getAggressiveBreakoutSettings, getAggressiveStopProtectionSettings, getGameMinute, getGameStatus, hktLocalToIso, isoToHktInputParts } from "@/lib/gameTime";

export function GameTimePanel({ marketId, onGameMinuteChange }: { marketId: string; onGameMinuteChange?: (minute: number) => void }) {
  const [setting, setSetting] = useState<GameTimeSetting | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [timezone, setTimezone] = useState(GAME_TIMEZONE);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [startingSecondHalf, setStartingSecondHalf] = useState(false);
  const [gapModelOpen, setGapModelOpen] = useState(false);
  const [gapModel, setGapModel] = useState<GapModelConfig | null>(null);
  const [gapModelText, setGapModelText] = useState("");
  const [savingGapModel, setSavingGapModel] = useState(false);

  function applySetting(next: GameTimeSetting) {
    setSetting(next);
    setTimezone(next.timezone || GAME_TIMEZONE);
    const parts = isoToHktInputParts(next.kickoffTimeIso);
    setDate(parts.date);
    setTime(parts.time);
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  function elapsedSecondsSince(iso: string | null | undefined) {
    if (!iso) return 0;
    const startedAt = new Date(iso).getTime();
    if (!Number.isFinite(startedAt)) return 0;
    return Math.max(0, Math.floor((now.getTime() - startedAt) / 1_000));
  }

  function formatElapsed(seconds: number) {
    const clamped = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(clamped / 60);
    const remainingSeconds = clamped % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function tierRangeLabel(index: number, tiers: GapModelConfig["breakout"]["tiers"]) {
    const tier = tiers[index];
    const next = tiers[index + 1];
    return next ? `${tier.startMinute}'-${next.startMinute}'` : `${tier.startMinute}'+`;
  }

  function formatSpread(tier: GapModelConfig["breakout"]["tiers"][number]) {
    return tier.disableMaxSpread ? `disabled / ${tier.maxSpreadCents}c` : `${tier.maxSpreadCents}c`;
  }

  useEffect(() => {
    let mounted = true;
    api<GameTimeSetting>(`/api/settings/game-time/${encodeURIComponent(marketId)}`).then((next) => {
      if (!mounted) return;
      applySetting(next);
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not load game time"));
    return () => { mounted = false; };
  }, [marketId]);

  useEffect(() => {
    let mounted = true;
    api<GapModelConfig>("/api/settings/gap-model").then((next) => {
      if (!mounted) return;
      setGapModel(next);
      if (!gapModelText) setGapModelText(JSON.stringify(next, null, 2));
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not load gap model"));
    return () => { mounted = false; };
  }, []);

  const live = useMemo(() => {
    if (!setting?.kickoffTimeIso) return { elapsedSeconds: 0, minute: 0, status: "Waiting for kickoff" };
    if (setting.paused) {
      const minute = setting.pausedGameMinute ?? setting.gameMinute ?? 0;
      return { elapsedSeconds: minute * 60, minute, status: "Paused" };
    }
    if (setting.phase === "SECOND_HALF" && setting.secondHalfStartedAtIso) {
      const elapsedSeconds = 45 * 60 + elapsedSecondsSince(setting.secondHalfStartedAtIso);
      const minute = Math.max(45, Math.floor(elapsedSeconds / 60));
      return { elapsedSeconds, minute, status: minute >= 120 ? "Finished" : "Second half" };
    }
    const firstHalfElapsedSeconds = Math.min(45 * 60, elapsedSecondsSince(setting.kickoffTimeIso));
    const firstHalfMinute = Math.min(45, Math.floor(firstHalfElapsedSeconds / 60));
    if (firstHalfMinute >= 45) return { elapsedSeconds: 45 * 60, minute: 45, status: "Half-time" };
    return { elapsedSeconds: firstHalfElapsedSeconds, minute: firstHalfMinute, status: getGameStatus(setting.kickoffTimeIso, now) === "Waiting for kickoff" ? "Waiting for kickoff" : "First half" };
  }, [now, setting?.gameMinute, setting?.kickoffTimeIso, setting?.paused, setting?.pausedGameMinute, setting?.phase, setting?.secondHalfStartedAtIso]);
  const breakoutPreset = getAggressiveBreakoutSettings(live.minute);
  const stopPreset = getAggressiveStopProtectionSettings(live.minute);

  useEffect(() => {
    onGameMinuteChange?.(live.minute);
  }, [live.minute, onGameMinuteChange]);

  async function save() {
    const kickoffTimeIso = hktLocalToIso(date, time);
    if (!kickoffTimeIso) {
      setMessage("Enter kickoff date and time.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const next = await api<GameTimeSetting>(`/api/settings/game-time/${encodeURIComponent(marketId)}`, {
        method: "PUT",
        body: JSON.stringify({ kickoffTimeIso, timezone })
      });
      applySetting(next);
      setMessage("Kickoff time saved");
      window.setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function togglePause() {
    if (!setting?.kickoffTimeIso) {
      setMessage("Save kickoff time first.");
      return;
    }
    setTogglingPause(true);
    setMessage("");
    try {
      const action = setting.paused ? "resume" : "pause";
      const next = await api<GameTimeSetting>(`/api/settings/game-time/${encodeURIComponent(marketId)}/${action}`, {
        method: "POST"
      });
      applySetting(next);
      setMessage(setting.paused ? "Game time resumed" : "Game time paused");
      window.setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update game time");
    } finally {
      setTogglingPause(false);
    }
  }

  async function startSecondHalf() {
    if (!setting?.kickoffTimeIso) {
      setMessage("Save kickoff time first.");
      return;
    }
    setStartingSecondHalf(true);
    setMessage("");
    try {
      const next = await api<GameTimeSetting>(`/api/settings/game-time/${encodeURIComponent(marketId)}/second-half`, {
        method: "POST"
      });
      applySetting(next);
      setMessage("Second half started");
      window.setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start second half");
    } finally {
      setStartingSecondHalf(false);
    }
  }

  async function saveGapModel() {
    setSavingGapModel(true);
    setMessage("");
    try {
      const parsed = JSON.parse(gapModelText) as GapModelConfig;
      const next = await api<GapModelConfig>("/api/settings/gap-model", {
        method: "PUT",
        body: JSON.stringify(parsed)
      });
      setGapModel(next);
      setGapModelText(JSON.stringify(next, null, 2));
      setMessage("Gap model saved");
      window.setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gap model save failed");
    } finally {
      setSavingGapModel(false);
    }
  }

  return (
    <section className="rounded-md border border-line bg-white p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clock className="h-4 w-4" /> Game Time</div>
      <div className="grid gap-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Kickoff date</span>
            <input className="control mt-1 w-full" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Kickoff time</span>
            <input className="control mt-1 w-full" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Timezone</span>
          <select className="control mt-1 w-full" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            <option value="Asia/Hong_Kong">HKT / Asia/Hong_Kong</option>
          </select>
        </label>
        <button className="secondary-button w-full" onClick={save} disabled={saving} type="button">
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Kickoff Time"}
        </button>
        <button className="secondary-button w-full" onClick={togglePause} disabled={togglingPause || !setting?.kickoffTimeIso} type="button">
          {setting?.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {togglingPause ? "Updating..." : setting?.paused ? "Resume Game Time" : "Pause Game Time"}
        </button>
        <button className="secondary-button w-full" onClick={startSecondHalf} disabled={startingSecondHalf || !setting?.kickoffTimeIso || setting?.phase === "SECOND_HALF"} type="button">
          <Play className="h-4 w-4" />
          {startingSecondHalf ? "Starting..." : "Start Second Half"}
        </button>
      </div>
      <div className="mt-3 rounded border border-line bg-panel p-2 text-xs">
        <div>Elapsed time: <span className="font-mono">{formatElapsed(live.elapsedSeconds)}</span></div>
        <div>Current game minute: <span className="font-mono">{live.minute}'</span></div>
        <div>Status: <span className="font-semibold">{live.status}</span></div>
        <div>Half: <span className="font-semibold">{live.status === "Second half" || setting?.phase === "SECOND_HALF" ? "Second" : live.status === "Half-time" ? "Half-time" : "First"}</span></div>
        <div>Current breakout: <span className="font-mono">{breakoutPreset.label}</span></div>
        <div>Current stop: <span className="font-mono">{stopPreset.label}</span></div>
        {gapModel && (
          <div className="mt-2 border-t border-line pt-2">
            <div className="mb-1 font-semibold">Full gap model</div>
            <div className="grid grid-cols-[3.4rem_1fr_1fr] gap-x-2 gap-y-1 font-mono text-[11px] leading-4">
              <span className="font-sans font-semibold">Time</span>
              <span className="font-sans font-semibold">Breakout</span>
              <span className="font-sans font-semibold">Stop</span>
              {gapModel.breakout.tiers.map((breakoutTier, index) => {
                const stopTier = gapModel.stopLoss.tiers[index];
                return (
                  <div key={`${breakoutTier.startMinute}-${index}`} className="contents">
                    <span>{tierRangeLabel(index, gapModel.breakout.tiers)}</span>
                    <span>{breakoutTier.slippageCents}c / {formatSpread(breakoutTier)}</span>
                    <span>{stopTier ? `${stopTier.slippageCents}c / ${formatSpread(stopTier)}` : "-"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <button className="secondary-button mt-3 w-full" onClick={() => setGapModelOpen((open) => !open)} type="button">
        <SlidersHorizontal className="h-4 w-4" />
        Gap Model
      </button>
      {gapModelOpen && (
        <div className="mt-3 rounded border border-line bg-panel p-2">
          <textarea
            className="control min-h-64 w-full font-mono text-[11px]"
            value={gapModelText}
            onChange={(event) => setGapModelText(event.target.value)}
            spellCheck={false}
          />
          <button className="primary-button mt-2 w-full" onClick={saveGapModel} disabled={savingGapModel || gapModelText.trim().length === 0} type="button">
            <Save className="h-4 w-4" />
            {savingGapModel ? "Saving..." : "Save Gap Model"}
          </button>
        </div>
      )}
      {message && <div className="mt-2 text-xs font-semibold text-slate-600">{message}</div>}
    </section>
  );
}
