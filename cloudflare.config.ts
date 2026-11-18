import { defineConfig, defineWorker, bindings, triggers } from "cf/config";

export const worker = defineWorker({
  name: "viuhti-calendar",
  compatibilityDate: "2026-11-01",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "./src/index.ts",
  workersDev: true,
  // Optional custom domains for your deployment:
  // domains: ["example.com", "www.example.com"],
  assets: {
    htmlHandling: "auto-trailing-slash",
    notFoundHandling: "none",
    runWorkerFirst: ["/api/*", "/", "/index.html", "/status", "/status.html"],
  },
  triggers: [
    // Free Tier hourly tick keeps shared TV/Movie release catalog fresh while cutting D1 Cron usage by 75% (24/day).
    triggers.scheduled({ schedule: "0 * * * *" }),
  ],
  observability: {
    enabled: true,
    logs: {
      enabled: true,
      headSamplingRate: 1,
    },
    traces: {
      enabled: true,
      headSamplingRate: 0.05,
    },
  },
  env: {
    DB: bindings.d1({ id: "YOUR_D1_DATABASE_ID", name: "viuhti-db" }),
    CACHE_KV: bindings.kv({ id: "YOUR_KV_NAMESPACE_ID" }),
    ASSETS: bindings.assets(),
  },
});

export type Env = {
  DB: D1Database;
  CACHE_KV?: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_SECRET?: string;
  TMDB_API_KEY?: string;
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
};

export default defineConfig({ worker });
