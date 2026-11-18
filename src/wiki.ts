import { safeJsonParse } from "./db";

const USER_AGENT = "Viuhti/1.0 (https://github.com/tommiph/viuhti-cloudflare)";
const POS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESTIGE_AWARD_RE =
  /Academy Award|Oscar|Primetime Emmy|Emmy Award|Golden Globe|BAFTA|Palme d'Or|Cannes|Venice Film Festival|Golden Lion|Berlin|Sundance|Peabody|Hugo Award|Nebula Award|Saturn Award|Critics' Choice|Screen Actors Guild|Directors Guild|Writers Guild|British Academy|César|Goya Award|AACTA/i;

export interface WikiDossier {
  found: boolean;
  qid?: string | null;
  wikiTitle?: string | null;
  wikiUrl?: string | null;
  extract?: string;
  description?: string;
  thumbnail?: string | null;
  basedOn?: Array<{ qid: string; name: string }>;
  authors?: Array<{ qid: string; name: string }>;
  composers?: Array<{ qid: string; name: string }>;
  directors?: Array<{ qid: string; name: string }>;
  writers?: Array<{ qid: string; name: string }>;
  awards?: string[];
  awardsTotal?: number;
  locations?: string[];
  filmingLocations?: string[];
  movements?: string[];
  birthYear?: number | null;
  deathYear?: number | null;
  birthPlace?: string | null;
  occupations?: string[];
  pubYear?: number | null;
  fetchedAt?: number;
}

export function makeDossierKey({
  kind = "show",
  imdbId = null,
  qid = null,
  wikiTitle = null,
  name = "",
  year = "",
}: {
  kind?: string;
  imdbId?: string | null;
  qid?: string | null;
  wikiTitle?: string | null;
  name?: string;
  year?: string | number;
}) {
  if (qid && /^Q\d+$/i.test(String(qid))) return `qid:${String(qid).toUpperCase()}`;
  if (imdbId) return `imdb:${String(imdbId).trim()}`;
  if (wikiTitle) return `wtitle:${String(wikiTitle).trim().toLowerCase()}`;
  return `${kind}:${String(name || "").trim().toLowerCase()}:${String(year || "").slice(0, 4)}`;
}

const wikiMemCache = new Map<string, WikiDossier>();

async function readCache(db: D1Database, cacheKey: string): Promise<WikiDossier | null> {
  const mem = wikiMemCache.get(cacheKey);
  if (mem) {
    const ttl = mem.found ? POS_TTL_MS : NEG_TTL_MS;
    if (Date.now() - Number(mem.fetchedAt || 0) <= ttl) return mem;
    wikiMemCache.delete(cacheKey);
  }
  const row = await db
    .prepare("SELECT data_json, fetched_at FROM wiki_cache WHERE cache_key = ?1")
    .bind(cacheKey)
    .first<{ data_json: string; fetched_at: number }>();
  if (!row) return null;
  const parsed = safeJsonParse<WikiDossier | null>(row.data_json, null);
  if (!parsed) return null;
  const ttl = parsed.found ? POS_TTL_MS : NEG_TTL_MS;
  if (Date.now() - Number(row.fetched_at || parsed.fetchedAt || 0) > ttl) return null;
  return parsed;
}

async function writeCache(_db: D1Database, cacheKey: string, payload: WikiDossier): Promise<WikiDossier> {
  const rec = { ...payload, fetchedAt: Date.now() };
  if (wikiMemCache.has(cacheKey)) wikiMemCache.delete(cacheKey);
  else if (wikiMemCache.size >= 240) {
    const oldest = wikiMemCache.keys().next().value;
    if (oldest !== undefined) wikiMemCache.delete(oldest);
  }
  wikiMemCache.set(cacheKey, rec);
  return rec;
}

export async function peekCachedDossier(
  db: D1Database,
  opts: Parameters<typeof makeDossierKey>[0]
): Promise<WikiDossier | null> {
  const key = makeDossierKey(opts);
  return await readCache(db, key);
}

