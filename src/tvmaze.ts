/**
 * Stateless TVmaze API client adapted for Cloudflare Workers fetch & bounded execution.
 */

const BASE = "https://api.tvmaze.com";
const USER_AGENT = "Viuhti/1.0 (https://github.com/tommiph/viuhti-cloudflare)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TvmazeChannel {
  id: number;
  name: string;
  country: string | null;
  timezone: string | null;
}

export interface SlimShow {
  id: number;
  name: string;
  url: string | null;
  type: string | null;
  language: string | null;
  genres: string[];
  status: string | null;
  premiered: string | null;
  ended: string | null;
  runtime: number | null;
  officialSite: string | null;
  rating: number | null;
  network: TvmazeChannel | null;
  webChannel: TvmazeChannel | null;
  schedule: { time?: string; days?: string[] } | null;
  poster: string | null;
  posterLarge: string | null;
  logo: string | null;
  banner: string | null;
  background: string | null;
  akas: string[];
  summary: string;
  weight: number;
  externals: { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null } | null;
  updated: number;
}

export interface SlimEpisode {
  id: number;
  season: number | null;
  number: number | null;
  name: string;
  type: string | null;
  airdate: string;
  airtime: string | null;
  airstamp: string | null;
  runtime: number | null;
  image: string | null;
  summary: string;
  url: string | null;
}

