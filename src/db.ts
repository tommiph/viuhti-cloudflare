import type { Env } from "../cloudflare.config";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    directors_choice INTEGER NOT NULL DEFAULT 0,
    channel_name TEXT,
    channel_kind TEXT,
    status TEXT,
    premiered TEXT,
    rating REAL,
    genres_json TEXT NOT NULL DEFAULT '[]',
    record_json TEXT NOT NULL DEFAULT '{}',
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shows_favorite ON shows(favorite, hidden)`,
  `CREATE INDEX IF NOT EXISTS idx_shows_hidden ON shows(hidden, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_shows_dc ON shows(directors_choice, hidden)`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY,
    show_id INTEGER NOT NULL,
    airdate TEXT NOT NULL,
    airtime TEXT,
    airstamp TEXT,
    season INTEGER,
    number INTEGER,
    episode_type TEXT,
    name TEXT,
    runtime INTEGER,
    summary TEXT,
    url TEXT,
    image TEXT,
    UNIQUE(show_id, season, number, airdate, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_airdate ON episodes(airdate)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_show_id ON episodes(show_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_show_airdate ON episodes(show_id, airdate)`,
  `CREATE TABLE IF NOT EXISTS watched_episodes (
    ep_id INTEGER PRIMARY KEY,
    show_id INTEGER NOT NULL,
    watched_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watched_episodes_show ON watched_episodes(show_id)`,
  `CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    release_date TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    directors_choice INTEGER NOT NULL DEFAULT 0,
    channel_name TEXT,
    status TEXT,
    rating REAL,
    genres_json TEXT NOT NULL DEFAULT '[]',
    record_json TEXT NOT NULL DEFAULT '{}',
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_movies_release ON movies(release_date)`,
  `CREATE TABLE IF NOT EXISTS watched_movies (
    movie_id INTEGER PRIMARY KEY,
    watched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hidden_items (
    kind TEXT NOT NULL CHECK(kind IN ('show', 'movie')),
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hidden_at ON hidden_items(hidden_at DESC)`,
  `CREATE TABLE IF NOT EXISTS wordpool (
    id TEXT PRIMARY KEY,
    word TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('primary', 'fuzzy', 'exclude')),
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wordpool_mode ON wordpool(mode, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS digest_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('show', 'movie')),
    item_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_digest_at ON digest_items(at DESC)`,
  `CREATE TABLE IF NOT EXISTS taste_items (
    item_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('show', 'movie', 'dismissed', 'skipped', 'profile')),
    id INTEGER NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_taste_kind_score ON taste_items(kind, score DESC)`,
  `CREATE TABLE IF NOT EXISTS wiki_cache (
    cache_key TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS item_cache (
    cache_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
];

let schemaInitialized = false;

const rawStmtMap = new WeakMap<object, D1PreparedStatement>();

export function isD1QuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /exceeded D1.*limit|daily row (read|write) limit|\[7500\]/i.test(msg);
}

export const isolateResourceStats = {
  startedAt: Date.now(),
  queries: 0,
  rowsRead: 0,
  rowsWritten: 0,
  l1Hits: 0,
  l1Misses: 0,
  edgeHits: 0,
  edgeMisses: 0,
  kvReads: 0,
  kvWrites: 0,
  kvFreshHits: 0,
  kvStaleHits: 0,
  kvMisses: 0,
  d1Origin: 0,
  d1Errors: 0,
};

let currentRequestMeter = { queries: 0, rowsRead: 0, rowsWritten: 0 };

export function resetRequestD1Meter() {
  currentRequestMeter = { queries: 0, rowsRead: 0, rowsWritten: 0 };
}

export function getRequestD1Meter() {
  return { ...currentRequestMeter };
}

export function trackD1Meta(meta: any) {
  if (!meta || typeof meta !== "object") return;
  const r = Number(meta.rows_read || 0);
  const w = Number(meta.rows_written || 0);
  currentRequestMeter.queries += 1;
  currentRequestMeter.rowsRead += r;
  currentRequestMeter.rowsWritten += w;
  isolateResourceStats.queries += 1;
  isolateResourceStats.rowsRead += r;
  isolateResourceStats.rowsWritten += w;
}

function wrapPreparedStatement(raw: D1PreparedStatement): D1PreparedStatement {
  const proxy: any = {
    bind(...values: unknown[]) {
      return wrapPreparedStatement(raw.bind(...values));
    },
    async first(colName?: string) {
      const res = colName !== undefined ? await raw.first(colName) : await raw.first();
      // first() does not carry meta directly in D1 types, so count at least 1 query cleanly
      currentRequestMeter.queries += 1;
      isolateResourceStats.queries += 1;
      return res;
    },
    async run() {
      const res = await raw.run();
      trackD1Meta(res?.meta);
      return res;
    },
    async all() {
      const res = await raw.all();
      trackD1Meta(res?.meta);
      return res;
    },
    async raw(options?: any) {
      return options !== undefined ? await raw.raw(options) : await raw.raw();
    },
  };
  rawStmtMap.set(proxy, raw);
  return proxy as D1PreparedStatement;
}

/**
 * Lightweight proxy around D1Database that measures real D1 rows_read & rows_written
 * via Cloudflare's native D1 meta counters without touching query call sites.
 */
export function wrapTrackedD1(db: D1Database): D1Database {
  return {
    prepare(query: string) {
      return wrapPreparedStatement(db.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const unwrapped = statements.map((s) => rawStmtMap.get(s as unknown as object) || s);
      const results = await db.batch<T>(unwrapped);
      for (const r of results || []) trackD1Meta((r as any)?.meta);
      return results;
    },
    dump() {
      return db.dump();
    },
    async exec(query: string) {
      const res = await db.exec(query);
      currentRequestMeter.queries += 1;
      isolateResourceStats.queries += 1;
      return res;
    },
    withSession(constraintOrBookmark?: string) {
      return typeof (db as any).withSession === "function"
        ? wrapTrackedD1((db as any).withSession(constraintOrBookmark))
        : wrapTrackedD1(db);
    },
  } as unknown as D1Database;
}

// Per-isolate L1 memory TTL cache to prevent duplicate D1 scans inside one request or warm isolate
const l1Cache = new Map<string, { value: unknown; expiresAt: number }>();
const l1Inflight = new Map<string, Promise<unknown>>();

export async function l1Cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = l1Cache.get(key);
  if (hit && hit.expiresAt > now) {
    isolateResourceStats.l1Hits += 1;
    return hit.value as T;
  }
  const pending = l1Inflight.get(key);
  if (pending) {
    isolateResourceStats.l1Hits += 1;
    return (await pending) as T;
  }
  isolateResourceStats.l1Misses += 1;
  const prom = (async () => {
    try {
      const val = await loader();
      if (l1Cache.size >= 64) {
        const oldestKey = l1Cache.keys().next().value;
        if (oldestKey !== undefined) l1Cache.delete(oldestKey);
      }
      l1Cache.set(key, { value: val, expiresAt: Date.now() + ttlMs });
      return val;
    } finally {
      l1Inflight.delete(key);
    }
  })();
  l1Inflight.set(key, prom);
  return await prom;
}

export function l1Invalidate(prefix = "") {
  if (!prefix) {
    l1Cache.clear();
    return;
  }
  for (const k of l1Cache.keys()) {
    if (k.startsWith(prefix)) l1Cache.delete(k);
  }
}

/**
 * Ensures local/remote D1 tables and performance indexes exist idempotently once per isolate lifecycle.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaInitialized) return;
  try {
    const [tbl, idx] = await db.batch([
      db.prepare("SELECT 1 FROM wordpool LIMIT 1"),
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_shows_dc', 'idx_episodes_show_airdate')"),
    ]);
    const idxNames = new Set(((idx?.results || []) as Array<{ name?: string }>).map((r) => r.name));
    if (tbl?.results !== undefined && idxNames.has("idx_shows_dc") && idxNames.has("idx_episodes_show_airdate")) {
      schemaInitialized = true;
      return;
    }
    if (tbl?.results !== undefined) {
      await db.batch([
        db.prepare("CREATE INDEX IF NOT EXISTS idx_shows_hidden ON shows(hidden, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_shows_dc ON shows(directors_choice, hidden)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_episodes_show_airdate ON episodes(show_id, airdate)"),
      ]);
      schemaInitialized = true;
      return;
    }
  } catch (err) {
    if (isD1QuotaError(err)) throw err;
    // Table missing — initialize full schema cleanly in one D1 batch.
  }
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  schemaInitialized = true;
}

export async function getKv<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db
    .prepare("SELECT value_json FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value_json: string }>();
  if (!row || !row.value_json) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export async function setKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export async function runChunkedBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 75
): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const slice = statements.slice(i, i + chunkSize);
    if (slice.length) await db.batch(slice);
  }
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function todayYmd(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isDateYmd(v: string | null | undefined): v is string {
  return Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...extraHeaders,
    },
  });
}

export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  const lenHeader = Number(request.headers.get("content-length") || 0);
  if (lenHeader > 12_000_000) {
    throw new HttpError(413, "Payload too large");
  }
  const text = await request.text();
  if (!text.trim()) return {} as T;
  if (text.length > 12_000_000) {
    throw new HttpError(413, "Payload too large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function resolveEnvTmdbKey(env: Env, settingsKey?: string): string {
  return String(settingsKey || env.TMDB_API_KEY || "").trim();
}
