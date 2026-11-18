import * as tmdb from "./tmdb";
import * as tvmaze from "./tvmaze";
import * as itunes from "./itunes";
import * as state from "./state";
import * as store from "./store";
import * as wp from "./wordpool";
import { getKv, setKv, runChunkedBatch, safeJsonParse, todayYmd, l1Cached, l1Invalidate } from "./db";
import type { DiscoveryRules } from "./store";

export interface MovieRecord {
  id: number;
  source?: string | null;
  addedAt?: number;
  favorite?: boolean;
  extQuery?: string | null;
  tdQuery?: string | null;
}

function addDaysYmd(ymd: string, delta: number): string {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10);
}

export async function upsertMovieRecord(
  db: D1Database,
  movie: ReturnType<typeof tmdb.slimMovie>,
  rec: MovieRecord,
  { hiddenFlag = 0 }: { hiddenFlag?: number } = {}
) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO movies (id, name, release_date, favorite, hidden, directors_choice, channel_name, status, rating, genres_json, record_json, data_json, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, release_date=excluded.release_date, favorite=excluded.favorite, hidden=excluded.hidden,
         channel_name=excluded.channel_name, status=excluded.status, rating=excluded.rating,
         genres_json=excluded.genres_json, record_json=excluded.record_json, data_json=excluded.data_json, updated_at=excluded.updated_at`
    )
    .bind(
      movie.id,
      movie.name,
      movie.airdate || movie.premiered || null,
      rec.favorite ? 1 : 0,
      hiddenFlag,
      movie.channelName || null,
      movie.status || null,
      movie.rating ?? null,
      JSON.stringify(movie.genres || []),
      JSON.stringify(rec),
      JSON.stringify(movie),
      now
    )
    .run();
  l1Invalidate("movies:");
}

export async function isTrackedMovie(db: D1Database, id: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM movies WHERE id = ?1 AND hidden = 0").bind(Number(id)).first();
  return Boolean(row);
}

export async function countMovies(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM movies WHERE hidden = 0").first<{ c: number }>();
  return Number(row?.c || 0);
}

export async function addMovie(
  db: D1Database,
  apiKey: string,
  id: number,
  source = "search",
  { record, hiddenFlag = 0 }: { record?: Partial<MovieRecord>; hiddenFlag?: number } = {}
) {
  const movieId = Number(id);
  const full = await tmdb.fetchMovieFull(apiKey, movieId);
  if (!full) throw new Error(`Movie ${movieId} not found on TMDB`);
  const existing = await db.prepare("SELECT hidden, record_json FROM movies WHERE id = ?1").bind(movieId).first<{ hidden: number; record_json: string }>();
  const prevRec = existing ? safeJsonParse<MovieRecord>(existing.record_json, { id: movieId }) : { id: movieId };
  const rec: MovieRecord = {
    ...prevRec,
    ...(record || {}),
    id: movieId,
    source: record?.source ?? prevRec.source ?? source,
    addedAt: prevRec.addedAt || Date.now(),
  };
  const nextHidden = existing ? Number(existing.hidden) : hiddenFlag;
  if (nextHidden === 0) {
    await state.removeHidden(db, "movie", movieId);
  }
  await upsertMovieRecord(db, full.movie, rec, { hiddenFlag: nextHidden });
  if (!existing && nextHidden === 0) {
    await state.recordDigest(db, {
      kind: "movie",
      itemId: movieId,
      event: "added",
      title: full.movie.name,
      detail: `${full.movie.genres?.slice(0, 2).join(", ") || "Movie"}${full.movie.channelName ? ` · ${full.movie.channelName}` : ""}`,
    });
  }
  return await getMovieSummary(db, movieId);
}

export async function restoreMovie(db: D1Database, apiKey: string, rec: MovieRecord) {
  const movieId = Number(rec.id);
  const existing = await db.prepare("SELECT record_json FROM movies WHERE id = ?1").bind(movieId).first<{ record_json: string }>();
  if (existing) {
    const merged: MovieRecord = { ...safeJsonParse<MovieRecord>(existing.record_json, { id: movieId }), ...rec, id: movieId };
    await db
      .prepare("UPDATE movies SET hidden = 0, favorite = ?1, record_json = ?2 WHERE id = ?3")
      .bind(merged.favorite ? 1 : 0, JSON.stringify(merged), movieId)
      .run();
    return await getMovieSummary(db, movieId);
  }
  if (!apiKey) {
    // Allow restoring stub metadata when TMDB key isn't set yet
    const stub = {
      id: movieId,
      kind: "movie" as const,
      name: `Movie #${movieId}`,
      originalName: null,
      url: `https://www.themoviedb.org/movie/${movieId}`,
      language: null,
      genres: [],
      status: "Released",
      premiered: null,
      airdate: null,
      releaseKind: "stream" as const,
      channelName: "TMDB",
      channelCountry: null,
      runtime: null,
      officialSite: null,
      imdbUrl: null,
      imdbId: null,
      rating: null,
      popularity: 0,
      poster: null,
      posterLarge: null,
      logo: null,
      background: null,
      summary: "",
      tagline: "",
    };
    await upsertMovieRecord(db, stub, rec, { hiddenFlag: 0 });
    return await getMovieSummary(db, movieId);
  }
  return await addMovie(db, apiKey, movieId, rec.source || "restored", { record: rec });
}

