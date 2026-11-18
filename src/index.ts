import type { Env } from "../cloudflare.config";
import * as tvmaze from "./tvmaze";
import * as tmdb from "./tmdb";
import * as itunes from "./itunes";
import * as state from "./state";
import * as store from "./store";
import * as movies from "./movies";
import * as wiki from "./wiki";
import * as wp from "./wordpool";
import * as recommender from "./recommender";
import * as galaxy from "./galaxy";
import * as ops from "./ops";
import {
  HttpError,
  jsonResponse,
  readJsonBody,
  todayYmd,
  isDateYmd,
  ensureSchema,
  runChunkedBatch,
  getKv,
  wrapTrackedD1,
  resetRequestD1Meter,
  getRequestD1Meter,
  isolateResourceStats,
  isD1QuotaError,
} from "./db";
import {
  buildCanonicalRouteKey,
  clearD1QuotaLock,
  createKvFallbackDb,
  getD1QuotaStatus,
  getL1Response,
  getRouteCachePolicy,
  invalidateCoreKvCaches,
  markD1QuotaLocked,
  readKvRoute,
  recordRequestTrace,
  setL1Response,
  writeKvRoute,
  type CacheLayer,
  type KvCacheEnvelope,
} from "./cache";

const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=120, s-maxage=600",
};

