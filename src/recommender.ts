import * as tvmaze from "./tvmaze";
import * as tmdb from "./tmdb";
import * as itunes from "./itunes";
import * as state from "./state";
import * as store from "./store";
import * as movies from "./movies";
import * as wiki from "./wiki";
import * as wp from "./wordpool";
import { getKv, setKv, runChunkedBatch, safeJsonParse, todayYmd, l1Cached, l1Invalidate } from "./db";

const POOL_TTL = 24 * 60 * 60 * 1000;

export const TEXT_THEMES: Record<string, string[]> = {
  "time travel": ["time travel", "time loop", "temporal", "paradox", "timeline"],
  cyberpunk: ["cyberpunk", "hacker", "virtual reality", "cyberspace", "dystopian", "megacorp"],
  "ai & robots": ["artificial intelligence", "android", "robot", "cyborg", "sentient machine"],
  space: ["spacecraft", "starship", "galaxy", "astronaut", "colonize", "extraterrestrial", "space station"],
  heist: ["heist", "robbery", "con artist", "capers", "master thief", "burglary"],
  espionage: ["espionage", "secret agent", "cia", "mi6", "undercover", "spy", "covert", "intelligence agency"],
  detective: ["detective", "murder", "homicide", "forensic", "serial killer", "cold case", "investigator"],
  legal: ["lawyer", "attorney", "courtroom", "law firm", "prosecutor", "verdict", "trial"],
  medical: ["hospital", "surgeon", "doctor", "medical", "emergency room", "clinic", "patient"],
  supernatural: ["supernatural", "ghost", "vampire", "witch", "demon", "haunted", "occult", "paranormal"],
  superhero: ["superhero", "superpower", "vigilante", "mutant", "masked hero"],
  "post-apocalyptic": ["apocalypse", "post-apocalyptic", "survivor", "outbreak", "pandemic", "wasteland", "zombie"],
  "political intrigue": ["president", "parliament", "white house", "conspiracy", "senator", "election", "corrupt"],
  "dark comedy": ["dark comedy", "dysfunctional", "satire", "absurd"],
  "coming of age": ["high school", "teenager", "coming of age", "college", "adolescence"],
  "workplace": ["office", "workplace", "startup", "boss", "employees"],
  "historical period": ["19th century", "victorian", "medieval", "world war", "ancient", "tudor", "dynasty"],
  survival: ["stranded", "wilderness", "shipwreck", "survival", "desert island"],
  mythology: ["mythology", "gods", "legend", "prophecy", "curse", "realm"],
  psychological: ["psychological", "amnesia", "trauma", "mind", "hallucination", "obsession"],
};

export function normalizeTextThemes(text: unknown): string[] {
  const clean = wp.stripHtml(text).toLowerCase();
  if (!clean) return [];
  const hits: string[] = [];
  for (const [theme, kws] of Object.entries(TEXT_THEMES)) {
    for (const kw of kws) {
      if (clean.includes(kw)) {
        hits.push(theme);
        break;
      }
    }
  }
  return hits;
}

export interface TasteState {
  feedback: { show: Record<string, any>; movie: Record<string, any> };
  overrides: { boost: string[]; mute: string[] };
  crosswalk: Record<string, number>;
  poolUpdatedAt: number | null;
  tmdbEnabled: boolean;
  job: { running: boolean; phase: string; done: number; total: number; lastRun: number | null; error: string | null };
}

const DEFAULT_TASTE: TasteState = {
  feedback: { show: {}, movie: {} },
  overrides: { boost: [], mute: [] },
  crosswalk: {},
  poolUpdatedAt: null,
  tmdbEnabled: false,
  job: { running: false, phase: "idle", done: 0, total: 0, lastRun: null, error: null },
};

export async function getTasteState(db: D1Database): Promise<TasteState> {
  return await l1Cached("taste:state", 60_000, async () => {
    const saved = await getKv<Partial<TasteState>>(db, "taste_state", {});
    return {
      feedback: {
        show: (saved.feedback && saved.feedback.show) || {},
        movie: (saved.feedback && saved.feedback.movie) || {},
      },
      overrides: {
        boost: (saved.overrides && saved.overrides.boost) || [],
        mute: (saved.overrides && saved.overrides.mute) || [],
      },
      crosswalk: saved.crosswalk || {},
      poolUpdatedAt: saved.poolUpdatedAt || null,
      tmdbEnabled: Boolean(saved.tmdbEnabled),
      job: { ...DEFAULT_TASTE.job, ...(saved.job || {}) },
    };
  });
}

export async function saveTasteState(db: D1Database, ts: TasteState) {
  await setKv(db, "taste_state", ts);
  l1Invalidate("taste:state");
}

