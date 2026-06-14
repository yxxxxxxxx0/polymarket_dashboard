import { TradeMode } from "@prisma/client";
import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { checkGeoblock } from "./geoblockService.js";
import { getAppSettings } from "./settingsService.js";
import { marketScope } from "./singleMarketService.js";
import { accountSummary } from "./accountService.js";

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

export async function assertTradingAllowed(input: {
  tradeMode: TradeMode;
  action: "OPEN" | "CLOSE" | "CANCEL";
  size?: number;
  price?: number;
}) {
  const settings = await getAppSettings();
  const geo = input.tradeMode === TradeMode.LIVE
    ? await checkGeoblock()
    : {
      blocked: false,
      closeOnly: false,
      canOpen: true,
      canClose: true
    };

  if (input.tradeMode === TradeMode.LIVE && !config.ENABLE_LIVE_TRADING) {
    throw new HttpError(403, "Live trading requires ENABLE_LIVE_TRADING=true");
  }

  if (input.tradeMode === TradeMode.LIVE && settings.tradeMode !== TradeMode.LIVE) {
    throw new HttpError(403, "Live trading must be enabled in app settings");
  }

  if (input.tradeMode === TradeMode.LIVE && input.action === "OPEN" && !geo.canOpen) {
    throw new HttpError(403, geo.closeOnly ? "This location is close-only; opening positions is disabled" : "This location is blocked from opening positions");
  }

  if (input.tradeMode === TradeMode.LIVE && input.action === "CLOSE" && !geo.canClose) {
    throw new HttpError(403, "This location is blocked from trading");
  }

  if (input.tradeMode === TradeMode.LIVE && input.action === "OPEN" && input.size && input.price) {
    const notional = input.size * input.price;
    const account = await accountSummary({ force: true });
    if (account.cash !== null && Number.isFinite(account.cash) && notional > account.cash + 1e-9) {
      throw new HttpError(400, `Live buy amount ${money(notional)} exceeds cash balance ${money(account.cash)}`);
    }
    if (account.allowance !== null && Number.isFinite(account.allowance) && notional > account.allowance + 1e-9) {
      throw new HttpError(400, `Live buy amount ${money(notional)} exceeds USDC allowance ${money(account.allowance)}`);
    }
  }

  if (input.action === "OPEN" && input.size && input.price) {
    const { marketId } = marketScope();
    const openExposure = await prisma.position.aggregate({ where: { marketId }, _sum: { size: true } });
    const exposure = Number(openExposure._sum.size ?? 0) + input.size * input.price;
    if (exposure > settings.maxTotalExposure) {
      throw new HttpError(400, `Total exposure would exceed maxTotalExposure ${settings.maxTotalExposure}`);
    }
  }

  return { settings, geo };
}
