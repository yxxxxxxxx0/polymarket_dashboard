import { defaults } from "../config.js";
import { prisma } from "../lib/prisma.js";

export async function getSetting(key: string, fallback: string): Promise<string> {
  const setting = await prisma.appSetting.findUnique({ where: { key } });
  return setting?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  return prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
}

export async function getAppSettings() {
  const [tradeMode, maxTotalExposure] = await Promise.all([
    getSetting("tradeMode", defaults.tradeMode),
    getSetting("maxTotalExposure", String(defaults.maxTotalExposure))
  ]);

  return {
    tradeMode,
    maxTotalExposure: Number(maxTotalExposure)
  };
}
