import { HttpError } from "./db";

const BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  nl: "Dutch",
  no: "Norwegian",
  sv: "Swedish",
  da: "Danish",
  pl: "Polish",
  ru: "Russian",
  th: "Thai",
  tl: "Tagalog",
  id: "Indonesian",
};

const COUNTRY_PRIORITY = ["US", "GB", "CA", "AU", "IE", "NZ", "DE", "FR", "ES", "BR"];

const TMDB_GENRE_NAMES: Record<number, string> = {
  12: "Adventure",
  14: "Fantasy",
  16: "Animation",
  18: "Drama",
  27: "Horror",
  28: "Action",
  35: "Comedy",
  36: "History",
  37: "Western",
  53: "Thriller",
  80: "Crime",
  99: "Documentary",
  878: "Science-Fiction",
  9648: "Mystery",
  10402: "Music",
  10749: "Romance",
  10751: "Family",
  10752: "War",
  10759: "Action",
  10762: "Family",
  10763: "News",
  10764: "Reality",
  10765: "Science-Fiction",
  10766: "Drama",
  10767: "Talk",
  10768: "War",
  10770: "TV Movie",
};

function cleanProvider(name: string): string {
  if (!name) return "";
  return String(name)
    .replace(/\s+(Standard\s+with\s+Ads|with\s+Ads|Amazon\s+Channel|Apple\s+TV\s+Channel|Premium(\s+Plus)?)$/i, "")
    .replace(/^Amazon\s+Prime\s+Video$/i, "Prime Video")
    .replace(/^Apple\s+TV\+$/i, "Apple TV")
    .replace(/^Apple\s+TV\s+Store$/i, "Apple TV")
    .replace(/^Max$/i, "HBO Max")
    .trim();
}