export async function readItemCache(db: D1Database, cacheKey: string): Promise<any | null> {
  const row = await db.prepare("SELECT data_json FROM item_cache WHERE cache_key = ?1").bind(cacheKey).first<{ data_json: string }>();
  return row ? safeJsonParse(row.data_json, null) : null;
}

export async function writeItemCache(db: D1Database, cacheKey: string, kind: string, data: any) {
  await db
    .prepare(
      `INSERT INTO item_cache (cache_key, kind, data_json, fetched_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(cache_key) DO UPDATE SET kind=excluded.kind, data_json=excluded.data_json, fetched_at=excluded.fetched_at`
    )
    .bind(cacheKey, kind, JSON.stringify(data), Date.now())
    .run();
  l1Invalidate("taste:itemCache");
}

function getEraBucket(premiered: string | null | undefined): string | null {
  const yr = Number(String(premiered || "").slice(0, 4));
  if (!Number.isFinite(yr) || yr < 1920) return null;
  if (yr < 1990) return "classic (<1990)";
  if (yr < 2010) return "1990s-2000s";
  if (yr < 2020) return "2010s";
  return "2020s+";
}

function displayLabel(key: string): string {
  const idx = key.indexOf(":");
  const kind = key.slice(0, idx);
  const val = key.slice(idx + 1);
  if (kind === "lang") return `${val} language`;
  if (kind === "type") return `${val} format`;
  if (kind === "creator") return `Creator · ${val}`;
  if (kind === "studio") return `Studio · ${val}`;
  if (kind === "era") return `Era · ${val}`;
  return val.replace(/\b\w/g, (m) => m.toUpperCase());
}

function candidateKeys(c: any): string[] {
  const out: string[] = [];
  for (const g of c.genres || []) out.push(`genre:${String(g).toLowerCase()}`);
  for (const kw of c.keywords || []) out.push(`kw:${String(typeof kw === "string" ? kw : kw.name).toLowerCase()}`);
  for (const th of normalizeTextThemes(`${c.name || ""} ${c.summary || ""}`)) out.push(`theme:${th}`);
  for (const cr of (c.creators || []).slice(0, 3)) out.push(`creator:${String(typeof cr === "string" ? cr : cr.name).toLowerCase()}`);
  for (const ca of (c.cast || []).slice(0, 4)) out.push(`actor:${String(typeof ca === "string" ? ca : ca.name).toLowerCase()}`);
  for (const st of (c.studios || []).slice(0, 2)) out.push(`studio:${String(st).toLowerCase()}`);
  if (c.language) out.push(`lang:${String(c.language).toLowerCase()}`);
  if (c.type) out.push(`type:${String(c.type).toLowerCase()}`);
  const era = getEraBucket(c.premiered);
  if (era) out.push(`era:${era}`);
  return [...new Set(out)];
}