export async function getMovieSummary(
  db: D1Database,
  id: number,
  { publicOnly = false }: { publicOnly?: boolean } = {}
) {
  const row = await db
    .prepare("SELECT id, favorite, hidden, record_json, data_json FROM movies WHERE id = ?1")
    .bind(Number(id))
    .first<{ id: number; favorite: number; hidden: number; record_json: string; data_json: string }>();
  if (!row || (publicOnly && Number(row.hidden) !== 0)) return null;
  const { movies: watchedSet } = await state.getWatchedSets(db);
  const m = safeJsonParse<any>(row.data_json, { id: row.id, kind: "movie", name: `Movie #${row.id}` });
  const t = safeJsonParse<MovieRecord>(row.record_json, { id: row.id });
  const copy = { ...m };
  delete copy.summary;
  delete copy.posterLarge;
  return {
    ...copy,
    favorite: Boolean(row.favorite || t.favorite),
    extQuery: t.extQuery || t.tdQuery || null,
    source: t.source || null,
    addedAt: t.addedAt || null,
    hidden: Number(row.hidden) === 1,
    watched: watchedSet.has(Number(row.id)),
  };
}

export async function getMovieDetails(db: D1Database, id: number) {
  const row = await db
    .prepare("SELECT data_json FROM movies WHERE id = ?1 AND hidden = 0")
    .bind(Number(id))
    .first<{ data_json: string }>();
  if (!row) return null;
  const m = safeJsonParse<any>(row.data_json, {});
  return {
    summary: m.summary || "",
    background: m.background || null,
    posterLarge: m.posterLarge || null,
  };
}

export async function listMovies(db: D1Database, { includeHidden = false }: { includeHidden?: boolean } = {}) {
  if (!includeHidden) {
    return await l1Cached("movies:active", 90_000, () => loadMoviesUncached(db, { includeHidden: false }));
  }
  return await loadMoviesUncached(db, { includeHidden });
}

async function loadMoviesUncached(db: D1Database, { includeHidden = false }: { includeHidden?: boolean } = {}) {
  const { movies: watchedSet } = await state.getWatchedSets(db);
  const { results } = await db
    .prepare(
      includeHidden
        ? "SELECT id, favorite, hidden, record_json, data_json FROM movies ORDER BY name ASC"
        : "SELECT id, favorite, hidden, record_json, data_json FROM movies WHERE hidden = 0 ORDER BY name ASC"
    )
    .all<{ id: number; favorite: number; hidden: number; record_json: string; data_json: string }>();

  const out: any[] = [];
  const seen = new Set<number>();
  for (const r of results || []) {
    seen.add(Number(r.id));
    const m = safeJsonParse<any>(r.data_json, { id: r.id, kind: "movie" });
    const t = safeJsonParse<MovieRecord>(r.record_json, { id: r.id });
    const copy = { ...m };
    delete copy.summary;
    delete copy.posterLarge;
    out.push({
      ...copy,
      favorite: Boolean(r.favorite || t.favorite),
      extQuery: t.extQuery || t.tdQuery || null,
      source: t.source || null,
      addedAt: t.addedAt || null,
      hidden: Boolean(r.hidden),
      watched: watchedSet.has(Number(r.id)),
    });
  }
  if (includeHidden) {
    const hiddenItems = await state.listHidden(db);
    for (const h of hiddenItems) {
      if (h.kind !== "movie" || seen.has(h.id)) continue;
      out.push({
        id: h.id,
        kind: "movie",
        name: h.name,
        poster: h.poster,
        banner: h.banner,
        logo: h.logo,
        channelName: h.channelName,
        releaseKind: h.channelKind || "stream",
        genres: [],
        premiered: h.premiered,
        airdate: h.premiered,
        status: h.status,
        favorite: h.favorite,
        extQuery: h.extQuery,
        hidden: true,
      });
    }
  }
  return out;
}