export async function apiGet<T = any>(
  apiKey: string,
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  { allow404 = false }: { allow404?: boolean } = {}
): Promise<T | null> {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new HttpError(400, "TMDB API key is required — add it in Control Center -> Sync & API Keys", "TMDB_NO_KEY");
  }
  const url = new URL(BASE + path);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.length > 48 || key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 404 && allow404) return null;
      if (!res.ok) {
        throw new HttpError(res.status, `TMDB responded ${res.status} for ${path}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr instanceof HttpError && lastErr.status >= 400 && lastErr.status < 500) throw lastErr;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`TMDB request failed: ${path}`);
}

export async function validateApiKey(key: string) {
  return await apiGet(key, "/configuration");
}

function pickLogo(raw: any): string | null {
  const logos = (raw.images && raw.images.logos) || [];
  if (!logos.length) return null;
  const sorted = [...logos].sort((a: any, b: any) => {
    const la = a.iso_639_1 === "en" ? 2 : a.iso_639_1 ? 0 : 1;
    const lb = b.iso_639_1 === "en" ? 2 : b.iso_639_1 ? 0 : 1;
    return lb - la || (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0);
  });
  return sorted[0].file_path ? `${IMG_BASE}/w500${sorted[0].file_path}` : null;
}

function pickWatchProvider(raw: any): { kind: "stream"; name: string; country: string } | null {
  const results = (raw["watch/providers"] && raw["watch/providers"].results) || {};
  for (const cc of ["US", "GB", "CA", "AU", ...Object.keys(results)]) {
    const entry = results[cc];
    if (!entry) continue;
    if (entry.flatrate && entry.flatrate.length) {
      return { kind: "stream", name: cleanProvider(entry.flatrate[0].provider_name), country: cc };
    }
  }
  return null;
}

function cleanPhysicalLabel(note: string): string {
  const s = String(note || "").trim();
  if (!s) return "Blu-ray / DVD";
  const has4k = /4k|ultra\s*hd|uhd/i.test(s);
  const hasBd = /blu-?ray/i.test(s);
  const hasDvd = /\bdvd\b/i.test(s);
  if (has4k && hasBd) return "4K UHD / Blu-ray";
  if (has4k) return "4K UHD";
  if (hasBd && hasDvd) return "Blu-ray / DVD";
  if (hasBd) return "Blu-ray";
  if (hasDvd) return "DVD";
  return cleanProvider(s.split(/[|,(]/)[0].trim()) || "Physical";
}

function pickRelease(raw: any, preferFrom: string | null = null, preferTo: string | null = null) {
  const byCountry = (raw.release_dates && raw.release_dates.results) || [];
  const candidates: Array<{ country: string; type: number; kind: "stream" | "physical" | "tv"; date: string; note: string }> = [];
  for (const c of byCountry) {
    for (const r of c.release_dates || []) {
      if (r.type !== 4 && r.type !== 5 && r.type !== 6) continue;
      const date = (r.release_date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const kind = r.type === 6 ? "tv" : r.type === 5 ? "physical" : "stream";
      const note =
        kind === "physical"
          ? cleanPhysicalLabel(r.note)
          : cleanProvider((r.note || "").split(/[,/]/)[0].trim());
      candidates.push({ country: c.iso_3166_1, type: r.type, kind, date, note });
    }
  }
  const inWindow = preferFrom && preferTo ? candidates.filter((c) => c.date >= preferFrom && c.date <= preferTo) : [];
  const pool = inWindow.length ? inWindow : candidates;
  const provider = pickWatchProvider(raw);
  if (pool.length) {
    const typeRank = (t: number) => (t === 4 ? 0 : t === 6 ? 1 : 2);
    pool.sort((a, b) => {
      const pa = COUNTRY_PRIORITY.indexOf(a.country);
      const pb = COUNTRY_PRIORITY.indexOf(b.country);
      const ca = pa === -1 ? 99 : pa;
      const cb = pb === -1 ? 99 : pb;
      return (
        ca - cb ||
        typeRank(a.type) - typeRank(b.type) ||
        Number(Boolean(b.note)) - Number(Boolean(a.note)) ||
        a.date.localeCompare(b.date)
      );
    });
    const best = pool[0];
    const name =
      best.note ||
      (best.kind === "stream" && provider ? provider.name : best.kind === "tv" ? "TV Premiere" : best.kind === "physical" ? "Blu-ray / DVD" : "Digital");
    return { airdate: best.date, kind: best.kind, channel: name, country: best.country };
  }
  return {
    airdate: raw.release_date || null,
    kind: "stream" as const,
    channel: provider ? provider.name : "Digital",
    country: provider ? provider.country : null,
  };
}

export function slimMovie(raw: any, preferFrom: string | null = null, preferTo: string | null = null) {
  const rel = pickRelease(raw, preferFrom, preferTo);
  const lang = LANG_NAMES[raw.original_language] || (raw.original_language ? String(raw.original_language).toUpperCase() : null);
  return {
    id: raw.id as number,
    kind: "movie" as const,
    name: raw.title as string,
    originalName: raw.original_title && raw.original_title !== raw.title ? raw.original_title : null,
    url: `https://www.themoviedb.org/movie/${raw.id}`,
    language: lang,
    genres: (raw.genres || []).map((g: any) => (g.name === "Science Fiction" ? "Science-Fiction" : g.name)),
    status: raw.status || "Released",
    premiered: raw.release_date || rel.airdate || null,
    airdate: rel.airdate,
    releaseKind: rel.kind,
    channelName: rel.channel,
    channelCountry: rel.country,
    runtime: raw.runtime || null,
    officialSite: raw.homepage || null,
    imdbUrl: raw.imdb_id ? `https://www.imdb.com/title/${raw.imdb_id}/` : null,
    imdbId: raw.imdb_id || null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    popularity: raw.popularity || 0,
    poster: raw.poster_path ? `${IMG_BASE}/w342${raw.poster_path}` : null,
    posterLarge: raw.poster_path ? `${IMG_BASE}/w780${raw.poster_path}` : null,
    logo: pickLogo(raw),
    background: raw.backdrop_path ? `${IMG_BASE}/w780${raw.backdrop_path}` : null,
    summary: raw.overview || "",
    tagline: raw.tagline || "",
  };
}

