import { getKv, setKv, runChunkedBatch, safeJsonParse, HttpError, l1Cached, l1Invalidate } from "./db";

export interface ViuhtiSettings {
  extSearchUrl: string;
  interests: string[];
  tmdbApiKey: string;
  tvmazeApiKey: string;
  installDate: string;
  style: string;
  showHidden: boolean;
  hideWatched: boolean;
  notifyBrowser: boolean;
  webhookUrl: string;
}

const VALID_STYLES = new Set([
  "midnight",
  "bistro",
  "airport",
  "cinema",
  "newspaper",
  "blueprint",
  "swiss",
  "cyber",
  "botanical",
  "popart",
]);

export const DEFAULT_SETTINGS: ViuhtiSettings = {
  extSearchUrl: "",
  interests: [],
  tmdbApiKey: "",
  tvmazeApiKey: "",
  installDate: "",
  style: "midnight",
  showHidden: false,
  hideWatched: false,
  notifyBrowser: false,
  webhookUrl: "",
};

export function normalizeStyle(v: unknown): string {
  const s = String(v || "").trim().toLowerCase();
  return VALID_STYLES.has(s) ? s : "midnight";
}

export function normalizeHttpUrl(v: unknown, label = "URL"): string {
  const s = String(v || "").trim().slice(0, 500);
  if (!s) return "";
  if (!/^https?:\/\/.+/i.test(s)) throw new HttpError(400, `${label} must start with http:// or https://`);
  return s;
}

export function maskKey(k: string): string {
  if (!k) return "";
  return k.length > 4 ? `${"•".repeat(Math.min(8, k.length - 4))}${k.slice(-4)}` : "••••";
}

export async function getRawSettings(db: D1Database): Promise<ViuhtiSettings> {
  return await l1Cached("settings:raw", 60_000, async () => {
    const saved = await getKv<Partial<ViuhtiSettings>>(db, "app_settings", {});
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      interests: Array.isArray(saved.interests) ? saved.interests : [],
      style: normalizeStyle(saved.style),
      showHidden: Boolean(saved.showHidden),
      hideWatched: Boolean(saved.hideWatched),
      notifyBrowser: Boolean(saved.notifyBrowser),
    };
  });
}

export function formatPublicSettings(raw: ViuhtiSettings, envTmdbKey = "") {
  const effTmdb = String(raw.tmdbApiKey || envTmdbKey || "").trim();
  const effTvmaze = String(raw.tvmazeApiKey || "").trim();
  return {
    apiKeys: {
      tmdb: Boolean(effTmdb),
      tmdbHint: maskKey(effTmdb),
      tmdbFromEnv: Boolean(!raw.tmdbApiKey && envTmdbKey),
      tvmaze: Boolean(effTvmaze),
      tvmazeHint: maskKey(effTvmaze),
    },
    tmdbKeySet: Boolean(effTmdb),
    tmdbKeyMask: maskKey(effTmdb),
    tvmazeKeySet: Boolean(effTvmaze),
    tvmazeKeyMask: maskKey(effTvmaze),
    installDate: raw.installDate || "",
    webhookUrl: "",
    webhookSet: Boolean(raw.webhookUrl),
  };
}

