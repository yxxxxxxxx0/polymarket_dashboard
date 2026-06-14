"use client";

import { Clock, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type GameTimeSetting } from "@/lib/api";
import { GAME_TIMEZONE, estimateGapByGameMinute, getGameMinute, getGameStatus, hktLocalToIso, isoToHktInputParts } from "@/lib/gameTime";

export function GameTimePanel({ marketId, onGameMinuteChange }: { marketId: string; onGameMinuteChange?: (minute: number) => void }) {
  const [setting, setSetting] = useState<GameTimeSetting | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [timezone, setTimezone] = useState(GAME_TIMEZONE);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    api<GameTimeSetting>(`/api/settings/game-time/${encodeURIComponent(marketId)}`).then((next) => {
      if (!mounted) return;
      setSetting(next);
      setTimezone(next.timezone || GAME_TIMEZONE);
      const parts = isoToHktInputParts(next.kickoffTimeIso);
      setDate(parts.date);
      setTime(parts.time);
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not load game time"));
    return () => { mounted = false; };
  }, [marketId]);

  const live = useMemo(() => {
    if (!setting?.kickoffTimeIso) return { minute: 0, status: "Waiting for kickoff", estimatedGap: 0 };
    const minute = getGameMinute(setting.kickoffTimeIso, now);
    return { minute, status: getGameStatus(setting.kickoffTimeIso, now), estimatedGap: estimateGapByGameMinute(minute) };
  }, [now, setting?.kickoffTimeIso]);

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
      setSetting(next);
      setMessage("Kickoff time saved");
      window.setTimeout(() => setMessage(""), 2_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
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
      </div>
      <div className="mt-3 rounded border border-line bg-panel p-2 text-xs">
        <div>Current game minute: <span className="font-mono">{live.minute}'</span></div>
        <div>Status: <span className="font-semibold">{live.status}</span></div>
        <div>Estimated gap: <span className="font-mono">{live.estimatedGap.toFixed(3)}</span></div>
      </div>
      {message && <div className="mt-2 text-xs font-semibold text-slate-600">{message}</div>}
    </section>
  );
}