export async function discoverMovies(apiKey: string, from: string, to: string, primaryCutoff: string, page = 1, releaseTypes = "4|5|6") {
  return await apiGet(apiKey, "/discover/movie", {
    with_release_type: releaseTypes,
    "release_date.gte": from,
    "release_date.lte": to,
    "primary_release_date.gte": primaryCutoff,
    sort_by: "popularity.desc",
    include_adult: false,
    page,
  });
}

export async function fetchMovieFull(apiKey: string, id: number, preferFrom: string | null = null, preferTo: string | null = null) {
  const raw = await apiGet(
    apiKey,
    `/movie/${id}`,
    { append_to_response: "release_dates,watch/providers,images", include_image_language: "en,null" },
    { allow404: true }
  );
  if (!raw) return null;
  return { movie: slimMovie(raw, preferFrom, preferTo), fetchedAt: Date.now() };
}

export async function searchMovies(apiKey: string, q: string) {
  const res = await apiGet(apiKey, "/search/movie", { query: q, include_adult: false });
  return ((res && res.results) || []).slice(0, 10).map((r: any) => ({
    id: r.id,
    kind: "movie" as const,
    name: r.title,
    premiered: r.release_date || null,
    language: LANG_NAMES[r.original_language] || r.original_language || null,
    genres: [],
    status: r.release_date ? "Released" : "Upcoming",
    poster: r.poster_path ? `${IMG_BASE}/w185${r.poster_path}` : null,
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    summary: r.overview || "",
    channelName: "TMDB Movie",
    releaseKind: "stream",
  }));
}

function normalizeGenreName(name: string): string {
  if (!name) return "";
  if (name === "Science Fiction" || name === "Sci-Fi & Fantasy") return "Science-Fiction";
  if (name === "Action & Adventure") return "Action";
  if (name === "War & Politics") return "War";
  return name;
}

export function slimCandidate(raw: any, forcedKind: "movie" | "show" | null = null) {
  const mediaType = forcedKind || (raw.media_type === "movie" || (!raw.first_air_date && raw.release_date) ? "movie" : "show");
  const isMovie = mediaType === "movie";
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((g: any) => normalizeGenreName(g.name)).filter(Boolean)
    : [...new Set((raw.genre_ids || []).map((id: number) => TMDB_GENRE_NAMES[id]).filter(Boolean))];
  return {
    tmdbId: raw.id as number,
    kind: (isMovie ? "movie" : "show") as "movie" | "show",
    name: (isMovie ? raw.title || raw.name : raw.name || raw.title) as string,
    premiered: isMovie ? raw.release_date || null : raw.first_air_date || null,
    language: LANG_NAMES[raw.original_language] || (raw.original_language ? String(raw.original_language).toUpperCase() : null),
    genres: [...new Set(genres)] as string[],
    poster: raw.poster_path ? `${IMG_BASE}/w342${raw.poster_path}` : null,
    backdrop: raw.backdrop_path ? `${IMG_BASE}/w780${raw.backdrop_path}` : null,
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    voteCount: (raw.vote_count || 0) as number,
    popularity: (raw.popularity || 0) as number,
    summary: (raw.overview || "") as string,
  };
}

export async function findTvByExternal(
  apiKey: string,
  { imdb = null, thetvdb = null, name = "", year = "" }: { imdb?: string | null; thetvdb?: string | number | null; name?: string; year?: string } = {}
): Promise<number | null> {
  if (imdb) {
    const res = await apiGet(apiKey, `/find/${encodeURIComponent(imdb)}`, { external_source: "imdb_id" }, { allow404: true }).catch(() => null);
    const hit = res && res.tv_results && res.tv_results[0];
    if (hit && hit.id) return hit.id;
  }
  if (thetvdb) {
    const res = await apiGet(apiKey, `/find/${encodeURIComponent(String(thetvdb))}`, { external_source: "tvdb_id" }, { allow404: true }).catch(() => null);
    const hit = res && res.tv_results && res.tv_results[0];
    if (hit && hit.id) return hit.id;
  }
  if (name) {
    const q = await apiGet(apiKey, "/search/tv", {
      query: name,
      ...(year ? { first_air_date_year: String(year).slice(0, 4) } : {}),
    }).catch(() => null);
    const list = (q && q.results) || [];
    const target = name.trim().toLowerCase();
    const exact = list.find((r: any) => String(r.name || "").trim().toLowerCase() === target) || list[0];
    if (exact && exact.id) return exact.id;
  }
  return null;
}

