# Viuhti Cloudflare (Free Tier Edition)

Public TV & Movie Release Calendar, **Control Center**, **Word Pool**, **Discover**, and **Graxobolt** 3D galaxy — built on **Cloudflare's Free Tier** (**Workers + Static Assets + D1 SQLite + Workers KV + Cron Triggers**).

## Architecture & Visitor Privacy Isolation

| Capability | Design in `viuhti-cloudflare` |
| --- | --- |
| **Static Assets (`public/*`)** | Served via **Workers Static Assets** (`assetsDirectory: "./public"`, `runWorkerFirst: ["/api/*"]`) with `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` |
| **4-Tier Cache Shield (`src/cache.ts`)** | `Edge Cache (caches.default)` → `Isolate L1 RAM` → `Global Workers KV (CACHE_KV)` → `D1 Origin` with automatic KV + live-upstream fallback (`createKvFallbackDb`, ephemeral TVmaze/iTunes/Wikipedia lookups) when D1 Free Tier daily quota is reached |
| **Per-Visitor Browser Isolation (`public/client-store.js`)** | Personal favorites, watched episodes/movies, hidden titles, Word Pool rules, taste feedback, custom external search URL, and themes live solely in each visitor's browser `localStorage` (`viuhti.*`) |
| **Shared Public Catalog (`D1`)** | D1 stores only the shared public catalog (`shows`, `episodes`, `movies`, `taste_items`). Visitor searches, modals, and locally added titles are handled ephemerally and never written to shared D1 or KV inventory |
| **Redacted `/status` Dashboard (`public/status.html`)** | Public `/api/ops/status` exposes aggregate cache/quota health while redacting live isolate request logs, per-item keys, and raw Cloudflare error strings unless authorized via `ADMIN_SECRET` |
| **Hourly Catalog Sync (`0 * * * *`)** | Bounded hourly Cron Trigger refreshes TVmaze schedules, keyless Wikipedia/iTunes movies, and pre-warms shared KV snapshots |

## Project Files

- `cloudflare.config.ts` — Declarative Worker configuration (`cf/config`: D1 `DB`, KV `CACHE_KV`, Assets `ASSETS`, hourly Cron trigger, secret bindings).
- `wrangler.config.ts` — Tooling config pointing Workers Static Assets at `./public`.
- `migrations/0001_init.sql` — D1 SQLite schema.
- `src/` — Worker TypeScript modules (`index.ts`, `cache.ts`, `ops.ts`, `db.ts`, `auth.ts`, `state.ts`, `store.ts`, `movies.ts`, `wordpool.ts`, `recommender.ts`, `galaxy.ts`, `tvmaze.ts`, `tmdb.ts`, `itunes.ts`, `wiki.ts`).
- `public/` — Frontend HTML/CSS/ESM (`index.html`, `status.html`, `client-store.js`, `app.js`, `graxobolt.mjs`, `styles.css`, `themes.css`, `vendor/three/`).

## Local Development & Verification

```bash
npm install
npm run typecheck
npm run build
npm run dev
```

## Deploying to Cloudflare Free Tier

1. Authenticate (`npx cf auth login`) and create your own Free Tier D1 database + KV namespace:
   ```bash
   npx cf d1 create viuhti-db
   npx cf kv namespaces create CACHE_KV
   ```
   Put your generated D1 database ID and KV namespace ID into `cloudflare.config.ts` (`YOUR_D1_DATABASE_ID`, `YOUR_KV_NAMESPACE_ID`) and `package.json` (`db:migrate:remote`), then apply the schema:
   ```bash
   npm run db:migrate:remote
   ```
   *(Optional: add your own custom hostnames to `domains` in `cloudflare.config.ts`.)*
2. Optional admin/provider secrets:
   ```bash
   npx cf workers secrets put ADMIN_SECRET
   npx cf workers secrets put TMDB_API_KEY
   ```
   - `ADMIN_SECRET`: Enables unredacted `/api/ops/status` request/KV traces (`Authorization: Bearer <secret>` or `X-Admin-Secret`) and admin routes (`/api/admin/seed`, `/api/refresh`, `/api/alerts/test`).
   - `TMDB_API_KEY`: Optional server-side key; without it, movie discovery and movie search run keyless via Wikipedia + iTunes charts.
3. Build and deploy:
   ```bash
   npm run deploy
   ```
4. Optional initial catalog seed (`VIUHTI_D1_ID=<your-d1-id> node scripts/populate-catalog.mjs`, or `--dry-run`).
