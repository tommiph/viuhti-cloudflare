import { isD1QuotaError, isolateResourceStats, l1Cached, l1Invalidate } from "./db";

export type CacheLayer =
  | "EDGE-HIT"
  | "L1-HIT"
  | "KV-FRESH"
  | "KV-STALE"
  | "D1-ORIGIN"
  | "FALLBACK"
  | "BYPASS";

export interface RouteCachePolicy {
  edgeTtlSec: number;
  kvTtlSec: number;
  staleGraceSec: number;
  cacheInKv: boolean;
}

export interface KvCacheMeta {
  key: string;
  cachedAt: number;
  freshUntil: number;
  bytes: number;
  source: string;
}

export interface KvCacheEnvelope {
  v: 1;
  cachedAt: number;
  freshUntil: number;
  contentType: string;
  body: string;
}

export interface RequestTraceEntry {
  at: number;
  method: string;
  path: string;
  status: number;
  layer: CacheLayer;
  ageSec: number | null;
  ms: number;
  d1Reads: number;
  d1Writes: number;
}

export interface D1QuotaStatus {
  locked: boolean;
  lockedAt: number | null;
  resetAt: number;
  resetInSec: number;
  error: string | null;
}

const QUOTA_META_KEY = "meta:d1_quota_lock";
export const OPS_SNAPSHOT_KEY = "meta:ops_last_good";

const l1RespCache = new Map<string, { env: KvCacheEnvelope; expiresAt: number }>();
const recentRequests: RequestTraceEntry[] = [];

const lockState = {
  lockedAt: 0,
  lockedUntil: 0,
  error: "",
  lastKvWriteAt: 0,
  lastKvReadAt: 0,
};

let lastOpsKvWriteAt = 0;

export function nextMidnightUtcMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5, 0);
}

export function isD1QuotaLockedLocally(now = Date.now()): boolean {
  if (lockState.lockedUntil > now) return true;
  if (lockState.lockedUntil && now >= lockState.lockedUntil) {
    lockState.lockedAt = 0;
    lockState.lockedUntil = 0;
    lockState.error = "";
  }
  return false;
}

export async function getD1QuotaStatus(kv?: KVNamespace, now = Date.now()): Promise<D1QuotaStatus> {
  if (!isD1QuotaLockedLocally(now) && kv && now - lockState.lastKvReadAt > 45_000) {
    lockState.lastKvReadAt = now;
    try {
      isolateResourceStats.kvReads += 1;
      const saved = await kv.get<{ lockedAt?: number; resetAt?: number; error?: string }>(QUOTA_META_KEY, "json");
      if (saved && Number(saved.resetAt || 0) > now) {
        lockState.lockedAt = Number(saved.lockedAt || now);
        lockState.lockedUntil = Number(saved.resetAt);
        lockState.error = String(saved.error || "D1 daily limit exceeded");
      }
    } catch {
      // Ignore KV transient errors
    }
  }
  const locked = isD1QuotaLockedLocally(now);
  const resetAt = locked ? lockState.lockedUntil : nextMidnightUtcMs(now);
  return {
    locked,
    lockedAt: locked ? lockState.lockedAt || null : null,
    resetAt,
    resetInSec: Math.max(0, Math.round((resetAt - now) / 1000)),
    error: locked ? lockState.error || "D1 daily row limit exceeded" : null,
  };
}

export async function markD1QuotaLocked(kv: KVNamespace | undefined, err: unknown): Promise<void> {
  if (!isD1QuotaError(err)) {
    isolateResourceStats.d1Errors += 1;
    return;
  }
  isolateResourceStats.d1Errors += 1;
  const now = Date.now();
  const resetAt = nextMidnightUtcMs(now);
  const msg = err instanceof Error ? err.message : String(err || "D1 quota exceeded");
  lockState.lockedAt = lockState.lockedAt || now;
  lockState.lockedUntil = resetAt;
  lockState.error = msg;

  // Persist lock marker cleanly at most once every 10 minutes to conserve KV free writes
  if (kv && now - lockState.lastKvWriteAt > 10 * 60_000) {
    lockState.lastKvWriteAt = now;
    try {
      isolateResourceStats.kvWrites += 1;
      await kv.put(
        QUOTA_META_KEY,
        JSON.stringify({ lockedAt: lockState.lockedAt, resetAt, error: msg }),
        { expirationTtl: Math.max(300, Math.ceil((resetAt - now) / 1000) + 60) }
      );
    } catch {
      // Ignore KV write failure
    }
  }
}