export async function saveSettingsPatch(db: D1Database, patch: Record<string, unknown>, envTmdbKey = "") {
  const cur = await getRawSettings(db);
  if (typeof patch.extSearchUrl === "string") {
    const raw = patch.extSearchUrl.trim().slice(0, 300);
    if (raw && !/^https?:\/\/.+/i.test(raw)) {
      throw new HttpError(400, "External search URL must start with http:// or https://");
    }
    cur.extSearchUrl = raw;
  }
  if (Array.isArray(patch.interests)) {
    cur.interests = [...new Set(patch.interests.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 30);
  }
  if (typeof patch.tmdbApiKey === "string") cur.tmdbApiKey = patch.tmdbApiKey.trim().slice(0, 260);
  if (typeof patch.tvmazeApiKey === "string") cur.tvmazeApiKey = patch.tvmazeApiKey.trim().slice(0, 260);
  if (typeof patch.installDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.installDate)) {
    cur.installDate = patch.installDate;
  }
  if (patch.style !== undefined) cur.style = normalizeStyle(patch.style);
  if (patch.showHidden !== undefined) cur.showHidden = Boolean(patch.showHidden);
  if (patch.hideWatched !== undefined) cur.hideWatched = Boolean(patch.hideWatched);
  if (patch.notifyBrowser !== undefined) cur.notifyBrowser = Boolean(patch.notifyBrowser);
  if (typeof patch.webhookUrl === "string") cur.webhookUrl = normalizeHttpUrl(patch.webhookUrl, "Webhook URL");
  await setKv(db, "app_settings", cur);
  l1Invalidate("settings:");
  return formatPublicSettings(cur, envTmdbKey);
}

// ---------------------------------------------------------------------------
// Hidden items (stored in D1 hidden_items table without FIFO cap)
// ---------------------------------------------------------------------------

export interface HiddenEntry {
  id: number;
  kind: "show" | "movie";
  name: string;
  poster?: string | null;
  banner?: string | null;
  background?: string | null;
  logo?: string | null;
  channelName?: string | null;
  channelKind?: string | null;
  premiered?: string | null;
  status?: string | null;
  hiddenAt: number;
  record?: Record<string, any>;
}

export async function loadHiddenSets(db: D1Database): Promise<{ show: Set<number>; movie: Set<number>; items: HiddenEntry[] }> {
  return await l1Cached("hidden:sets", 60_000, async () => {
    const { results } = await db
      .prepare("SELECT kind, id, name, hidden_at, data_json FROM hidden_items ORDER BY hidden_at DESC")
      .all<{ kind: string; id: number; name: string; hidden_at: number; data_json: string }>();
    const show = new Set<number>();
    const movie = new Set<number>();
    const items: HiddenEntry[] = [];
    for (const r of results || []) {
      const k = r.kind === "movie" ? "movie" : "show";
      if (k === "movie") movie.add(Number(r.id));
      else show.add(Number(r.id));
      const parsed = safeJsonParse<HiddenEntry>(r.data_json, {
        id: Number(r.id),
        kind: k,
        name: r.name,
        hiddenAt: Number(r.hidden_at),
      });
      items.push(parsed);
    }
    return { show, movie, items };
  });
}

export async function isHidden(db: D1Database, kind: "show" | "movie", id: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM hidden_items WHERE kind = ?1 AND id = ?2")
    .bind(kind, Number(id))
    .first();
  return Boolean(row);
}

export async function addHiddenEntry(db: D1Database, entry: Partial<HiddenEntry> & { id: number; kind: "show" | "movie" }): Promise<HiddenEntry | null> {
  const id = Number(entry.id);
  if (!id) return null;
  const kind = entry.kind === "movie" ? "movie" : "show";
  const clean: HiddenEntry = {
    id,
    kind,
    name: String(entry.name || `${kind} #${id}`).slice(0, 140),
    poster: entry.poster || null,
    banner: entry.banner || null,
    background: entry.background || null,
    logo: entry.logo || null,
    channelName: entry.channelName || null,
    channelKind: entry.channelKind || (kind === "movie" ? "stream" : "tv"),
    premiered: entry.premiered || null,
    status: entry.status || null,
    hiddenAt: Number(entry.hiddenAt) || Date.now(),
    record: entry.record || { id, addedAt: Date.now() },
  };
  await db
    .prepare(
      `INSERT INTO hidden_items (kind, id, name, hidden_at, data_json)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, hidden_at = excluded.hidden_at, data_json = excluded.data_json`
    )
    .bind(kind, id, clean.name, clean.hiddenAt, JSON.stringify(clean))
    .run();
  l1Invalidate("hidden:");
  return clean;
}

