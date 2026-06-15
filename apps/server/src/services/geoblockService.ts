import type { GeoblockResult } from "../types/domain.js";
import { config } from "../config.js";
import { fetchWithTimeout } from "../lib/timeout.js";

const closeOnlyCountries = new Set(["PL", "SG", "TH", "TW"]);

export async function checkGeoblock(): Promise<GeoblockResult> {
  const countryOverride = config.GEO_COUNTRY_OVERRIDE?.trim().toUpperCase();
  if (countryOverride) {
    const closeOnly = closeOnlyCountries.has(countryOverride);
    return {
      blocked: false,
      closeOnly,
      canOpen: !closeOnly,
      canClose: true,
      country: countryOverride,
      region: config.GEO_REGION_OVERRIDE
    };
  }

  const response = await fetchWithTimeout("https://polymarket.com/api/geoblock", {
    headers: { accept: "application/json" },
    cache: "no-store"
  }, config.POLYMARKET_FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Geoblock check failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    blocked?: boolean;
    ip?: string;
    country?: string;
    region?: string;
  };

  const country = body.country?.toUpperCase();
  const closeOnly = country ? closeOnlyCountries.has(country) : false;
  const blocked = Boolean(body.blocked) && !closeOnly;

  return {
    blocked,
    closeOnly,
    canOpen: !blocked && !closeOnly,
    canClose: !blocked || closeOnly,
    country,
    region: body.region,
    ip: body.ip
  };
}