function formatScheduleMovieRow(
  r: { id: number; hidden: number; record_json: string; data_json: string },
  watchedSet: Set<number>,
  withSummaries: boolean,
  now: number
) {
  const m = safeJsonParse<any>(r.data_json, { id: r.id, kind: "movie" });
  const t = safeJsonParse<MovieRecord>(r.record_json, { id: r.id });
  const airdate = m.airdate || m.premiered;
  if (!airdate) return null;
  const airMs = Date.parse(`${airdate}T12:00:00Z`);
  const primMs = m.premiered ? Date.parse(`${m.premiered}T12:00:00Z`) : airMs;
  const isFreshWindow = Math.abs(now - airMs) <= 21 * 86_400_000 && airMs - primMs <= 540 * 86_400_000;
  const isNew = Boolean(
    isFreshWindow || ((t.source === "auto-weekly" || t.source === "auto-bimonthly") && t.addedAt && now - t.addedAt <= 21 * 86_400_000)
  );
  return {
    id: `m-${r.id}`,
    movieId: r.id,
    kind: "movie",
    airdate,
    airtime: "",
    airstamp: `${airdate}T12:00:00Z`,
    name:
      m.tagline ||
      (m.releaseKind === "tv" ? "TV Premiere" : m.releaseKind === "physical" ? "Physical Media Release" : "Streaming Release"),
    isNew,
    hidden: Number(r.hidden) === 1,
    watched: watchedSet.has(Number(r.id)),
    ...(withSummaries ? { summary: m.summary || "" } : {}),
  };
}