export async function buildProfile(db: D1Database, apiKey = "") {
  const [showsList, moviesList, hiddenSets, watchedSets, ts, appSettings] = await Promise.all([
    store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
    movies.listMovies(db, { includeHidden: false }),
    state.loadHiddenSets(db),
    state.getWatchedSets(db),
    getTasteState(db),
    state.getRawSettings(db),
  ]);

  const cacheMap = await l1Cached("taste:itemCache", 120_000, async () => {
    const { results: cacheRows } = await db
      .prepare("SELECT cache_key, data_json FROM item_cache LIMIT 250")
      .all<{ cache_key: string; data_json: string }>();
    const m = new Map<string, any>();
    for (const r of cacheRows || []) m.set(r.cache_key, safeJsonParse(r.data_json, null));
    return m;
  });

  const weights = new Map<string, number>();
  const bump = (key: string, w: number) => {
    if (!key) return;
    weights.set(key, (weights.get(key) || 0) + w);
  };

  let positiveCount = 0;
  let negativeCount = 0;
  const anchors: any[] = [];

  for (const s of showsList) {
    const isFav = Boolean(s.favorite);
    const fb = ts.feedback.show[String(s.id)];
    const mult = isFav ? 3.2 : fb?.action === "liked" ? 2.4 : s.source === "search" ? 1.8 : 1.0;
    if (isFav || s.source === "search" || fb?.action === "liked") positiveCount++;
    const deep = cacheMap.get(`tv_${s.id}`);
    const merged = { ...s, ...(deep || {}) };
    for (const k of candidateKeys(merged)) bump(k, mult);
    anchors.push({
      key: `show:${s.id}`,
      kind: "show",
      tvmazeId: s.id,
      tmdbId: ts.crosswalk[`tv:${s.id}`] || (deep && deep.tmdbId) || null,
      name: s.name,
      favorite: isFav,
      traits: candidateKeys(merged),
      score: mult,
    });
  }

  for (const m of moviesList) {
    const isFav = Boolean(m.favorite);
    const fb = ts.feedback.movie[String(m.id)];
    const mult = isFav ? 3.2 : fb?.action === "liked" ? 2.4 : m.source === "search" ? 1.8 : 1.0;
    if (isFav || m.source === "search" || fb?.action === "liked") positiveCount++;
    const deep = cacheMap.get(`tmdb_movie_${m.id}`);
    const merged = { ...m, ...(deep || {}), kind: "movie" };
    for (const k of candidateKeys(merged)) bump(k, mult);
    anchors.push({
      key: `movie:${m.id}`,
      kind: "movie",
      tmdbId: m.id,
      name: m.name,
      favorite: isFav,
      traits: candidateKeys(merged),
      score: mult,
    });
  }

  for (const h of hiddenSets.items.slice(0, 80)) {
    negativeCount++;
    const rec = h.record || {};
    for (const g of rec.genres || []) bump(`genre:${String(g).toLowerCase()}`, -0.9);
  }

  for (const fb of [...Object.values(ts.feedback.show), ...Object.values(ts.feedback.movie)]) {
    if (!fb || !fb.action) continue;
    if (fb.action === "dislike") {
      negativeCount++;
      for (const k of candidateKeys(fb)) bump(k, -2.1);
    } else if (fb.action === "seen") {
      positiveCount++;
      for (const k of candidateKeys(fb)) bump(k, 1.4);
    }
  }

  for (const g of appSettings.interests || []) bump(`genre:${String(g).toLowerCase()}`, 1.8);
  for (const bk of ts.overrides.boost) bump(bk, 5.5);
  for (const mk of ts.overrides.mute) bump(mk, -6.5);

  const sortedTraits = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const loves = sortedTraits
    .filter(([, w]) => w > 1.2)
    .slice(0, 14)
    .map(([key, weight]) => ({ key, label: displayLabel(key), weight: Math.round(weight * 10) / 10 }));
  const avoids = sortedTraits
    .filter(([, w]) => w < -1.0)
    .reverse()
    .slice(0, 8)
    .map(([key, weight]) => ({ key, label: displayLabel(key), weight: Math.round(weight * 10) / 10 }));

  anchors.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.score - a.score);
  const signalCount = showsList.length + moviesList.length + Object.keys(ts.feedback.show).length + Object.keys(ts.feedback.movie).length;
  const confidence = Math.min(100, Math.round(Math.min(1, positiveCount / 10) * 65 + Math.min(1, negativeCount / 12) * 35));

  return {
    weights,
    loves,
    avoids,
    anchors: anchors.slice(0, 24),
    signalCount,
    positiveCount,
    negativeCount,
    watchedCount: watchedSets.episodes.size + watchedSets.movies.size,
    confidence,
    coldStart: signalCount < 3,
    tmdbEnabled: Boolean(apiKey),
  };
}

export async function getPoolItems(db: D1Database): Promise<any[]> {
  return await l1Cached("taste:pool", 90_000, async () => {
    const { results } = await db
      .prepare("SELECT data_json FROM taste_items WHERE kind IN ('show', 'movie') ORDER BY score DESC LIMIT 300")
      .all<{ data_json: string }>();
    return (results || []).map((r) => safeJsonParse(r.data_json, null)).filter(Boolean);
  });
}