function mondayOfWeekYmd(ref = todayYmd()): string {
  const ms = Date.parse(`${ref}T12:00:00Z`);
  const dow = new Date(ms).getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  return new Date(ms + diff * 86_400_000).toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

function icsEscape(s: unknown): string {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsUtcStamp(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function nextYmdDay(ymd: string): string {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

async function buildIcsFeed(db: D1Database, { media = "both" } = {}): Promise<string> {
  const from = todayYmd(-30);
  const to = todayYmd(120);
  const dtStamp = icsUtcStamp();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Viuhti//Cloud Release Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Viuhti Release Calendar",
  ];

  const pushAllDay = (uid: string, airdate: string, summary: string, desc: string, cats: string) => {
    const startDay = airdate.replace(/-/g, "");
    const endDay = nextYmdDay(airdate).replace(/-/g, "");
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtStamp}`);
    lines.push(`DTSTART;VALUE=DATE:${startDay}`);
    lines.push(`DTEND;VALUE=DATE:${endDay}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (cats) lines.push(`CATEGORIES:${icsEscape(cats)}`);
    lines.push("END:VEVENT");
  };

  if (media !== "movies") {
    const [showList, epList] = await Promise.all([
      store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
      store.scheduleShows(db, from, to, { includeHidden: false }),
    ]);
    const showById = new Map(showList.map((s) => [Number(s.id), s]));
    for (const e of epList) {
      const s = showById.get(Number(e.showId));
      if (!s) continue;
      const code = e.season != null && e.number != null ? `S${String(e.season).padStart(2, "0")}E${String(e.number).padStart(2, "0")}` : "Special";
      const summary = `${s.name} · ${code}${e.name ? ` — ${e.name}` : ""}`;
      const ch = (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || "";
      const desc = [ch ? `Channel: ${ch}` : "", (s.genres || []).join(", ")].filter(Boolean).join(" · ");
      const cats = [e.premiere === "series" ? "Series Premiere" : e.premiere === "season" ? "Season Premiere" : "", ...(s.genres || [])]
        .filter(Boolean)
        .join(",");
      if (e.airtime && e.airstamp && Number.isFinite(Date.parse(e.airstamp))) {
        const startMs = Date.parse(e.airstamp);
        const endMs = startMs + Math.max(15, Number(e.runtime) || Number(s.runtime) || 45) * 60_000;
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:viuhti-ep-${e.id}@viuhti.cloud`);
        lines.push(`DTSTAMP:${dtStamp}`);
        lines.push(`DTSTART:${icsUtcStamp(startMs)}`);
        lines.push(`DTEND:${icsUtcStamp(endMs)}`);
        lines.push(`SUMMARY:${icsEscape(summary)}`);
        if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
        if (cats) lines.push(`CATEGORIES:${icsEscape(cats)}`);
        lines.push("END:VEVENT");
      } else {
        pushAllDay(`viuhti-ep-${e.id}@viuhti.cloud`, e.airdate, summary, desc, cats);
      }
    }
  }

  if (media !== "shows") {
    const [mvList, mvSched] = await Promise.all([
      movies.listMovies(db, { includeHidden: false }),
      movies.scheduleMovies(db, from, to, { includeHidden: false }),
    ]);
    const mvById = new Map(mvList.map((m) => [Number(m.id), m]));
    for (const me of mvSched) {
      const m = mvById.get(Number(me.movieId));
      if (!m) continue;
      const yr = String(m.premiered || m.airdate || "").slice(0, 4);
      const summary = `${m.name}${yr ? ` (${yr})` : ""} — ${me.name}`;
      const desc = [m.channelName ? `Platform: ${m.channelName}` : "", (m.genres || []).join(", ")].filter(Boolean).join(" · ");
      pushAllDay(`viuhti-movie-${m.id}@viuhti.cloud`, me.airdate, summary, desc, (m.genres || []).join(","));
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function isAdminAuthorized(request: Request, env: Env): boolean {
  const secret = String(env.ADMIN_SECRET || "").trim();
  if (!secret) return false;
  const authHdr = String(request.headers.get("authorization") || "");
  const bearer = authHdr.startsWith("Bearer ") ? authHdr.slice(7).trim() : "";
  const xAdmin = String(request.headers.get("x-admin-secret") || "").trim();
  const cand = bearer || xAdmin;
  if (!cand || cand.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ cand.charCodeAt(i);
  return diff === 0;
}

async function seedCatalogFromTvmaze(db: D1Database, { maxShows = 30, page = 0 }: { maxShows?: number; page?: number } = {}) {
  const showsPage = await tvmaze.fetchShowsPage(page).catch(() => []);
  const candidates = showsPage
    .filter((s) => s && s.id && (s.language === "English" || (s.weight || 0) >= 85) && (s.weight || 0) >= 65)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  // Also grab full upcoming schedule to ensure plenty of currently airing shows this month!
  const sched = await tvmaze.fetchFullSchedule().catch(() => []);
  const upcomingIds = new Set<number>();
  const today = todayYmd(-7);
  const horizon = todayYmd(45);
  const upcomingShows = new Map<number, { rawShow: any; episodes: any[] }>();
  for (const row of sched) {
    if (!row || !row.airdate || row.airdate < today || row.airdate > horizon) continue;
    const rs = row._embedded && row._embedded.show;
    if (!rs || !rs.id || (rs.language !== "English" && (rs.weight || 0) < 90) || (rs.weight || 0) < 70) continue;
    upcomingIds.add(rs.id);
    if (!upcomingShows.has(rs.id)) upcomingShows.set(rs.id, { rawShow: rs, episodes: [] });
    upcomingShows.get(rs.id)!.episodes.push(tvmaze.slimEpisode(row));
  }

  let seeded = 0;
  const now = Date.now();
  const topUpcoming = [...upcomingShows.values()]
    .sort((a, b) => (b.rawShow.weight || 0) - (a.rawShow.weight || 0))
    .slice(0, maxShows);
  for (const { rawShow, episodes } of topUpcoming) {
    const slim = tvmaze.slimShow(rawShow);
    await store.upsertShowRecord(
      db,
      { show: slim, episodes, fetchedAt: now },
      { id: slim.id, source: "catalog-seed", addedAt: now },
      { hiddenFlag: 0 }
    );
    seeded++;
  }

  // Also populate Discover pool items cleanly if candidates exist
  const tasteStmts: D1PreparedStatement[] = [];
  for (const s of candidates.slice(0, 80)) {
    const key = `tvmaze:${s.id}`;
    const item = {
      key,
      kind: "show",
      id: s.id,
      tvmazeId: s.id,
      imdbId: s.externals?.imdb || null,
      name: s.name,
      poster: s.poster,
      backdrop: s.background,
      premiered: s.premiered,
      status: s.status,
      language: s.language,
      type: s.type,
      genres: s.genres || [],
      rating: s.rating,
      popularity: s.weight || 0,
      summary: wp.stripHtml(s.summary).slice(0, 320),
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      keywords: [],
      creators: [],
      cast: [],
    };
    tasteStmts.push(
      db
        .prepare(
          `INSERT INTO taste_items (item_key, kind, id, score, data_json, updated_at)
           VALUES (?1, 'show', ?2, ?3, ?4, ?5)
           ON CONFLICT(item_key) DO UPDATE SET score=excluded.score, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(key, s.id, s.weight || s.rating || 0, JSON.stringify(item), now)
    );
  }
  await runChunkedBatch(db, tasteStmts);
  return { seededShows: seeded, seededTaste: tasteStmts.length };
}

async function searchFallbackFromKv(
  env: Env,
  q: string,
  kind: string,
  effectiveTmdbKey: string
): Promise<Response> {
  const [tvList, movieList, showsKv, moviesKv] = await Promise.all([
    kind === "movie"
      ? Promise.resolve([])
      : tvmaze
          .searchShows(q)
          .then((r) => r.map((x) => ({ ...tvmaze.slimShow(x.show), kind: "show" })))
          .catch(() => []),
    kind === "show"
      ? Promise.resolve([])
      : effectiveTmdbKey
        ? tmdb.searchMovies(effectiveTmdbKey, q).catch(() => [])
        : itunes.searchMovies(q, 5).catch(() => []),
    readKvRoute(env.CACHE_KV, "/api/shows"),
    readKvRoute(env.CACHE_KV, "/api/movies"),
  ]);
  let showsList: any[] = [];
  let moviesList: any[] = [];
  try {
    if (showsKv) showsList = JSON.parse(showsKv.body);
  } catch {}
  try {
    if (moviesKv) moviesList = JSON.parse(moviesKv.body);
  } catch {}

  const results = [...tvList.slice(0, 7), ...movieList.slice(0, 5)];
  const qNorm = wp.normText(q);
  const mapped = results.map((item: any) => ({
    ...item,
    onCalendar: false,
    hidden: false,
    ...(!(qNorm && wp.normText(item.name).includes(qNorm)) ? { fuzzyMatch: true, fuzzyLabel: "Fuzzy Match" } : {}),
  }));
  const seenIds = new Set(mapped.map((x: any) => `${x.kind === "movie" ? "movie" : "show"}:${x.id}`));
  const localPool = [...showsList, ...moviesList.map((m) => ({ ...m, kind: "movie" }))];
  for (const fh of wp.searchLocalFuzzy(q, localPool, { limit: 6 })) {
    const it = fh.item;
    const isMv = it.kind === "movie";
    const itemId = Number(isMv ? it.tmdbId || it.id : it.tvmazeId || it.id);
    const sk = `${isMv ? "movie" : "show"}:${itemId}`;
    if (!itemId || seenIds.has(sk)) continue;
    seenIds.add(sk);
    mapped.push({
      id: itemId,
      kind: isMv ? "movie" : "show",
      name: it.name,
      poster: it.poster || null,
      premiered: it.premiered || null,
      status: it.status || "",
      genres: it.genres || [],
      network: it.network || null,
      webChannel: it.webChannel || null,
      channelName: it.channelName || null,
      summary: it.summary || "",
      fuzzyMatch: true,
      fuzzyLabel: "Fuzzy Match",
      fuzzyConfidence: fh.confidence,
      fuzzyField: fh.field,
      fuzzySnippet: fh.snippet,
      onCalendar: false,
      hidden: false,
    });
  }
  return jsonResponse(mapped, 200, { "Cache-Control": "public, max-age=120, s-maxage=300" });
}

async function fetchEphemeralShow(
  id: number,
  range?: { from?: string; to?: string; withSummaries?: boolean }
): Promise<{ summary: any; episodes: any[] } | null> {
  const full = await tvmaze.fetchShowFull(id).catch(() => null);
  if (!full?.show?.id) return null;
  const slim = tvmaze.slimShow(full.show);
  const now = Date.now();
  const epTime = (e: { airstamp?: string | null; airdate?: string | null }) => {
    if (e.airstamp) {
      const t = Date.parse(e.airstamp);
      if (Number.isFinite(t)) return t;
    }
    return e.airdate ? Date.parse(`${e.airdate}T23:59:59Z`) : NaN;
  };
  const validEps = (full.episodes || []).filter((e) => e && e.airdate);
  const next = validEps.find((e) => epTime(e) >= now) || null;
  const past = validEps.filter((e) => epTime(e) < now);
  const last = past.length ? past[past.length - 1] : null;
  const summary = {
    ...slim,
    favorite: false,
    extQuery: null,
    source: "visitor-ephemeral",
    addedAt: now,
    hidden: false,
    nextEpisode: next ? { season: next.season, number: next.number, name: next.name, airstamp: next.airstamp, airdate: next.airdate } : null,
    lastEpisode: last ? { season: last.season, number: last.number, name: last.name, airstamp: last.airstamp, airdate: last.airdate } : null,
  };
  const episodes: any[] = [];
  if (range?.from && range?.to) {
    const chKind = slim.network ? "tv" : "stream";
    const chName = (slim.network && slim.network.name) || (slim.webChannel && slim.webChannel.name) || null;
    for (const e of validEps) {
      if (e.airdate < range.from || e.airdate > range.to) continue;
      const premiere = e.number === 1 && e.season != null ? (e.season === 1 ? "series" : "season") : null;
      const special = e.type === "significant_special" || (e.season != null && e.number == null);
      episodes.push({
        showId: slim.id,
        id: Number(e.id),
        season: e.season,
        number: e.number,
        name: e.name,
        type: e.type,
        airdate: e.airdate,
        airtime: e.airtime,
        airstamp: e.airstamp,
        runtime: e.runtime,
        premiere,
        finale: null,
        special,
        isNew: Boolean(e.airstamp && Date.parse(e.airstamp) >= now - 14 * 86_400_000),
        hidden: false,
        watched: false,
        channelKind: chKind,
        channelName: chName,
        ...(range.withSummaries ? { summary: e.summary || "", showSummary: slim.summary || "" } : {}),
      });
    }
  }
  return { summary, episodes };
}

async function fetchEphemeralMovie(
  id: number,
  effectiveTmdbKey: string,
  range?: { from?: string; to?: string; withSummaries?: boolean }
): Promise<{ summary: any; event: any | null } | null> {
  const raw =
    id >= itunes.ITUNES_ID_MIN
      ? await itunes.lookupMovie(id).catch(() => null)
      : effectiveTmdbKey
        ? await tmdb.fetchMovieFull(effectiveTmdbKey, id).catch(() => null)
        : null;
  if (!raw) return null;
  const mv = "movie" in raw ? raw.movie : raw;
  const releaseKind = ("releaseKind" in raw && raw.releaseKind) || mv.releaseKind || "stream";
  const channelName = ("channelName" in raw && raw.channelName) || mv.channelName || "Apple TV";
  const releaseDate = ("releaseDate" in raw && raw.releaseDate) || mv.airdate || mv.premiered || null;
  const copy = { ...mv } as Record<string, any>;
  delete copy.summary;
  delete copy.posterLarge;
  const summary = {
    ...copy,
    favorite: false,
    extQuery: null,
    source: "visitor-ephemeral",
    addedAt: Date.now(),
    hidden: false,
    watched: false,
  };
  let event: any | null = null;
  if (range?.from && range?.to && releaseDate && releaseDate >= range.from && releaseDate <= range.to) {
    event = {
      id: `movie:${mv.id}`,
      kind: "movie",
      movieId: Number(mv.id),
      name: mv.name,
      airdate: releaseDate,
      poster: mv.poster || null,
      genres: mv.genres || [],
      channelName,
      channelCountry: mv.channelCountry || null,
      releaseKind,
      releaseType: ("releaseType" in raw && raw.releaseType) || null,
      rating: mv.rating ?? null,
      favorite: false,
      hidden: false,
      watched: false,
      ...(range.withSummaries ? { summary: mv.summary || "" } : {}),
    };
  }
  return { summary, event };
}

async function enrichItemDetailOnFallback(
  kind: string,
  id: number,
  epId: number | null,
  includeEpisodes: boolean,
  existing: any,
  tmdbKey: string
) {
  if (kind === "show") {
    const needLive =
      !existing ||
      !existing.summary ||
      (includeEpisodes && (!Array.isArray(existing.episodes) || !existing.episodes.length));
    if (!needLive) return existing;
    const full = await tvmaze.fetchShowFull(id).catch(() => null);
    if (!full?.show?.id) return existing;
    const slim = tvmaze.slimShow(full.show);
    const epMatch = epId ? (full.episodes || []).find((e) => Number(e.id) === epId) : null;
    const liveEps = includeEpisodes
      ? (full.episodes || []).map((e) => ({
          id: e.id,
          season: e.season,
          number: e.number,
          name: e.name,
          type: e.type,
          airdate: e.airdate,
          airtime: e.airtime,
          airstamp: e.airstamp,
          runtime: e.runtime,
          summary: e.summary || "",
          url: e.url || null,
        }))
      : undefined;
    return {
      summary: existing?.summary || slim.summary || "",
      background: existing?.background || slim.background || null,
      posterLarge: existing?.posterLarge || slim.posterLarge || null,
      episodeSummary: existing?.episodeSummary || epMatch?.summary || "",
      episodeUrl: existing?.episodeUrl || epMatch?.url || null,
      ...(includeEpisodes ? { episodes: existing?.episodes?.length ? existing.episodes : liveEps || [] } : {}),
    };
  }
  if (existing && existing.summary) return existing;
  const mvRaw =
    id >= itunes.ITUNES_ID_MIN
      ? await itunes.lookupMovie(id).catch(() => null)
      : tmdbKey
        ? await tmdb.fetchMovieFull(tmdbKey, id).catch(() => null)
        : null;
  const mv = mvRaw && "movie" in mvRaw ? mvRaw.movie : mvRaw;
  if (!mv) return existing;
  return {
    summary: existing?.summary || mv.summary || "",
    background: existing?.background || mv.background || null,
    posterLarge: existing?.posterLarge || mv.posterLarge || null,
  };
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  opts: { useKvFallback?: boolean } = {}
): Promise<Response> {
  const useKvFallback = Boolean(opts.useKvFallback);
  const db = useKvFallback ? createKvFallbackDb(env.CACHE_KV) : wrapTrackedD1(env.DB);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();

  if (pathname === "/api/health") {
    return jsonResponse({ ok: true, mode: "public-cloud", runtime: "cloudflare-free-tier", kvCache: Boolean(env.CACHE_KV) });
  }

  if (pathname === "/api/ops/status" && method === "GET") {
    const runProbes = searchParams.get("probe") === "1";
    const isAdmin = isAdminAuthorized(request, env);
    const forceLive = isAdmin && searchParams.get("live") === "1";
    const cfInfo = (request as Request & { cf?: { colo?: string } }).cf;
    const data = await ops.getOpsStatus(db, {
      runProbes,
      forceLive,
      edgeColo: cfInfo?.colo || null,
      origin: url.origin,
      kv: env.CACHE_KV,
      isAdmin,
    });
    return jsonResponse(
      data,
      200,
      isAdmin || runProbes ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=30, s-maxage=60" }
    );
  }

  if (pathname === "/api/auth/status" && method === "GET") {
    return jsonResponse({ lockEnabled: false, authenticated: true, publicMode: true });
  }

  // Personal client-side routes never touch shared D1
  if (
    pathname === "/api/watched" ||
    pathname === "/api/wordpool" ||
    pathname === "/api/settings" ||
    pathname === "/api/hidden" ||
    pathname === "/api/hidden/restore" ||
    pathname === "/api/digest" ||
    pathname === "/api/digest/read" ||
    pathname === "/api/discover/feedback" ||
    pathname === "/api/discover/traits" ||
    pathname.startsWith("/api/shows/") ||
    pathname.startsWith("/api/movies/")
  ) {
    if (pathname === "/api/hidden" && method === "GET") return jsonResponse([]);
    if (pathname === "/api/digest" && method === "GET") return jsonResponse({ dismissedBefore: 0, unreadCount: 0, unreadItems: [], items: [] });
    if (pathname === "/api/wordpool" && method === "GET") {
      return jsonResponse({ entries: [], stats: { total: 0, active: 0, primary: 0, fuzzy: 0, exclude: 0 }, suggestions: [] });
    }
    return jsonResponse({ ok: true, clientManaged: true });
  }

  if (pathname === "/api/alerts/test" && method === "POST") {
    if (!isAdminAuthorized(request, env)) {
      return jsonResponse({ error: "Server webhooks are disabled in public multi-visitor mode" }, 403);
    }
    return jsonResponse({ ok: true });
  }

  if (!useKvFallback) await ensureSchema(db);
  const rawSettings = await state.getRawSettings(db);
  const envTmdbKey = String(env.TMDB_API_KEY || "").trim();
  const effectiveTmdbKey = String(rawSettings.tmdbApiKey || envTmdbKey || "").trim();
  const pubSettings = state.formatPublicSettings(rawSettings, envTmdbKey);

  // Admin-gated server seed / bulk import routes (protected by ADMIN_SECRET)
  if (pathname === "/api/admin/seed" && method === "POST") {
    if (!isAdminAuthorized(request, env)) {
      return jsonResponse({ error: "Admin authorization required" }, 403);
    }
    const body = await readJsonBody<{ shows?: any[]; maxShows?: number; page?: number; hydrateIds?: number[] }>(request).catch(
      () => ({} as { shows?: any[]; maxShows?: number; page?: number; hydrateIds?: number[] })
    );
    let customHydrated = 0;
    for (const idRaw of (body.hydrateIds || []).slice(0, 12)) {
      const id = Number(idRaw);
      if (!id) continue;
      if (await store.isTrackedShow(db, id)) continue;
      await store.addShow(db, id, "admin-seed").catch(() => null);
      customHydrated++;
    }
    if (Array.isArray(body.shows) && body.shows.length) {
      const stmts: D1PreparedStatement[] = [];
      const now = Date.now();
      for (const s of body.shows.slice(0, 60)) {
        if (!s || !s.show || !s.show.id) continue;
        await store.upsertShowRecord(db, s, { id: s.show.id, source: "admin-seed", addedAt: now }, { hiddenFlag: 0 });
        customHydrated++;
      }
      void stmts;
    }
    const res = body.maxShows !== 0 ? await seedCatalogFromTvmaze(db, { maxShows: body.maxShows ?? 30, page: body.page ?? 0 }) : { seededShows: 0, seededTaste: 0 };
    return jsonResponse({ ok: true, customHydrated, ...res });
  }

  if (pathname === "/api/calendar.ics" && method === "GET") {
    const media = searchParams.get("media") || "both";
    const body = await buildIcsFeed(db, { media });
    const disp = searchParams.get("download") === "1" ? "attachment" : "inline";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `${disp}; filename="viuhti.ics"`,
        ...PUBLIC_CACHE_HEADERS,
      },
    });
  }

  // Public shared catalog endpoints (edge-cached, non-destructive)
  if (pathname === "/api/shows" && method === "GET") {
    const list = await store.listShows(db, { includeHidden: false });
    return jsonResponse(list, 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/movies" && method === "GET") {
    const list = await movies.listMovies(db, { includeHidden: false });
    return jsonResponse(list, 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/item/rich" && method === "GET") {
    const out = await galaxy.getRichItemDetails(db, effectiveTmdbKey, {
      kind: searchParams.get("kind") === "movie" ? "movie" : "show",
      id: Number(searchParams.get("id")) || null,
      tvmazeId: Number(searchParams.get("tvmazeId")) || null,
      tmdbId: Number(searchParams.get("tmdbId")) || null,
      imdbId: (searchParams.get("imdbId") || "").trim() || null,
      name: (searchParams.get("name") || "").trim(),
      year: (searchParams.get("year") || "").slice(0, 4),
    });
    return jsonResponse(out, 200, PUBLIC_CACHE_HEADERS);
  }

  const itemDetail = pathname.match(/^\/api\/item\/(show|movie)\/(\d+)$/);
  if (itemDetail && method === "GET") {
    const [, kind, id] = itemDetail;
    const epId = Number(searchParams.get("epId")) || null;
    const includeEpisodes = searchParams.get("episodes") === "1";
    let detail =
      kind === "movie"
        ? await movies.getMovieDetails(db, Number(id))
        : await store.getShowDetails(db, Number(id), epId, includeEpisodes);
    if (!detail || useKvFallback) {
      detail = await enrichItemDetailOnFallback(kind, Number(id), epId, includeEpisodes, detail, effectiveTmdbKey);
    }
    if (!detail) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse(detail, 200, PUBLIC_CACHE_HEADERS);
  }

  // Ephemeral visitor item lookup: reads public shared D1 catalog first, otherwise fetches upstream
  // without persisting individual visitors' added items into shared D1.
  if (pathname === "/api/shows" && method === "POST") {
    const body = await readJsonBody<{ id?: number }>(request);
    const id = Number(body.id);
    if (!id) return jsonResponse({ error: "Missing show id" }, 400);
    const existing = await store.formatShowSummary(db, id, { publicOnly: true });
    if (existing) return jsonResponse(existing, 200);
    const eph = await fetchEphemeralShow(id);
    if (!eph) return jsonResponse({ error: `Show ${id} not found on TVmaze` }, 404);
    return jsonResponse(eph.summary, 200);
  }

  if (pathname === "/api/movies" && method === "POST") {
    const body = await readJsonBody<{ id?: number }>(request);
    const id = Number(body.id);
    if (!id) return jsonResponse({ error: "Missing movie id" }, 400);
    const existing = await movies.getMovieSummary(db, id, { publicOnly: true });
    if (existing) return jsonResponse(existing, 200);
    if (id < itunes.ITUNES_ID_MIN && !effectiveTmdbKey) {
      return jsonResponse({ error: "TMDB API key is not configured on the server" }, 400);
    }
    const eph = await fetchEphemeralMovie(id, effectiveTmdbKey);
    if (!eph) return jsonResponse({ error: "Movie lookup not found" }, 404);
    return jsonResponse(eph.summary, 200);
  }

  if (pathname === "/api/catalog/hydrate" && method === "POST") {
    const body = await readJsonBody<{
      showIds?: number[];
      movieIds?: number[];
      from?: string;
      to?: string;
      withSummaries?: boolean;
    }>(request).catch(() => ({} as { showIds?: number[]; movieIds?: number[]; from?: string; to?: string; withSummaries?: boolean }));
    const cleanShowIds = [...new Set((body.showIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))].slice(0, 24);
    const cleanMovieIds = [...new Set((body.movieIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))].slice(0, 24);
    const hasRange = isDateYmd(body.from) && isDateYmd(body.to);
    const withSummaries = Boolean(body.withSummaries);

    const showsOut: any[] = [];
    const ephShowIds = new Set<number>();
    const ephEpisodes: any[] = [];
    for (const id of cleanShowIds.slice(0, 12)) {
      const s = await store.formatShowSummary(db, id, { publicOnly: true });
      if (s) {
        showsOut.push(s);
      } else {
        const eph = await fetchEphemeralShow(id, hasRange ? { from: body.from!, to: body.to!, withSummaries } : undefined);
        if (eph) {
          showsOut.push(eph.summary);
          ephShowIds.add(id);
          ephEpisodes.push(...eph.episodes);
        }
      }
    }

    const moviesOut: any[] = [];
    const ephMovieIds = new Set<number>();
    const ephMovieEvents: any[] = [];
    for (const id of cleanMovieIds.slice(0, 12)) {
      const m = await movies.getMovieSummary(db, id, { publicOnly: true });
      if (m) {
        moviesOut.push(m);
      } else if (id >= itunes.ITUNES_ID_MIN || effectiveTmdbKey) {
        const eph = await fetchEphemeralMovie(id, effectiveTmdbKey, hasRange ? { from: body.from!, to: body.to!, withSummaries } : undefined);
        if (eph) {
          moviesOut.push(eph.summary);
          ephMovieIds.add(id);
          if (eph.event) ephMovieEvents.push(eph.event);
        }
      }
    }

    const dbShowIds = cleanShowIds.filter((id) => !ephShowIds.has(id));
    const dbMovieIds = cleanMovieIds.filter((id) => !ephMovieIds.has(id));
    const [dbEpisodesOut, dbMovieEventsOut] = hasRange
      ? await Promise.all([
          dbShowIds.length
            ? store.scheduleShowsForIds(db, body.from!, body.to!, dbShowIds, { withSummaries })
            : Promise.resolve([]),
          dbMovieIds.length
            ? movies.scheduleMoviesForIds(db, body.from!, body.to!, dbMovieIds, { withSummaries })
            : Promise.resolve([]),
        ])
      : [[], []];
    return jsonResponse({
      ok: true,
      shows: showsOut,
      movies: moviesOut,
      episodes: [...dbEpisodesOut, ...ephEpisodes],
      movieEvents: [...dbMovieEventsOut, ...ephMovieEvents],
    });
  }

  if (pathname === "/api/search" && method === "GET") {
    const q = (searchParams.get("q") || "").trim();
    const kind = searchParams.get("kind") || "all";
    if (q.length < 2) return jsonResponse([]);
    const [kvShows, kvMovies, kvDiscover] = env.CACHE_KV
      ? await Promise.all([
          readKvRoute(env.CACHE_KV, "/api/shows"),
          readKvRoute(env.CACHE_KV, "/api/movies"),
          readKvRoute(env.CACHE_KV, "/api/discover?lens=mix&media=all&seeds=1"),
        ])
      : [null, null, null];
    const parseArr = (envPayload: KvCacheEnvelope | null, pick?: (v: any) => any) => {
      if (!envPayload?.body) return null;
      try {
        const parsed = JSON.parse(envPayload.body);
        const val = pick ? pick(parsed) : parsed;
        return Array.isArray(val) ? val : null;
      } catch {
        return null;
      }
    };
    const kvShowsArr = parseArr(kvShows);
    const kvMoviesArr = parseArr(kvMovies);
    const kvPoolArr = parseArr(kvDiscover, (d) => d?.items);

    const [tvList, movieList, showsList, moviesList, poolItems] = await Promise.all([
      kind === "movie"
        ? Promise.resolve([])
        : tvmaze
            .searchShows(q)
            .then((r) => r.map((x) => ({ ...tvmaze.slimShow(x.show), kind: "show" })))
            .catch(() => []),
      kind === "show"
        ? Promise.resolve([])
        : effectiveTmdbKey
          ? tmdb.searchMovies(effectiveTmdbKey, q).catch(() => [])
          : itunes.searchMovies(q, 5).catch(() => []),
      kvShowsArr ? Promise.resolve(kvShowsArr) : store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
      kvMoviesArr ? Promise.resolve(kvMoviesArr) : movies.listMovies(db, { includeHidden: false }),
      kvPoolArr ? Promise.resolve(kvPoolArr) : recommender.getPoolItems(db),
    ]);

    const results = [...tvList.slice(0, 7), ...movieList.slice(0, 5)];
    const qNorm = wp.normText(q);
    const mapped = results.map((item: any) => ({
      ...item,
      onCalendar: false,
      hidden: false,
      ...(!(qNorm && wp.normText(item.name).includes(qNorm)) ? { fuzzyMatch: true, fuzzyLabel: "Fuzzy Match" } : {}),
    }));

    const seenIds = new Set(mapped.map((x: any) => `${x.kind === "movie" ? "movie" : "show"}:${x.id}`));
    const localPool = [...showsList, ...moviesList.map((m) => ({ ...m, kind: "movie" })), ...poolItems];
    for (const fh of wp.searchLocalFuzzy(q, localPool, { limit: 6 })) {
      const it = fh.item;
      const isMv = it.kind === "movie";
      const itemId = Number(isMv ? it.tmdbId || it.id : it.tvmazeId || it.id);
      const sk = `${isMv ? "movie" : "show"}:${itemId}`;
      if (!itemId || seenIds.has(sk)) continue;
      seenIds.add(sk);
      mapped.push({
        id: itemId,
        kind: isMv ? "movie" : "show",
        name: it.name,
        poster: it.poster || null,
        premiered: it.premiered || null,
        status: it.status || "",
        genres: it.genres || [],
        network: it.network || null,
        webChannel: it.webChannel || null,
        channelName: it.channelName || null,
        summary: it.summary || "",
        fuzzyMatch: true,
        fuzzyLabel: "Fuzzy Match",
        fuzzyConfidence: fh.confidence,
        fuzzyField: fh.field,
        fuzzySnippet: fh.snippet,
        onCalendar: false,
        hidden: false,
      });
    }
    return jsonResponse(mapped, 200, { "Cache-Control": "public, max-age=120, s-maxage=300" });
  }

  if (pathname === "/api/schedule" && method === "GET") {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (!isDateYmd(from) || !isDateYmd(to)) return jsonResponse({ error: "from/to must be YYYY-MM-DD" }, 400);
    const withSummaries = searchParams.get("summaries") === "1";

    const [epList, mvList] = await Promise.all([
      store.scheduleShows(db, from, to, { withSummaries, includeHidden: false }),
      movies.scheduleMovies(db, from, to, { withSummaries, includeHidden: false }),
    ]);

    return jsonResponse({ episodes: epList, movies: mvList, settings: pubSettings }, 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/status" && method === "GET") {
    const [showCount, moviesCount, discCfg, syncStatus, tasteState] = await Promise.all([
      store.countActiveShows(db),
      movies.countMovies(db),
      movies.getDiscoveryConfig(db),
      getKv<any>(db, "sync_status", { running: false, total: 0, done: 0, lastSync: null, error: null }),
      recommender.getTasteState(db),
    ]);
    return jsonResponse(
      {
        publicMode: true,
        showCount,
        moviesCount,
        hiddenCount: 0,
        watchedCount: 0,
        wordpool: { total: 0, active: 0, primary: 0, fuzzy: 0, exclude: 0 },
        sync: syncStatus,
        discovery: discCfg,
        movieDiscovery: { enabled: discCfg.enabled, lastRun: discCfg.lastRun, lastAdded: discCfg.lastAdded },
        discover: tasteState.job,
        digest: { dismissedBefore: 0, unreadCount: 0, unreadItems: [], items: [] },
        settings: pubSettings,
        network: { host: url.hostname, port: null, urls: [url.origin] },
        platform: "cloudflare-free-tier-public",
      },
      200,
      PUBLIC_CACHE_HEADERS
    );
  }

  if (pathname === "/api/discover" && method === "GET") {
    const media = searchParams.get("media") || "all";
    const lens = searchParams.get("lens") || "mix";
    const anchorKey = searchParams.get("anchor") || "";
    const needSeeds = searchParams.get("seeds") === "1";
    const rec = await recommender.getRecommendations(db, { apiKey: effectiveTmdbKey, media, lens, anchorKey, limit: 80 });
    const starterSeeds = needSeeds || rec.profile.coldStart ? await recommender.buildStarterSeeds(db, effectiveTmdbKey) : [];
    return jsonResponse({ ...rec, starterSeeds, job: { running: false, phase: "ready" } }, 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/galaxy" && method === "GET") {
    const seedKind = searchParams.get("seedKind") || "";
    const seedId = searchParams.get("seedId") || "";
    const seedTmdbId = searchParams.get("seedTmdbId") || "";
    const seedQid = searchParams.get("seedQid") || "";
    const seedWikiTitle = searchParams.get("seedWikiTitle") || "";
    const seedName = searchParams.get("seedName") || "";
    const imdbId = searchParams.get("imdbId") || "";
    const showDarkMatter = searchParams.get("darkMatter") === "1";

    if (seedKind || seedId || seedTmdbId || seedQid || seedName) {
      return jsonResponse(
        await galaxy.buildSeedGalaxy(db, effectiveTmdbKey, {
          seedKind: seedKind || "show",
          seedId: seedId || null,
          seedTmdbId: seedTmdbId || null,
          seedQid: seedQid || null,
          seedWikiTitle: seedWikiTitle || null,
          seedName,
          imdbId: imdbId || null,
        }),
        200,
        PUBLIC_CACHE_HEADERS
      );
    }
    return jsonResponse(await galaxy.buildTasteGalaxy(db, effectiveTmdbKey, { showDarkMatter }), 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/galaxy/expand" && method === "POST") {
    const body = await readJsonBody<any>(request);
    return jsonResponse(
      await galaxy.expandNode(db, effectiveTmdbKey, {
        node: body.node || {},
        existingKeys: body.existingKeys || [],
        includeWiki: Boolean(body.includeWiki),
      })
    );
  }

  if (pathname === "/api/galaxy/wiki" && method === "GET") {
    const dossier = await wiki.getWikiDossier(db, {
      kind: searchParams.get("kind") || "show",
      name: (searchParams.get("name") || "").trim(),
      year: (searchParams.get("year") || "").slice(0, 4),
      qid: (searchParams.get("qid") || "").trim() || null,
      wikiTitle: (searchParams.get("wikiTitle") || "").trim() || null,
      imdbId: (searchParams.get("imdbId") || "").trim() || null,
    });
    return jsonResponse(dossier, 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/galaxy/search" && method === "GET") {
    return jsonResponse(await galaxy.searchEntities(db, effectiveTmdbKey, searchParams.get("q") || ""), 200, PUBLIC_CACHE_HEADERS);
  }

  if (pathname === "/api/onboarding/shows" && method === "GET") {
    const showsList = await store.listShows(db, { includeHidden: false });
    return jsonResponse({
      installDate: todayYmd(),
      fromDate: todayYmd(),
      toDate: todayYmd(90),
      total: showsList.length,
      genres: [],
      languages: [],
      shows: showsList.slice(0, 120),
    });
  }

  // Admin-only background refresh/discover endpoints (fail closed when ADMIN_SECRET is unset or unauthorized)
  if ((pathname === "/api/discover/run" || pathname === "/api/discovery/run" || pathname === "/api/movies/discovery/run" || pathname === "/api/refresh") && method === "POST") {
    if (!isAdminAuthorized(request, env)) {
      return jsonResponse({ ok: true, clientManaged: true, note: "Shared catalog refreshes automatically." }, 200);
    }
    const [sync, disc, mvRef, scan] = await Promise.all([
      store.refreshStaleShowsStep(db, { force: true, maxCount: 4 }),
      movies.runDiscoveryStep(db, effectiveTmdbKey, { maxAdd: 3 }),
      movies.refreshStaleMoviesStep(db, effectiveTmdbKey, { force: true, maxCount: 3 }),
      recommender.runDeepScan(db, effectiveTmdbKey, { force: true }),
    ]);
    return jsonResponse({ sync, discovery: disc, movieDiscovery: mvRef, discover: scan });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

function buildCachedResponse(
  envPayload: KvCacheEnvelope,
  opts: {
    layer: CacheLayer;
    edgeCacheStatus: string;
    edgeTtlSec: number;
    quotaLocked: boolean;
  }
): Response {
  const ageSec = Math.max(0, Math.round((Date.now() - Number(envPayload.cachedAt || Date.now())) / 1000));
  const ttl = Math.max(30, opts.edgeTtlSec || 120);
  return new Response(envPayload.body, {
    status: 200,
    headers: {
      "Content-Type": envPayload.contentType || "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Cache-Layer": opts.layer,
      "X-Edge-Cache": opts.edgeCacheStatus,
      "X-Cache-Age-Sec": String(ageSec),
      "X-D1-Rows-Read": "0",
      "X-D1-Rows-Written": "0",
      "X-D1-Queries": "0",
      "X-D1-Quota-Lock": opts.quotaLocked ? "1" : "0",
    },
  });
}

async function tryScheduleFallbackFromKv(env: Env, url: URL): Promise<Response | null> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDateYmd(from) || !isDateYmd(to)) return null;
  const mon = mondayOfWeekYmd();
  const wideRoute = `/api/schedule?from=${addDaysYmd(mon, -1)}&to=${addDaysYmd(mon, 40)}`;
  const [wideSchedKv, fixedSchedKv, moviesKv] = await Promise.all([
    readKvRoute(env.CACHE_KV, wideRoute),
    wideRoute === "/api/schedule?from=2026-10-26&to=2026-12-06"
      ? Promise.resolve(null)
      : readKvRoute(env.CACHE_KV, "/api/schedule?from=2026-10-26&to=2026-12-06"),
    readKvRoute(env.CACHE_KV, "/api/movies"),
  ]);
  const schedKv = wideSchedKv || fixedSchedKv;
  if (!schedKv && !moviesKv) return null;

  let epOut: any[] = [];
  let mvOut: any[] = [];
  let sourceTag = "kv-movies";

  if (schedKv) {
    try {
      const parsed = JSON.parse(schedKv.body);
      if (Array.isArray(parsed?.episodes)) {
        epOut = parsed.episodes.filter((e: any) => e?.airdate && e.airdate >= from && e.airdate <= to);
      }
      if (Array.isArray(parsed?.movies)) {
        mvOut = parsed.movies.filter((m: any) => {
          const d = m?.airdate || m?.releaseDate;
          return Boolean(d && d >= from && d <= to);
        });
      }
      sourceTag = "kv-schedule-slice";
    } catch {
      epOut = [];
      mvOut = [];
    }
  }

  if (!mvOut.length && moviesKv) {
    try {
      const list = JSON.parse(moviesKv.body);
      if (Array.isArray(list)) {
        mvOut = list
          .filter((m) => m?.releaseDate && m.releaseDate >= from && m.releaseDate <= to)
          .map((m) => ({
            id: `movie:${m.id}`,
            kind: "movie",
            movieId: m.id,
            name: m.name,
            airdate: m.releaseDate,
            poster: m.poster || null,
            genres: m.genres || [],
            channelName: m.channelName || null,
            favorite: Boolean(m.favorite),
            releaseType: m.releaseType || null,
            summary: "",
          }));
      }
    } catch {
      // Ignore parse failure
    }
  }

  return jsonResponse(
    { episodes: epOut, movies: mvOut, settings: {}, degraded: true, cacheFallback: sourceTag },
    200,
    {
      "Cache-Control": "public, max-age=120, s-maxage=120",
      "X-Cache-Layer": "FALLBACK",
      "X-Edge-Cache": "SKIP",
      "X-D1-Rows-Read": "0",
      "X-D1-Rows-Written": "0",
      "X-D1-Queries": "0",
      "X-D1-Quota-Lock": "1",
    }
  );
}

async function tryApiFallbackWhenD1Locked(request: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    const kind = url.searchParams.get("kind") || "all";
    if (q.length < 2) return jsonResponse([]);
    const fb = await searchFallbackFromKv(env, q, kind, String(env.TMDB_API_KEY || "").trim());
    const h = new Headers(fb.headers);
    h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  h.set("X-Cache-Layer", "FALLBACK");
    h.set("X-Edge-Cache", "SKIP");
    h.set("X-D1-Rows-Read", "0");
    h.set("X-D1-Rows-Written", "0");
    h.set("X-D1-Queries", "0");
    h.set("X-D1-Quota-Lock", "1");
    return new Response(fb.body, { status: 200, headers: h });
  }
  if (p === "/api/schedule") {
    return tryScheduleFallbackFromKv(env, url);
  }
  if (p === "/api/status") {
    const [showsKv, moviesKv] = await Promise.all([
      readKvRoute(env.CACHE_KV, "/api/shows"),
      readKvRoute(env.CACHE_KV, "/api/movies"),
    ]);
    let showCount = 0;
    let moviesCount = 0;
    try {
      if (showsKv) showCount = JSON.parse(showsKv.body).length || 0;
    } catch {}
    try {
      if (moviesKv) moviesCount = JSON.parse(moviesKv.body).length || 0;
    } catch {}
    return jsonResponse(
      {
        publicMode: true,
        degraded: true,
        showCount,
        moviesCount,
        hiddenCount: 0,
        watchedCount: 0,
        wordpool: { total: 0, active: 0, primary: 0, fuzzy: 0, exclude: 0 },
        sync: { running: false, total: 0, done: 0, lastSync: null, error: null },
        discovery: { enabled: true, lastRun: null, lastAdded: 0 },
        movieDiscovery: { enabled: true, lastRun: null, lastAdded: 0 },
        discover: null,
        digest: { dismissedBefore: 0, unreadCount: 0, unreadItems: [], items: [] },
        settings: {},
        network: { host: url.hostname, port: null, urls: [url.origin] },
        platform: "cloudflare-free-tier-public",
      },
      200,
      { "X-Cache-Layer": "FALLBACK", "X-D1-Quota-Lock": "1", "X-D1-Rows-Read": "0", "X-D1-Rows-Written": "0", "X-D1-Queries": "0" }
    );
  }
  if (p === "/api/discover" && !(url.searchParams.get("anchor") || "").trim()) {
    const media = url.searchParams.get("media") || "all";
    const lens = url.searchParams.get("lens") || "mix";
    const anchorKey = url.searchParams.get("anchor") || "";
    const baseKv =
      (await readKvRoute(env.CACHE_KV, `/api/discover?lens=${encodeURIComponent(lens)}&media=all&seeds=1`)) ||
      (await readKvRoute(env.CACHE_KV, "/api/discover?lens=mix&media=all&seeds=1"));
    if (!baseKv) return null;
    try {
      const parsed = JSON.parse(baseKv.body);
      let items: any[] = Array.isArray(parsed.items) ? parsed.items : [];
      const today = todayYmd();
      if (media === "show") items = items.filter((it) => it.kind !== "movie");
      else if (media === "movie" || media === "movies") items = items.filter((it) => it.kind === "movie");
      if (lens === "binge") items = items.filter((it) => it.kind === "show" && /ended|canceled/i.test(it.status || ""));
      else if (lens === "upcoming") items = items.filter((it) => (it.upcomingDate && it.upcomingDate >= today) || (it.premiered && it.premiered >= today));
      else if (lens === "gems") items = items.filter((it) => Number(it.rating || 0) >= 7.2 && Number(it.popularity || 0) <= 95);
      if (anchorKey && parsed.profile && Array.isArray(parsed.profile.anchors)) {
        const anchor = parsed.profile.anchors.find((a: any) => a.key === anchorKey);
        const traitSet = new Set<string>(anchor?.traits || []);
        if (traitSet.size) {
          items = [...items]
            .map((it) => {
              const overlap = (it.genres || []).filter((g: string) => traitSet.has(`genre:${g}`) || traitSet.has(g)).length;
              return { ...it, _anchorScore: overlap * 25 + Number(it.score || 0) };
            })
            .sort((a, b) => b._anchorScore - a._anchorScore);
        }
      }
      return jsonResponse(
        {
          ...parsed,
          items,
          degraded: true,
          fallbackFromKv: true,
        },
        200,
        {
          "Cache-Control": "public, max-age=120, s-maxage=120",
          "X-Cache-Layer": "FALLBACK",
          "X-Edge-Cache": "SKIP",
          "X-D1-Rows-Read": "0",
          "X-D1-Rows-Written": "0",
          "X-D1-Queries": "0",
          "X-D1-Quota-Lock": "1",
        }
      );
    } catch {
      return null;
    }
  }
  void request;
  return null;
}

async function serveApiFallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  reqStart: number
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (url.pathname === "/api/ops/status" || url.pathname === "/api/health") {
    return null;
  }
  if (method === "GET") {
    const directFb = await tryApiFallbackWhenD1Locked(request, env, url).catch(() => null);
    if (directFb) {
      recordRequestTrace({
        at: reqStart,
        method,
        path: url.pathname,
        status: directFb.status,
        layer: "FALLBACK",
        ageSec: null,
        ms: Date.now() - reqStart,
        d1Reads: 0,
        d1Writes: 0,
      });
      return directFb;
    }
  }
  const fbRes = await handleApi(request, env, ctx, url, { useKvFallback: true }).catch(() => null);
  if (!fbRes) return null;
  const h = new Headers(fbRes.headers);
  if (method === "GET" && fbRes.status === 200) {
    h.set("Cache-Control", "public, max-age=120, s-maxage=120");
  }
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  h.set("X-Cache-Layer", "FALLBACK");
  h.set("X-Edge-Cache", "SKIP");
  h.set("X-D1-Rows-Read", "0");
  h.set("X-D1-Rows-Written", "0");
  h.set("X-D1-Queries", "0");
  h.set("X-D1-Quota-Lock", "1");
  recordRequestTrace({
    at: reqStart,
    method,
    path: url.pathname,
    status: fbRes.status,
    layer: "FALLBACK",
    ageSec: null,
    ms: Date.now() - reqStart,
    d1Reads: 0,
    d1Writes: 0,
  });
  return new Response(fbRes.body, { status: fbRes.status, statusText: fbRes.statusText, headers: h });
}

async function refreshRouteIntoKv(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  routeKey: string,
  edgeCache: Cache | null,
  cacheReq: Request | null,
  policy: { edgeTtlSec: number; kvTtlSec: number; staleGraceSec: number }
): Promise<void> {
  try {
    resetRequestD1Meter();
    const res = await handleApi(request, env, ctx, url);
    if (res.status !== 200) return;
    const bodyText = await res.text();
    const ct = res.headers.get("Content-Type") || "application/json; charset=utf-8";
    await writeKvRoute(env.CACHE_KV, routeKey, {
      body: bodyText,
      contentType: ct,
      kvTtlSec: policy.kvTtlSec,
      staleGraceSec: policy.staleGraceSec,
      source: "swr",
    });
    if (edgeCache && cacheReq && policy.edgeTtlSec > 0) {
      const h = new Headers(res.headers);
      h.set("Cache-Control", `public, max-age=${policy.edgeTtlSec}, s-maxage=${policy.edgeTtlSec}`);
      h.delete("Set-Cookie");
      await edgeCache.put(cacheReq, new Response(bodyText, { status: 200, headers: h })).catch(() => {});
    }
    if (getRequestD1Meter().queries > 0) {
      await clearD1QuotaLock(env.CACHE_KV);
    }
  } catch (err) {
    if (isD1QuotaError(err)) await markD1QuotaLocked(env.CACHE_KV, err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Keep visitor localStorage unified on canonical apex origin when accessed via www.*
    if (url.hostname.startsWith("www.")) {
      const target = new URL(request.url);
      target.hostname = url.hostname.slice(4);
      target.protocol = "https:";
      return Response.redirect(target.toString(), 301);
    }
    if (url.pathname.startsWith("/api/")) {
      const reqStart = Date.now();
      const method = request.method.toUpperCase();
      const hasAdminHdr = request.headers.has("authorization") || request.headers.has("x-admin-secret");
      const policy = method === "GET" ? getRouteCachePolicy(url.pathname, url.searchParams) : { edgeTtlSec: 0, kvTtlSec: 0, staleGraceSec: 0, cacheInKv: false };
      const routeKey = buildCanonicalRouteKey(url);
      const edgeCache = !hasAdminHdr && policy.edgeTtlSec > 0 && typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
      const cacheReq = edgeCache ? new Request(url.toString(), { method: "GET" }) : null;
      const fallbackReq = method === "POST" ? request.clone() : request;

      try {
        resetRequestD1Meter();
        // Layer 1: Cloudflare Edge Cache (0 KV reads, 0 D1 reads)
        if (edgeCache && cacheReq) {
          const hit = await edgeCache.match(cacheReq).catch(() => undefined);
          if (hit) {
            isolateResourceStats.edgeHits += 1;
            const hitHeaders = new Headers(hit.headers);
            hitHeaders.set("X-Cache-Layer", "EDGE-HIT");
            hitHeaders.set("X-Edge-Cache", "HIT");
            hitHeaders.set("X-D1-Rows-Read", "0");
            hitHeaders.set("X-D1-Rows-Written", "0");
            hitHeaders.set("X-D1-Queries", "0");
            recordRequestTrace({
              at: reqStart,
              method,
              path: url.pathname,
              status: hit.status,
              layer: "EDGE-HIT",
              ageSec: Number(hitHeaders.get("X-Cache-Age-Sec")) || 0,
              ms: Date.now() - reqStart,
              d1Reads: 0,
              d1Writes: 0,
            });
            return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hitHeaders });
          }
          isolateResourceStats.edgeMisses += 1;
        }

        // Layer 2: Per-isolate L1 response cache
        if (policy.cacheInKv) {
          const l1Hit = getL1Response(routeKey);
          if (l1Hit) {
            const resp = buildCachedResponse(l1Hit, {
              layer: "L1-HIT",
              edgeCacheStatus: "MISS",
              edgeTtlSec: policy.edgeTtlSec,
              quotaLocked: (await getD1QuotaStatus(env.CACHE_KV)).locked,
            });
            if (edgeCache && cacheReq) {
              ctx.waitUntil(edgeCache.put(cacheReq, resp.clone()).catch(() => {}));
            }
            recordRequestTrace({
              at: reqStart,
              method,
              path: url.pathname,
              status: 200,
              layer: "L1-HIT",
              ageSec: Math.round((Date.now() - l1Hit.cachedAt) / 1000),
              ms: Date.now() - reqStart,
              d1Reads: 0,
              d1Writes: 0,
            });
            return resp;
          }
        }

        // Layer 3: Global Workers KV cache (fresh hit, stale-while-revalidate, or D1-lock shield)
        let staleKvCandidate: KvCacheEnvelope | null = null;
        const quotaStatus = policy.cacheInKv || url.pathname === "/api/search" ? await getD1QuotaStatus(env.CACHE_KV) : { locked: false };
        if (policy.cacheInKv && env.CACHE_KV) {
          const kvHit = await readKvRoute(env.CACHE_KV, routeKey);
          if (kvHit) {
            const now = Date.now();
            const isFresh = now < Number(kvHit.freshUntil || 0);
            if (isFresh) {
              isolateResourceStats.kvFreshHits += 1;
              setL1Response(routeKey, kvHit, 45_000);
              const resp = buildCachedResponse(kvHit, {
                layer: "KV-FRESH",
                edgeCacheStatus: "MISS",
                edgeTtlSec: policy.edgeTtlSec,
                quotaLocked: quotaStatus.locked,
              });
              if (edgeCache && cacheReq) {
                ctx.waitUntil(edgeCache.put(cacheReq, resp.clone()).catch(() => {}));
              }
              recordRequestTrace({
                at: reqStart,
                method,
                path: url.pathname,
                status: 200,
                layer: "KV-FRESH",
                ageSec: Math.round((now - kvHit.cachedAt) / 1000),
                ms: Date.now() - reqStart,
                d1Reads: 0,
                d1Writes: 0,
              });
              return resp;
            }
            staleKvCandidate = kvHit;
            const staleAgeMs = now - Number(kvHit.cachedAt || 0);
            if (quotaStatus.locked || staleAgeMs < 24 * 3600_000) {
              isolateResourceStats.kvStaleHits += 1;
              setL1Response(routeKey, kvHit, 30_000);
              const resp = buildCachedResponse(kvHit, {
                layer: "KV-STALE",
                edgeCacheStatus: "MISS",
                edgeTtlSec: Math.min(policy.edgeTtlSec || 120, 120),
                quotaLocked: quotaStatus.locked,
              });
              if (!quotaStatus.locked) {
                ctx.waitUntil(refreshRouteIntoKv(request, env, ctx, url, routeKey, edgeCache, cacheReq, policy));
              }
              recordRequestTrace({
                at: reqStart,
                method,
                path: url.pathname,
                status: 200,
                layer: "KV-STALE",
                ageSec: Math.round(staleAgeMs / 1000),
                ms: Date.now() - reqStart,
                d1Reads: 0,
                d1Writes: 0,
              });
              return resp;
            }
          }
        }

        // If D1 is already known quota-locked, serve via KV + live upstream fallback immediately
        if (quotaStatus.locked) {
          const fb = await serveApiFallback(request, env, ctx, url, reqStart);
          if (fb) return fb;
        }

        // Layer 4: Origin (D1 + live APIs)
        isolateResourceStats.d1Origin += 1;
        const res = await handleApi(request, env, ctx, url);
        const meter = getRequestD1Meter();
        if (meter.queries > 0 && res.status === 200) {
          ctx.waitUntil(clearD1QuotaLock(env.CACHE_KV));
        }
        const outHeaders = new Headers(res.headers);
        outHeaders.set("X-D1-Rows-Read", String(meter.rowsRead));
        outHeaders.set("X-D1-Rows-Written", String(meter.rowsWritten));
        outHeaders.set("X-D1-Queries", String(meter.queries));
        outHeaders.set("X-D1-Quota-Lock", "0");

        if (
          method === "POST" &&
          res.status >= 200 &&
          res.status < 300 &&
          url.pathname === "/api/admin/seed"
        ) {
          ctx.waitUntil(invalidateCoreKvCaches(env.CACHE_KV, url.origin));
        }

        if (method === "GET" && res.status === 200 && policy.cacheInKv) {
          const bodyText = await res.text();
          const ct = outHeaders.get("Content-Type") || "application/json; charset=utf-8";
          outHeaders.set("Cache-Control", `public, max-age=${policy.edgeTtlSec}, s-maxage=${policy.edgeTtlSec}`);
          outHeaders.set("X-Cache-Layer", "D1-ORIGIN");
          outHeaders.set("X-Edge-Cache", edgeCache ? "MISS" : "BYPASS");
          outHeaders.set("X-Cache-Age-Sec", "0");

          const cHeaders = new Headers(outHeaders);
          cHeaders.delete("Set-Cookie");
          if (edgeCache && cacheReq) {
            ctx.waitUntil(edgeCache.put(cacheReq, new Response(bodyText, { status: 200, headers: cHeaders })).catch(() => {}));
          }
          ctx.waitUntil(
            writeKvRoute(env.CACHE_KV, routeKey, {
              body: bodyText,
              contentType: ct,
              kvTtlSec: policy.kvTtlSec,
              staleGraceSec: policy.staleGraceSec,
              source: "origin",
            })
          );
          recordRequestTrace({
            at: reqStart,
            method,
            path: url.pathname,
            status: 200,
            layer: "D1-ORIGIN",
            ageSec: 0,
            ms: Date.now() - reqStart,
            d1Reads: meter.rowsRead,
            d1Writes: meter.rowsWritten,
          });
          return new Response(bodyText, { status: 200, headers: outHeaders });
        }

        if (edgeCache && cacheReq && res.status === 200) {
          const cHeaders = new Headers(outHeaders);
          cHeaders.set("Cache-Control", `public, max-age=${policy.edgeTtlSec}, s-maxage=${policy.edgeTtlSec}`);
          cHeaders.delete("Set-Cookie");
          const cloneForCache = res.clone();
          ctx.waitUntil(edgeCache.put(cacheReq, new Response(cloneForCache.body, { status: 200, headers: cHeaders })).catch(() => {}));
          outHeaders.set("Cache-Control", `public, max-age=${policy.edgeTtlSec}, s-maxage=${policy.edgeTtlSec}`);
          outHeaders.set("X-Edge-Cache", "MISS");
          outHeaders.set("X-Cache-Layer", "D1-ORIGIN");
        } else {
          outHeaders.set("X-Edge-Cache", policy.edgeTtlSec > 0 ? "SKIP" : "BYPASS");
          outHeaders.set("X-Cache-Layer", "BYPASS");
        }

        recordRequestTrace({
          at: reqStart,
          method,
          path: url.pathname,
          status: res.status,
          layer: (outHeaders.get("X-Cache-Layer") as CacheLayer) || "BYPASS",
          ageSec: 0,
          ms: Date.now() - reqStart,
          d1Reads: meter.rowsRead,
          d1Writes: meter.rowsWritten,
        });
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
      } catch (err) {
        if (err instanceof HttpError) {
          return jsonResponse({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
        }
        await markD1QuotaLocked(env.CACHE_KV, err);

        // Emergency stale-if-error KV fallback (never fail a page load if KV has a snapshot!)
        if (method === "GET" && policy.cacheInKv && env.CACHE_KV) {
          const staleEnv = await readKvRoute(env.CACHE_KV, routeKey).catch(() => null);
          if (staleEnv) {
            isolateResourceStats.kvStaleHits += 1;
            const resp = buildCachedResponse(staleEnv, {
              layer: "KV-STALE",
              edgeCacheStatus: "MISS",
              edgeTtlSec: 120,
              quotaLocked: true,
            });
            recordRequestTrace({
              at: reqStart,
              method,
              path: url.pathname,
              status: 200,
              layer: "KV-STALE",
              ageSec: Math.round((Date.now() - staleEnv.cachedAt) / 1000),
              ms: Date.now() - reqStart,
              d1Reads: 0,
              d1Writes: 0,
            });
            return resp;
          }
        }
        if (isD1QuotaError(err)) {
          const fb = await serveApiFallback(fallbackReq, env, ctx, url, reqStart).catch(() => null);
          if (fb) return fb;
        }

        console.error("API error:", err);
        const quota = await getD1QuotaStatus(env.CACHE_KV).catch(() => null);
        const isQuota = isD1QuotaError(err);
        recordRequestTrace({
          at: reqStart,
          method,
          path: url.pathname,
          status: isQuota ? 503 : 500,
          layer: "BYPASS",
          ageSec: null,
          ms: Date.now() - reqStart,
          d1Reads: getRequestD1Meter().rowsRead,
          d1Writes: getRequestD1Meter().rowsWritten,
        });
        return jsonResponse(
          {
            error: err instanceof Error ? err.message : "Internal server error",
            ...(isQuota ? { code: "D1_QUOTA_LOCKED", resetAt: quota?.resetAt || null, dashboard: "/status" } : {}),
          },
          isQuota ? 503 : 500
        );
      }
    }
    const assetRes = await env.ASSETS.fetch(request);
    const headers = new Headers(assetRes.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const quota = await getD1QuotaStatus(env.CACHE_KV);
        if (quota.locked) {
          console.log("Cron skipped cleanly while D1 quota is locked until", new Date(quota.resetAt).toISOString());
          return;
        }
        const t0 = Date.now();
        resetRequestD1Meter();
        const db = wrapTrackedD1(env.DB);
        try {
          await ensureSchema(db);
          const rawSettings = await state.getRawSettings(db);
          const apiKey = String(rawSettings.tmdbApiKey || env.TMDB_API_KEY || "").trim();

          const errors: string[] = [];
          let bootstrapped = false;
          const activeShows = await store.countActiveShows(db);
          if (activeShows < 25) {
            bootstrapped = true;
            await seedCatalogFromTvmaze(db, { maxShows: 30, page: 0 }).catch((e) => {
              errors.push(`bootstrap: ${e instanceof Error ? e.message : String(e)}`);
            });
          }

          const syncRes = await store.refreshStaleShowsStep(db, { force: false, maxCount: 4 }).catch((e) => {
            errors.push(`sync: ${e instanceof Error ? e.message : String(e)}`);
            return { done: 0 };
          });
          const mvRefresh = await movies.refreshStaleMoviesStep(db, apiKey, { force: false, maxCount: 2 }).catch((e) => {
            errors.push(`movieRefresh: ${e instanceof Error ? e.message : String(e)}`);
            return { refreshed: 0 };
          });
          const discRes = await movies.runDiscoveryStep(db, apiKey, { maxAdd: 3 }).catch((e) => {
            errors.push(`discovery: ${e instanceof Error ? e.message : String(e)}`);
            return { addedShows: 0, addedMovies: 0 };
          });
          const tasteRes = await recommender.runDeepScan(db, apiKey, { force: false }).catch((e) => {
            errors.push(`discover: ${e instanceof Error ? e.message : String(e)}`);
            return { done: 0, cached: false };
          });

          const refreshedShows = Number((syncRes as any)?.done || 0);
          const refreshedMovies = Number((mvRefresh as any)?.refreshed || 0);
          const addedShows = Number((discRes as any)?.addedShows || 0);
          const addedMovies = Number((discRes as any)?.addedMovies || 0);
          const tasteCached = Boolean((tasteRes as any)?.cached);
          const didMutate =
            bootstrapped || refreshedShows > 0 || refreshedMovies > 0 || addedShows > 0 || addedMovies > 0 || !tasteCached;

          const cronMeter = getRequestD1Meter();
          await ops
            .recordCronRun(db, {
              at: t0,
              durationMs: Date.now() - t0,
              ok: errors.length === 0,
              bootstrapped,
              refreshedShows,
              refreshedMovies,
              addedShows,
              addedMovies,
              tasteDone: Number((tasteRes as any)?.done || 0),
              tasteCached,
              d1RowsRead: cronMeter.rowsRead,
              d1RowsWritten: cronMeter.rowsWritten,
              error: errors.length ? errors.join("; ") : null,
            })
            .catch((e) => console.error("cron telemetry err:", e));

          // Pre-warm KV routes only when catalog changed or a key is missing/expired; also refresh ops snapshot for /status
          if (env.CACHE_KV) {
            const mon = mondayOfWeekYmd();
            const schedFrom = addDaysYmd(mon, -1);
            const schedTo = addDaysYmd(mon, 7);
            const warmPaths = [
              "/api/shows",
              "/api/movies",
              "/api/status",
              `/api/schedule?from=${schedFrom}&to=${schedTo}`,
              "/api/discover?anchor=&lens=mix&media=all&seeds=1",
              "/api/galaxy",
            ];
            const nowMs = Date.now();
            for (const wpPath of warmPaths) {
              const u = new URL(`https://viuhti.local${wpPath}`);
              const pol = getRouteCachePolicy(u.pathname, u.searchParams);
              const rk = buildCanonicalRouteKey(u);
              if (!didMutate) {
                const existing = await readKvRoute(env.CACHE_KV, rk);
                if (existing && nowMs < Number(existing.freshUntil || 0)) continue;
              }
              await refreshRouteIntoKv(new Request(u.toString()), env, ctx, u, rk, null, null, pol);
            }
            await ops
              .getOpsStatus(db, {
                forceLive: true,
                origin: "https://viuhti.local",
                kv: env.CACHE_KV,
                isAdmin: true,
              })
              .catch(() => {});
          }
        } catch (err) {
          if (isD1QuotaError(err)) {
            await markD1QuotaLocked(env.CACHE_KV, err);
          } else {
            console.error("scheduled error:", err);
          }
        }
      })()
    );
  },
} satisfies ExportedHandler<Env>;