export async function apiGet<T = unknown>(
  path: string,
  { allow404 = false }: { allow404?: boolean } = {}
): Promise<T | null> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`TVmaze responded ${res.status} for ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message.includes("responded 4")) throw lastErr;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`TVmaze request failed: ${path}`);
}

function pickImage(images: any[], type: string, size = "original"): string | null {
  const list = images.filter((i) => i && i.type === type);
  if (!list.length) return null;
  list.sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)));
  const res = list[0].resolutions || {};
  return (res[size] && res[size].url) || (res.original && res.original.url) || null;
}

function channelInfo(ch: any): TvmazeChannel | null {
  if (!ch) return null;
  return {
    id: ch.id,
    name: ch.name,
    country: ch.country ? ch.country.code : null,
    timezone: ch.country ? ch.country.timezone : null,
  };
}

export function slimShow(raw: any): SlimShow {
  const images = (raw._embedded && raw._embedded.images) || [];
  const akas = (raw._embedded && raw._embedded.akas) || [];
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url || null,
    type: raw.type || null,
    language: raw.language || null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    status: raw.status || null,
    premiered: raw.premiered || null,
    ended: raw.ended || null,
    runtime: raw.runtime || raw.averageRuntime || null,
    officialSite: raw.officialSite || null,
    rating: raw.rating ? raw.rating.average : null,
    network: channelInfo(raw.network),
    webChannel: channelInfo(raw.webChannel),
    schedule: raw.schedule || null,
    poster: raw.image ? raw.image.medium : null,
    posterLarge: raw.image ? raw.image.original : null,
    logo: pickImage(images, "typography"),
    banner: pickImage(images, "banner", "medium"),
    background: pickImage(images, "background"),
    akas: [...new Set(akas.map((a: any) => a.name).filter((n: string) => n && n !== raw.name))] as string[],
    summary: raw.summary || "",
    weight: raw.weight || 0,
    externals: raw.externals || null,
    updated: raw.updated || 0,
  };
}

export function slimEpisode(e: any): SlimEpisode {
  return {
    id: e.id,
    season: e.season ?? null,
    number: e.number ?? null,
    name: e.name || "",
    type: e.type || null,
    airdate: e.airdate || "",
    airtime: e.airtime || null,
    airstamp: e.airstamp || null,
    runtime: e.runtime || null,
    image: e.image ? e.image.medium : null,
    summary: e.summary || "",
    url: e.url || null,
  };
}

export async function fetchShowFull(id: number): Promise<{ show: SlimShow; episodes: SlimEpisode[]; fetchedAt: number } | null> {
  const raw = await apiGet<any>(`/shows/${id}?embed[]=episodes&embed[]=images&embed[]=akas`, { allow404: true });
  if (!raw) return null;
  const episodes = ((raw._embedded && raw._embedded.episodes) || [])
    .filter((e: any) => e && e.type !== "insignificant_special" && e.airdate)
    .map(slimEpisode);
  return { show: slimShow(raw), episodes, fetchedAt: Date.now() };
}

export async function fetchSchedule(date: string, web = false): Promise<any[]> {
  return (await apiGet<any[]>(`/schedule${web ? "/web" : ""}?date=${encodeURIComponent(date)}`)) || [];
}

export async function fetchFullSchedule(): Promise<any[]> {
  return (await apiGet<any[]>("/schedule/full")) || [];
}

export async function searchShows(q: string): Promise<Array<{ score: number; show: any }>> {
  const results = await apiGet<any[]>(`/search/shows?q=${encodeURIComponent(q)}`);
  return (results || []).map((r) => ({ score: r.score || 0, show: r.show }));
}

export async function fetchUpdates(since = "day"): Promise<Record<string, number>> {
  return (await apiGet<Record<string, number>>(`/updates/shows?since=${since}`)) || {};
}

export async function fetchShowPeople(id: number): Promise<{
  show: SlimShow;
  cast: string[];
  crew: Array<{ name: string; role: string }>;
  castPeople: Array<{ id: number | null; name: string; image: string | null; role: string }>;
  crewPeople: Array<{ id: number | null; name: string; image: string | null; role: string }>;
} | null> {
  const raw = await apiGet<any>(`/shows/${id}?embed[]=cast&embed[]=crew`, { allow404: true });
  if (!raw) return null;
  const cast: string[] = [];
  const castPeople: Array<{ id: number | null; name: string; image: string | null; role: string }> = [];
  const seenCast = new Set<string>();
  for (const c of (raw._embedded && raw._embedded.cast) || []) {
    const p = c && c.person;
    const name = p && p.name;
    if (name && !seenCast.has(name)) {
      seenCast.add(name);
      cast.push(name);
      castPeople.push({
        id: p.id || null,
        name,
        image: (p.image && p.image.medium) || (c.character && c.character.image && c.character.image.medium) || null,
        role: (c.character && c.character.name) || "Cast",
      });
      if (cast.length >= 12) break;
    }
  }
  const crew: Array<{ name: string; role: string }> = [];
  const crewPeople: Array<{ id: number | null; name: string; image: string | null; role: string }> = [];
  const crewByName = new Map<string, { id: number | null; name: string; image: string | null; role: string }>();
  for (const cr of (raw._embedded && raw._embedded.crew) || []) {
    const p = cr && cr.person;
    const name = p && p.name;
    const type = String((cr && cr.type) || "");
    if (!name || !/creator|showrunner|executive producer|writer|director|composer|music|cinematograph|director of photography/i.test(type)) continue;
    const prev = crewByName.get(name);
    if (prev) {
      if (type && !prev.role.includes(type)) prev.role = `${prev.role} · ${type}`;
      if (!prev.image && p.image && p.image.medium) prev.image = p.image.medium;
    } else if (crewPeople.length < 10) {
      const entry = {
        id: p.id || null,
        name,
        image: (p.image && p.image.medium) || null,
        role: type,
      };
      crewByName.set(name, entry);
      crewPeople.push(entry);
      crew.push({ name, role: type });
    }
  }
  return { show: slimShow(raw), cast, crew, castPeople, crewPeople };
}

export async function fetchPersonCredits(personId: number): Promise<Array<SlimShow & { creditRole: string }>> {
  const id = Number(personId);
  if (!id) return [];
  const [castRows, crewRows] = await Promise.all([
    apiGet<any[]>(`/people/${id}/castcredits?embed=show`, { allow404: true }).catch(() => []),
    apiGet<any[]>(`/people/${id}/crewcredits?embed=show`, { allow404: true }).catch(() => []),
  ]);
  const map = new Map<number, SlimShow & { creditRole: string }>();
  for (const row of [...(crewRows || []), ...(castRows || [])]) {
    const rawShow = row && row._embedded && row._embedded.show;
    if (!rawShow || !rawShow.id) continue;
    const prev = map.get(rawShow.id);
    const role = row.type || "Cast";
    if (!prev) map.set(rawShow.id, { ...slimShow(rawShow), creditRole: role });
    else if (row.type && !prev.creditRole.includes(row.type)) prev.creditRole = `${prev.creditRole} · ${row.type}`;
  }
  return [...map.values()].sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.weight || 0) - (a.weight || 0));
}

export async function searchPeople(q: string) {
  const rows = (await apiGet<any[]>(`/search/people?q=${encodeURIComponent(q)}`, { allow404: true })) || [];
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 8)
    .map((r) => r && r.person)
    .filter(Boolean)
    .map((p) => ({
      kind: "person" as const,
      tvmazePersonId: p.id,
      name: p.name,
      country: p.country ? p.country.name : null,
      image: (p.image && p.image.medium) || null,
    }));
}

export async function fetchShowsPage(page = 0): Promise<SlimShow[]> {
  const rows = (await apiGet<any[]>(`/shows?page=${Math.max(0, Number(page) || 0)}`, { allow404: true })) || [];
  return Array.isArray(rows) ? rows.map(slimShow) : [];
}

export async function resolveShow({ imdbId = null, name = "", year = "" }: { imdbId?: string | null; name?: string; year?: string } = {}): Promise<SlimShow | null> {
  if (imdbId) {
    try {
      const raw = await apiGet<any>(`/lookup/shows?imdb=${encodeURIComponent(imdbId)}`, { allow404: true });
      if (raw && raw.id) return slimShow(raw);
    } catch {
      // fall through
    }
  }
  if (!name) return null;
  const hits = await searchShows(name);
  const target = name.trim().toLowerCase();
  const yStr = String(year || "").slice(0, 4);
  const ranked = hits
    .map((h) => {
      const s = h.show;
      const sn = String(s.name || "").trim().toLowerCase();
      let score = h.score || 0;
      if (sn === target) score += 20;
      if (yStr && String(s.premiered || "").startsWith(yStr)) score += 10;
      return { show: slimShow(s), score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] ? ranked[0].show : null;
}
