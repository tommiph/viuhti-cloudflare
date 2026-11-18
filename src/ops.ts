import { getKv, setKv, todayYmd, getRequestD1Meter, isolateResourceStats, isD1QuotaError } from "./db";
import {
  clearD1QuotaLock,
  getD1QuotaStatus,
  getKvCacheInventory,
  getRecentRequestTraces,
  markD1QuotaLocked,
  readKvRoute,
  readOpsSnapshotFromKv,
  saveOpsSnapshotToKv,
} from "./cache";

export interface CronRunRecord {
  at: number;
  durationMs: number;
  ok: boolean;
  bootstrapped: boolean;
  refreshedShows: number;
  refreshedMovies: number;
  addedShows: number;
  addedMovies: number;
  tasteDone: number;
  tasteCached: boolean;
  d1RowsRead?: number;
  d1RowsWritten?: number;
  error: string | null;
}

export interface CronTelemetry {
  day: string;
  runsToday: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  history: CronRunRecord[];
}

function mondayBounds(refYmd = todayYmd()): { thisFrom: string; thisTo: string; nextFrom: string; nextTo: string } {
  const ms = Date.parse(`${refYmd}T12:00:00Z`);
  const dow = new Date(ms).getUTCDay(); // 0=Sun..6=Sat
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monMs = ms + diffToMon * 86_400_000;
  const fmt = (offsetDays: number) => new Date(monMs + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return {
    thisFrom: fmt(0),
    thisTo: fmt(6),
    nextFrom: fmt(7),
    nextTo: fmt(13),
  };
}

export async function getCronTelemetry(db: D1Database): Promise<CronTelemetry> {
  const saved = await getKv<Partial<CronTelemetry>>(db, "cron_telemetry", {});
  const today = todayYmd();
  const sameDay = saved.day === today;
  return {
    day: today,
    runsToday: sameDay ? Number(saved.runsToday || 0) : 0,
    lastRunAt: Number(saved.lastRunAt) || null,
    lastDurationMs: saved.lastDurationMs != null ? Number(saved.lastDurationMs) : null,
    lastOk: saved.lastOk !== undefined ? saved.lastOk : null,
    lastError: saved.lastError || null,
    history: Array.isArray(saved.history) ? saved.history.slice(0, 16) : [],
  };
}

export async function recordCronRun(db: D1Database, entry: CronRunRecord): Promise<CronTelemetry> {
  const cur = await getCronTelemetry(db);
  const next: CronTelemetry = {
    day: todayYmd(),
    runsToday: cur.runsToday + 1,
    lastRunAt: entry.at,
    lastDurationMs: entry.durationMs,
    lastOk: entry.ok,
    lastError: entry.error,
    history: [entry, ...cur.history].slice(0, 16),
  };
  await setKv(db, "cron_telemetry", next);
  return next;
}

async function probeEndpoint(label: string, url: string, headers: Record<string, string> = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Viuhti/1.0 (https://github.com/tommiph/viuhti-cloudflare)", ...headers },
      signal: AbortSignal.timeout(4500),
    });
    const text = await res.text();
    let detail = `${res.status}`;
    if (res.ok && headers.Accept === "application/dns-json") {
      try {
        const d = JSON.parse(text);
        const ips = (d.Answer || []).filter((a: any) => a.type === 1).map((a: any) => a.data);
        detail = ips.length ? ips.join(", ") : `status=${d.Status}`;
      } catch {
        detail = `${res.status} OK`;
      }
    } else if (res.ok) {
      detail = `${text.length} bytes`;
    }
    return { label, ok: res.ok, status: res.status, ms: Date.now() - t0, detail };
  } catch (err) {
    return { label, ok: false, status: 0, ms: Date.now() - t0, detail: err instanceof Error ? err.message : "Failed" };
  }
}