export async function scheduleMoviesForIds(
  db: D1Database,
  from: string,
  to: string,
  movieIds: number[],
  { withSummaries = false }: { withSummaries?: boolean } = {}
) {
  const cleanIds = [...new Set((movieIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))].slice(0, 40);
  if (!cleanIds.length) return [];
  const { movies: watchedSet } = await state.getWatchedSets(db);
  const placeholders = cleanIds.map((_, idx) => `?${idx + 3}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, hidden, record_json, data_json FROM movies
       WHERE release_date >= ?1 AND release_date <= ?2
         AND id IN (${placeholders})
       ORDER BY release_date ASC, id ASC`
    )
    .bind(from, to, ...cleanIds)
    .all<{ id: number; hidden: number; record_json: string; data_json: string }>();

  const now = Date.now();
  return (results || [])
    .map((r) => formatScheduleMovieRow(r, watchedSet, withSummaries, now))
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export async function scheduleMovies(
  db: D1Database,
  from: string,
  to: string,
  { withSummaries = false, includeHidden = false }: { withSummaries?: boolean; includeHidden?: boolean } = {}
) {
  const { movies: watchedSet } = await state.getWatchedSets(db);
  const { results } = await db
    .prepare(
      `SELECT id, hidden, record_json, data_json FROM movies
       WHERE release_date >= ?1 AND release_date <= ?2
         ${includeHidden ? "" : "AND hidden = 0"}
       ORDER BY release_date ASC, id ASC`
    )
    .bind(from, to)
    .all<{ id: number; hidden: number; record_json: string; data_json: string }>();

  const now = Date.now();
  return (results || [])
    .map((r) => formatScheduleMovieRow(r, watchedSet, withSummaries, now))
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export async function setMovieFavorite(db: D1Database, id: number, fav?: boolean) {
  const movieId = Number(id);
  const row = await db.prepare("SELECT favorite, record_json FROM movies WHERE id = ?1").bind(movieId).first<{ favorite: number; record_json: string }>();
  if (row) {
    const t = safeJsonParse<MovieRecord>(row.record_json, { id: movieId });
    const next = fav === undefined ? !Boolean(t.favorite) : Boolean(fav);
    if (next) t.favorite = true;
    else delete t.favorite;
    await db.prepare("UPDATE movies SET favorite = ?1, record_json = ?2 WHERE id = ?3").bind(next ? 1 : 0, JSON.stringify(t), movieId).run();
    return await getMovieSummary(db, movieId);
  }
  const h = await state.takeHiddenEntry(db, "movie", movieId);
  if (h) {
    const rec: MovieRecord = { ...(h.record || { id: movieId }), id: movieId };
    const next = fav === undefined ? !Boolean(rec.favorite) : Boolean(fav);
    rec.favorite = next;
    h.record = rec;
    await state.addHiddenEntry(db, h);
    return { ...h, favorite: next, hidden: true };
  }
  return null;
}

export async function setMovieExtQuery(db: D1Database, id: number, extQuery: unknown) {
  const movieId = Number(id);
  const q = String(extQuery || "").trim().slice(0, 120);
  const row = await db.prepare("SELECT record_json FROM movies WHERE id = ?1").bind(movieId).first<{ record_json: string }>();
  if (!row) return null;
  const t = safeJsonParse<MovieRecord>(row.record_json, { id: movieId });
  if (q) t.extQuery = q;
  else delete t.extQuery;
  delete t.tdQuery;
  await db.prepare("UPDATE movies SET record_json = ?1 WHERE id = ?2").bind(JSON.stringify(t), movieId).run();
  return await getMovieSummary(db, movieId);
}

export async function hideMovie(db: D1Database, id: number, fallbackMeta: { id: number; name?: string; premiered?: string | null } | null = null) {
  const movieId = Number(id);
  const row = await db.prepare("SELECT record_json, data_json FROM movies WHERE id = ?1").bind(movieId).first<{ record_json: string; data_json: string }>();
  let snap: state.HiddenEntry | null = null;
  if (row) {
    const m = safeJsonParse<any>(row.data_json, { id: movieId, name: `Movie #${movieId}` });
    const t = safeJsonParse<MovieRecord>(row.record_json, { id: movieId });
    snap = {
      id: movieId,
      kind: "movie",
      name: m.name,
      poster: m.poster || null,
      banner: m.banner || null,
      background: m.background || null,
      logo: m.logo || null,
      channelName: m.channelName || null,
      channelKind: m.releaseKind || "stream",
      premiered: m.premiered || null,
      status: m.status || null,
      hiddenAt: Date.now(),
      record: t,
    };
    await db.prepare("UPDATE movies SET hidden = 1 WHERE id = ?1").bind(movieId).run();
  } else if (fallbackMeta) {
    snap = {
      id: movieId,
      kind: "movie",
      name: fallbackMeta.name || `Movie #${movieId}`,
      premiered: fallbackMeta.premiered || null,
      hiddenAt: Date.now(),
      record: { id: movieId, addedAt: Date.now() },
    };
  }
  if (snap) await state.addHiddenEntry(db, snap);
  return { ok: Boolean(row), id: movieId, name: snap ? snap.name : `Movie #${movieId}` };
}

export async function getDiscoveryConfig(db: D1Database): Promise<{ enabled: boolean; rules: DiscoveryRules; lastRun: number | null; lastAdded: number }> {
  const raw = await getKv<any>(db, "discovery_config", {});
  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : true,
    rules: { ...store.DEFAULT_DISCOVERY_RULES, ...(raw.rules || {}) },
    lastRun: Number(raw.lastRun) || null,
    lastAdded: Number(raw.lastAdded) || 0,
  };
}

export async function setDiscoveryConfig(db: D1Database, patch: { enabled?: boolean; rules?: Partial<DiscoveryRules>; lastRun?: number; lastAdded?: number }) {
  const cur = await getDiscoveryConfig(db);
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : cur.enabled,
    rules: patch.rules ? { ...cur.rules, ...patch.rules } : cur.rules,
    lastRun: patch.lastRun ?? cur.lastRun,
    lastAdded: patch.lastAdded ?? cur.lastAdded,
  };
  await setKv(db, "discovery_config", next);
  return next;
}