export async function takeHiddenEntry(db: D1Database, kind: "show" | "movie", id: number): Promise<HiddenEntry | null> {
  const row = await db
    .prepare("SELECT data_json FROM hidden_items WHERE kind = ?1 AND id = ?2")
    .bind(kind, Number(id))
    .first<{ data_json: string }>();
  await db.prepare("DELETE FROM hidden_items WHERE kind = ?1 AND id = ?2").bind(kind, Number(id)).run();
  l1Invalidate("hidden:");
  if (!row) return null;
  return safeJsonParse<HiddenEntry | null>(row.data_json, null);
}

export async function removeHidden(db: D1Database, kind: "show" | "movie", id: number): Promise<void> {
  await db.prepare("DELETE FROM hidden_items WHERE kind = ?1 AND id = ?2").bind(kind, Number(id)).run();
  l1Invalidate("hidden:");
}

export async function listHidden(db: D1Database) {
  const { items } = await loadHiddenSets(db);
  return items.map((x) => ({
    id: x.id,
    kind: x.kind,
    name: x.name,
    poster: x.poster || null,
    banner: x.banner || null,
    background: x.background || null,
    logo: x.logo || null,
    channelName: x.channelName || null,
    channelKind: x.channelKind || (x.kind === "movie" ? "stream" : "tv"),
    premiered: x.premiered || null,
    status: x.status || null,
    favorite: Boolean(x.record && x.record.favorite),
    extQuery: (x.record && x.record.extQuery) || null,
    hiddenAt: x.hiddenAt,
  }));
}

export async function countHidden(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) as c FROM hidden_items").first<{ c: number }>();
  return Number(r?.c || 0);
}

export async function exportHiddenData(db: D1Database) {
  const { show, movie, items } = await loadHiddenSets(db);
  return {
    ids: { show: [...show], movie: [...movie] },
    items,
  };
}

export async function importHiddenData(db: D1Database, raw: any = {}, { replace = false } = {}) {
  const stmts: D1PreparedStatement[] = [];
  if (replace) stmts.push(db.prepare("DELETE FROM hidden_items"));
  const seen = new Set<string>();
  for (const x of raw.items || []) {
    if (!x || !Number(x.id) || (x.kind !== "show" && x.kind !== "movie")) continue;
    const id = Number(x.id);
    const k = `${x.kind}:${id}`;
    seen.add(k);
    const clean: HiddenEntry = {
      id,
      kind: x.kind,
      name: String(x.name || `${x.kind} #${id}`).slice(0, 140),
      poster: x.poster || null,
      banner: x.banner || null,
      background: x.background || null,
      logo: x.logo || null,
      channelName: x.channelName || null,
      channelKind: x.channelKind || (x.kind === "movie" ? "stream" : "tv"),
      premiered: x.premiered || null,
      status: x.status || null,
      hiddenAt: Number(x.hiddenAt || x.trashedAt) || Date.now(),
      record: x.record || { id, addedAt: Date.now() },
    };
    stmts.push(
      db
        .prepare(
          `INSERT INTO hidden_items (kind, id, name, hidden_at, data_json)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(kind, id) DO UPDATE SET name=excluded.name, hidden_at=excluded.hidden_at, data_json=excluded.data_json`
        )
        .bind(clean.kind, clean.id, clean.name, clean.hiddenAt, JSON.stringify(clean))
    );
  }
  for (const kind of ["show", "movie"] as const) {
    for (const idRaw of (raw.ids && raw.ids[kind]) || []) {
      const id = Number(idRaw);
      if (!id || seen.has(`${kind}:${id}`)) continue;
      seen.add(`${kind}:${id}`);
      const clean: HiddenEntry = { id, kind, name: `${kind === "movie" ? "Movie" : "Show"} #${id}`, hiddenAt: Date.now(), record: { id, addedAt: Date.now() } };
      stmts.push(
        db
          .prepare(
            `INSERT INTO hidden_items (kind, id, name, hidden_at, data_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(kind, id) DO NOTHING`
          )
          .bind(kind, id, clean.name, clean.hiddenAt, JSON.stringify(clean))
      );
    }
  }
  await runChunkedBatch(db, stmts);
  l1Invalidate("hidden:");
}