async function fetchJsonPolite(url: string, accept = "application/json"): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(6500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function qidFromUri(uri: unknown): string | null {
  const m = String(uri || "").match(/\/(Q\d+)$/);
  return m ? m[1] : null;
}

function wikiTitleFromUrl(url: unknown): string | null {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (!u.hostname.endsWith("wikipedia.org")) return null;
    const raw = u.pathname.replace(/^\/wiki\//, "");
    return raw ? decodeURIComponent(raw.replace(/_/g, " ")) : null;
  } catch {
    return null;
  }
}

function splitConcat(binding: any, field: string, cap = 25): string[] {
  const val = binding && binding[field] && binding[field].value;
  if (!val) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(val).split("||")) {
    const clean = part.trim();
    if (!clean || /^Q\d+$/.test(clean) || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

function splitEntityConcat(binding: any, field: string, cap = 8): Array<{ qid: string; name: string }> {
  const val = binding && binding[field] && binding[field].value;
  if (!val) return [];
  const out: Array<{ qid: string; name: string }> = [];
  const seen = new Set<string>();
  for (const part of String(val).split("||")) {
    const idx = part.indexOf("::");
    if (idx === -1) continue;
    const qid = qidFromUri(part.slice(0, idx).trim());
    const name = part.slice(idx + 2).trim();
    if (!qid || !name || /^Q\d+$/.test(name) || seen.has(qid)) continue;
    seen.add(qid);
    out.push({ qid, name });
    if (out.length >= cap) break;
  }
  return out;
}

function rankAwards(list: string[], limit = 5) {
  const uniq = [...new Set(list.filter(Boolean))];
  const sorted = uniq.sort((a, b) => {
    const pa = PRESTIGE_AWARD_RE.test(a) ? 0 : 1;
    const pb = PRESTIGE_AWARD_RE.test(b) ? 0 : 1;
    return pa - pb || a.length - b.length;
  });
  return { awards: sorted.slice(0, limit), awardsTotal: uniq.length };
}

async function fetchWikidataMedia(imdbId: string | null, qid: string | null) {
  const cleanImdb = imdbId ? String(imdbId).replace(/[^A-Za-z0-9_-]/g, "") : "";
  const cleanQid = qid && /^Q\d+$/.test(String(qid)) ? String(qid) : "";
  if (!cleanImdb && !cleanQid) return null;

  const matchClause = cleanImdb ? `?item wdt:P345 "${cleanImdb}" .` : `VALUES ?item { wd:${cleanQid} }`;
  const sparql = `
SELECT ?item ?article
  (SAMPLE(YEAR(?pub)) AS ?pubYear)
  (GROUP_CONCAT(DISTINCT ?basedOnStr; separator="||") AS ?basedOnList)
  (GROUP_CONCAT(DISTINCT ?authorStr; separator="||") AS ?authorList)
  (GROUP_CONCAT(DISTINCT ?composerStr; separator="||") AS ?composerList)
  (GROUP_CONCAT(DISTINCT ?directorStr; separator="||") AS ?directorList)
  (GROUP_CONCAT(DISTINCT ?writerStr; separator="||") AS ?writerList)
  (GROUP_CONCAT(DISTINCT ?awardLabel; separator="||") AS ?awards)
  (GROUP_CONCAT(DISTINCT ?locLabel; separator="||") AS ?locs)
  (GROUP_CONCAT(DISTINCT ?filmLocLabel; separator="||") AS ?filmLocs)
  (GROUP_CONCAT(DISTINCT ?movementLabel; separator="||") AS ?movements)
WHERE {
  ${matchClause}
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wdt:P577 ?pub . }
  OPTIONAL {
    ?item wdt:P50 ?directAuthor .
    ?directAuthor rdfs:label ?directAuthorLabel . FILTER(LANG(?directAuthorLabel)="en")
    BIND(CONCAT(STR(?directAuthor), "::", ?directAuthorLabel) AS ?authorStr)
  }
  OPTIONAL {
    ?item wdt:P144 ?basedOn .
    ?basedOn rdfs:label ?basedOnLabel . FILTER(LANG(?basedOnLabel)="en")
    BIND(CONCAT(STR(?basedOn), "::", ?basedOnLabel) AS ?basedOnStr)
    OPTIONAL {
      ?basedOn wdt:P50 ?author .
      ?author rdfs:label ?authorLabel . FILTER(LANG(?authorLabel)="en")
      BIND(CONCAT(STR(?author), "::", ?authorLabel) AS ?authorStr)
    }
  }
  OPTIONAL { ?item wdt:P86 ?composer . ?composer rdfs:label ?composerLabel . FILTER(LANG(?composerLabel)="en") BIND(CONCAT(STR(?composer), "::", ?composerLabel) AS ?composerStr) }
  OPTIONAL { ?item wdt:P57 ?director . ?director rdfs:label ?directorLabel . FILTER(LANG(?directorLabel)="en") BIND(CONCAT(STR(?director), "::", ?directorLabel) AS ?directorStr) }
  OPTIONAL { ?item wdt:P58 ?writer . ?writer rdfs:label ?writerLabel . FILTER(LANG(?writerLabel)="en") BIND(CONCAT(STR(?writer), "::", ?writerLabel) AS ?writerStr) }
  OPTIONAL { ?item wdt:P166 ?award . ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel)="en") }
  OPTIONAL { ?item wdt:P840 ?loc . ?loc rdfs:label ?locLabel . FILTER(LANG(?locLabel)="en") }
  OPTIONAL { ?item wdt:P915 ?filmLoc . ?filmLoc rdfs:label ?filmLocLabel . FILTER(LANG(?filmLocLabel)="en") }
  OPTIONAL { ?item wdt:P135 ?movement . ?movement rdfs:label ?movementLabel . FILTER(LANG(?movementLabel)="en") }
} GROUP BY ?item ?article LIMIT 1`;

  const json = await fetchJsonPolite(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
    "application/sparql-results+json"
  );
  const b = (json && json.results && json.results.bindings && json.results.bindings[0]) || null;
  if (!b) return null;
  const { awards, awardsTotal } = rankAwards(splitConcat(b, "awards", 40), 5);
  return {
    qid: qidFromUri(b.item && b.item.value),
    wikiUrl: (b.article && b.article.value) || null,
    wikiTitle: wikiTitleFromUrl(b.article && b.article.value),
    pubYear: b.pubYear && b.pubYear.value ? Number(b.pubYear.value) : null,
    basedOn: splitEntityConcat(b, "basedOnList", 4),
    authors: splitEntityConcat(b, "authorList", 4),
    composers: splitEntityConcat(b, "composerList", 4),
    directors: splitEntityConcat(b, "directorList", 4),
    writers: splitEntityConcat(b, "writerList", 4),
    awards,
    awardsTotal,
    locations: splitConcat(b, "locs", 4),
    filmingLocations: splitConcat(b, "filmLocs", 4),
    movements: splitConcat(b, "movements", 3),
  };
}

async function fetchWikipediaSummary(title: string) {
  if (!title) return null;
  const slug = encodeURIComponent(String(title).replace(/\s+/g, "_"));
  const data = await fetchJsonPolite(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
  if (!data || data.type === "disambiguation" || !data.title) return null;
  return {
    wikiTitle: data.title as string,
    wikiUrl: (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || null,
    extract: String(data.extract || "").slice(0, 620),
    description: String(data.description || ""),
    thumbnail: (data.thumbnail && data.thumbnail.source) || null,
  };
}

async function resolveWikipediaTitleBySearch(name: string, kind: string, year: string): Promise<string | null> {
  const hint = kind === "movie" ? "film" : kind === "person" ? "" : kind === "source" ? "novel" : "TV series";
  const queries = [year && hint ? `${name} ${year} ${hint}` : `${name} ${hint}`.trim(), name].filter(Boolean);
  const targetLow = name.trim().toLowerCase();
  for (const q of [...new Set(queries)]) {
    const json = await fetchJsonPolite(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=${encodeURIComponent(q)}`
    );
    const hits = (json && json.query && json.query.search) || [];
    const exact = hits.find((h: any) => String(h.title || "").toLowerCase().startsWith(targetLow));
    if (exact && exact.title) return exact.title;
    if (hits[0] && hits[0].title) return hits[0].title;
  }
  return null;
}

export async function getWikiDossier(
  db: D1Database,
  opts: {
    kind?: string;
    name?: string;
    year?: string | number;
    imdbId?: string | null;
    qid?: string | null;
    wikiTitle?: string | null;
  }
): Promise<WikiDossier> {
  const kind = opts.kind || "show";
  const name = String(opts.name || "").trim();
  const year = String(opts.year || "").slice(0, 4);
  const key = makeDossierKey({ kind, imdbId: opts.imdbId, qid: opts.qid, wikiTitle: opts.wikiTitle, name, year });

  const cached = await readCache(db, key);
  if (cached) return cached;

  let wd: any = null;
  if (opts.imdbId || opts.qid) {
    wd = await fetchWikidataMedia(opts.imdbId || null, opts.qid || null);
  }

  let titleToFetch = (wd && wd.wikiTitle) || opts.wikiTitle || null;
  if (!titleToFetch && name) {
    titleToFetch = await resolveWikipediaTitleBySearch(name, kind, year);
  }
  const wp = titleToFetch ? await fetchWikipediaSummary(titleToFetch) : null;

  if (!wd && !wp) {
    return await writeCache(db, key, { found: false });
  }

  const dossier: WikiDossier = {
    found: true,
    qid: (wd && wd.qid) || opts.qid || null,
    wikiTitle: (wp && wp.wikiTitle) || (wd && wd.wikiTitle) || titleToFetch || null,
    wikiUrl: (wp && wp.wikiUrl) || (wd && wd.wikiUrl) || null,
    extract: (wp && wp.extract) || "",
    description: (wp && wp.description) || "",
    thumbnail: (wp && wp.thumbnail) || null,
    basedOn: (wd && wd.basedOn) || [],
    authors: (wd && wd.authors) || [],
    composers: (wd && wd.composers) || [],
    directors: (wd && wd.directors) || [],
    writers: (wd && wd.writers) || [],
    awards: (wd && wd.awards) || [],
    awardsTotal: (wd && wd.awardsTotal) || 0,
    locations: (wd && wd.locations) || [],
    filmingLocations: (wd && wd.filmingLocations) || [],
    movements: (wd && wd.movements) || [],
    pubYear: (wd && wd.pubYear) || null,
  };
  return await writeCache(db, key, dossier);
}

const NON_SCREEN_WORK_RE =
  /\b(game|tabletop|role-playing|board game|video game|cancelled|abandoned|unproduced|soundtrack|album|audio drama|stage play|musical)\b/i;
const SCREEN_WORK_RE = /\b(film|movie|television|tv|miniseries|series|anime|animated|serial|special|documentary)\b/i;

export interface WikiScreenWork {
  qid: string;
  name: string;
  imdbId: string | null;
  year: number | null;
  wikiUrl: string | null;
  wikiTitle: string | null;
  kindHint: "show" | "movie";
  creditRole?: string;
}

function parseScreenWorks(rows: any[], includeRole = false): WikiScreenWork[] {
  const items: WikiScreenWork[] = [];
  const seen = new Set<string>();
  for (const r of rows || []) {
    const workQid = qidFromUri(r.work && r.work.value);
    if (!workQid || seen.has(workQid)) continue;
    const wikiUrl = (r.wikiArticle && r.wikiArticle.value) || null;
    const wikiTitle = wikiTitleFromUrl(wikiUrl);
    let name = (r.workLabel && r.workLabel.value) || "";
    if (!name || /^Q\d+$/.test(name)) {
      if (!wikiTitle) continue;
      name = wikiTitle.replace(/\s*\([^)]*(?:film|TV series|television series|miniseries|series)\)$/i, "").trim();
    }
    if (!name || /^Q\d+$/.test(name)) continue;

    const types = String((r.types && r.types.value) || "").toLowerCase();
    const imdbId = (r.imdb && r.imdb.value) || null;
    if (NON_SCREEN_WORK_RE.test(types)) continue;
    if (!imdbId && types && !SCREEN_WORK_RE.test(types)) continue;

    seen.add(workQid);
    const kindHint: "show" | "movie" = /television|tv series|miniseries|anime/.test(types) ? "show" : "movie";
    const entry: WikiScreenWork = {
      qid: workQid,
      name,
      imdbId,
      year: r.year && r.year.value ? Number(r.year.value) : null,
      wikiUrl,
      wikiTitle,
      kindHint,
    };
    if (includeRole) entry.creditRole = (r.role && r.role.value) || "Credit";
    items.push(entry);
  }
  return items;
}

export async function fetchSourceAdaptations(db: D1Database, qid: string | null): Promise<WikiScreenWork[]> {
  const cleanQid = qid && /^Q\d+$/i.test(String(qid)) ? String(qid).toUpperCase() : "";
  if (!cleanQid) return [];
  const cKey = `src_adapt:${cleanQid}`;
  const cached = await readCache(db, cKey);
  if (cached && Array.isArray((cached as any).items)) return (cached as any).items;

  const sparql = `
SELECT DISTINCT ?work ?workLabel ?imdb
  (SAMPLE(COALESCE(YEAR(?pub), YEAR(?start))) AS ?year)
  (SAMPLE(?article) AS ?wikiArticle)
  (GROUP_CONCAT(DISTINCT ?instLabel; separator=", ") AS ?types)
WHERE {
  ?work wdt:P144 wd:${cleanQid} .
  OPTIONAL { ?work wdt:P345 ?imdb . }
  OPTIONAL { ?work wdt:P577 ?pub . }
  OPTIONAL { ?work wdt:P580 ?start . }
  OPTIONAL { ?article schema:about ?work ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?work wdt:P31 ?inst . ?inst rdfs:label ?instLabel . FILTER(LANG(?instLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?work ?workLabel ?imdb LIMIT 20`;

  const json = await fetchJsonPolite(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
    "application/sparql-results+json"
  );
  const rows = (json && json.results && json.results.bindings) || [];
  const items = parseScreenWorks(rows, false);
  await writeCache(db, cKey, { found: items.length > 0, items } as any);
  return items;
}

export async function fetchPersonWikiCredits(db: D1Database, qid: string | null): Promise<WikiScreenWork[]> {
  const cleanQid = qid && /^Q\d+$/i.test(String(qid)) ? String(qid).toUpperCase() : "";
  if (!cleanQid) return [];
  const cKey = `p_works:${cleanQid}`;
  const cached = await readCache(db, cKey);
  if (cached && Array.isArray((cached as any).items)) return (cached as any).items;

  const sparql = `
SELECT DISTINCT ?work ?workLabel ?imdb ?role
  (SAMPLE(COALESCE(YEAR(?pub), YEAR(?start))) AS ?year)
  (SAMPLE(?article) AS ?wikiArticle)
  (GROUP_CONCAT(DISTINCT ?instLabel; separator=", ") AS ?types)
WHERE {
  { ?work wdt:P86 wd:${cleanQid} . BIND("Score Composer" AS ?role) }
  UNION
  { ?work wdt:P57 wd:${cleanQid} . BIND("Director" AS ?role) }
  UNION
  { ?src wdt:P50 wd:${cleanQid} . ?work wdt:P144 ?src . BIND("Adapted Author" AS ?role) }
  OPTIONAL { ?work wdt:P345 ?imdb . }
  OPTIONAL { ?work wdt:P577 ?pub . }
  OPTIONAL { ?work wdt:P580 ?start . }
  OPTIONAL { ?article schema:about ?work ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?work wdt:P31 ?inst . ?inst rdfs:label ?instLabel . FILTER(LANG(?instLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?work ?workLabel ?imdb ?role LIMIT 18`;

  const json = await fetchJsonPolite(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
    "application/sparql-results+json"
  );
  const rows = (json && json.results && json.results.bindings) || [];
  const items = parseScreenWorks(rows, true);
  await writeCache(db, cKey, { found: items.length > 0, items } as any);
  return items;
}

const NON_PERSON_DESC_RE =
  /\b(disambiguation|municipality|commune|village in|town in|city in|river in|mountain in|studio album|song by|single by|genus of|species of|horologist|clockmaker|carpenter|footballer|cricketer|baseball|basketball|ice hockey|rugby|golfer|politician|senator|congressman|governor|bishop|archbishop)\b/i;

export async function fetchPeoplePortraits(db: D1Database, names: string[] = []) {
  const result = new Map<string, { image: string | null; wikiDesc: string; wikiUrl: string | null }>();
  const uncached: string[] = [];
  const seen = new Set<string>();
  for (const raw of names || []) {
    const n = String(raw || "").trim();
    const low = n.toLowerCase();
    if (!n || seen.has(low)) continue;
    seen.add(low);
    const cached = await readCache(db, `p_img:${low}`);
    if (cached) {
      if (cached.found) {
        result.set(low, { image: cached.thumbnail || null, wikiDesc: cached.description || "", wikiUrl: cached.wikiUrl || null });
      }
    } else {
      uncached.push(n);
    }
    if (uncached.length >= 15) break;
  }
  if (!uncached.length) return result;

  const u =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1" +
    "&titles=" +
    encodeURIComponent(uncached.join("|")) +
    "&prop=pageimages|description|info&inprop=url&piprop=thumbnail&pithumbsize=220";
  const json = await fetchJsonPolite(u);
  const q = (json && json.query) || {};
  const normMap = new Map<string, string>();
  for (const n of q.normalized || []) normMap.set(n.from, n.to);
  const redirMap = new Map<string, string>();
  for (const r of q.redirects || []) redirMap.set(r.from, r.to);

  const byFinalTitle = new Map<string, { image: string | null; wikiDesc: string; wikiUrl: string | null }>();
  for (const p of q.pages || []) {
    if (!p || p.missing) continue;
    const desc = String(p.description || "");
    if (NON_PERSON_DESC_RE.test(desc)) continue;
    byFinalTitle.set(p.title, {
      image: (p.thumbnail && p.thumbnail.source) || null,
      wikiDesc: desc,
      wikiUrl: p.canonicalurl || p.fullurl || null,
    });
  }

  for (const inputName of uncached) {
    let cur = inputName;
    if (normMap.has(cur)) cur = normMap.get(cur)!;
    if (redirMap.has(cur)) cur = redirMap.get(cur)!;
    const hit = byFinalTitle.get(cur) || null;
    const low = inputName.toLowerCase();
    if (hit) {
      await writeCache(db, `p_img:${low}`, {
        found: true,
        thumbnail: hit.image,
        description: hit.wikiDesc,
        wikiUrl: hit.wikiUrl,
      });
      result.set(low, hit);
    } else {
      await writeCache(db, `p_img:${low}`, { found: false });
    }
  }
  return result;
}
