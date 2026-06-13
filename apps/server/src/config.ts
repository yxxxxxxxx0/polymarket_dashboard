import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? "../../.env" });
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env", override: false });

const envSchema = z.object({
  PRIVATE_KEY: z.string().optional(),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
  DEPOSIT_WALLET_ADDRESS: z.string().optional(),
  SIGNATURE_TYPE: z.coerce.number().default(3),
  BALANCE_SIGNATURE_TYPE: z.coerce.number().optional(),
  ORDER_SIGNATURE_TYPE: z.coerce.number().optional(),
  ENABLE_LIVE_TRADING: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  POLYMARKET_MARKET_ID: z.string().default("missing-market"),
  POLYMARKET_CONDITION_ID: z.string().default("missing-condition"),
  POLYMARKET_OUTCOME_1_NAME: z.string().optional(),
  POLYMARKET_OUTCOME_2_NAME: z.string().optional(),
  POLYMARKET_OUTCOME_3_NAME: z.string().optional(),
  POLYMARKET_OUTCOME_1_TOKEN_ID: z.string().optional(),
  POLYMARKET_OUTCOME_2_TOKEN_ID: z.string().optional(),
  POLYMARKET_OUTCOME_3_TOKEN_ID: z.string().optional(),
  POLYMARKET_CANADA_TOKEN_ID: z.string().optional(),
  POLYMARKET_BOSNIA_TOKEN_ID: z.string().optional(),
  POLYMARKET_MEXICO_TOKEN_ID: z.string().optional(),
  POLYMARKET_DRAW_TOKEN_ID: z.string().default("missing-draw-token"),
  POLYMARKET_SOUTH_AFRICA_TOKEN_ID: z.string().optional(),
  POLYMARKET_MARKET_TITLE: z.string().default("Configured Polymarket Market"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  POLYMARKET_CLOB_HOST: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_WS_HOST: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com"),
  POLYMARKET_DATA_HOST: z.string().url().default("https://data-api.polymarket.com"),
  POLYGON_RPC_URL: z.string().url().default("https://polygon-rpc.com"),
  OFI_ROLLING_WINDOW_30_SECONDS: z.coerce.number().positive().default(30),
  OFI_ROLLING_WINDOW_2M_SECONDS: z.coerce.number().positive().default(120),
  OFI_STRONG_BUY_THRESHOLD: z.coerce.number().default(0.30),
  OFI_BUY_THRESHOLD: z.coerce.number().default(0.10),
  OFI_SELL_THRESHOLD: z.coerce.number().default(-0.10),
  OFI_STRONG_SELL_THRESHOLD: z.coerce.number().default(-0.30),
  STOP_OFI_CONFIRMATION_TICKS: z.coerce.number().int().positive().default(2),
  STOP_OFI_SELL_THRESHOLD: z.coerce.number().default(-0.10),
  ORDERBOOK_REFRESH_MS: z.coerce.number().int().min(100).default(1_000),
  RULE_EVALUATION_MS: z.coerce.number().int().min(100).default(1_000),
  ORDERBOOK_STALE_MS: z.coerce.number().int().min(100).default(2_000),
  MARKET_STATS_REFRESH_MS: z.coerce.number().int().min(1_000).default(5_000),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().default("Asia/Hong_Kong"),
  GEO_COUNTRY_OVERRIDE: z.string().optional(),
  GEO_REGION_OVERRIDE: z.string().optional()
});

export const config = envSchema.parse(process.env);
export const webOrigins = config.WEB_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
export const balanceSignatureType = config.BALANCE_SIGNATURE_TYPE ?? config.SIGNATURE_TYPE;
export const orderSignatureType = config.ORDER_SIGNATURE_TYPE ?? config.SIGNATURE_TYPE;

process.env.DATABASE_URL = config.DATABASE_URL;
process.env.TZ = config.APP_TIMEZONE;

export const defaults = {
  maxTotalExposure: 250,
  tradeMode: "PAPER"
} as const;