// ---------------------------------------------------------------------------
// Watched items (watched_episodes + watched_movies)
// ---------------------------------------------------------------------------

export async function getWatchedSets(db: D1Database): Promise<{ episodes: Set<number>; movies: Set<number> }> {
  return await l1Cached("watched:sets", 60_000, async () => {
    const [epRows, mvRows] = await db.batch([
      db.prepare("SELECT ep_id FROM watched_episodes"),
      db.prepare("SELECT movie_id FROM watched_movies"),
    ]);
    const episodes = new Set<number>();
    for (const r of (epRows.results || []) as Array<{ ep_id: number }>) episodes.add(Number(r.ep_id));
    const movies = new Set<number>();
    for (const r of (mvRows.results || []) as Array<{ movie_id: number }>) movies.add(Number(r.movie_id));
    return { episodes, movies };
  });
}

export async function countWatched(db: D1Database): Promise<number> {
  const [e, m] = await db.batch([
    db.prepare("SELECT COUNT(*) as c FROM watched_episodes"),
    db.prepare("SELECT COUNT(*) as c FROM watched_movies"),
  ]);
  return Number((e.results?.[0] as any)?.c || 0) + Number((m.results?.[0] as any)?.c || 0);
}

export async function setWatched(
  db: D1Database,
  items: Array<{ kind?: string; id: number; showId?: number }>,
  watchedVal: boolean
): Promise<number> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const it of items) {
    const id = Number(it.id);
    if (!id) continue;
    if (it.kind === "movie") {
      if (watchedVal) {
        stmts.push(
          db.prepare("INSERT INTO watched_movies (movie_id, watched_at) VALUES (?1, ?2) ON CONFLICT(movie_id) DO NOTHING").bind(id, now)
        );
      } else {
        stmts.push(db.prepare("DELETE FROM watched_movies WHERE movie_id = ?1").bind(id));
      }
    } else {
      if (watchedVal) {
        stmts.push(
          db
            .prepare("INSERT INTO watched_episodes (ep_id, show_id, watched_at) VALUES (?1, ?2, ?3) ON CONFLICT(ep_id) DO NOTHING")
            .bind(id, Number(it.showId) || 0, now)
        );
      } else {
        stmts.push(db.prepare("DELETE FROM watched_episodes WHERE ep_id = ?1").bind(id));
      }
    }
  }
  await runChunkedBatch(db, stmts);
  l1Invalidate("watched:");
  return await countWatched(db);
}

export async function exportWatchedData(db: D1Database) {
  const { episodes, movies } = await getWatchedSets(db);
  return { episodes: [...episodes], movies: [...movies] };
}

export async function importWatchedData(db: D1Database, raw: any = {}, { replace = false } = {}) {
  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();
  if (replace) {
    stmts.push(db.prepare("DELETE FROM watched_episodes"));
    stmts.push(db.prepare("DELETE FROM watched_movies"));
  }
  for (const id of raw.episodes || []) {
    const n = Number(id);
    if (n) {
      stmts.push(
        db.prepare("INSERT INTO watched_episodes (ep_id, show_id, watched_at) VALUES (?1, 0, ?2) ON CONFLICT(ep_id) DO NOTHING").bind(n, now)
      );
    }
  }
  for (const id of raw.movies || []) {
    const n = Number(id);
    if (n) {
      stmts.push(
        db.prepare("INSERT INTO watched_movies (movie_id, watched_at) VALUES (?1, ?2) ON CONFLICT(movie_id) DO NOTHING").bind(n, now)
      );
    }
  }
  await runChunkedBatch(db, stmts);
  l1Invalidate("watched:");
}

// ---------------------------------------------------------------------------
// Digest & Webhook Alerts
// ---------------------------------------------------------------------------