export async function addKeylessMovie(
  db: D1Database,
  movieId: number,
  source = "visitor-lookup",
  { hiddenFlag = 0 }: { hiddenFlag?: number } = {}
) {
  const movie = await itunes.lookupMovie(movieId);
  if (!movie) return null;
  await upsertMovieRecord(db, movie, { id: movie.id, source, addedAt: Date.now() }, { hiddenFlag });
  return await getMovieSummary(db, movie.id);
}

/**
 * Bounded TVmaze (broadcast + streaming) + TMDB / keyless iTunes discovery step
 * designed for Cloudflare Workers Free Tier CPU & subrequest budgets.
 */
export async function runDiscoveryStep(
  db: D1Database,
  apiKey: string,
  { maxAdd = 4, forceMovies = false }: { maxAdd?: number; forceMovies?: boolean } = {}
) {
  const cfg = await getDiscoveryConfig(db);
  if (!cfg.enabled) return { ...cfg, added: 0 };

  const hiddenSets = await state.loadHiddenSets(db);
  const wpEntries = await wp.loadEntries(db);
  const rules = cfg.rules;
  const genreSet = new Set(rules.genres || []);
  const langSet = new Set(rules.languages || []);
  const typeSet = new Set(rules.types || []);

  // 1. Rotate across broadcast & streaming TVmaze schedules across 5 upcoming horizons
  const horizons = [todayYmd(0), todayYmd(1), todayYmd(4), todayYmd(7), todayYmd(14)];
  const slotDate = horizons[Math.floor(Date.now() / 900_000) % horizons.length];
  const [broadcastRows, webRows, existingShowIdsRes] = await Promise.all([
    tvmaze.fetchSchedule(slotDate, false).catch(() => []),
    tvmaze.fetchSchedule(slotDate, true).catch(() => []),
    db.prepare("SELECT id FROM shows WHERE hidden = 0").all<{ id: number }>(),
  ]);
  const trackedShowIds = new Set((existingShowIdsRes.results || []).map((r) => Number(r.id)));
  const rawEntries: any[] = [...broadcastRows, ...webRows];

  let addedShows = 0;
  for (const row of rawEntries) {
    if (addedShows >= maxAdd) break;
    const rawShow = row && row._embedded && row._embedded.show ? row._embedded.show : row && row.show;
    if (!rawShow || !rawShow.id) continue;
    const id = Number(rawShow.id);
    if (hiddenSets.show.has(id) || trackedShowIds.has(id)) continue;

    const slim = tvmaze.slimShow(rawShow);
    const wpMatch = wp.matchItemWithEntries(wpEntries, slim);
    if (!wpMatch.primary) {
      if ((slim.weight || 0) < (rules.minWeight || 60)) continue;
      if (langSet.size > 0 && !langSet.has(slim.language || "Unknown")) continue;
      if (typeSet.size > 0 && !typeSet.has(slim.type || "Unknown")) continue;
      if (genreSet.size > 0 && !(slim.genres || []).some((g) => genreSet.has(g))) continue;
    }
    try {
      await store.addShow(db, id, "auto-bimonthly");
      trackedShowIds.add(id);
      addedShows++;
    } catch {
      // ignore individual show failure
    }
  }

  // 2. Discover new digital/streaming movies: TMDB if key configured, else keyless iTunes RSS/Lookup
  let addedMovies = 0;
  if (apiKey) {
    const from = todayYmd(-3);
    const to = todayYmd(45);
    const cutoff = addDaysYmd(todayYmd(), -540);
    const [disc, existingMvRes] = await Promise.all([
      tmdb.discoverMovies(apiKey, from, to, cutoff, 1, rules.releaseTypes || "4|5|6").catch(() => null),
      db.prepare("SELECT id FROM movies WHERE hidden = 0").all<{ id: number }>(),
    ]);
    const trackedMovieIds = new Set((existingMvRes.results || []).map((r) => Number(r.id)));
    for (const r of ((disc && disc.results) || []).slice(0, 12)) {
      if (addedMovies >= 3) break;
      const mid = Number(r.id);
      if (!mid || hiddenSets.movie.has(mid) || trackedMovieIds.has(mid)) continue;
      try {
        await addMovie(db, apiKey, mid, "auto-bimonthly");
        trackedMovieIds.add(mid);
        addedMovies++;
      } catch {
        // ignore individual movie failure
      }
    }
  } else {
    const mvSync = await getKv<{ lastAt?: number }>(db, "keyless_movie_sync", {});
    const stale = !mvSync.lastAt || Date.now() - mvSync.lastAt >= 12 * 3600_000;
    if (forceMovies || stale) {
      const [{ results: existingRows }, wikiFeed] = await Promise.all([
        db.prepare("SELECT id, name FROM movies").all<{ id: number; name: string }>(),
        itunes.fetchUpcomingWikiMovies({ allDates: false, limit: 24 }).catch(() => []),
      ]);
      const trackedIds = new Set((existingRows || []).map((x) => Number(x.id)));
      const trackedTitles = new Set((existingRows || []).map((x) => itunes.normalizeMovieTitle(x.name)));
      const cap = Math.min(4, maxAdd);

      for (const cand of wikiFeed) {
        if (addedMovies >= cap) break;
        const norm = itunes.normalizeMovieTitle(cand.name);
        if (!norm || trackedTitles.has(norm)) continue;
        try {
          const rich = await itunes.resolveWikiMovieToSlim(cand);
          if (!rich || !rich.id || hiddenSets.movie.has(rich.id) || trackedIds.has(rich.id)) continue;
          await upsertMovieRecord(db, rich, { id: rich.id, source: "auto-bimonthly", addedAt: Date.now() }, { hiddenFlag: 0 });
          trackedIds.add(rich.id);
          trackedTitles.add(norm);
          addedMovies++;
        } catch {
          // ignore individual keyless movie failure
        }
      }
      await setKv(db, "keyless_movie_sync", { lastAt: Date.now(), country: "wiki-imdb" });
    }
  }

  const totalAdded = addedShows + addedMovies;
  const now = Date.now();
  if (totalAdded > 0 || !cfg.lastRun || now - Number(cfg.lastRun) > 6 * 3600_000) {
    await setDiscoveryConfig(db, { lastRun: now, lastAdded: totalAdded });
  }
  return { enabled: cfg.enabled, rules, lastRun: now, lastAdded: totalAdded, addedShows, addedMovies };
}