export async function getRecommendations(
  db: D1Database,
  {
    apiKey = "",
    media = "all",
    lens = "mix",
    anchorKey = "",
    limit = 36,
  }: { apiKey?: string; media?: string; lens?: string; anchorKey?: string; limit?: number } = {}
) {
  const [profile, ts, hiddenSets, showsList, moviesList, poolItems, wpEntries] = await Promise.all([
    buildProfile(db, apiKey),
    getTasteState(db),
    state.loadHiddenSets(db),
    store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
    movies.listMovies(db, { includeHidden: false }),
    getPoolItems(db),
    wp.loadEntries(db),
  ]);

  const activeShowIds = new Set(showsList.map((s) => Number(s.id)));
  const activeMovieIds = new Set(moviesList.map((m) => Number(m.id)));
  const activeNames = new Set([...showsList, ...moviesList].map((x) => String(x.name || "").trim().toLowerCase()));
  const hiddenNames = new Set(hiddenSets.items.map((x) => String(x.name || "").trim().toLowerCase()));
  const feedbackShowIds = new Set(Object.keys(ts.feedback.show));
  const feedbackMovieIds = new Set(Object.keys(ts.feedback.movie));

  const anchor = anchorKey ? profile.anchors.find((a) => a.key === anchorKey) || null : null;
  const anchorTraitSet = anchor ? new Set<string>(anchor.traits || []) : null;
  const today = todayYmd();
  const wpActive = wpEntries.some((e) => e.enabled);
  const wpMap = new Map<string, wp.WordPoolResult>();

  let workingPool = poolItems;
  if (lens === "upcoming") {
    const existingUpcoming = workingPool.filter((c) => c && ((c.upcomingDate && c.upcomingDate >= today) || (c.premiered && c.premiered >= today))).length;
    if (existingUpcoming < 10) {
      const [schedWeb, schedTv, wikiUpcoming] = await Promise.all([
        media === "movie" ? Promise.resolve([]) : tvmaze.fetchSchedule(todayYmd(3), true).catch(() => []),
        media === "movie" ? Promise.resolve([]) : tvmaze.fetchSchedule(todayYmd(1), false).catch(() => []),
        media === "show" ? Promise.resolve([]) : itunes.fetchUpcomingWikiMovies({ allDates: false, limit: 12 }).catch(() => []),
      ]);
      const extra: any[] = [];
      const seenKeys = new Set(workingPool.map((c) => c?.key).filter(Boolean));
      for (const ep of [...schedWeb, ...schedTv]) {
        const rawShow = ep?._embedded?.show || ep?.show;
        if (!rawShow || !rawShow.id) continue;
        const s = tvmaze.slimShow(rawShow);
        const key = `tvmaze:${s.id}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        extra.push({
          key,
          kind: "show",
          id: s.id,
          tvmazeId: s.id,
          imdbId: s.externals?.imdb || null,
          name: s.name,
          poster: s.poster,
          backdrop: s.background,
          premiered: s.premiered,
          upcomingDate: ep.airdate || todayYmd(2),
          status: s.status || "Running",
          language: s.language,
          type: s.type,
          genres: s.genres || [],
          rating: s.rating,
          popularity: s.weight || 80,
          summary: wp.stripHtml(s.summary).slice(0, 320),
          channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
          keywords: [],
          creators: [],
          cast: [],
        });
        if (extra.length >= 28) break;
      }
      for (const wm of wikiUpcoming.slice(0, 10)) {
        const key = `wiki:movie:${itunes.normalizeMovieTitle(wm.name)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        extra.push({
          key,
          kind: "movie",
          id: itunes.IMDB_MOVIE_BASE_ID + extra.length + 1,
          tmdbId: null,
          imdbId: null,
          name: wm.name,
          poster: null,
          premiered: wm.releaseDate || today,
          upcomingDate: wm.releaseDate || today,
          genres: [],
          rating: null,
          popularity: 95,
          summary: wm.cast ? `Starring ${wm.cast}` : "",
          channelName: wm.studio || "Theatrical",
          keywords: [],
          creators: [],
          cast: [],
        });
      }
      if (extra.length) workingPool = [...extra, ...workingPool];
    }
  }

  const filtered = workingPool.filter((c) => {
    if (!c || !c.name) return false;
    const isMv = c.kind === "movie";
    const nm = String(c.name).trim().toLowerCase();
    if (isMv) {
      if (hiddenSets.movie.has(Number(c.tmdbId || c.id))) return false;
      if (activeMovieIds.has(Number(c.tmdbId || c.id))) return false;
      if (feedbackMovieIds.has(String(c.tmdbId || c.id))) return false;
    } else {
      if (c.tvmazeId && (hiddenSets.show.has(Number(c.tvmazeId)) || activeShowIds.has(Number(c.tvmazeId)) || feedbackShowIds.has(String(c.tvmazeId)))) return false;
      if (activeNames.has(nm) || hiddenNames.has(nm)) return false;
    }
    if (media === "show" && isMv) return false;
    if (media === "movie" && !isMv) return false;

    let wpHit: wp.WordPoolResult | null = null;
    if (wpActive) {
      wpHit = wp.matchItemWithEntries(wpEntries, c);
      if (wpHit.excluded) return false;
      if (wpHit.primary || wpHit.fuzzy) wpMap.set(c.key, wpHit);
    }
    if (wpHit && wpHit.primary) return true;

    if (lens === "binge" && !(c.kind === "show" && /ended|canceled/i.test(c.status || ""))) return false;
    if (lens === "upcoming") {
      const up = (c.upcomingDate && c.upcomingDate >= today) || (c.premiered && c.premiered >= today);
      if (!up) return false;
    }
    if (lens === "gems") {
      const isMegahit = (c.popularity || 0) > 180 || (c.voteCount || 0) > 7000;
      if (isMegahit || ((c.rating || 0) > 0 && c.rating < 7.2)) return false;
    }
    return true;
  });

  const scored = filtered
    .map((c) => {
      const keys = candidateKeys(c);
      let rawScore = c.rating ? (Number(c.rating) - 6.5) * 0.9 : 0;
      const reasons: string[] = [];
      const matchedTraits: Array<{ key: string; label: string; weight: number }> = [];
      for (const k of keys) {
        const w = profile.weights.get(k) || 0;
        if (Math.abs(w) < 0.35) continue;
        rawScore += w;
        if (anchorTraitSet && anchorTraitSet.has(k)) rawScore += 2.2;
        if (w > 1.0) {
          matchedTraits.push({ key: k, label: displayLabel(k), weight: w });
        }
      }
      matchedTraits.sort((a, b) => b.weight - a.weight);
      if (anchor) reasons.push(`Similar vibe to ${anchor.name}`);
      if (matchedTraits.length) {
        reasons.push(`Matches: ${matchedTraits.slice(0, 3).map((t) => t.label).join(" · ")}`);
      } else if (c.rating) {
        reasons.push(`Highly rated (${c.rating}★)`);
      }

      const wpHit = wpMap.get(c.key) || null;
      if (wpHit && wpHit.primary) {
        const terms = [...new Set(wpHit.primaryMatches.map((m) => m.term))];
        rawScore = Math.max(rawScore, 0) + 28 + (wpHit.primaryMatches[0]?.weight || 5) * 2;
        reasons.unshift(`★ Primary strict override: ${terms.join(", ")}`);
      } else if (wpHit && wpHit.fuzzy) {
        const terms = [...new Set(wpHit.fuzzyMatches.map((m) => m.term))];
        rawScore += 3.4 + (wpHit.fuzzyMatches[0]?.weight || 2) * 2;
        reasons.unshift(`Fuzzy Match: ${terms.join(", ")}`);
      }

      return {
        ...c,
        rawScore,
        reasons: reasons.slice(0, 4),
        matchedTraits: matchedTraits.slice(0, 4),
        ...(wpHit && (wpHit.primary || wpHit.fuzzy)
          ? { wordPool: wpHit, primaryOverride: Boolean(wpHit.primary), fuzzyMatch: Boolean(wpHit.fuzzy) }
          : {}),
      };
    })
    .sort((a, b) => Number(Boolean(b.primaryOverride)) - Number(Boolean(a.primaryOverride)) || b.rawScore - a.rawScore);

  const nonPrimary = scored.filter((c) => !c.primaryOverride);
  const maxS = nonPrimary[0] ? Math.max(2, nonPrimary[0].rawScore) : 8;
  const minS = scored.length ? Math.min(0, scored[scored.length - 1].rawScore) : 0;
  const span = Math.max(2.5, maxS - minS);

  const items = scored.slice(0, limit).map((c) => ({
    ...c,
    matchPct: c.primaryOverride ? 100 : Math.round(62 + Math.max(0, Math.min(1, (c.rawScore - minS) / span)) * 36),
  }));

  return {
    items,
    poolCount: poolItems.length,
    poolUpdatedAt: ts.poolUpdatedAt,
    poolStale: !ts.poolUpdatedAt || Date.now() - ts.poolUpdatedAt > POOL_TTL || ts.tmdbEnabled !== Boolean(apiKey),
    profile: {
      coldStart: profile.coldStart,
      confidence: profile.confidence,
      signalCount: profile.signalCount,
      positiveCount: profile.positiveCount,
      negativeCount: profile.negativeCount,
      tmdbEnabled: Boolean(apiKey),
      loves: profile.loves,
      avoids: profile.avoids,
      anchors: profile.anchors.map((a) => ({ key: a.key, kind: a.kind, name: a.name, favorite: Boolean(a.favorite) })),
    },
  };
}

/**
 * Bounded single-request Deep Scan for Cloudflare Free Tier (10 ms CPU & <= 50 subrequests).
 * Fetches fresh TVmaze catalog + trending/discover TMDB items + enriches up to 4 anchors in D1.
 */
export async function runDeepScan(db: D1Database, apiKey = "", { force = false }: { force?: boolean } = {}) {
  const ts = await getTasteState(db);
  if (!force && ts.poolUpdatedAt && ts.job?.done > 0 && Date.now() - ts.poolUpdatedAt < POOL_TTL) {
    return { ...ts.job, cached: true };
  }

  const [hiddenSets, showsList, moviesList] = await Promise.all([
    state.loadHiddenSets(db),
    store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
    movies.listMovies(db, { includeHidden: false }),
  ]);

  const activeShowIds = new Set(showsList.map((s) => Number(s.id)));
  const activeMovieIds = new Set(moviesList.map((m) => Number(m.id)));
  const activeMovieTitles = new Set(moviesList.map((m) => itunes.normalizeMovieTitle(m.name)));
  const collected = new Map<string, any>();

  // 1. TVmaze curated pages rotating across pages 0..15
  const pageOffset = Math.floor(Date.now() / (6 * 60 * 60_000)) % 16;
  const pageRows = await tvmaze.fetchShowsPage(pageOffset).catch(() => []);
  for (const s of pageRows) {
    if (!s || !s.id || activeShowIds.has(s.id) || hiddenSets.show.has(s.id)) continue;
    if ((s.weight || 0) < 45 && (s.rating || 0) < 7.0) continue;
    const key = `tvmaze:${s.id}`;
    collected.set(key, {
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
    });
    if (collected.size >= 140) break;
  }

  // 1b. Blend upcoming TV schedule items so Discover "Airing Soon" stays populated
  const schedRows = await tvmaze.fetchSchedule(todayYmd(5), true).catch(() => []);
  let schedAdded = 0;
  for (const ep of schedRows) {
    if (schedAdded >= 24) break;
    const rawShow = ep?._embedded?.show || ep?.show;
    if (!rawShow || !rawShow.id) continue;
    const s = tvmaze.slimShow(rawShow);
    if (activeShowIds.has(s.id) || hiddenSets.show.has(s.id)) continue;
    const key = `tvmaze:${s.id}`;
    const upDate = ep.airdate || todayYmd(5);
    const prev = collected.get(key);
    if (prev) {
      prev.upcomingDate = upDate;
      continue;
    }
    schedAdded++;
    collected.set(key, {
      key,
      kind: "show",
      id: s.id,
      tvmazeId: s.id,
      imdbId: s.externals?.imdb || null,
      name: s.name,
      poster: s.poster,
      backdrop: s.background,
      premiered: s.premiered,
      upcomingDate: upDate,
      status: s.status,
      language: s.language,
      type: s.type,
      genres: s.genres || [],
      rating: s.rating,
      popularity: Math.max(85, s.weight || 0),
      summary: wp.stripHtml(s.summary).slice(0, 320),
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      keywords: [],
      creators: [],
      cast: [],
    });
  }

  // 2. Movie pool: keyless Wikipedia + IMDb Suggest resolution when no TMDB key is configured
  if (!apiKey) {
    const wikiFeed = await itunes.fetchUpcomingWikiMovies({ allDates: true, limit: 16 }).catch(() => []);
    let mvAdded = 0;
    for (const [idx, entry] of wikiFeed.entries()) {
      if (mvAdded >= 8) break;
      const norm = itunes.normalizeMovieTitle(entry.name);
      if (!norm || activeMovieTitles.has(norm)) continue;
      const c = await itunes.resolveWikiMovieToSlim(entry).catch(() => null);
      if (!c || !c.id || activeMovieIds.has(c.id) || hiddenSets.movie.has(c.id)) continue;
      const key = `imdb:movie:${c.imdbId || c.id}`;
      if (collected.has(key)) continue;
      activeMovieTitles.add(norm);
      mvAdded++;
      collected.set(key, {
        key,
        kind: "movie",
        id: c.id,
        tmdbId: null,
        imdbId: c.imdbId || null,
        name: c.name,
        poster: c.poster,
        backdrop: c.background,
        premiered: c.premiered,
        upcomingDate: c.airdate || c.premiered || entry.releaseDate || null,
        language: c.language,
        genres: c.genres || [],
        rating: c.rating,
        popularity: Math.max(105, 148 - idx),
        summary: wp.stripHtml(c.summary).slice(0, 320),
        channelName: c.channelName || "Theatrical",
        keywords: [],
        creators: [],
        cast: [],
      });
    }
  }

  // 2. TMDB trending + movie discovery + up to 3 deep anchor enrichments if API key present
  if (apiKey) {
    const trending = await tmdb.fetchTrending(apiKey, "all").catch(() => []);
    for (const c of trending) {
      if (!c || !c.tmdbId) continue;
      if (c.kind === "movie" && (activeMovieIds.has(c.tmdbId) || hiddenSets.movie.has(c.tmdbId))) continue;
      const key = `tmdb:${c.kind}:${c.tmdbId}`;
      collected.set(key, {
        key,
        kind: c.kind,
        id: c.tmdbId,
        tmdbId: c.tmdbId,
        name: c.name,
        poster: c.poster,
        backdrop: c.backdrop,
        premiered: c.premiered,
        language: c.language,
        genres: c.genres || [],
        rating: c.rating,
        voteCount: c.voteCount,
        popularity: c.popularity,
        summary: wp.stripHtml(c.summary).slice(0, 320),
        keywords: [],
        creators: [],
        cast: [],
      });
    }

    // Enrich top 2 uncached tracked shows or movies for deeper cast/keyword signals
    let enrichCount = 0;
    for (const s of showsList.slice(0, 12)) {
      if (enrichCount >= 2) break;
      const cached = await readItemCache(db, `tv_${s.id}`);
      if (cached) continue;
      const tid = await tmdb.findTvByExternal(apiKey, { imdb: s.externals?.imdb || null, name: s.name, year: s.premiered || "" }).catch(() => null);
      if (tid) {
        const deep = await tmdb.fetchDeepProfile(apiKey, "show", tid).catch(() => null);
        if (deep) {
          ts.crosswalk[`tv:${s.id}`] = tid;
          await writeItemCache(db, `tv_${s.id}`, "show", deep);
          await writeItemCache(db, `tmdb_tv_${tid}`, "show", deep);
          for (const r of (deep.recommendations || []).slice(0, 8)) {
            if (!r.tmdbId) continue;
            const rk = `tmdb:${r.kind}:${r.tmdbId}`;
            if (!collected.has(rk)) collected.set(rk, { ...r, key: rk, id: r.tmdbId });
          }
          enrichCount++;
        }
      }
    }
  }

  const now = Date.now();
  const { results: existingTaste } = await db
    .prepare("SELECT item_key, score, data_json FROM taste_items WHERE kind IN ('show', 'movie')")
    .all<{ item_key: string; score: number; data_json: string }>();
  const existingMap = new Map<string, { score: number; data_json: string }>();
  for (const r of existingTaste || []) {
    existingMap.set(r.item_key, { score: Number(r.score || 0), data_json: r.data_json });
  }

  const stmts: D1PreparedStatement[] = [];
  let newKeysAdded = 0;
  for (const cand of collected.values()) {
    const score = Number(cand.popularity || cand.rating || 0);
    const json = JSON.stringify(cand);
    const prev = existingMap.get(cand.key);
    if (prev && prev.score === score && prev.data_json === json) {
      continue;
    }
    if (!prev) newKeysAdded++;
    stmts.push(
      db
        .prepare(
          `INSERT INTO taste_items (item_key, kind, id, score, data_json, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(item_key) DO UPDATE SET score=excluded.score, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(cand.key, cand.kind === "movie" ? "movie" : "show", Number(cand.id) || 0, score, json, now)
    );
  }
  await runChunkedBatch(db, stmts);
  // Only prune Discover pool when total size actually exceeds 320
  if (existingMap.size + newKeysAdded > 320) {
    await db
      .prepare(
        "DELETE FROM taste_items WHERE kind IN ('show', 'movie') AND item_key NOT IN (SELECT item_key FROM taste_items WHERE kind IN ('show', 'movie') ORDER BY score DESC, updated_at DESC LIMIT 320)"
      )
      .run();
  }

  ts.poolUpdatedAt = now;
  ts.tmdbEnabled = Boolean(apiKey);
  ts.job = { running: false, phase: "ready", done: collected.size, total: collected.size, lastRun: now, error: null };
  await saveTasteState(db, ts);
  l1Invalidate("taste:");
  return ts.job;
}

export async function recordFeedback(
  db: D1Database,
  apiKey: string,
  {
    kind = "show",
    id,
    tvmazeId = null,
    tmdbId = null,
    imdbId = null,
    action,
    item = null,
  }: { kind?: string; id: number | string; tvmazeId?: number | null; tmdbId?: number | null; imdbId?: string | null; action: string; item?: any }
) {
  const k = kind === "movie" ? "movie" : "show";
  const ts = await getTasteState(db);
  const fbKey = String(tvmazeId || (k === "movie" ? tmdbId : id) || (tmdbId ? `tmdb_${tmdbId}` : id));

  if (action === "clear") {
    delete ts.feedback[k][fbKey];
    await saveTasteState(db, ts);
    return { ok: true };
  }

  if (action === "track") {
    let addedItem: any = null;
    if (k === "movie") {
      const mId = Number(tmdbId || id);
      if (!mId) throw new Error("Missing TMDB movie ID");
      addedItem = await movies.addMovie(db, apiKey, mId, "discover");
    } else {
      let sId = Number(tvmazeId);
      if (!sId) {
        const resolved = await tvmaze.resolveShow({
          imdbId: imdbId || item?.imdbId || null,
          name: item?.name || "",
          year: item?.premiered || "",
        });
        if (!resolved || !resolved.id) throw new Error(`Could not locate "${item?.name || "show"}" on TVmaze`);
        sId = resolved.id;
      }
      addedItem = await store.addShow(db, sId, "discover");
    }
    if (addedItem) {
      ts.feedback[k][String(addedItem.id)] = {
        action: "liked",
        name: addedItem.name,
        tvmazeId: k === "show" ? addedItem.id : null,
        tmdbId: k === "movie" ? addedItem.id : tmdbId || null,
        genres: addedItem.genres || item?.genres || [],
        poster: addedItem.poster || item?.poster || null,
        at: Date.now(),
      };
      await saveTasteState(db, ts);
    }
    return { ok: true, item: addedItem };
  }

  if (!["liked", "seen", "dislike"].includes(action)) throw new Error("Invalid feedback action");
  const record = {
    action,
    name: item?.name || `${k} #${fbKey}`,
    tvmazeId: tvmazeId ? Number(tvmazeId) : null,
    tmdbId: tmdbId ? Number(tmdbId) : null,
    imdbId: imdbId || item?.imdbId || null,
    genres: item?.genres || [],
    type: item?.type || null,
    language: item?.language || null,
    network: item?.channelName || item?.network?.name || null,
    poster: item?.poster || null,
    rating: item?.rating || null,
    premiered: item?.premiered || null,
    summary: wp.stripHtml(item?.summary || "").slice(0, 320),
    at: Date.now(),
  };
  ts.feedback[k][fbKey] = record;

  if (action === "dislike") {
    const hideId = k === "movie" ? Number(tmdbId || id) : Number(tvmazeId);
    if (hideId) {
      await state.addHiddenEntry(db, {
        id: hideId,
        kind: k,
        name: record.name,
        poster: record.poster,
        channelName: record.network,
        channelKind: k === "movie" ? "stream" : "tv",
        premiered: record.premiered,
        record: { id: hideId, source: "discover", addedAt: Date.now() },
      });
    }
  }
  await saveTasteState(db, ts);
  return { ok: true };
}

export async function updateTraitOverrides(db: D1Database, { boost, mute, reset }: { boost?: string[]; mute?: string[]; reset?: boolean } = {}) {
  const ts = await getTasteState(db);
  if (reset) {
    ts.overrides = { boost: [], mute: [] };
  } else {
    if (Array.isArray(boost)) ts.overrides.boost = boost.map(String).slice(0, 30);
    if (Array.isArray(mute)) ts.overrides.mute = mute.map(String).slice(0, 30);
  }
  await saveTasteState(db, ts);
  return ts.overrides;
}

export async function buildStarterSeeds(db: D1Database, apiKey = "") {
  const trending = apiKey ? await tmdb.fetchTrending(apiKey, "all").catch(() => []) : [];
  if (trending.length) return trending.slice(0, 12);
  const page = await tvmaze.fetchShowsPage(0).catch(() => []);
  return page.slice(0, 12).map((s) => ({
    kind: "show",
    tvmazeId: s.id,
    id: s.id,
    name: s.name,
    poster: s.poster,
    genres: s.genres,
    rating: s.rating,
    premiered: s.premiered,
    summary: wp.stripHtml(s.summary).slice(0, 220),
  }));
}

export async function exportTasteBackup(db: D1Database) {
  const ts = await getTasteState(db);
  return { feedback: ts.feedback, overrides: ts.overrides, crosswalk: ts.crosswalk };
}

export async function importTasteBackup(db: D1Database, raw: any = {}, { replace = false } = {}) {
  const cur = await getTasteState(db);
  if (replace) {
    cur.feedback = { show: {}, movie: {} };
    cur.overrides = { boost: [], mute: [] };
    cur.crosswalk = {};
  }
  if (raw.feedback && typeof raw.feedback === "object") {
    if (raw.feedback.show) Object.assign(cur.feedback.show, raw.feedback.show);
    if (raw.feedback.movie) Object.assign(cur.feedback.movie, raw.feedback.movie);
  }
  if (raw.overrides) {
    cur.overrides.boost = [...new Set([...cur.overrides.boost, ...(raw.overrides.boost || [])])];
    cur.overrides.mute = [...new Set([...cur.overrides.mute, ...(raw.overrides.mute || [])])];
  }
  if (raw.crosswalk && typeof raw.crosswalk === "object") {
    Object.assign(cur.crosswalk, raw.crosswalk);
  }
  await saveTasteState(db, cur);
}