export async function recordDigest(
  db: D1Database,
  { kind = "show", itemId, event = "added", title, detail = "" }: { kind?: "show" | "movie"; itemId: number; event?: string; title: string; detail?: string }
) {
  const idNum = Number(itemId);
  if (!title || !idNum) return;
  const now = Date.now();
  const k = kind === "movie" ? "movie" : "show";
  const existing = await db
    .prepare("SELECT id, detail FROM digest_items WHERE kind = ?1 AND item_id = ?2 AND event = ?3 AND at > ?4 ORDER BY at DESC LIMIT 1")
    .bind(k, idNum, String(event), now - 12 * 60 * 60 * 1000)
    .first<{ id: string; detail: string }>();
  if (existing) {
    if (detail && detail !== existing.detail) {
      await db
        .prepare("UPDATE digest_items SET detail = ?1, at = ?2 WHERE id = ?3")
        .bind(String(detail).slice(0, 160), now, existing.id)
        .run();
    }
    return;
  }
  const entryId = `${now}-${k}-${idNum}-${Math.random().toString(16).slice(2, 6)}`;
  await db
    .prepare("INSERT INTO digest_items (id, kind, item_id, event, title, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(entryId, k, idNum, String(event), String(title).slice(0, 140), String(detail || "").slice(0, 160), now)
    .run();
  // Prune old rows beyond 80 cleanly
  await db.prepare("DELETE FROM digest_items WHERE id NOT IN (SELECT id FROM digest_items ORDER BY at DESC LIMIT 80)").run();
}

export async function getDigestStatus(db: D1Database) {
  const state = await getKv<{ dismissedBefore?: number }>(db, "digest_state", { dismissedBefore: 0 });
  const dismissedBefore = Number(state.dismissedBefore) || 0;
  const { results } = await db
    .prepare("SELECT id, kind, item_id as itemId, event, title, detail, at FROM digest_items ORDER BY at DESC LIMIT 40")
    .all<{ id: string; kind: string; itemId: number; event: string; title: string; detail: string; at: number }>();
  const items = results || [];
  const unread = items.filter((x) => x.at > dismissedBefore);
  return {
    dismissedBefore,
    unreadCount: unread.length,
    unreadItems: unread.slice(0, 20),
    items,
  };
}

export async function markDigestRead(db: D1Database, untilTs = Date.now()) {
  const cur = await getKv<{ dismissedBefore?: number }>(db, "digest_state", { dismissedBefore: 0 });
  const next = Math.max(Number(cur.dismissedBefore) || 0, Number(untilTs) || Date.now());
  await setKv(db, "digest_state", { dismissedBefore: next });
  return await getDigestStatus(db);
}

export async function dispatchWebhook(webhookUrl: string, title: string, message: string, payload: Record<string, unknown> = {}) {
  const target = normalizeHttpUrl(webhookUrl, "Webhook URL");
  const url = new URL(target);
  const host = url.hostname.toLowerCase();
  const isNtfy = host === "ntfy.sh" || host.endsWith(".ntfy.sh") || host.startsWith("ntfy.");
  const isDiscord = host.includes("discord.com") || host.includes("discordapp.com");
  const isSlack = host.includes("hooks.slack.com");

  let reqInit: RequestInit;
  if (isNtfy) {
    reqInit = {
      method: "POST",
      headers: { Title: title, Priority: "default", Tags: "tv,clapper" },
      body: message,
      signal: AbortSignal.timeout(8000),
    };
  } else if (isDiscord) {
    reqInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**${title}**\n${message}` }),
      signal: AbortSignal.timeout(8000),
    };
  } else if (isSlack) {
    reqInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${title}*\n${message}` }),
      signal: AbortSignal.timeout(8000),
    };
  } else {
    reqInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "viuhti", title, message, text: message, ...payload }),
      signal: AbortSignal.timeout(8000),
    };
  }

  const res = await fetch(target, reqInit);
  if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  return { ok: true, status: res.status };
}
