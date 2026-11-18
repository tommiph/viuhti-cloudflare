import { todayYmd } from "./db";
import type { slimMovie } from "./tmdb";

type SlimMovie = ReturnType<typeof slimMovie>;

const USER_AGENT = "Viuhti/1.0 (https://github.com/tommiph/viuhti-cloudflare)";
export const ITUNES_ID_MIN = 1_000_000_000;
export const IMDB_MOVIE_BASE_ID = 9_000_000_000;

export function normalizeMovieTitle(name: string): string {
  return String(name || "")
    .replace(/\(\d{4}\)\s*$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function upgradePoster(url: string | null | undefined, w: number, h: number): string | null {
  if (!url) return null;
  return String(url).replace(/\/\d+x\d+bb[^/]*$/, `/${w}x${h}bb.jpg`);
}

function mapGenres(raw: string | null | undefined): string[] {
  const s = String(raw || "").trim();
  if (!s) return [];
  if (s === "Action & Adventure") return ["Action", "Adventure"];
  if (s === "Sci-Fi & Fantasy") return ["Science-Fiction", "Fantasy"];
  if (s === "Kids & Family") return ["Family"];
  if (s === "Independent") return ["Indie"];
  return s
    .split(/\s*[&,]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function shiftDays(ymd: string, delta: number): string {
  const ms = Date.parse(`${ymd}T12:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + delta * 86_400_000).toISOString().slice(0, 10) : ymd;
}

function deriveDigitalAirdate(premieredYmd: string | null, today: string): string {
  if (!premieredYmd || !/^\d{4}-\d{2}-\d{2}$/.test(premieredYmd)) return today;
  const recentWindowStart = shiftDays(today, -14);
  if (premieredYmd >= recentWindowStart) return premieredYmd;
  // Theatrical film arriving on Digital/VOD charts within the last 150 days maps to current chart arrival week.
  return today;
}

export function isRecentDigitalWindow(premieredYmd: string | null, today = todayYmd()): boolean {
  if (!premieredYmd || !/^\d{4}-\d{2}-\d{2}$/.test(premieredYmd)) return false;
  return premieredYmd >= shiftDays(today, -150) && premieredYmd <= shiftDays(today, 90);
}

export async function fetchTopMovies(
  country: "us" | "gb" = "us",
  limit = 50,
  { allDates = false }: { allDates?: boolean } = {}
): Promise<SlimMovie[]> {
  const capped = Math.max(10, Math.min(100, Number(limit) || 50));
  const res = await fetch(`https://itunes.apple.com/${country}/rss/topmovies/limit=${capped}/json`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const entries: any[] = data?.feed?.entry || [];
  const today = todayYmd();
  const out: SlimMovie[] = [];

  entries.forEach((e, idx) => {
    const id = Number(e?.id?.attributes?.["im:id"] || 0);
    const name = String(e?.["im:name"]?.label || "").trim();
    if (!id || !name) return;

    const relRaw = String(e?.["im:releaseDate"]?.label || "").slice(0, 10);
    const premiered = /^\d{4}-\d{2}-\d{2}$/.test(relRaw) ? relRaw : null;
    if (!allDates && !isRecentDigitalWindow(premiered, today)) return;

    const imgs: any[] = Array.isArray(e?.["im:image"]) ? e["im:image"] : [];
    const lastImg = imgs[imgs.length - 1]?.label || imgs[0]?.label || null;
    const poster = upgradePoster(lastImg, 342, 513);
    const posterLarge = upgradePoster(lastImg, 780, 1170);
    const linkAlt = Array.isArray(e?.link)
      ? e.link.find((l: any) => l?.attributes?.rel === "alternate")?.attributes?.href
      : e?.link?.attributes?.href;
    const genreLabel = e?.category?.attributes?.label || "";

    out.push({
      id,
      kind: "movie",
      name,
      originalName: null,
      url: linkAlt || `https://tv.apple.com`,
      language: "English",
      genres: mapGenres(genreLabel),
      status: premiered && premiered > today ? "Upcoming" : "Released",
      premiered,
      airdate: deriveDigitalAirdate(premiered, today),
      releaseKind: "stream",
      channelName: "Apple TV",
      channelCountry: country.toUpperCase(),
      runtime: null,
      officialSite: linkAlt || null,
      imdbUrl: null,
      imdbId: null,
      rating: null,
      popularity: Math.max(10, 100 - idx * 1.5),
      poster,
      posterLarge,
      logo: null,
      background: posterLarge,
      summary: String(e?.summary?.label || "").trim(),
      tagline: String(e?.rights?.label || "").replace(/^©\s*/, "").trim(),
    });
  });

  return out;
}

function resizeImdbPoster(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  return String(url).replace(/\._V1_.*\.jpg$/i, `._V1_UX${width}_.jpg`);
}

function imdbEntryToSlimMovie(entry: any): SlimMovie | null {
  const ttId = String(entry?.id || "").trim();
  const m = ttId.match(/^tt(\d+)$/i);
  if (!m || !entry?.l) return null;
  const numId = IMDB_MOVIE_BASE_ID + Number(m[1]);
  const year = Number(entry?.y || 0);
  const premiered = year >= 1900 ? `${year}-01-01` : null;
  const img = entry?.i?.imageUrl || null;
  const today = todayYmd();

  return {
    id: numId,
    kind: "movie",
    name: String(entry.l).trim(),
    originalName: null,
    url: `https://www.imdb.com/title/${ttId}/`,
    language: "English",
    genres: [],
    status: year && year > Number(today.slice(0, 4)) ? "Upcoming" : "Released",
    premiered,
    airdate: premiered,
    releaseKind: "stream",
    channelName: "IMDb",
    channelCountry: "US",
    runtime: null,
    officialSite: null,
    imdbUrl: `https://www.imdb.com/title/${ttId}/`,
    imdbId: ttId,
    rating: null,
    popularity: entry?.rank ? Math.max(10, Math.round(10000 / Math.max(1, Number(entry.rank)))) : 20,
    poster: resizeImdbPoster(img, 342),
    posterLarge: resizeImdbPoster(img, 780),
    logo: null,
    background: resizeImdbPoster(img, 780),
    summary: entry?.s ? `Starring ${entry.s}` : "",
    tagline: entry?.s ? String(entry.s) : "",
  };
}

export async function searchMovies(query: string, limit = 5): Promise<SlimMovie[]> {
  const clean = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, "_")
    .trim();
  if (clean.length < 2) return [];
  const prefix = clean[0].replace(/[^a-z0-9]/, "x");
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/${prefix}/${encodeURIComponent(clean)}.json`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const rows: any[] = Array.isArray(data?.d) ? data.d : [];
  const out: SlimMovie[] = [];
  for (const row of rows) {
    if (!row || !/^tt\d+$/i.test(String(row.id || ""))) continue;
    const qid = String(row.qid || row.q || "").toLowerCase();
    if (qid !== "movie" && qid !== "feature" && qid !== "tvmovie") continue;
    const slim = imdbEntryToSlimMovie(row);
    if (slim) out.push(slim);
    if (out.length >= limit) break;
  }
  return out;
}

export async function lookupMovie(id: number): Promise<SlimMovie | null> {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  if (numId >= IMDB_MOVIE_BASE_ID) {
    const ttNum = numId - IMDB_MOVIE_BASE_ID;
    const ttId = `tt${String(ttNum).padStart(7, "0")}`;
    const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/t/${ttId}.json`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const row = Array.isArray(data?.d) ? data.d.find((x: any) => String(x?.id || "").toLowerCase() === ttId) || data.d[0] : null;
    return row ? imdbEntryToSlimMovie(row) : null;
  }
  const res = await fetch(`https://itunes.apple.com/lookup?id=${numId}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  const r = Array.isArray(data?.results) ? data.results[0] : null;
  if (!r || !r.trackId) return null;

  const today = todayYmd();
  const relRaw = String(r.releaseDate || "").slice(0, 10);
  const premiered = /^\d{4}-\d{2}-\d{2}$/.test(relRaw) ? relRaw : null;
  const art = r.artworkUrl100 || r.artworkUrl60 || null;
  const poster = upgradePoster(art, 342, 513);
  const posterLarge = upgradePoster(art, 780, 1170);
  const runtimeMin = r.trackTimeMillis ? Math.round(Number(r.trackTimeMillis) / 60_000) : null;

  return {
    id: Number(r.trackId),
    kind: "movie",
    name: String(r.trackName || `Movie #${numId}`),
    originalName: null,
    url: r.trackViewUrl || r.collectionViewUrl || null,
    language: "English",
    genres: mapGenres(r.primaryGenreName),
    status: premiered && premiered > today ? "Upcoming" : "Released",
    premiered,
    airdate: deriveDigitalAirdate(premiered, today),
    releaseKind: "stream",
    channelName: "Apple TV",
    channelCountry: String(r.country || "US").slice(0, 2),
    runtime: runtimeMin,
    officialSite: r.trackViewUrl || null,
    imdbUrl: null,
    imdbId: null,
    rating: null,
    popularity: 65,
    poster,
    posterLarge,
    logo: null,
    background: posterLarge,
    summary: String(r.longDescription || r.shortDescription || "").trim(),
    tagline: r.artistName ? `Directed by ${r.artistName}` : "",
  };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function cleanWikiText(raw: string): string {
  return String(raw || "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/''+/g, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchUpcomingWikiMovies(
  { allDates = false, limit = 30 }: { allDates?: boolean; limit?: number } = {}
): Promise<Array<{ name: string; releaseDate: string; studio: string; cast: string }>> {
  const today = todayYmd();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const quarterIdx = month <= 3 ? 0 : month <= 6 ? 1 : month <= 9 ? 2 : 3;
  const page = `List_of_American_films_of_${year}`;

  const secRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(6500) }
  );
  if (!secRes.ok) return [];
  const secJson = (await secRes.json()) as any;
  const sections: any[] = secJson?.parse?.sections || [];
  const quarterPatterns = [/january/i, /april/i, /july/i, /october/i];
  const sec = sections.find((s) => quarterPatterns[quarterIdx].test(String(s.line || "")));
  if (!sec || !sec.index) return [];

  const wtRes = await fetch(
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&section=${encodeURIComponent(sec.index)}&prop=wikitext&format=json`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(6500) }
  );
  if (!wtRes.ok) return [];
  const wtJson = (await wtRes.json()) as any;
  const wikitext = String(wtJson?.parse?.wikitext?.["*"] || "");
  if (!wikitext) return [];

  const fromYmd = shiftDays(today, -10);
  const toYmd = shiftDays(today, 90);
  const rows = wikitext.split(/\n\|-\s*\n/);
  const out: Array<{ name: string; releaseDate: string; studio: string; cast: string }> = [];
  let curMonth = month;
  let curDay = 1;

  for (const block of rows) {
    const mMatch = block.match(/data-sort-value="(\d{1,2})"|aria-label="([A-Za-z]+)"/i);
    if (mMatch) {
      if (mMatch[1]) curMonth = Number(mMatch[1]);
      else if (mMatch[2] && MONTHS[mMatch[2].toLowerCase()]) curMonth = MONTHS[mMatch[2].toLowerCase()];
    }
    const dMatch = block.match(/'''(\d{1,2})'''/);
    if (dMatch) curDay = Number(dMatch[1]);

    const lines = block.split("\n").map((l) => l.trim());
    const dataLine = lines.find((l) => l.startsWith("|") && l.includes("''[[") && l.includes("||"));
    if (!dataLine) continue;

    const cells = dataLine.replace(/^\|\s*/, "").split("||").map((c) => c.trim());
    const titleMatch = cells[0]?.match(/''\[\[(?:[^\]|]+\|)?([^\]]+)\]\]''/);
    const name = cleanWikiText(titleMatch ? titleMatch[1] : cells[0] || "");
    if (!name || name.length < 2) continue;

    const releaseDate = `${year}-${String(curMonth).padStart(2, "0")}-${String(curDay).padStart(2, "0")}`;
    if (!allDates && (releaseDate < fromYmd || releaseDate > toYmd)) continue;

    const studio = cleanWikiText((cells[1] || "").split("/")[0] || "Theatrical");
    const cast = cleanWikiText(cells[2] || "");
    out.push({ name, releaseDate, studio: studio || "Theatrical", cast });
    if (out.length >= limit) break;
  }
  return out;
}

export async function resolveWikiMovieToSlim(entry: {
  name: string;
  releaseDate: string;
  studio: string;
  cast: string;
}): Promise<SlimMovie | null> {
  const matches = await searchMovies(entry.name, 4).catch(() => []);
  const normTarget = normalizeMovieTitle(entry.name);
  const year = Number(entry.releaseDate.slice(0, 4));
  const hit =
    matches.find((m) => normalizeMovieTitle(m.name) === normTarget && (!m.premiered || Math.abs(Number(m.premiered.slice(0, 4)) - year) <= 1)) ||
    matches[0];
  if (!hit) return null;

  const today = todayYmd();
  const isStreamer = /netflix|prime|amazon|apple|disney|hulu|peacock|max|paramount/i.test(entry.studio);
  return {
    ...hit,
    premiered: entry.releaseDate,
    airdate: entry.releaseDate,
    status: entry.releaseDate > today ? "Upcoming" : "Released",
    releaseKind: isStreamer ? "stream" : "tv",
    channelName: entry.studio || hit.channelName || "Theatrical",
    summary: entry.cast ? `${entry.studio ? `${entry.studio} · ` : ""}${entry.cast.slice(0, 260)}` : hit.summary,
  };
}
