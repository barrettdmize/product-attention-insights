# AI Product Draft App

A Shopify embedded app that provides **Product Attention Insights** — AI-generated advisory recommendations for products that may need attention (e.g. stale descriptions, pricing, imagery). **Advisory only**: no product data is written back to Shopify.

## What it does

- **Insights page** (`/app/insights`): Lists products by “days since updated,” computes attention score and status (recently updated / healthy / neglected), and lets you generate AI explanations per product or in batch.
- **Runs page** (`/app/runs`): Lists recent batch runs and per-product job outcomes (queued, running, succeeded, failed).
- **Worker**: Background process that polls for queued AI jobs, calls OpenAI, and writes results to `ProductInsight`. Supports retries with backoff (up to 3 attempts).
- **Webhooks**: `app/uninstalled` with idempotency (ignores duplicates by `X-Shopify-Webhook-Id`) and full shop data cleanup.

## How to run locally

### Prerequisites

- Node.js 20.19+ or 22.12+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- OpenAI API key

### Setup

1. Copy `.env.example` to `.env`.
2. Run `shopify app dev` — this sets `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, and `SHOPIFY_APP_URL` automatically.
3. Add `OPENAI_API_KEY` to `.env` (get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)).
4. Run migrations: `npm run db:migrate` (or `npm run setup` for generate + migrate).

### Run the app and worker

1. **App**: `npm run dev` (or `shopify app dev`) — starts the app with tunnel.
2. **Worker** (separate terminal): `npm run worker` — polls for queued jobs and processes them.

Both processes share the same `.env` and SQLite database.

## Architecture overview

| Component | Role |
|-----------|------|
| **Auth** | Shopify OAuth via `@shopify/shopify-app-react-router`; sessions in Prisma/SQLite. |
| **Loader** | `/app/insights` fetches products via Admin GraphQL, upserts `ProductInsight`, returns list. |
| **Queue** | Single-product or batch actions enqueue `InsightJob` rows (status `QUEUED`). |
| **Worker** | Polls for `QUEUED` jobs, claims with concurrency-safe `updateMany`, calls OpenAI, updates `ProductInsight` and `InsightJob`. |
| **Webhooks** | `app/uninstalled` verified via HMAC; idempotent via `WebhookEvent`; deletes all shop data. |

## Key decisions

- **Advisory only**: AI output is stored in `ProductInsight`; nothing is written to Shopify products.
- **Per-product trigger**: Each “Generate AI insight” enqueues one job; batch “Generate AI for visible list” enqueues up to 10.
- **Hard limits**: Batch size ≤ 10; AI prompt avoids product copy generation.
- **Retries**: Up to 3 attempts with backoff (2s, 5s, 10s); `nextRetryAt` prevents immediate re-processing.
- **Idempotency**: Webhook deduplication by `X-Shopify-Webhook-Id`; job claiming uses `updatedAt` for concurrency safety.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start app (shopify app dev) |
| `npm run worker` | Run AI insight job worker |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run build` | Build for production |
| `npm run start` | Run production server |

## Verify end-to-end

1. Run `npm run dev` and `npm run worker` in two terminals.
2. Open the app in Shopify admin → Insights.
3. Click “Generate AI insight” on a product (or “Generate AI for visible list”).
4. Worker logs processing; refresh Insights to see AI output.
5. Go to Runs → open a run to see per-product status.
6. Uninstall the app → webhook fires; reinstall and confirm data was cleaned.

## What’s next (stretch ideas)

- Scheduled batch runs (cron).
- Webhook for `products/update` to refresh `ProductInsight` when products change.
- Rate limiting / queue depth limits.
- Production database (PostgreSQL) and hosted worker (e.g. Fly.io, Railway).
