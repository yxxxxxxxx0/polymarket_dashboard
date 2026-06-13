"use client";

import { CheckCircle2, ChevronsUpDown, Plus, RefreshCw, ShieldPlus, Trash2, TrendingUp, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api, post, withProfile, type ActiveMarketConfig, type MarketSummary, type SavedMarketConfig } from "@/lib/api";
import { MarketPriceChart } from "./MarketPriceChart";
import { OrderBookPanel } from "./OrderBookPanel";
import { OrderBookProvider } from "./OrderBookProvider";
import { OrderTicket } from "./OrderTicket";
import { PositionSummary } from "./PositionSummary";
import { StopLossForm, type RuleMode } from "./StopLossForm";
import { BuyingPowerSummary } from "./BuyingPowerSummary";
import { StopLossView } from "./DataViews";
import { useAccount } from "./AccountProvider";

export function SingleMarketDashboard({ profile = "football", marketLabel = "Market" }: { profile?: string; marketLabel?: string }) {
  const { account, refreshAccount } = useAccount();
  const [market, setMarket] = useState<MarketSummary | null>(null);
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  const [positionAutoSelected, setPositionAutoSelected] = useState(false);
  const [ruleMode, setRuleMode] = useState<RuleMode | null>(null);
  const [rulesRefreshKey, setRulesRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [marketPanelOpen, setMarketPanelOpen] = useState(false);
  const [marketEnvText, setMarketEnvText] = useState("");
  const [marketChangeError, setMarketChangeError] = useState("");
  const [marketChanging, setMarketChanging] = useState(false);
  const [marketLoadError, setMarketLoadError] = useState("");
  const [savedMarkets, setSavedMarkets] = useState<SavedMarketConfig[]>([]);
  const [selectedSavedMarketId, setSelectedSavedMarketId] = useState("");
  const [savedMarketsLoading, setSavedMarketsLoading] = useState(false);
  const [newMarketOpen, setNewMarketOpen] = useState(false);

  async function loadMarket() {
    setMarketLoadError("");
    try {
      setMarket(await api<MarketSummary>(withProfile("/api/market", profile)));
    } catch (error) {
      setMarket(null);
      setMarketLoadError(error instanceof Error ? error.message : "Could not load configured market");
    }
  }

  useEffect(() => {
    void loadMarket();
  }, [profile]);

  async function loadSavedMarkets() {
    setSavedMarketsLoading(true);
    setMarketChangeError("");
    try {
      const entries = await api<SavedMarketConfig[]>(withProfile("/api/active-market/saved", profile));
      setSavedMarkets(entries);
      setSelectedSavedMarketId((current) => {
        if (current && entries.some((entry) => entry.marketId === current)) return current;
        if (market && entries.some((entry) => entry.marketId === market.id)) return market.id;
        return entries[0]?.marketId ?? "";
      });
    } catch (error) {
      setMarketChangeError(error instanceof Error ? error.message : "Could not load saved markets");
    } finally {
      setSavedMarketsLoading(false);
    }
  }

  useEffect(() => {
    if (!marketPanelOpen) return;
    void loadSavedMarkets();
  }, [marketPanelOpen]);

  useEffect(() => {
    if (!market || positionAutoSelected) return;
    const heldTokenId = account?.positions[0]?.tokenId;
    if (!heldTokenId) return;
    const heldIndex = market.tokenIds.findIndex((tokenId) => tokenId === heldTokenId);
    if (heldIndex >= 0) {
      setOutcomeIndex(heldIndex);
      setPositionAutoSelected(true);
    }
  }, [account?.positions, market, positionAutoSelected]);

  if (!market) {
    return (
      <div className="rounded-md border border-line bg-white p-4 text-sm">
        {marketLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-sell">Could not load configured market.</div>
              <div className="mt-1 text-xs text-slate-600">{marketLoadError}</div>
            </div>
            <button className="secondary-button" onClick={loadMarket} type="button">Retry</button>
          </div>
        ) : "Loading configured market..."}
      </div>
    );
  }

  const tokenId = market.tokenIds[outcomeIndex];
  const outcome = market.outcomes[outcomeIndex] ?? "Outcome";

  function handleRuleSaved(message: string) {
    setRulesRefreshKey((key) => key + 1);
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3_000);
  }

  async function refreshMarket() {
    const nextMarket = await api<MarketSummary>(withProfile("/api/market", profile));
    setMarket(nextMarket);
    return nextMarket;
  }

  async function handleSavedMarketChange() {
    if (!selectedSavedMarketId) return;
    setMarketChangeError("");
    setMarketChanging(true);
    try {
      await post<ActiveMarketConfig>(withProfile("/api/active-market/from-saved", profile), { marketId: selectedSavedMarketId });
      const nextMarket = await refreshMarket();
      setOutcomeIndex(0);
      setPositionAutoSelected(false);
      setRulesRefreshKey((key) => key + 1);
      await refreshAccount({ force: true });
      setNotice(`Active market changed to ${nextMarket.title}`);
      window.setTimeout(() => setNotice(""), 3_000);
      setMarketPanelOpen(false);
    } catch (error) {
      setMarketChangeError(error instanceof Error ? error.message : "Could not change market");
    } finally {
      setMarketChanging(false);
    }
  }

  async function handleNewMarket() {
    setMarketChangeError("");
    setMarketChanging(true);
    try {
      await post<ActiveMarketConfig>(withProfile("/api/active-market/saved", profile), { marketText: marketEnvText });
      await loadSavedMarkets();
      const nextMarket = await refreshMarket();
      setOutcomeIndex(0);
      setPositionAutoSelected(false);
      setRulesRefreshKey((key) => key + 1);
      await refreshAccount({ force: true });
      setNotice(`Added ${nextMarket.title}`);
      window.setTimeout(() => setNotice(""), 3_000);
      setMarketEnvText("");
      setNewMarketOpen(false);
      setMarketPanelOpen(false);
    } catch (error) {
      setMarketChangeError(error instanceof Error ? error.message : "Could not add market");
    } finally {
      setMarketChanging(false);
    }
  }

  async function handleRemoveSavedMarket() {
    if (!selectedSavedMarketId) return;
    const selected = savedMarkets.find((entry) => entry.marketId === selectedSavedMarketId);
    if (!window.confirm(`Remove ${selected?.title ?? selectedSavedMarketId} from saved ${marketLabel.toLowerCase()}s?`)) return;
    setMarketChangeError("");
    setMarketChanging(true);
    try {
      await api<ActiveMarketConfig>(withProfile(`/api/active-market/saved/${encodeURIComponent(selectedSavedMarketId)}`, profile), { method: "DELETE" });
      const entries = await api<SavedMarketConfig[]>(withProfile("/api/active-market/saved", profile));
      setSavedMarkets(entries);
      setSelectedSavedMarketId(entries[0]?.marketId ?? "");
      setNotice(`Removed ${selected?.title ?? selectedSavedMarketId}`);
      window.setTimeout(() => setNotice(""), 3_000);
    } catch (error) {
      setMarketChangeError(error instanceof Error ? error.message : "Could not remove market");
    } finally {
      setMarketChanging(false);
    }
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className="fixed right-4 top-16 z-50 flex items-center gap-2 rounded-md border border-buy/30 bg-white px-3 py-2 text-sm font-semibold text-buy shadow-lg">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      )}

      <OrderBookProvider tokenIds={market.tokenIds} profile={profile}>
        <div className="grid gap-4 2xl:grid-cols-[minmax(420px,1fr)_460px_330px]">
          <section className="space-y-4">
            <div className="rounded-md border border-line bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold">{market.title}</h1>
                  <div className="mt-1 font-mono text-xs text-slate-500">{market.conditionId ?? market.id}</div>
                </div>
                <button className="secondary-button h-9" onClick={() => setMarketPanelOpen((open) => !open)} type="button">
                  <ChevronsUpDown className="h-4 w-4" />
                  Change {marketLabel}
                </button>
              </div>
              {marketPanelOpen && (
                <div className="mt-4 rounded-md border border-line bg-panel p-3">
                  <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                    <select
                      className="control w-full"
                      disabled={savedMarketsLoading || savedMarkets.length === 0}
                      onChange={(event) => setSelectedSavedMarketId(event.target.value)}
                      value={selectedSavedMarketId}
                    >
                      {savedMarkets.length === 0 ? (
                        <option value="">{savedMarketsLoading ? "Loading markets..." : "No saved markets"}</option>
                      ) : savedMarkets.map((entry) => (
                        <option key={`${entry.marketId}-${entry.sourceIndex}`} value={entry.marketId}>
                          {entry.title} ({entry.marketId})
                        </option>
                      ))}
                    </select>
                    <button className="secondary-button" disabled={savedMarketsLoading} onClick={loadSavedMarkets} type="button">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <button className="secondary-button" disabled={marketChanging || !selectedSavedMarketId} onClick={handleRemoveSavedMarket} type="button">
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </button>
                    <button className="secondary-button" onClick={() => setNewMarketOpen((open) => !open)} type="button">
                      <Plus className="h-4 w-4" />
                      New Market
                    </button>
                  </div>
                  {newMarketOpen && (
                    <textarea
                      className="control mt-3 min-h-44 w-full font-mono text-xs"
                      onChange={(event) => setMarketEnvText(event.target.value)}
                      placeholder="Paste one market object or POLYMARKET_* block"
                      value={marketEnvText}
                    />
                  )}
                  {marketChangeError && <div className="mt-2 rounded-md bg-sell/10 p-2 text-xs font-semibold text-sell">{marketChangeError}</div>}
                  <div className="mt-3 flex justify-end gap-2">
                    <button className="secondary-button" disabled={marketChanging} onClick={() => setMarketPanelOpen(false)} type="button">Cancel</button>
                    {newMarketOpen ? (
                      <button className="primary-button" disabled={marketChanging || marketEnvText.trim().length === 0} onClick={handleNewMarket} type="button">
                        {marketChanging ? "Adding..." : "Add & Use"}
                      </button>
                    ) : (
                      <button className="primary-button" disabled={marketChanging || !selectedSavedMarketId} onClick={handleSavedMarketChange} type="button">
                        {marketChanging ? "Updating..." : "Use Selected"}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-4 grid rounded-md border border-line bg-panel p-1" style={{ gridTemplateColumns: `repeat(${market.outcomes.length}, minmax(0, 1fr))` }}>
                {market.outcomes.map((item, index) => (
                  <button
                    key={item}
                    className={`h-9 rounded text-sm font-semibold ${index === outcomeIndex ? "bg-ink text-white" : ""}`}
                    onClick={() => {
                      setOutcomeIndex(index);
                      setPositionAutoSelected(true);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <MarketPriceChart tokenIds={market.tokenIds} outcomeNames={market.outcomes} marketVolume={market.volume} />
            <PositionSummary tokenId={tokenId} />
          </section>

          <section className="space-y-4">
            <OrderBookPanel tokenId={tokenId} />
          </section>

          <section className="space-y-4">
            <BuyingPowerSummary tokenId={tokenId} />
            <OrderTicket profile={profile} marketId={market.id} conditionId={market.conditionId} tokenId={tokenId} outcomeName={outcome} />
            <div className="grid grid-cols-3 gap-2">
              <button className="primary-button w-full" onClick={() => setRuleMode("STOP_LOSS")}>
                <ShieldPlus className="h-4 w-4" />
                Stop
              </button>
              <button className="secondary-button w-full" onClick={() => setRuleMode("TRAILING_STOP")}>
                <TrendingUp className="h-4 w-4" />
                Trail
              </button>
              <button className="secondary-button w-full" onClick={() => setRuleMode("BREAKOUT_BUY")}>
                <Zap className="h-4 w-4" />
                Breakout
              </button>
            </div>
          </section>
        </div>

        {ruleMode && (
          <StopLossForm
            marketId={market.id}
            conditionId={market.conditionId}
            tokenId={tokenId}
            outcomeName={outcome}
            profile={profile}
            initialMode={ruleMode}
            onClose={() => setRuleMode(null)}
            onSaved={handleRuleSaved}
          />
        )}
      </OrderBookProvider>

      <StopLossView profile={profile} refreshKey={rulesRefreshKey} title="All Stop Loss, Trailing Stop, and Breakout Buy Orders" />
    </div>
  );
}