export async function exportMoviesBackup(db: D1Database) {
  const { results } = await db.prepare("SELECT record_json FROM movies WHERE hidden = 0").all<{ record_json: string }>();
  return (results || []).map((r) => safeJsonParse<MovieRecord>(r.record_json, { id: 0 })).filter((x) => x.id);
}

export async function refreshStaleMoviesStep(db: D1Database, apiKey: string, { force = false, maxCount = 3 }: { force?: boolean; maxCount?: number } = {}) {
  const cutoff = force ? Date.now() - 5 * 60_000 : Date.now() - 24 * 60 * 60_000;
  const { results } = await db
    .prepare(
      apiKey
        ? "SELECT id, record_json FROM movies WHERE hidden = 0 AND updated_at < ?1 ORDER BY updated_at ASC LIMIT ?2"
        : "SELECT id, record_json FROM movies WHERE hidden = 0 AND updated_at < ?1 AND id >= ?3 ORDER BY updated_at ASC LIMIT ?2"
    )
    .bind(...(apiKey ? [cutoff, maxCount] : [cutoff, maxCount, itunes.ITUNES_ID_MIN]))
    .all<{ id: number; record_json: string }>();
  let refreshed = 0;
  for (const r of results || []) {
    const rec = safeJsonParse<MovieRecord>(r.record_json, { id: r.id });
    if (r.id >= itunes.ITUNES_ID_MIN) {
      const fresh = await itunes.lookupMovie(r.id).catch(() => null);
      if (!fresh) continue;
      await upsertMovieRecord(db, fresh, rec, { hiddenFlag: 0 });
      refreshed++;
    } else if (apiKey) {
      const full = await tmdb.fetchMovieFull(apiKey, r.id).catch(() => null);
      if (!full) continue;
      await upsertMovieRecord(db, full.movie, rec, { hiddenFlag: 0 });
      refreshed++;
    }
  }
  return { refreshed };
}
