# Single-Market Polymarket Trading Dashboard

Full-stack dashboard for one active Polymarket market. It shows the active market title, dynamic outcome switching, real Polymarket order books, the Polymarket embedded odds chart, scoped positions/orders, and synthetic stop-loss rules.

## Compliance and Risk Defaults

- The backend calls `GET https://polymarket.com/api/geoblock` before enabling any trading action.
- Blocked locations cannot open new positions.
- Close-only locations can only close or reduce positions.
- Live trading is disabled unless `ENABLE_LIVE_TRADING=true`.
- Paper trading is the default mode.
- Secrets are backend-only and loaded from `.env`.
- Unknown token IDs are rejected. Only token IDs from `config/active-market.json` are accepted.

## Setup

```bash
mkdir -p ~/polymarket_data
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Frontend: `http://localhost:3000`

Backend: `http://localhost:4000`

## Active Market

The active market lives in a local runtime file such as `config/active-market.json`. To change it without editing `.env` or restarting the frontend, open the dashboard, click `Change Market`, paste `.env`-style market text, and submit.

Do not commit active-market JSON files from production servers. They are ignored because a Git pull should not overwrite the market currently being traded on AWS.

The backend routes are:

- `GET /api/active-market`
- `POST /api/active-market/from-env`

The real `.env` should keep stable app settings and secrets only, such as CLOB hosts, wallet credentials, ports, and API settings.

## Local Data Safety

Keep trading data outside the code checkout. The default local SQLite URL is:

```bash
DATABASE_URL=file:/Users/justincheng/polymarket_data/dev.db
```

The repo ignores `.env`, active-market JSON files, SQLite databases, JSONL files, logs, build output, and `polymarket_data/` so Git operations do not overwrite local trading history or production market selection.

## Runtime Speed Knobs

The server uses Polymarket market WebSocket updates as the primary order book source and streams cached books to the browser over server-sent events. Polling is only a fallback and is configurable:

```bash
ORDERBOOK_REFRESH_MS=1000
RULE_EVALUATION_MS=1000
ORDERBOOK_STALE_MS=2000
MARKET_STATS_REFRESH_MS=5000
NEXT_PUBLIC_UI_REFRESH_MS=10000
```

## Notes

This project uses public Polymarket CLOB endpoints for order book display and `@polymarket/clob-client-v2` plus `viem` for signed order operations. The trading service refuses live order placement until the live trading environment flag, app trading mode, token guard, and geoblock check all allow the requested action.