export async function fetchDeepProfile(apiKey: string, kind: "movie" | "show", tmdbId: number) {
  const isMovie = kind === "movie";
  const raw = await apiGet(
    apiKey,
    isMovie ? `/movie/${tmdbId}` : `/tv/${tmdbId}`,
    { append_to_response: "keywords,credits,recommendations,similar,external_ids" },
    { allow404: true }
  );
  if (!raw) return null;
  const kwRoot = raw.keywords || {};
  const keywords = (isMovie ? kwRoot.keywords : kwRoot.results) || [];
  const credits = raw.credits || {};
  const castPeople = (credits.cast || [])
    .slice(0, 12)
    .filter((c: any) => c && c.name)
    .map((c: any) => ({
      tmdbPersonId: c.id || null,
      name: c.name as string,
      image: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : null,
      role: (c.character || "Cast") as string,
    }));
  const cast = castPeople.map((c: any) => c.name);
  const creatorsByName = new Map<string, any>();
  const creatorPeople: any[] = [];
  const addCreator = (id: number | null, name: string, profilePath: string | null, job: string) => {
    if (!name || !job) return;
    const prev = creatorsByName.get(name);
    const img = profilePath ? `${IMG_BASE}/w185${profilePath}` : null;
    if (prev) {
      if (!prev.role.includes(job)) prev.role = `${prev.role} · ${job}`;
      if (!prev.image && img) prev.image = img;
      return;
    }
    if (creatorPeople.length >= 10) return;
    const entry = { tmdbPersonId: id || null, name, image: img, role: job };
    creatorsByName.set(name, entry);
    creatorPeople.push(entry);
  };
  if (!isMovie) {
    for (const c of raw.created_by || []) {
      if (c && c.name) addCreator(c.id, c.name, c.profile_path, "Creator");
    }
  }
  for (const cr of credits.crew || []) {
    if (!cr || !cr.name) continue;
    if (/^(Director|Series Director|Creator|Showrunner|Screenplay|Writer|Executive Producer|Original Music Composer|Composer|Director of Photography)$/i.test(cr.job || "")) {
      addCreator(cr.id, cr.name, cr.profile_path, cr.job);
    }
  }
  const studios = isMovie
    ? (raw.production_companies || []).slice(0, 3).map((p: any) => p.name).filter(Boolean)
    : [...(raw.networks || []), ...(raw.production_companies || [])].slice(0, 4).map((p: any) => p.name).filter(Boolean);
  const base = slimCandidate(raw, isMovie ? "movie" : "show");
  const imdbId = (raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id || null;
  return {
    ...base,
    id: raw.id as number,
    imdbId,
    status: raw.status || null,
    tagline: raw.tagline || "",
    runtime: isMovie ? raw.runtime || null : (raw.episode_run_time && raw.episode_run_time[0]) || null,
    studios: [...new Set(studios)] as string[],
    keywords: keywords.slice(0, 18).map((k: any) => ({ id: k.id, name: String(k.name || "").toLowerCase() })).filter((k: any) => k.name),
    creators: creatorPeople.map((c) => c.name) as string[],
    creatorPeople,
    cast,
    castPeople,
    recommendations: ((raw.recommendations && raw.recommendations.results) || []).slice(0, 14).map((r: any) => slimCandidate(r, base.kind)),
    similar: ((raw.similar && raw.similar.results) || []).slice(0, 10).map((r: any) => slimCandidate(r, base.kind)),
    url: `https://www.themoviedb.org/${isMovie ? "movie" : "tv"}/${raw.id}`,
    imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
  };
}

export async function discoverDeep(apiKey: string, kind: "movie" | "show", params: Record<string, any> = {}) {
  const isMovie = kind === "movie";
  const res = await apiGet(apiKey, `/discover/${isMovie ? "movie" : "tv"}`, {
    include_adult: false,
    sort_by: params.sortBy || "vote_average.desc",
    ...params,
  });
  return ((res && res.results) || []).map((r: any) => slimCandidate(r, isMovie ? "movie" : "show"));
}

export async function fetchTrending(apiKey: string, media = "all") {
  const res = await apiGet(apiKey, `/trending/${media}/week`, {}).catch(() => null);
  return ((res && res.results) || []).map((r: any) => slimCandidate(r)).filter((x: any) => x.name && (x.poster || x.backdrop));
}

export async function searchPerson(apiKey: string, name: string) {
  const res = await apiGet(apiKey, "/search/person", { query: name, include_adult: false }).catch(() => null);
  const list = (res && res.results) || [];
  const target = String(name || "").trim().toLowerCase();
  const best = list.find((p: any) => String(p.name || "").trim().toLowerCase() === target) || list[0];
  if (!best || !best.id) return null;
  return {
    tmdbPersonId: best.id as number,
    name: best.name as string,
    image: best.profile_path ? `${IMG_BASE}/w185${best.profile_path}` : null,
    department: best.known_for_department || null,
  };
}

export async function fetchPersonCredits(apiKey: string, tmdbPersonId: number) {
  const raw = await apiGet(apiKey, `/person/${tmdbPersonId}/combined_credits`, {}, { allow404: true }).catch(() => null);
  if (!raw) return [];
  const map = new Map<string, any>();
  const consider = (r: any, role: string) => {
    if (!r || !r.id || (!r.title && !r.name)) return;
    if (r.media_type !== "movie" && r.media_type !== "tv") return;
    const isCrew = role !== "Cast";
    if (isCrew && !/Creator|Director|Writer|Screenplay|Executive Producer|Producer|Composer|Music|Cinematograph|Director of Photography/i.test(role)) return;
    const key = `${r.media_type}:${r.id}`;
    const c = { ...slimCandidate(r, r.media_type === "movie" ? "movie" : "show"), creditRole: role };
    const prev = map.get(key);
    if (!prev || isCrew) map.set(key, prev ? { ...prev, creditRole: isCrew ? role : prev.creditRole } : c);
  };
  for (const cr of raw.crew || []) consider(cr, cr.job || "Crew");
  for (const ca of raw.cast || []) consider(ca, "Cast");
  return [...map.values()]
    .filter((x) => (x.poster || x.voteCount >= 10) && x.name)
    .sort((a, b) => (b.rating || 0) * Math.log10(10 + (b.voteCount || 0)) - (a.rating || 0) * Math.log10(10 + (a.voteCount || 0)))
    .slice(0, 26);
}

export async function searchTv(apiKey: string, q: string) {
  const res = await apiGet(apiKey, "/search/tv", { query: q, include_adult: false }).catch(() => null);
  return ((res && res.results) || []).slice(0, 8).map((r: any) => slimCandidate(r, "show"));
}

export async function findMovieByExternal(
  apiKey: string,
  { imdb = null, name = "", year = "" }: { imdb?: string | null; name?: string; year?: string } = {}
): Promise<number | null> {
  if (imdb) {
    const res = await apiGet(apiKey, `/find/${encodeURIComponent(imdb)}`, { external_source: "imdb_id" }, { allow404: true }).catch(() => null);
    const hit = res && res.movie_results && res.movie_results[0];
    if (hit && hit.id) return hit.id;
  }
  if (name) {
    const q = await apiGet(apiKey, "/search/movie", {
      query: name,
      include_adult: false,
      ...(year ? { year: String(year).slice(0, 4) } : {}),
    }).catch(() => null);
    const list = (q && q.results) || [];
    const target = name.trim().toLowerCase();
    const exact = list.find((r: any) => String(r.title || "").trim().toLowerCase() === target) || list[0];
    if (exact && exact.id) return exact.id;
  }
  return null;
}