export async function clearD1QuotaLock(kv?: KVNamespace): Promise<void> {
  const wasLocked = lockState.lockedUntil > 0;
  lockState.lockedAt = 0;
  lockState.lockedUntil = 0;
  lockState.error = "";
  if (wasLocked && kv) {
    await kv.delete(QUOTA_META_KEY).catch(() => {});
  }
}

export function isSharedCatalogKvKey(routeKey: string): boolean {
  const key = String(routeKey || "");
  if (
    key === "/api/status" ||
    key === "/api/shows" ||
    key === "/api/movies" ||
    key === "/api/calendar.ics" ||
    key === "/api/onboarding/shows" ||
    key === "/api/galaxy"
  ) {
    return true;
  }
  if (key.startsWith("/api/schedule?")) return true;
  if (key.startsWith("/api/discover?") && !/[?&]anchor=/.test(key)) return true;
  return false;
}

export function getRouteCachePolicy(pathname: string, searchParams: URLSearchParams): RouteCachePolicy {
  if (pathname === "/api/ops/status") {
    if (searchParams.get("live") === "1") {
      return { edgeTtlSec: 0, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
    }
    const edgeTtlSec = searchParams.get("probe") === "1" ? 45 : 60;
    return { edgeTtlSec, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
  }
  if (pathname === "/api/status") {
    return { edgeTtlSec: 180, kvTtlSec: 3 * 3600, staleGraceSec: 7 * 86_400, cacheInKv: true };
  }
  if (
    pathname === "/api/shows" ||
    pathname === "/api/movies" ||
    pathname === "/api/calendar.ics" ||
    pathname === "/api/onboarding/shows"
  ) {
    return { edgeTtlSec: 600, kvTtlSec: 12 * 3600, staleGraceSec: 7 * 86_400, cacheInKv: true };
  }
  if (pathname === "/api/schedule") {
    return { edgeTtlSec: 600, kvTtlSec: 6 * 3600, staleGraceSec: 7 * 86_400, cacheInKv: true };
  }
  if (pathname === "/api/discover") {
    const hasAnchor = Boolean((searchParams.get("anchor") || "").trim());
    return hasAnchor
      ? { edgeTtlSec: 300, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false }
      : { edgeTtlSec: 600, kvTtlSec: 12 * 3600, staleGraceSec: 7 * 86_400, cacheInKv: true };
  }
  if (pathname === "/api/galaxy") {
    const hasSeed = Boolean(
      searchParams.get("seedKind") ||
        searchParams.get("seedId") ||
        searchParams.get("seedTmdbId") ||
        searchParams.get("seedQid") ||
        searchParams.get("seedName")
    );
    return hasSeed
      ? { edgeTtlSec: 600, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false }
      : { edgeTtlSec: 600, kvTtlSec: 12 * 3600, staleGraceSec: 7 * 86_400, cacheInKv: true };
  }
  // Per-item & wiki lookups are cached at Edge/L1 only so shared KV inventory never stores user-looked-up titles
  if (
    pathname === "/api/galaxy/wiki" ||
    pathname === "/api/item/rich" ||
    /^\/api\/item\/(show|movie)\/\d+$/.test(pathname)
  ) {
    return { edgeTtlSec: 300, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
  }
  if (pathname === "/api/search" || pathname === "/api/galaxy/search") {
    return { edgeTtlSec: 600, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
  }
  return { edgeTtlSec: 0, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
}

export function buildCanonicalRouteKey(url: URL): string {
  const entries = [...url.searchParams.entries()]
    .filter(([k, v]) => k !== "_" && k !== "live" && k !== "t" && v !== "")
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)));
  if (!entries.length) return url.pathname;
  const qs = new URLSearchParams(entries).toString();
  return `${url.pathname}?${qs}`;
}

export function kvStorageKey(routeKey: string): string {
  return `cache:${routeKey}`;
}

export function getL1Response(routeKey: string, now = Date.now()): KvCacheEnvelope | null {
  const hit = l1RespCache.get(routeKey);
  if (hit && hit.expiresAt > now) {
    isolateResourceStats.l1Hits += 1;
    return hit.env;
  }
  if (hit) l1RespCache.delete(routeKey);
  return null;
}

export function setL1Response(routeKey: string, env: KvCacheEnvelope, ttlMs = 45_000): void {
  if (l1RespCache.size >= 36) {
    const oldest = l1RespCache.keys().next().value;
    if (oldest !== undefined) l1RespCache.delete(oldest);
  }
  l1RespCache.set(routeKey, { env, expiresAt: Date.now() + ttlMs });
}

export async function readKvRoute(kv: KVNamespace | undefined, routeKey: string): Promise<KvCacheEnvelope | null> {
  if (!kv) return null;
  try {
    isolateResourceStats.kvReads += 1;
    const raw = await kv.get(kvStorageKey(routeKey), "text");
    if (!raw) {
      isolateResourceStats.kvMisses += 1;
      return null;
    }
    const parsed = JSON.parse(raw) as KvCacheEnvelope;
    if (!parsed || typeof parsed.body !== "string") {
      isolateResourceStats.kvMisses += 1;
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeKvRoute(
  kv: KVNamespace | undefined,
  routeKey: string,
  opts: { body: string; contentType: string; kvTtlSec: number; staleGraceSec: number; source: string }
): Promise<KvCacheEnvelope | null> {
  const now = Date.now();
  const envelope: KvCacheEnvelope = {
    v: 1,
    cachedAt: now,
    freshUntil: now + opts.kvTtlSec * 1000,
    contentType: opts.contentType || "application/json; charset=utf-8",
    body: opts.body,
  };
  setL1Response(routeKey, envelope, Math.min(60_000, opts.kvTtlSec * 1000));
  if (!kv) return envelope;
  try {
    const meta: KvCacheMeta = {
      key: routeKey,
      cachedAt: now,
      freshUntil: envelope.freshUntil,
      bytes: opts.body.length,
      source: opts.source,
    };
    isolateResourceStats.kvWrites += 1;
    await kv.put(kvStorageKey(routeKey), JSON.stringify(envelope), {
      expirationTtl: Math.max(3600, opts.kvTtlSec + opts.staleGraceSec),
      metadata: meta,
    });
    l1Invalidate("kv:inventory");
  } catch {
    // Ignore KV quota/put errors cleanly so response still succeeds
  }
  return envelope;
}

export async function invalidateCoreKvCaches(kv: KVNamespace | undefined, origin = "https://viuhti.local"): Promise<void> {
  l1RespCache.clear();
  l1Invalidate("");
  const corePaths = ["/api/shows", "/api/movies", "/api/status", "/api/onboarding/shows", "/api/calendar.ics"];
  if (typeof caches !== "undefined") {
    const edgeCache = (caches as unknown as { default: Cache }).default;
    await Promise.all(corePaths.map((p) => edgeCache.delete(new Request(`${origin}${p}`)).catch(() => false)));
  }
  if (kv) {
    await Promise.all(corePaths.map((p) => kv.delete(kvStorageKey(p)).catch(() => {})));
  }
}

export async function saveOpsSnapshotToKv(kv: KVNamespace | undefined, snapshot: unknown): Promise<void> {
  if (!kv) return;
  const now = Date.now();
  if (now - lastOpsKvWriteAt < 20 * 60_000) return;
  lastOpsKvWriteAt = now;
  try {
    isolateResourceStats.kvWrites += 1;
    await kv.put(OPS_SNAPSHOT_KEY, JSON.stringify({ savedAt: now, data: snapshot }), {
      expirationTtl: 7 * 86_400,
    });
  } catch {
    // Ignore KV write failures
  }
}

export async function readOpsSnapshotFromKv(kv: KVNamespace | undefined): Promise<{ savedAt: number; data: any } | null> {
  if (!kv) return null;
  try {
    isolateResourceStats.kvReads += 1;
    const raw = await kv.get(OPS_SNAPSHOT_KEY, "json");
    return (raw as { savedAt: number; data: any } | null) || null;
  } catch {
    return null;
  }
}

export async function getKvCacheInventory(
  kv: KVNamespace | undefined,
  opts: { includePrivateKeys?: boolean } = {}
): Promise<{
  enabled: boolean;
  totalKeys: number;
  totalBytes: number;
  freshKeys: number;
  staleKeys: number;
  redactedKeys?: number;
  entries: Array<{ key: string; cachedAt: number; freshUntil: number; ageSec: number; fresh: boolean; bytes: number; source: string }>;
}> {
  if (!kv) {
    return { enabled: false, totalKeys: 0, totalBytes: 0, freshKeys: 0, staleKeys: 0, entries: [] };
  }
  const includePrivateKeys = Boolean(opts.includePrivateKeys);
  const rawInv = await l1Cached("kv:inventory", 20_000, async () => {
    const now = Date.now();
    const list = await kv.list<KvCacheMeta>({ prefix: "cache:", limit: 100 }).catch(() => ({ keys: [] as any[] }));
    const entries: Array<{ key: string; cachedAt: number; freshUntil: number; ageSec: number; fresh: boolean; bytes: number; source: string }> = [];
    let totalBytes = 0;
    let freshKeys = 0;
    let staleKeys = 0;
    for (const k of list.keys || []) {
      const m = (k.metadata || {}) as Partial<KvCacheMeta>;
      const cachedAt = Number(m.cachedAt || 0);
      const freshUntil = Number(m.freshUntil || 0);
      const bytes = Number(m.bytes || 0);
      const fresh = freshUntil > now;
      if (fresh) freshKeys++;
      else staleKeys++;
      totalBytes += bytes;
      entries.push({
        key: String(m.key || k.name.replace(/^cache:/, "")),
        cachedAt,
        freshUntil,
        ageSec: cachedAt ? Math.max(0, Math.round((now - cachedAt) / 1000)) : 0,
        fresh,
        bytes,
        source: String(m.source || "kv"),
      });
    }
    entries.sort((a, b) => b.cachedAt - a.cachedAt);
    return {
      enabled: true,
      totalKeys: entries.length,
      totalBytes,
      freshKeys,
      staleKeys,
      entries,
    };
  });
  if (includePrivateKeys) return rawInv;
  const publicEntries = rawInv.entries.filter((e) => isSharedCatalogKvKey(e.key));
  const redactedKeys = Math.max(0, rawInv.entries.length - publicEntries.length);
  return {
    ...rawInv,
    redactedKeys,
    entries: publicEntries,
  };
}

export function recordRequestTrace(entry: RequestTraceEntry): void {
  recentRequests.unshift(entry);
  if (recentRequests.length > 35) recentRequests.length = 35;
}

export function getRecentRequestTraces(): RequestTraceEntry[] {
  return recentRequests.slice(0, 30);
}

const kvFallbackWikiMem = new Map<string, { data_json: string; fetched_at: number }>();
const kvFallbackItemMem = new Map<string, { cache_key: string; kind: string; data_json: string; fetched_at: number }>();

function setBoundedMap<K, V>(map: Map<K, V>, key: K, val: V, max = 180): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, val);
}

function emptyD1Meta(): D1Meta & Record<string, any> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    served_by: "kv-fallback",
  };
}

/**
 * Read-mostly D1Database facade backed by Cloudflare KV cached snapshots plus
 * per-request ephemeral maps for freshly fetched items/episodes. Allows secondary
 * catalog, item-dossier, wiki, and Graxobolt routes to keep serving 200 OK while
 * D1 Free Tier daily quota is locked.
 */
export function createKvFallbackDb(kv?: KVNamespace): D1Database {
  const ephemeralShows = new Map<number, any>();
  const ephemeralMovies = new Map<number, any>();
  const ephemeralEpisodes = new Map<number, any[]>();

  async function loadBaseShows(): Promise<Map<number, any>> {
    const base = await l1Cached("kvfb:shows_map", 30_000, async () => {
      const m = new Map<number, any>();
      const env = await readKvRoute(kv, "/api/shows");
      if (!env) return m;
      try {
        const arr = JSON.parse(env.body);
        if (Array.isArray(arr)) {
          const now = env.cachedAt || Date.now();
          for (const s of arr) {
            const id = Number(s?.id);
            if (!id) continue;
            const rec = {
              id,
              favorite: Boolean(s.favorite),
              directorsChoice: Boolean(s.directorsChoice),
              source: s.source || "kv",
              addedAt: Number(s.addedAt || 0) || now,
            };
            m.set(id, {
              id,
              name: String(s.name || ""),
              favorite: rec.favorite ? 1 : 0,
              hidden: 0,
              directors_choice: rec.directorsChoice ? 1 : 0,
              channel_name: String(s.channelName || s.network?.name || s.webChannel?.name || ""),
              channel_kind: String(s.channelKind || ""),
              status: String(s.status || ""),
              premiered: String(s.premiered || ""),
              rating: s.rating?.average ?? s.rating ?? null,
              genres_json: JSON.stringify(s.genres || []),
              record_json: JSON.stringify(rec),
              data_json: JSON.stringify(s),
              updated_at: now,
            });
          }
        }
      } catch {
        // Ignore parse failure
      }
      return m;
    });
    if (!ephemeralShows.size) return base;
    const merged = new Map(base);
    for (const [k, v] of ephemeralShows) merged.set(k, v);
    return merged;
  }

  async function loadBaseMovies(): Promise<Map<number, any>> {
    const base = await l1Cached("kvfb:movies_map", 30_000, async () => {
      const m = new Map<number, any>();
      const env = await readKvRoute(kv, "/api/movies");
      if (!env) return m;
      try {
        const arr = JSON.parse(env.body);
        if (Array.isArray(arr)) {
          const now = env.cachedAt || Date.now();
          for (const mv of arr) {
            const id = Number(mv?.id);
            if (!id) continue;
            const rec = {
              id,
              favorite: Boolean(mv.favorite),
              source: mv.source || "kv",
              addedAt: Number(mv.addedAt || 0) || now,
            };
            m.set(id, {
              id,
              name: String(mv.name || ""),
              release_date: mv.releaseDate || mv.premiered || null,
              favorite: rec.favorite ? 1 : 0,
              hidden: 0,
              directors_choice: 0,
              channel_name: String(mv.channelName || ""),
              status: String(mv.status || ""),
              rating: mv.rating ?? null,
              genres_json: JSON.stringify(mv.genres || []),
              record_json: JSON.stringify(rec),
              data_json: JSON.stringify(mv),
              updated_at: now,
            });
          }
        }
      } catch {
        // Ignore parse failure
      }
      return m;
    });
    if (!ephemeralMovies.size) return base;
    const merged = new Map(base);
    for (const [k, v] of ephemeralMovies) merged.set(k, v);
    return merged;
  }

  async function loadTasteRows(): Promise<Array<{ item_key: string; kind: string; id: number; score: number; data_json: string; updated_at: number }>> {
    return l1Cached("kvfb:taste_rows", 30_000, async () => {
      const env = await readKvRoute(kv, "/api/discover?lens=mix&media=all&seeds=1");
      if (!env) return [];
      try {
        const parsed = JSON.parse(env.body);
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        const now = env.cachedAt || Date.now();
        return items.map((it: any) => ({
          item_key: `${it.kind || "show"}:${it.id}`,
          kind: it.kind === "movie" ? "movie" : "show",
          id: Number(it.id || 0),
          score: Number(it.score || 0),
          data_json: JSON.stringify(it),
          updated_at: now,
        }));
      } catch {
        return [];
      }
    });
  }

  async function loadScheduleEpisodes(): Promise<any[]> {
    const base = await l1Cached("kvfb:sched_eps", 30_000, async () => {
      const env = await readKvRoute(kv, "/api/schedule?from=2026-10-26&to=2026-12-06");
      if (!env) return [];
      try {
        const parsed = JSON.parse(env.body);
        const eps = Array.isArray(parsed?.episodes) ? parsed.episodes : [];
        return eps
          .filter((e: any) => e && e.id && e.showId && e.airdate)
          .map((e: any) => ({
            id: Number(e.id),
            show_id: Number(e.showId),
            airdate: String(e.airdate),
            airtime: e.airtime || null,
            airstamp: e.airstamp || null,
            season: e.season ?? null,
            number: e.number ?? null,
            episode_type: e.type || null,
            name: String(e.name || ""),
            runtime: e.runtime ?? null,
            summary: String(e.summary || ""),
            url: null,
            image: null,
          }));
      } catch {
        return [];
      }
    });
    if (!ephemeralEpisodes.size) return base;
    const filtered = base.filter((e: any) => !ephemeralEpisodes.has(Number(e.show_id)));
    for (const eps of ephemeralEpisodes.values()) filtered.push(...eps);
    return filtered;
  }

  async function execQuery(sql: string, params: any[]): Promise<{ rows: any[]; isWrite: boolean }> {
    const clean = sql.replace(/\s+/g, " ").trim();
    const upper = clean.toUpperCase();

    if (upper.startsWith("INSERT ") || upper.startsWith("UPDATE ") || upper.startsWith("DELETE ") || upper.startsWith("CREATE ") || upper.startsWith("ALTER ")) {
      if (upper.startsWith("INSERT INTO SHOWS ")) {
        const id = Number(params[0]);
        if (id) {
          ephemeralShows.set(id, {
            id,
            name: params[1] || "",
            favorite: Number(params[2] || 0),
            hidden: Number(params[3] || 0),
            directors_choice: Number(params[4] || 0),
            channel_name: params[5] || "",
            channel_kind: params[6] || "",
            status: params[7] || "",
            premiered: params[8] || "",
            rating: params[9] ?? null,
            genres_json: params[10] || "[]",
            record_json: params[11] || "{}",
            data_json: params[12] || "{}",
            updated_at: Number(params[13] || Date.now()),
          });
        }
      } else if (upper.startsWith("DELETE FROM EPISODES WHERE SHOW_ID")) {
        ephemeralEpisodes.set(Number(params[0]), []);
      } else if (upper.startsWith("INSERT INTO EPISODES ")) {
        const showId = Number(params[1]);
        const list = ephemeralEpisodes.get(showId) || [];
        list.push({
          id: Number(params[0]),
          show_id: showId,
          airdate: params[2] || "",
          airtime: params[3] ?? null,
          airstamp: params[4] ?? null,
          season: params[5] ?? null,
          number: params[6] ?? null,
          episode_type: params[7] ?? null,
          name: params[8] || "",
          runtime: params[9] ?? null,
          summary: params[10] || "",
          url: params[11] ?? null,
          image: params[12] ?? null,
        });
        ephemeralEpisodes.set(showId, list);
      } else if (upper.startsWith("INSERT INTO MOVIES ")) {
        const id = Number(params[0]);
        if (id) {
          ephemeralMovies.set(id, {
            id,
            name: params[1] || "",
            release_date: params[2] ?? null,
            favorite: Number(params[3] || 0),
            hidden: Number(params[4] || 0),
            directors_choice: 0,
            channel_name: params[5] || "",
            status: params[6] || "",
            rating: params[7] ?? null,
            genres_json: params[8] || "[]",
            record_json: params[9] || "{}",
            data_json: params[10] || "{}",
            updated_at: Number(params[11] || Date.now()),
          });
        }
      } else if (upper.startsWith("INSERT INTO WIKI_CACHE ")) {
        setBoundedMap(kvFallbackWikiMem, String(params[0]), {
          data_json: String(params[1] || "{}"),
          fetched_at: Number(params[2] || Date.now()),
        });
      } else if (upper.startsWith("INSERT INTO ITEM_CACHE ")) {
        setBoundedMap(kvFallbackItemMem, String(params[0]), {
          cache_key: String(params[0]),
          kind: String(params[1] || ""),
          data_json: String(params[2] || "{}"),
          fetched_at: Number(params[3] || Date.now()),
        });
      }
      return { rows: [], isWrite: true };
    }

    if (upper.includes("SQLITE_MASTER") || upper.startsWith("SELECT 1 FROM WORDPOOL")) {
      return { rows: [{ 1: 1 }], isWrite: false };
    }

    if (upper.includes("FROM SETTINGS")) {
      return { rows: [], isWrite: false };
    }

    if (upper.includes("FROM WIKI_CACHE")) {
      const hit = kvFallbackWikiMem.get(String(params[0]));
      return { rows: hit ? [hit] : [], isWrite: false };
    }

    if (upper.includes("FROM ITEM_CACHE")) {
      if (upper.includes("WHERE CACHE_KEY")) {
        const hit = kvFallbackItemMem.get(String(params[0]));
        return { rows: hit ? [hit] : [], isWrite: false };
      }
      return { rows: [...kvFallbackItemMem.values()].slice(0, 250), isWrite: false };
    }

    if (upper.includes("FROM TASTE_ITEMS")) {
      const taste = await loadTasteRows();
      return { rows: taste.slice(0, 300), isWrite: false };
    }

    if (upper.includes("FROM EPISODES E JOIN SHOWS S")) {
      const [eps, showsMap] = await Promise.all([loadScheduleEpisodes(), loadBaseShows()]);
      const from = String(params[0] || "");
      const to = String(params[1] || "");
      const hasInClause = upper.includes("S.ID IN (");
      const allowedIds = hasInClause ? new Set(params.slice(2).map(Number)) : null;
      const requireNotDc = upper.includes("S.DIRECTORS_CHOICE = 0");
      const requireVisible = upper.includes("S.HIDDEN = 0");
      const joined: any[] = [];
      for (const ep of eps) {
        if (from && ep.airdate < from) continue;
        if (to && ep.airdate > to) continue;
        const sh = showsMap.get(Number(ep.show_id));
        if (!sh) continue;
        if (allowedIds && !allowedIds.has(Number(sh.id))) continue;
        if (requireNotDc && Number(sh.directors_choice) !== 0) continue;
        if (requireVisible && Number(sh.hidden) !== 0) continue;
        joined.push({
          ...ep,
          show_hidden: sh.hidden,
          record_json: sh.record_json,
          data_json: sh.data_json,
        });
      }
      joined.sort((a, b) => a.airdate.localeCompare(b.airdate) || String(a.airtime || "").localeCompare(String(b.airtime || "")) || a.id - b.id);
      return { rows: joined, isWrite: false };
    }

    if (upper.includes("FROM EPISODES")) {
      const eps = await loadScheduleEpisodes();
      if (upper.includes("COUNT(*) AS C") && upper.includes("GROUP BY SHOW_ID")) {
        const want = new Set(params.map(Number));
        const counts = new Map<number, number>();
        for (const e of eps) {
          const sid = Number(e.show_id);
          if (!want.size || want.has(sid)) counts.set(sid, (counts.get(sid) || 0) + 1);
        }
        return { rows: [...counts.entries()].map(([show_id, c]) => ({ show_id, c })), isWrite: false };
      }
      if (upper.includes("MIN(AIRDATE)")) {
        const minDate = String(params[0] || "");
        const earliest = new Map<number, string>();
        for (const e of eps) {
          if (minDate && e.airdate < minDate) continue;
          const sid = Number(e.show_id);
          const prev = earliest.get(sid);
          if (!prev || e.airdate < prev) earliest.set(sid, e.airdate);
        }
        return { rows: [...earliest.entries()].map(([show_id, next_airdate]) => ({ show_id, next_airdate })), isWrite: false };
      }
      if (upper.includes("WHERE ID = ?1 AND SHOW_ID = ?2")) {
        const eid = Number(params[0]);
        const sid = Number(params[1]);
        const match = eps.find((e) => Number(e.id) === eid && Number(e.show_id) === sid);
        return { rows: match ? [match] : [], isWrite: false };
      }
      if (upper.includes("WHERE SHOW_ID = ?1")) {
        const sid = Number(params[0]);
        const list = eps
          .filter((e) => Number(e.show_id) === sid)
          .map((e) => ({ ...e, type: e.episode_type }))
          .sort((a, b) => a.airdate.localeCompare(b.airdate) || a.id - b.id)
          .slice(0, 500);
        return { rows: list, isWrite: false };
      }
      return { rows: [{ c: eps.length }], isWrite: false };
    }

    if (upper.includes("FROM SHOWS")) {
      const showsMap = await loadBaseShows();
      let list = [...showsMap.values()];
      if (upper.includes("WHERE ID = ?1") || upper.includes("AND ID =")) {
        const sh = showsMap.get(Number(params[0]));
        list = sh ? [sh] : [];
      }
      if (upper.includes("HIDDEN = 0")) {
        list = list.filter((s) => Number(s.hidden) === 0);
      }
      if (upper.includes("DIRECTORS_CHOICE = 1")) {
        list = list.filter((s) => Number(s.directors_choice) === 1);
      }
      if (upper.startsWith("SELECT 1 FROM SHOWS")) {
        return { rows: list.length ? [{ 1: 1 }] : [], isWrite: false };
      }
      if (upper.includes("COUNT(*) AS C")) {
        return { rows: [{ c: list.length }], isWrite: false };
      }
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { rows: list, isWrite: false };
    }

    if (upper.includes("FROM MOVIES")) {
      const moviesMap = await loadBaseMovies();
      let list = [...moviesMap.values()];
      if (upper.includes("WHERE ID = ?1") || upper.includes("AND ID =")) {
        const mv = moviesMap.get(Number(params[0]));
        list = mv ? [mv] : [];
      }
      if (upper.includes("HIDDEN = 0")) {
        list = list.filter((m) => Number(m.hidden) === 0);
      }
      if (upper.startsWith("SELECT 1 FROM MOVIES")) {
        return { rows: list.length ? [{ 1: 1 }] : [], isWrite: false };
      }
      if (upper.includes("COUNT(*) AS C")) {
        return { rows: [{ c: list.length }], isWrite: false };
      }
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { rows: list, isWrite: false };
    }

    if (upper.includes("COUNT(*)")) {
      return { rows: [{ c: 0 }], isWrite: false };
    }
    return { rows: [], isWrite: false };
  }

  function makeStatement(sql: string, params: any[] = []): any {
    return {
      bind(...nextParams: any[]) {
        return makeStatement(sql, nextParams);
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const { rows } = await execQuery(sql, params);
        if (!rows.length) return null;
        if (colName) return ((rows[0] as any)[colName] ?? null) as T | null;
        return rows[0] as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const { rows } = await execQuery(sql, params);
        return { results: rows as T[], success: true, meta: emptyD1Meta() };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        const { rows } = await execQuery(sql, params);
        return rows.map((r) => Object.values(r)) as T[];
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        await execQuery(sql, params);
        return { results: [] as T[], success: true, meta: emptyD1Meta() };
      },
    };
  }

  return {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const st of statements) {
        out.push(await st.all<T>());
      }
      return out;
    },
    async exec(_query: string): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async withSession() {
      return this;
    },
  } as unknown as D1Database;
}