export async function getOpsStatus(
  db: D1Database,
  {
    runProbes = false,
    forceLive = false,
    edgeColo = null,
    origin = "https://viuhti.local",
    kv,
    isAdmin = false,
  }: { runProbes?: boolean; forceLive?: boolean; edgeColo?: string | null; origin?: string; kv?: KVNamespace; isAdmin?: boolean } = {}
) {
  const t0 = Date.now();
  const bounds = mondayBounds();
  const probeHost = (() => {
    try {
      const h = new URL(origin).hostname;
      return h && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".local") ? h : "api.tvmaze.com";
    } catch {
      return "api.tvmaze.com";
    }
  })();

  const probesPromise = runProbes
    ? Promise.all([
        probeEndpoint("TVmaze Updates API", "https://api.tvmaze.com/updates/shows?since=day"),
        probeEndpoint(
          `Wikipedia Films API (${todayYmd().slice(0, 4)})`,
          `https://en.wikipedia.org/w/api.php?action=parse&page=List_of_American_films_of_${todayYmd().slice(0, 4)}&prop=sections&format=json`
        ),
        probeEndpoint("IMDb Suggestion CDN", "https://v3.sg.media-imdb.com/suggestion/d/dune.json"),
        probeEndpoint(`Cloudflare 1.1.1.1 DoH (${probeHost})`, `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(probeHost)}&type=A`, {
          Accept: "application/dns-json",
        }),
        probeEndpoint(`Google 8.8.8.8 DoH (${probeHost})`, `https://dns.google/resolve?name=${encodeURIComponent(probeHost)}&type=A`, {
          Accept: "application/dns-json",
        }),
      ])
    : Promise.resolve(null);

  const [quotaBefore, kvInventory, existingSnap] = await Promise.all([
    getD1QuotaStatus(kv),
    getKvCacheInventory(kv, { includePrivateKeys: isAdmin }),
    !forceLive && kv ? readOpsSnapshotFromKv(kv) : Promise.resolve(null),
  ]);

  let degraded = false;
  let d1Ms: number | null = null;
  let sizeBytes: number | null = null;
  let catalog: any = null;
  let privacy: any = null;
  let syncBlock: any = null;
  let cron: CronTelemetry | null = null;
  let keylessMode = true;
  let d1ErrorMessage: string | null = quotaBefore.error;
  let snapshotSavedAt: number | null = null;

  const snapFresh =
    !forceLive &&
    Boolean(existingSnap?.data?.catalog) &&
    Number(existingSnap?.savedAt || 0) > 0 &&
    Date.now() - Number(existingSnap?.savedAt || 0) < 3600_000;

  if (snapFresh && !quotaBefore.locked && existingSnap?.data) {
    snapshotSavedAt = Number(existingSnap.savedAt || 0) || null;
    catalog = existingSnap.data.catalog || null;
    privacy = existingSnap.data.privacy || null;
    syncBlock = existingSnap.data.sync || null;
    cron = existingSnap.data.cron || null;
    sizeBytes = existingSnap.data.d1SizeBytes ?? null;
    if (existingSnap.data.keylessMode !== undefined) keylessMode = Boolean(existingSnap.data.keylessMode);
  } else if (!quotaBefore.locked) {
    try {
      const [showAgg, mvAgg, tasteAgg, cacheAgg, privacyAgg, weekEpAgg, weekMvAgg, cronRes, syncStatus, discCfg, mvSync, tasteState, cachedEpCount] = await Promise.all([
        db
          .prepare("SELECT SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS shows, SUM(CASE WHEN favorite = 1 OR hidden = 1 THEN 1 ELSE 0 END) AS dirtyShows FROM shows")
          .first<{ shows: number; dirtyShows: number }>(),
        db
          .prepare("SELECT SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS movies, SUM(CASE WHEN favorite = 1 OR hidden = 1 THEN 1 ELSE 0 END) AS dirtyMovies FROM movies")
          .first<{ movies: number; dirtyMovies: number }>(),
        db
          .prepare("SELECT SUM(CASE WHEN kind IN ('show', 'movie') THEN 1 ELSE 0 END) AS tasteItems, SUM(CASE WHEN kind = 'movie' THEN 1 ELSE 0 END) AS tasteMovies FROM taste_items")
          .first<{ tasteItems: number; tasteMovies: number }>(),
        db
          .prepare("SELECT (SELECT COUNT(*) FROM wiki_cache) AS wikiCache, (SELECT COUNT(*) FROM item_cache) AS itemCache")
          .run<{ wikiCache: number; itemCache: number }>(),
        db
          .prepare("SELECT (SELECT COUNT(*) FROM watched_episodes) AS watchedEps, (SELECT COUNT(*) FROM watched_movies) AS watchedMovies, (SELECT COUNT(*) FROM wordpool) AS wordpool")
          .first<{ watchedEps: number; watchedMovies: number; wordpool: number }>(),
        db
          .prepare(
            `SELECT
              SUM(CASE WHEN e.airdate <= ?2 THEN 1 ELSE 0 END) AS thisEps,
              SUM(CASE WHEN e.airdate >= ?3 THEN 1 ELSE 0 END) AS nextEps
             FROM episodes e
             JOIN shows s ON s.id = e.show_id
             WHERE e.airdate >= ?1 AND e.airdate <= ?4
               AND s.hidden = 0 AND s.directors_choice = 0`
          )
          .bind(bounds.thisFrom, bounds.thisTo, bounds.nextFrom, bounds.nextTo)
          .first<{ thisEps: number; nextEps: number }>(),
        db
          .prepare(
            `SELECT
              SUM(CASE WHEN release_date <= ?2 THEN 1 ELSE 0 END) AS thisMovies,
              SUM(CASE WHEN release_date >= ?3 THEN 1 ELSE 0 END) AS nextMovies
             FROM movies
             WHERE release_date >= ?1 AND release_date <= ?4 AND hidden = 0`
          )
          .bind(bounds.thisFrom, bounds.thisTo, bounds.nextFrom, bounds.nextTo)
          .first<{ thisMovies: number; nextMovies: number }>(),
        getCronTelemetry(db),
        getKv<any>(db, "sync_status", { lastSync: null, done: 0, total: 0, error: null }),
        getKv<any>(db, "discovery_config", { enabled: true, lastRun: null, lastAdded: 0 }),
        getKv<any>(db, "keyless_movie_sync", { lastAt: null, country: null }),
        getKv<any>(db, "taste_state", { poolUpdatedAt: null, tmdbEnabled: false, job: null }),
        getKv<{ episodes?: number; updatedAt?: number }>(db, "ops_episode_count", {}),
      ]);

      let totalEpisodes = Number(cachedEpCount?.episodes || 0);
      if (!cachedEpCount?.updatedAt || Date.now() - Number(cachedEpCount.updatedAt) > 24 * 60 * 60_000) {
        const epRow = await db.prepare("SELECT COUNT(*) AS c FROM episodes").first<{ c: number }>().catch(() => null);
        if (epRow && epRow.c != null) {
          totalEpisodes = Number(epRow.c);
          await setKv(db, "ops_episode_count", { episodes: totalEpisodes, updatedAt: Date.now() }).catch(() => {});
        }
      }

      d1Ms = Date.now() - t0;
      const cacheRow = (cacheAgg.results && cacheAgg.results[0]) || { wikiCache: 0, itemCache: 0 };
      sizeBytes = Number((cacheAgg.meta as any)?.size_after || 0) || null;

      const privacyClean =
        Number(showAgg?.dirtyShows || 0) === 0 &&
        Number(mvAgg?.dirtyMovies || 0) === 0 &&
        Number(privacyAgg?.watchedEps || 0) === 0 &&
        Number(privacyAgg?.watchedMovies || 0) === 0 &&
        Number(privacyAgg?.wordpool || 0) === 0;

      catalog = {
        shows: Number(showAgg?.shows || 0),
        episodes: totalEpisodes,
        movies: Number(mvAgg?.movies || 0),
        tasteItems: Number(tasteAgg?.tasteItems || 0),
        tasteMovies: Number(tasteAgg?.tasteMovies || 0),
        wikiCache: Number(cacheRow.wikiCache || 0),
        itemCache: Number(cacheRow.itemCache || 0),
        thisWeek: { from: bounds.thisFrom, to: bounds.thisTo, episodes: Number(weekEpAgg?.thisEps || 0), movies: Number(weekMvAgg?.thisMovies || 0) },
        nextWeek: { from: bounds.nextFrom, to: bounds.nextTo, episodes: Number(weekEpAgg?.nextEps || 0), movies: Number(weekMvAgg?.nextMovies || 0) },
      };
      privacy = {
        clean: privacyClean,
        dirtyShows: Number(showAgg?.dirtyShows || 0),
        dirtyMovies: Number(mvAgg?.dirtyMovies || 0),
        watchedItems: Number(privacyAgg?.watchedEps || 0) + Number(privacyAgg?.watchedMovies || 0),
        wordpoolRules: Number(privacyAgg?.wordpool || 0),
      };
      syncBlock = {
        lastSync: syncStatus?.lastSync || null,
        lastDiscovery: discCfg?.lastRun || null,
        lastAdded: Number(discCfg?.lastAdded || 0),
        lastKeylessMoviesAt: mvSync?.lastAt || null,
        lastKeylessMovieCountry: mvSync?.country || null,
        tastePoolUpdatedAt: tasteState?.poolUpdatedAt || null,
      };
      cron = cronRes;
      keylessMode = !Boolean(tasteState?.tmdbEnabled);

      await clearD1QuotaLock(kv);
      await saveOpsSnapshotToKv(kv, { catalog, privacy, sync: syncBlock, cron, d1SizeBytes: sizeBytes, keylessMode });
    } catch (err) {
      degraded = true;
      d1ErrorMessage = err instanceof Error ? err.message : String(err || "D1 unavailable");
      if (isD1QuotaError(err)) {
        await markD1QuotaLocked(kv, err);
      }
    }
  } else {
    degraded = true;
  }

  if (degraded || !catalog) {
    const snap = existingSnap || (await readOpsSnapshotFromKv(kv));
    if (snap?.data) {
      snapshotSavedAt = Number(snap.savedAt || 0) || null;
      catalog = snap.data.catalog || catalog;
      privacy = snap.data.privacy || privacy;
      syncBlock = snap.data.sync || syncBlock;
      cron = snap.data.cron || cron;
      sizeBytes = snap.data.d1SizeBytes ?? sizeBytes;
      if (snap.data.keylessMode !== undefined) keylessMode = Boolean(snap.data.keylessMode);
    }
    if (!catalog) {
      const statusKv = await readKvRoute(kv, "/api/status");
      let parsedStatus: any = null;
      try {
        parsedStatus = statusKv ? JSON.parse(statusKv.body) : null;
      } catch {
        parsedStatus = null;
      }
      catalog = {
        shows: Number(parsedStatus?.showCount || 0),
        episodes: 0,
        movies: Number(parsedStatus?.moviesCount || 0),
        tasteItems: 0,
        tasteMovies: 0,
        wikiCache: 0,
        itemCache: 0,
        thisWeek: { from: bounds.thisFrom, to: bounds.thisTo, episodes: 0, movies: 0 },
        nextWeek: { from: bounds.nextFrom, to: bounds.nextTo, episodes: 0, movies: 0 },
      };
    }
    if (!privacy) {
      privacy = { clean: true, dirtyShows: 0, dirtyMovies: 0, watchedItems: 0, wordpoolRules: 0 };
    }
    if (!syncBlock) {
      syncBlock = { lastSync: null, lastDiscovery: null, lastAdded: 0, lastKeylessMoviesAt: null, lastKeylessMovieCountry: null, tastePoolUpdatedAt: null };
    }
    if (!cron) {
      cron = { day: todayYmd(), runsToday: 0, lastRunAt: null, lastDurationMs: null, lastOk: null, lastError: null, history: [] };
    }
  }

  const safeCron: CronTelemetry = cron || {
    day: todayYmd(),
    runsToday: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastOk: null,
    lastError: null,
    history: [],
  };

  const [probes, quotaAfter] = await Promise.all([probesPromise, getD1QuotaStatus(kv)]);
  const sampleMeter = getRequestD1Meter();
  const cronWithReads = (safeCron.history || []).filter((h) => Number.isFinite(h.d1RowsRead));
  const avgCronReads = cronWithReads.length
    ? Math.round(cronWithReads.reduce((sum, h) => sum + Number(h.d1RowsRead || 0), 0) / cronWithReads.length)
    : null;
  const avgCronWrites = cronWithReads.length
    ? Math.round(cronWithReads.reduce((sum, h) => sum + Number(h.d1RowsWritten || 0), 0) / cronWithReads.length)
    : null;

  const totalHandled =
    isolateResourceStats.edgeHits +
    isolateResourceStats.l1Hits +
    isolateResourceStats.kvFreshHits +
    isolateResourceStats.kvStaleHits +
    isolateResourceStats.d1Origin;
  const cacheServed =
    isolateResourceStats.edgeHits +
    isolateResourceStats.l1Hits +
    isolateResourceStats.kvFreshHits +
    isolateResourceStats.kvStaleHits;

  return {
    ok: true,
    degraded,
    snapshotSavedAt,
    checkedAt: Date.now(),
    origin,
    edgeColo,
    d1LatencyMs: d1Ms,
    d1SizeBytes: sizeBytes,
    d1FreeLimitBytes: 500 * 1024 * 1024,
    d1Quota: {
      locked: quotaAfter.locked || (degraded && isD1QuotaError(d1ErrorMessage)),
      lockedAt: quotaAfter.lockedAt,
      resetAt: quotaAfter.resetAt,
      resetInSec: quotaAfter.resetInSec,
      error: isAdmin
        ? d1ErrorMessage
        : quotaAfter.locked || (degraded && isD1QuotaError(d1ErrorMessage))
          ? "D1 daily quota exceeded — serving from KV cache fallback"
          : d1ErrorMessage
            ? "D1 temporarily unavailable"
            : null,
    },
    runtime: {
      platform: "Cloudflare Workers + D1 + KV",
      tier: "Free Tier ($0/mo)",
      cronSchedule: "0 * * * *",
      idlePollMs: 120_000,
      tastePoolCap: 320,
      keylessMode,
    },
    resources: {
      d1DailyReadLimit: 5_000_000,
      d1DailyWriteLimit: 100_000,
      kvDailyReadLimit: 100_000,
      kvDailyWriteLimit: 1_000,
      cronMaxPerDay: 24,
      sampleQueries: sampleMeter.queries,
      sampleRowsRead: sampleMeter.rowsRead,
      sampleRowsWritten: sampleMeter.rowsWritten,
      isolateQueries: isolateResourceStats.queries,
      isolateRowsRead: isolateResourceStats.rowsRead,
      isolateRowsWritten: isolateResourceStats.rowsWritten,
      isolateUptimeMs: Date.now() - isolateResourceStats.startedAt,
      edgeCacheHits: isolateResourceStats.edgeHits,
      edgeCacheMisses: isolateResourceStats.edgeMisses,
      l1CacheHits: isolateResourceStats.l1Hits,
      l1CacheMisses: isolateResourceStats.l1Misses,
      kvReads: isolateResourceStats.kvReads,
      kvWrites: isolateResourceStats.kvWrites,
      kvFreshHits: isolateResourceStats.kvFreshHits,
      kvStaleHits: isolateResourceStats.kvStaleHits,
      kvMisses: isolateResourceStats.kvMisses,
      d1OriginHits: isolateResourceStats.d1Origin,
      d1Errors: isolateResourceStats.d1Errors,
      cacheHitRatePct: totalHandled > 0 ? Math.round((cacheServed / totalHandled) * 1000) / 10 : 100,
      estCronDailyReads: avgCronReads != null ? avgCronReads * 24 : null,
      estCronDailyWrites: avgCronWrites != null ? avgCronWrites * 24 : null,
    },
    cache: {
      kvEnabled: Boolean(kv),
      inventory: kvInventory,
      tracesRedacted: !isAdmin,
      recentRequests: isAdmin ? getRecentRequestTraces() : [],
    },
    catalog,
    privacy,
    sync: syncBlock,
    cron: safeCron,
    probes,
  };
}
