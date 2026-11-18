import * as tvmaze from "./tvmaze";
import * as tmdb from "./tmdb";
import * as itunes from "./itunes";
import * as state from "./state";
import * as store from "./store";
import * as movies from "./movies";
import * as recommender from "./recommender";
import * as wiki from "./wiki";
import * as wp from "./wordpool";
import { safeJsonParse } from "./db";

function hashFloat(str: string): number {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * O(N) deterministic 3D cluster-aware golden spiral placement (sub-1ms on Free Tier Worker).
 * The browser WebGL engine refines spring force layout interactively on receipt.
 */
function assignFastSpiralLayout3D(nodes: any[], edges: any[], { lockSeed = false } = {}) {
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }
  const nTotal = Math.max(1, nodes.length);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    nd.degree = degreeMap.get(nd.key) || nd.degree || 1;
    if (nd.fixed && Number.isFinite(nd.x) && Number.isFinite(nd.y) && Number.isFinite(nd.z)) continue;
    if (nd.seed) {
      nd.x = 0;
      nd.y = 0;
      nd.z = 0;
      continue;
    }
    if (lockSeed) {
      // Outward -Z cone fanning away from the seed camera at (0, 0.8, -5)
      const baseDepth =
        nd.kind === "theme"
          ? 58
          : nd.kind === "person"
          ? 78
          : nd.kind === "source"
          ? 90
          : nd.tracked
          ? 104
          : 120;
      const depth = baseDepth + hashFloat(nd.key) * 52;
      const t = (i + 0.5) / nTotal;
      const radialFrac = 0.22 + 0.44 * Math.sqrt(t);
      const maxR = depth * radialFrac;
      const theta = i * goldenAngle + hashFloat(nd.clusterHint || nd.key) * 1.4;
      nd.x = Math.round(Math.cos(theta) * maxR * 10) / 10;
      nd.y = Math.round(Math.sin(theta) * maxR * 0.72 * 10) / 10;
      nd.z = -Math.round(Math.max(52, depth) * 10) / 10;
      continue;
    }
    const baseR =
      nd.kind === "theme"
        ? 42
        : nd.kind === "person"
        ? 68
        : nd.kind === "source"
        ? 84
        : nd.tracked
        ? 108
        : 145;
    const t = (i + 0.5) / nTotal;
    const yNorm = 1 - 2 * t;
    const radXZ = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));
    const theta = i * goldenAngle + hashFloat(nd.clusterHint || nd.key) * 1.4;
    const r = baseR + hashFloat(nd.key) * 28;
    nd.x = Math.round(Math.cos(theta) * radXZ * r * 10) / 10;
    nd.y = Math.round(yNorm * r * 0.72 * 10) / 10;
    nd.z = Math.round(Math.sin(theta) * radXZ * r * 10) / 10;
  }
}

function makeMediaKey(kind: string, tvmazeId?: number | null, tmdbId?: number | null, name = ""): string {
  const k = kind === "movie" ? "movie" : "show";
  if (k === "show" && tvmazeId) return `show:${tvmazeId}`;
  if (k === "movie" && tmdbId) return `movie:${tmdbId}`;
  return `${k}:${String(name || "item").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

interface LibIndex {
  shows: any[];
  movies: any[];
  pool: any[];
}

async function loadLibraryIndex(db: D1Database): Promise<LibIndex> {
  const [showsList, moviesList, pool] = await Promise.all([
    store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
    movies.listMovies(db, { includeHidden: false }),
    recommender.getPoolItems(db),
  ]);
  return { shows: showsList, movies: moviesList, pool };
}

function findInLibrary(lib: LibIndex, { kind, id, tvmazeId, tmdbId, imdbId, name }: any): { kind: "show" | "movie"; item: any; tracked: boolean } | null {
  const targetName = String(name || "").replace(/\s*\(\d{4}\)$/, "").trim().toLowerCase();
  const numId = Number(tvmazeId || tmdbId || id) || 0;
  if (kind !== "movie") {
    const sh = lib.shows.find(
      (s) =>
        (numId && Number(s.id) === numId) ||
        (imdbId && s.externals?.imdb && s.externals.imdb === imdbId) ||
        (targetName && String(s.name || "").trim().toLowerCase() === targetName)
    );
    if (sh) return { kind: "show", item: sh, tracked: true };
  }
  if (kind !== "show") {
    const mv = lib.movies.find(
      (m) =>
        (numId && Number(m.id) === numId) ||
        (imdbId && m.imdbId && m.imdbId === imdbId) ||
        (targetName && String(m.name || "").trim().toLowerCase() === targetName)
    );
    if (mv) return { kind: "movie", item: mv, tracked: true };
  }
  const pItem = lib.pool.find(
    (p) =>
      (!kind || p.kind === kind) &&
      ((numId && Number(p.tvmazeId || p.tmdbId || p.id) === numId) ||
        (imdbId && p.imdbId && p.imdbId === imdbId) ||
        (targetName && String(p.name || "").trim().toLowerCase() === targetName))
  );
  if (pItem) return { kind: pItem.kind === "movie" ? "movie" : "show", item: pItem, tracked: false };
  return null;
}

function toGalaxyMediaNode(rec: any, tracked = false, extra: Record<string, any> = {}) {
  const isMv = rec.kind === "movie";
  const tvId = !isMv ? Number(rec.tvmazeId || (!rec.tmdbId ? rec.id : 0)) || null : null;
  const tmId = isMv ? Number(rec.tmdbId || rec.id) || null : rec.tmdbId || null;
  const key = rec.key && /^(show|movie):/.test(rec.key) ? rec.key : makeMediaKey(isMv ? "movie" : "show", tvId, tmId, rec.name);
  return {
    key,
    kind: isMv ? "movie" : "show",
    id: isMv ? tmId || rec.id || null : tvId || rec.id || null,
    tvmazeId: tvId,
    tmdbId: tmId,
    imdbId: rec.imdbId || rec.externals?.imdb || null,
    name: rec.name,
    poster: rec.poster || null,
    channelName: rec.channelName || (rec.network && rec.network.name) || (rec.webChannel && rec.webChannel.name) || null,
    premiered: rec.premiered || null,
    status: rec.status || null,
    rating: rec.rating ?? null,
    genres: rec.genres || [],
    summary: wp.stripHtml(rec.summary || "").slice(0, 260),
    tracked: Boolean(tracked),
    favorite: Boolean(rec.favorite),
    size: rec.favorite ? 1.35 : tracked ? 1.12 : 1.02,
    ...extra,
  };
}

function attachWikiLinksInto(rootNode: any, dossier: wiki.WikiDossier | null, addNode: (nd: any) => any, addEdge: (s: string, t: string, k: string, l?: string, w?: number) => void) {
  if (!dossier || !dossier.found || !rootNode || !rootNode.key) return;
  const sourceKeys: string[] = [];
  for (const b of (dossier.basedOn || []).slice(0, 3)) {
    const sk = b.qid ? `source:${b.qid}` : `source:${b.name.toLowerCase()}`;
    addNode({
      key: sk,
      kind: "source",
      qid: b.qid || null,
      name: b.name,
      clusterHint: sk,
      size: 1.12,
      reasons: [`Source material adapted by ${rootNode.name}`],
    });
    addEdge(rootNode.key, sk, "adapted", "Based on", 1.0);
    sourceKeys.push(sk);
  }
  for (const a of (dossier.authors || []).slice(0, 3)) {
    const ak = `person:${a.name.toLowerCase()}`;
    addNode({
      key: ak,
      kind: "person",
      qid: a.qid || null,
      name: a.name,
      role: "Author",
      clusterHint: ak,
      size: 1.02,
      reasons: [`Original author behind ${rootNode.name}`],
    });
    addEdge(sourceKeys[0] || rootNode.key, ak, "author", "Author", 0.95);
  }
  for (const c of (dossier.composers || []).slice(0, 2)) {
    const ck = `person:${c.name.toLowerCase()}`;
    addNode({
      key: ck,
      kind: "person",
      qid: c.qid || null,
      name: c.name,
      role: "Score Composer",
      clusterHint: ck,
      size: 0.98,
      reasons: [`Original music composer for ${rootNode.name}`],
    });
    addEdge(rootNode.key, ck, "composer", "Score Composer", 0.9);
  }
}

function attachLocalSimilarMedia(
  rootNode: any,
  lib: LibIndex,
  addNode: (nd: any) => any,
  addEdge: (s: string, t: string, k: string, l?: string, w?: number) => void,
  maxItems = 12
) {
  const rootGenres = new Set((rootNode.genres || []).map((g: string) => String(g).toLowerCase()));
  const rootThemes = new Set(recommender.normalizeTextThemes(`${rootNode.name || ""} ${rootNode.summary || ""}`));
  const rootName = String(rootNode.name || "").trim().toLowerCase();

  const candidates: Array<{ score: number; tracked: boolean; item: any; kind: "show" | "movie"; shared: string[] }> = [];
  const seen = new Set<string>([rootNode.key]);

  const consider = (raw: any, kind: "show" | "movie", tracked: boolean) => {
    const nm = String(raw.name || "").trim().toLowerCase();
    if (!nm || nm === rootName) return;
    const node = toGalaxyMediaNode({ ...raw, kind }, tracked);
    if (seen.has(node.key)) return;
    seen.add(node.key);

    const gSet = (raw.genres || []).map((g: string) => String(g));
    const shared = gSet.filter((g: string) => rootGenres.has(g.toLowerCase()));
    const textThemes = recommender.normalizeTextThemes(`${raw.name || ""} ${raw.summary || ""}`);
    const sharedThemes = textThemes.filter((t) => rootThemes.has(t));
    const overlap = shared.length + sharedThemes.length * 1.3;
    if (overlap === 0 && (rootGenres.size > 0 || rootThemes.size > 0)) return;

    const score = overlap * 3.2 + (kind === rootNode.kind ? 0.9 : 0) + (Number(raw.rating) || 6) * 0.3 + (tracked ? 0.8 : 0);
    candidates.push({ score, tracked, item: node, kind, shared: [...shared, ...sharedThemes].slice(0, 3) });
  };

  for (const s of lib.shows) consider(s, "show", true);
  for (const m of lib.movies) consider(m, "movie", true);
  for (const p of lib.pool) consider(p, p.kind === "movie" ? "movie" : "show", false);

  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates.slice(0, maxItems)) {
    const label = c.shared.length ? `Shares ${c.shared.slice(0, 2).join(" · ")}` : "Similar";
    addNode({
      ...c.item,
      clusterHint: c.shared[0] ? `theme:${c.shared[0].toLowerCase()}` : rootNode.key,
      reasons: c.shared.length ? [`Shares ${c.shared.join(" · ")} with ${rootNode.name}`] : [`Related to ${rootNode.name}`],
    });
    addEdge(rootNode.key, c.item.key, "cowatch", label, 0.88);
    for (const g of c.shared.slice(0, 1)) {
      const tk = `theme:${String(g).toLowerCase()}`;
      addNode({ key: tk, kind: "theme", name: g.replace(/\b\w/g, (m) => m.toUpperCase()), size: 0.92 });
      addEdge(c.item.key, tk, "theme", g, 0.65);
    }
  }
}

async function expandThemeInto(
  themeNode: any,
  lib: LibIndex,
  apiKey: string,
  addNode: (nd: any) => any,
  addEdge: (s: string, t: string, k: string, l?: string, w?: number) => void,
  maxItems = 20
) {
  const target = String(themeNode.name || "").trim().toLowerCase();
  const tokens = target.split(/[\/,& ]+/).filter((w) => w.length > 2);
  const matchesTheme = (text: string, kwList: any[] = [], genres: any[] = []) => {
    const lowList = [...kwList, ...genres].map((x) => String(typeof x === "string" ? x : x?.name || "").toLowerCase());
    if (lowList.some((x) => x === target || (target.length > 3 && x.includes(target)))) return true;
    const lowText = String(text || "").toLowerCase();
    if (target && lowText.includes(target)) return true;
    if (recommender.normalizeTextThemes(lowText).some((t) => t.toLowerCase() === target)) return true;
    return tokens.length >= 2 && tokens.every((w) => lowText.includes(w));
  };

  const hits: Array<{ score: number; node: any }> = [];
  const seen = new Set<string>();
  const consider = (raw: any, kind: "show" | "movie", tracked: boolean) => {
    const summary = wp.stripHtml(raw.summary || "");
    const genres = raw.genres || [];
    if (!matchesTheme(`${raw.name || ""} ${genres.join(" ")} ${summary}`, raw.keywords || [], genres)) return;
    const node = toGalaxyMediaNode({ ...raw, kind }, tracked, {
      clusterHint: themeNode.key,
      reasons: [`Explores theme "${themeNode.name}"`],
    });
    if (seen.has(node.key)) return;
    seen.add(node.key);
    const exactGenre = genres.some((g: string) => String(g).toLowerCase() === target) ? 4 : 0;
    const score = exactGenre + (Number(raw.rating) || 6) + (tracked ? 1.5 : 0);
    hits.push({ score, node });
  };

  for (const s of lib.shows) consider(s, "show", true);
  for (const m of lib.movies) consider(m, "movie", true);
  for (const p of lib.pool) consider(p, p.kind === "movie" ? "movie" : "show", false);

  if (hits.length < 8) {
    const page0 = await tvmaze.fetchShowsPage(0).catch(() => []);
    for (const s of page0) consider(s, "show", false);
  }
  if (hits.length < 8 && apiKey && themeNode.tmdbKeywordId) {
    const [tvRows, mvRows] = await Promise.all([
      tmdb.discoverDeep(apiKey, "show", { with_keywords: String(themeNode.tmdbKeywordId), sort_by: "vote_average.desc", page: 1 }).catch(() => []),
      tmdb.discoverDeep(apiKey, "movie", { with_keywords: String(themeNode.tmdbKeywordId), sort_by: "vote_average.desc", page: 1 }).catch(() => []),
    ]);
    for (const r of [...tvRows.slice(0, 8), ...mvRows.slice(0, 8)]) consider(r, r.kind === "movie" ? "movie" : "show", false);
  }

  hits.sort((a, b) => b.score - a.score);
  for (const { node } of hits.slice(0, maxItems)) {
    addNode(node);
    addEdge(themeNode.key, node.key, "theme", themeNode.name, 0.92);
    for (const g of (node.genres || []).slice(0, 2)) {
      const gk = `theme:${String(g).toLowerCase()}`;
      if (gk === themeNode.key) continue;
      addNode({ key: gk, kind: "theme", name: g, clusterHint: gk, size: 0.9 });
      addEdge(node.key, gk, "theme", g, 0.55);
    }
  }
}

async function expandPersonInto(
  db: D1Database,
  apiKey: string,
  personNode: any,
  lib: LibIndex,
  addNode: (nd: any) => any,
  addEdge: (s: string, t: string, k: string, l?: string, w?: number) => void,
  { maxItems = 18, skipKey = null }: { maxItems?: number; skipKey?: string | null } = {}
) {
  let tvmId = personNode.tvmazePersonId ? Number(personNode.tvmazePersonId) : null;
  const tmdbPId = personNode.tmdbPersonId ? Number(personNode.tmdbPersonId) : null;
  if (!tvmId && personNode.name) {
    const people = await tvmaze.searchPeople(personNode.name).catch(() => []);
    const low = String(personNode.name).trim().toLowerCase();
    const best = people.find((p) => p.name.toLowerCase() === low) || people[0];
    if (best && best.tvmazePersonId) {
      tvmId = best.tvmazePersonId;
      personNode.tvmazePersonId = tvmId;
      if (!personNode.image && best.image) personNode.image = best.image;
    }
  }

  const [tvCreds, tmdbCreds] = await Promise.all([
    tvmId ? tvmaze.fetchPersonCredits(tvmId).catch(() => []) : Promise.resolve([]),
    tmdbPId && apiKey ? tmdb.fetchPersonCredits(apiKey, tmdbPId).catch(() => []) : Promise.resolve([]),
  ]);

  const dedupe = new Map<string, any>();
  for (const s of tvCreds) {
    const match = findInLibrary(lib, { kind: "show", tvmazeId: s.id, name: s.name });
    dedupe.set(`show:${s.name.toLowerCase()}`, toGalaxyMediaNode({ ...s, kind: "show" }, Boolean(match?.tracked), { creditRole: s.creditRole || "Credit" }));
  }
  for (const m of tmdbCreds) {
    const norm = `${m.kind}:${String(m.name).trim().toLowerCase()}`;
    if (!dedupe.has(norm)) {
      const match = findInLibrary(lib, { kind: m.kind, tmdbId: m.tmdbId, name: m.name });
      dedupe.set(norm, toGalaxyMediaNode(m, Boolean(match?.tracked), { creditRole: m.creditRole || "Credit" }));
    }
  }

  if (dedupe.size < 3 && (personNode.qid || personNode.name)) {
    let pQid = personNode.qid || null;
    if (!pQid && personNode.name) {
      const dos = await wiki.getWikiDossier(db, { kind: "person", name: personNode.name }).catch(() => null);
      if (dos?.qid) pQid = dos.qid;
      if (dos?.thumbnail && !personNode.image) personNode.image = dos.thumbnail;
    }
    if (pQid) {
      const wikiCreds = await wiki.fetchPersonWikiCredits(db, pQid).catch(() => []);
      for (const w of wikiCreds) {
        const local = findInLibrary(lib, { kind: w.kindHint, imdbId: w.imdbId, name: w.name });
        const kind = local ? local.kind : w.kindHint;
        const norm = `${kind}:${w.name.toLowerCase()}`;
        if (dedupe.has(norm)) continue;
        const base = local ? local.item : { name: w.name, kind, imdbId: w.imdbId, premiered: w.year ? String(w.year) : null };
        dedupe.set(norm, toGalaxyMediaNode({ ...base, kind, qid: w.qid, wikiTitle: w.wikiTitle }, Boolean(local?.tracked), { creditRole: w.creditRole || "Credit" }));
      }
    }
  }

  for (const item of [...dedupe.values()].slice(0, maxItems)) {
    if (skipKey && item.key === skipKey) continue;
    addNode({ ...item, clusterHint: personNode.key, reasons: [`${item.creditRole || "Credit"} · ${personNode.name}`] });
    const rel = /creator|showrunner|director|writer|author/i.test(item.creditRole || "") ? "creator" : "credit";
    addEdge(personNode.key, item.key, rel, item.creditRole || "Credit", 0.9);
  }
}

async function expandSourceInto(
  db: D1Database,
  sourceNode: any,
  lib: LibIndex,
  addNode: (nd: any) => any,
  addEdge: (s: string, t: string, k: string, l?: string, w?: number) => void,
  maxItems = 14
) {
  const dossier = await wiki.getWikiDossier(db, {
    kind: "source",
    qid: sourceNode.qid || null,
    wikiTitle: sourceNode.wikiTitle || null,
    name: sourceNode.name,
  }).catch(() => null);
  if (dossier?.found) {
    if (dossier.qid && !sourceNode.qid) sourceNode.qid = dossier.qid;
    if (dossier.wikiTitle && !sourceNode.wikiTitle) sourceNode.wikiTitle = dossier.wikiTitle;
    if (dossier.pubYear && !sourceNode.premiered) sourceNode.premiered = String(dossier.pubYear);
    if (dossier.extract && !sourceNode.summary) sourceNode.summary = dossier.extract;
    for (const a of (dossier.authors || []).slice(0, 4)) {
      const ak = `person:${a.name.toLowerCase()}`;
      addNode({
        key: ak,
        kind: "person",
        qid: a.qid || null,
        name: a.name,
        role: "Author",
        clusterHint: ak,
        size: 1.1,
        reasons: [`Author of ${sourceNode.name}`],
      });
      addEdge(sourceNode.key, ak, "author", "Author", 1.0);
    }
  }

  const effectiveQid = sourceNode.qid || dossier?.qid || null;
  let addedCount = 0;
  if (effectiveQid) {
    const adaptations = await wiki.fetchSourceAdaptations(db, effectiveQid).catch(() => []);
    for (const ad of adaptations.slice(0, maxItems)) {
      const local = findInLibrary(lib, { kind: ad.kindHint, imdbId: ad.imdbId, name: ad.name });
      const kind = local ? local.kind : ad.kindHint;
      const base = local ? local.item : { name: ad.name, kind, imdbId: ad.imdbId, premiered: ad.year ? String(ad.year) : null };
      const node = toGalaxyMediaNode({ ...base, kind, qid: ad.qid, wikiTitle: ad.wikiTitle }, Boolean(local?.tracked), {
        clusterHint: sourceNode.key,
        reasons: [`Adapted from ${sourceNode.name}`],
      });
      addNode(node);
      addEdge(sourceNode.key, node.key, "adapted", "Adaptation", 1.05);
      addedCount++;
    }
  }

  if (addedCount === 0 && sourceNode.name) {
    const q = String(sourceNode.name).trim().toLowerCase();
    for (const raw of [...lib.shows, ...lib.movies, ...lib.pool]) {
      const hay = `${raw.name || ""} ${wp.stripHtml(raw.summary || "")}`.toLowerCase();
      if (!hay.includes(q)) continue;
      const node = toGalaxyMediaNode(raw, lib.shows.includes(raw) || lib.movies.includes(raw), {
        clusterHint: sourceNode.key,
        reasons: [`Matches "${sourceNode.name}"`],
      });
      addNode(node);
      addEdge(sourceNode.key, node.key, "adapted", "Related", 0.85);
      if (++addedCount >= 8) break;
    }
  }
}

function disambiguateMediaNodes(nodes: any[]) {
  const byTitle = new Map<string, any[]>();
  for (const n of nodes) {
    if (n.kind !== "show" && n.kind !== "movie" && n.kind !== "source") continue;
    const base = String(n.name || "").trim().toLowerCase();
    if (!base) continue;
    if (!byTitle.has(base)) byTitle.set(base, []);
    byTitle.get(base)!.push(n);
  }
  for (const [, group] of byTitle) {
    if (group.length < 2) continue;
    for (const n of group) {
      const yr = String(n.premiered || "").slice(0, 4);
      const tag = yr || (n.kind === "movie" ? "Film" : "TV");
      n.displayName = `${n.name} (${tag})`;
    }
  }
}

function buildNebulaClusters(nodes: any[]) {
  const hubs = nodes
    .filter((n) => n.kind === "theme" || (n.kind === "person" && (n.degree || 0) >= 2) || n.seed)
    .sort((a, b) => (b.degree || 1) - (a.degree || 1))
    .slice(0, 7);
  return hubs.map((h) => ({
    id: `cl:${h.key}`,
    label: h.name,
    kind: h.kind,
    x: h.x || 0,
    y: h.y || 0,
    z: h.z || 0,
    radius: h.seed ? 58 : 46 + Math.min(26, (h.degree || 1) * 4),
  }));
}

async function enrichThermalAndWordPool(
  db: D1Database,
  nodes: any[],
  { wpEntries, watchedSets, profile }: { wpEntries: wp.WordPoolEntry[]; watchedSets: { episodes: Set<number>; movies: Set<number> }; profile: any }
) {
  const curYear = new Date().getFullYear();
  const wpActive = wpEntries.some((e) => e.enabled);

  // Batch count unwatched episodes only for the show IDs in this graph (avoids full 33k+ table scans)
  const uniqueShowIds = [...new Set(nodes.filter((n) => n.kind === "show" && n.tvmazeId).map((n) => Number(n.tvmazeId)))].slice(0, 80);
  const totalEpMap = new Map<number, number>();
  for (let i = 0; i < uniqueShowIds.length; i += 40) {
    const chunk = uniqueShowIds.slice(i, i + 40);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const { results } = await db
      .prepare(`SELECT show_id, COUNT(*) as c FROM episodes WHERE show_id IN (${placeholders}) GROUP BY show_id`)
      .bind(...chunk)
      .all<{ show_id: number; c: number }>();
    for (const r of results || []) totalEpMap.set(Number(r.show_id), Number(r.c));
  }

  for (const nd of nodes) {
    if (!nd) continue;
    let wpHit: wp.WordPoolResult | null = null;
    if (wpActive) {
      wpHit = wp.matchItemWithEntries(wpEntries, nd);
      if (wpHit.primary || wpHit.fuzzy) {
        nd.wordPool = {
          primary: Boolean(wpHit.primary),
          fuzzy: Boolean(wpHit.fuzzy),
          primaryMatches: wpHit.primaryMatches,
          fuzzyMatches: wpHit.fuzzyMatches,
        };
      }
    }

    let affinity = 48;
    if (nd.hidden) affinity = 4;
    else if (wpHit && wpHit.primary) affinity = 100;
    else if (nd.favorite || nd.loved) affinity = Math.max(92, nd.matchPct || 94);
    else if (nd.matchPct) affinity = Math.max(25, Math.min(99, Number(nd.matchPct)));
    else if (nd.kind === "theme" || nd.kind === "person") {
      const pref = nd.kind === "theme" ? "kw:" : "creator:";
      const w = profile?.weights?.get(`${pref}${String(nd.name || "").toLowerCase()}`) || 0;
      affinity = w > 0 ? Math.min(96, Math.round(58 + w * 14)) : Math.min(84, 34 + (nd.degree || 1) * 11);
    } else if (nd.tracked) affinity = 72;
    else affinity = Math.min(82, 42 + Math.round((Number(nd.rating) || 6) * 4));
    if (wpHit && wpHit.fuzzy && !nd.hidden) affinity = Math.min(99, affinity + 12);

    const yr = Number(String(nd.premiered || "").slice(0, 4)) || 0;
    const yrScore = yr ? Math.max(0, Math.min(40, 40 - Math.max(0, curYear - yr) * 2.5)) : 14;
    let momentum = yrScore + (nd.rating ? Math.max(0, (Number(nd.rating) - 5) * 4) : 10);
    if (/running|returning/i.test(nd.status || "")) momentum += 22;
    if (nd.kind === "person" || nd.kind === "theme") momentum = Math.min(92, 28 + (nd.degree || 1) * 12);
    momentum = Math.max(5, Math.min(100, Math.round(momentum)));

    let backlog = 28;
    if (nd.hidden || nd.seen) backlog = 8;
    else if (nd.kind === "show" && nd.tvmazeId && totalEpMap.has(Number(nd.tvmazeId))) {
      backlog = Math.min(100, 34 + Math.min(16, totalEpMap.get(Number(nd.tvmazeId))!) * 4);
    } else if (nd.kind === "movie" && nd.tracked) {
      backlog = watchedSets.movies.has(Number(nd.tmdbId || nd.id)) ? 10 : 88;
    } else if (nd.kind === "show" || nd.kind === "movie") {
      backlog = nd.matchPct ? Math.min(96, 48 + Math.round((nd.matchPct - 60) * 1.1)) : 54;
    } else {
      backlog = Math.min(80, 26 + (nd.degree || 1) * 10);
    }
    if (wpHit && wpHit.primary && !nd.hidden) backlog = Math.max(backlog, 90);

    let lore = Math.min(68, 18 + (nd.degree || 1) * 9);
    if (wpHit && wpHit.primary) lore = 100;
    else if (wpHit && wpHit.fuzzy) lore = Math.max(lore, 82);
    lore = Math.max(6, Math.min(100, Math.round(lore)));

    nd.heat = {
      affinity: Math.max(0, Math.min(100, Math.round(affinity))),
      momentum,
      backlog: Math.max(0, Math.min(100, Math.round(backlog))),
      lore,
    };
  }
}

export async function buildTasteGalaxy(db: D1Database, apiKey = "", { showDarkMatter = false } = {}) {
  const [showsList, moviesList, hiddenSets, watchedSets, profile, rec, wpEntries] = await Promise.all([
    store.listShows(db, { includeHidden: false, includeNextEpisode: false }),
    movies.listMovies(db, { includeHidden: false }),
    state.loadHiddenSets(db),
    state.getWatchedSets(db),
    recommender.buildProfile(db, apiKey),
    recommender.getRecommendations(db, { apiKey, media: "all", lens: "mix", limit: 18 }),
    wp.loadEntries(db),
  ]);

  const nodesMap = new Map<string, any>();
  const edges: any[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (nd: any) => {
    if (!nd || !nd.key) return;
    if (!nodesMap.has(nd.key)) nodesMap.set(nd.key, { ...nd });
    else Object.assign(nodesMap.get(nd.key), { ...nd, ...nodesMap.get(nd.key) });
  };
  const addEdge = (source: string, target: string, kind: string, label = "", weight = 0.7) => {
    if (!source || !target || source === target) return;
    const ek = source < target ? `${source}<->${target}:${kind}` : `${target}<->${source}:${kind}`;
    if (edgeKeys.has(ek)) return;
    edgeKeys.add(ek);
    edges.push({ source, target, kind, rel: kind, label, weight });
  };

  const featuredShows = [...showsList]
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (Number(b.rating) || 0) - (Number(a.rating) || 0) || (b.weight || 0) - (a.weight || 0))
    .slice(0, 28);

  for (const s of featuredShows) {
    const k = `show:${s.id}`;
    addNode({
      key: k,
      kind: "show",
      id: s.id,
      tvmazeId: s.id,
      imdbId: s.externals?.imdb || null,
      name: s.name,
      poster: s.poster || null,
      channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
      premiered: s.premiered || null,
      status: s.status || null,
      rating: s.rating || null,
      genres: s.genres || [],
      tracked: true,
      favorite: Boolean(s.favorite),
      size: s.favorite ? 1.4 : 1.05,
    });
    for (const g of (s.genres || []).slice(0, 2)) {
      const tk = `theme:${String(g).toLowerCase()}`;
      addNode({ key: tk, kind: "theme", name: g, themeGroup: "genre", clusterHint: tk, size: 1.0 });
      addEdge(k, tk, "theme", g, 0.7);
    }
  }

  for (const m of moviesList.slice(0, 20)) {
    const k = `movie:${m.id}`;
    addNode({
      key: k,
      kind: "movie",
      id: m.id,
      tmdbId: m.id,
      imdbId: m.imdbId || null,
      name: m.name,
      poster: m.poster || null,
      channelName: m.channelName || null,
      premiered: m.premiered || null,
      rating: m.rating || null,
      genres: m.genres || [],
      tracked: true,
      favorite: Boolean(m.favorite),
      size: m.favorite ? 1.4 : 1.05,
    });
    for (const g of (m.genres || []).slice(0, 2)) {
      const tk = `theme:${String(g).toLowerCase()}`;
      addNode({ key: tk, kind: "theme", name: g, themeGroup: "genre", clusterHint: tk, size: 1.0 });
      addEdge(k, tk, "theme", g, 0.7);
    }
  }

  for (const c of rec.items.slice(0, 18)) {
    const k = c.key || `${c.kind}:${c.id}`;
    addNode({
      key: k,
      kind: c.kind === "movie" ? "movie" : "show",
      id: c.id,
      tvmazeId: c.tvmazeId || null,
      tmdbId: c.tmdbId || null,
      imdbId: c.imdbId || null,
      name: c.name,
      poster: c.poster || null,
      channelName: c.channelName || null,
      premiered: c.premiered || null,
      rating: c.rating || null,
      genres: c.genres || [],
      matchPct: c.matchPct,
      tracked: false,
      size: 1.05,
    });
    for (const g of (c.genres || []).slice(0, 2)) {
      const tk = `theme:${String(g).toLowerCase()}`;
      addNode({ key: tk, kind: "theme", name: g, themeGroup: "genre", clusterHint: tk, size: 0.95 });
      addEdge(k, tk, "theme", g, 0.65);
    }
  }

  if (showDarkMatter) {
    hiddenSets.items.slice(0, 16).forEach((h, idx) => {
      const hk = `hidden:${h.kind}:${h.id}`;
      const ang = (idx / 16) * Math.PI * 2;
      addNode({
        key: hk,
        kind: h.kind,
        tvmazeId: h.kind === "show" ? h.id : null,
        tmdbId: h.kind === "movie" ? h.id : null,
        name: h.name,
        poster: h.poster || null,
        channelName: h.channelName || null,
        premiered: h.premiered || null,
        hidden: true,
        fixed: true,
        size: 0.72,
        x: Math.cos(ang) * 215,
        y: (hashFloat(hk) - 0.5) * 45,
        z: Math.sin(ang) * 215,
      });
    });
  }

  const finalNodes = [...nodesMap.values()];
  disambiguateMediaNodes(finalNodes);
  assignFastSpiralLayout3D(finalNodes, edges);
  await enrichThermalAndWordPool(db, finalNodes, { wpEntries, watchedSets, profile });

  return {
    mode: "taste",
    title: showsList.length + moviesList.length === 0 ? "Discovery Starter Galaxy" : "Your Taste Nebula",
    clientLayoutNeeded: true,
    nodes: finalNodes,
    edges,
    clusters: buildNebulaClusters(finalNodes),
  };
}

export async function buildSeedGalaxy(
  db: D1Database,
  apiKey: string,
  {
    seedKind = "show",
    seedId = null,
    seedTmdbId = null,
    seedKeywordId = null,
    seedQid = null,
    seedWikiTitle = null,
    seedName = "",
    imdbId = null,
  }: Record<string, any>
) {
  const [watchedSets, wpEntries, profile, lib] = await Promise.all([
    state.getWatchedSets(db),
    wp.loadEntries(db),
    recommender.buildProfile(db, apiKey),
    loadLibraryIndex(db),
  ]);

  const nodesMap = new Map<string, any>();
  const edges: any[] = [];
  const edgeKeys = new Set<string>();
  const addNode = (nd: any) => {
    if (!nd || !nd.key) return null;
    if (!nodesMap.has(nd.key)) nodesMap.set(nd.key, { ...nd });
    else Object.assign(nodesMap.get(nd.key), { ...nd, ...nodesMap.get(nd.key) });
    return nodesMap.get(nd.key);
  };
  const addEdge = (source: string, target: string, kind: string, label = "", weight = 0.8) => {
    if (!source || !target || source === target) return;
    const ek = source < target ? `${source}<->${target}:${kind}` : `${target}<->${source}:${kind}`;
    if (edgeKeys.has(ek)) return;
    edgeKeys.add(ek);
    edges.push({ source, target, kind, rel: kind, label, weight });
  };

  let rootKey = "";
  let title = seedName || "Seed Galaxy";

  if (seedKind === "source") {
    const sName = seedName || "Source Work";
    rootKey = seedQid ? `source:${seedQid}` : `source:${sName.toLowerCase()}`;
    const sNode = addNode({
      key: rootKey,
      kind: "source",
      qid: seedQid || null,
      wikiTitle: seedWikiTitle || null,
      name: sName,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 1.8,
    });
    await expandSourceInto(db, sNode, lib, addNode, addEdge, 16);
    title = sNode?.name || title;
  } else if (seedKind === "theme") {
    const tName = seedName || "Theme Nebula";
    rootKey = `theme:${tName.toLowerCase()}`;
    const tNode = addNode({
      key: rootKey,
      kind: "theme",
      tmdbKeywordId: seedKeywordId ? Number(seedKeywordId) : null,
      name: tName,
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 1.8,
    });
    await expandThemeInto(tNode, lib, apiKey, addNode, addEdge, 22);
    title = tNode?.name || title;
  } else if (seedKind === "person") {
    const pName = seedName || `Person #${seedId || seedTmdbId || ""}`;
    rootKey = `person:${pName.toLowerCase()}`;
    const pNode = addNode({
      key: rootKey,
      kind: "person",
      tvmazePersonId: seedId ? Number(seedId) : null,
      tmdbPersonId: seedTmdbId ? Number(seedTmdbId) : null,
      qid: seedQid || null,
      wikiTitle: seedWikiTitle || null,
      name: pName,
      role: "Creator / Cast",
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 1.8,
    });
    await expandPersonInto(db, apiKey, pNode, lib, addNode, addEdge, { maxItems: 22 });
    title = pNode?.name || title;
  } else {
    const rich = await getRichItemDetails(db, apiKey, {
      kind: seedKind === "movie" ? "movie" : "show",
      id: seedId ? Number(seedId) : null,
      tvmazeId: seedKind === "show" && seedId ? Number(seedId) : null,
      tmdbId: seedTmdbId ? Number(seedTmdbId) : seedKind === "movie" && seedId ? Number(seedId) : null,
      imdbId,
      name: seedName,
    });
    const mId = rich?.tvmazeId || rich?.tmdbId || seedId || null;
    rootKey = makeMediaKey(seedKind === "movie" ? "movie" : "show", rich?.tvmazeId, rich?.tmdbId, rich?.name || seedName);
    const localMatch = findInLibrary(lib, { kind: seedKind, id: mId, tvmazeId: rich?.tvmazeId, tmdbId: rich?.tmdbId, imdbId: rich?.imdbId || imdbId, name: rich?.name || seedName });
    const rootNode = addNode({
      key: rootKey,
      kind: seedKind === "movie" ? "movie" : "show",
      id: mId,
      tvmazeId: rich?.tvmazeId || null,
      tmdbId: rich?.tmdbId || null,
      imdbId: rich?.imdbId || imdbId || null,
      name: rich?.name || seedName || "Seed",
      poster: rich?.poster || null,
      channelName: (rich?.studios && rich.studios[0]) || null,
      premiered: rich?.premiered || null,
      rating: rich?.rating ?? null,
      genres: rich?.genres || [],
      summary: wp.stripHtml(rich?.summary || "").slice(0, 320),
      tracked: Boolean(localMatch?.tracked),
      seed: true,
      fixed: true,
      x: 0,
      y: 0,
      z: 0,
      size: 1.8,
    });
    title = rootNode?.name || title;

    if (rich) {
      for (const p of [...(rich.creatorPeople || []), ...(rich.castPeople || [])].slice(0, 8)) {
        const pk = `person:${String(p.name).toLowerCase()}`;
        const isCreator = /creator|showrunner|director|writer|author|producer/i.test(p.role || "");
        addNode({
          key: pk,
          kind: "person",
          name: p.name,
          role: p.role,
          image: p.image || null,
          tvmazePersonId: p.id || null,
          tmdbPersonId: p.tmdbPersonId || null,
          qid: p.qid || null,
          size: isCreator ? 1.08 : 0.95,
        });
        addEdge(rootKey, pk, isCreator ? "creator" : "cast", p.role || "Credit", 0.9);
      }
      for (const kw of [...(rich.genres || []), ...(rich.keywords || []).map((k: any) => k.name || k)].slice(0, 6)) {
        const tk = `theme:${String(kw).toLowerCase()}`;
        addNode({ key: tk, kind: "theme", name: String(kw), size: 0.95 });
        addEdge(rootKey, tk, "theme", String(kw), 0.75);
      }
      if (rich.wikiDossier) {
        attachWikiLinksInto(rootNode, rich.wikiDossier, addNode, addEdge);
      }
    }
    attachLocalSimilarMedia(rootNode, lib, addNode, addEdge, 12);
  }

  const finalNodes = [...nodesMap.values()];
  disambiguateMediaNodes(finalNodes);
  assignFastSpiralLayout3D(finalNodes, edges, { lockSeed: true });
  await enrichThermalAndWordPool(db, finalNodes, { wpEntries, watchedSets, profile });

  return {
    mode: "seed",
    title,
    seedKey: rootKey,
    clientLayoutNeeded: true,
    nodes: finalNodes,
    edges,
    clusters: buildNebulaClusters(finalNodes),
  };
}

export async function expandNode(
  db: D1Database,
  apiKey: string,
  { node = {}, existingKeys = [], includeWiki = false }: { node?: any; existingKeys?: string[]; includeWiki?: boolean }
) {
  const lib = await loadLibraryIndex(db);
  const existing = new Set(existingKeys);
  const newNodes: any[] = [];
  const newEdges: any[] = [];
  const edgeKeys = new Set<string>();
  const add = (nd: any, edgeKind = "", label = "") => {
    if (!nd || !nd.key) return null;
    if (!existing.has(nd.key)) {
      existing.add(nd.key);
      newNodes.push(nd);
    }
    if (edgeKind && node.key && nd.key !== node.key) {
      addEdge(node.key, nd.key, edgeKind, label, 0.85);
    }
    return nd;
  };
  const addNodeOnly = (nd: any) => {
    if (!nd || !nd.key || nd.key === node.key) return nd;
    if (existing.has(nd.key)) return nd;
    existing.add(nd.key);
    newNodes.push(nd);
    return nd;
  };
  const addEdge = (source: string, target: string, kind: string, label = "", weight = 0.85) => {
    if (!source || !target || source === target) return;
    const ek = source < target ? `${source}<->${target}:${kind}` : `${target}<->${source}:${kind}`;
    if (edgeKeys.has(ek)) return;
    edgeKeys.add(ek);
    newEdges.push({ source, target, kind, rel: kind, label, weight });
  };

  if (node.kind === "source") {
    await expandSourceInto(db, { ...node }, lib, addNodeOnly, addEdge, 14);
  } else if (node.kind === "theme") {
    await expandThemeInto(node, lib, apiKey, addNodeOnly, addEdge, 16);
  } else if (node.kind === "person") {
    await expandPersonInto(db, apiKey, { ...node }, lib, addNodeOnly, addEdge, { maxItems: 16, skipKey: node.key });
  } else if (node.kind === "show" || node.kind === "movie") {
    const rich = await getRichItemDetails(db, apiKey, {
      kind: node.kind,
      id: node.id || null,
      tvmazeId: node.tvmazeId || null,
      tmdbId: node.tmdbId || null,
      imdbId: node.imdbId || null,
      name: node.name || "",
      year: String(node.premiered || "").slice(0, 4),
    });
    for (const p of [...(rich.creatorPeople || []), ...(rich.castPeople || [])].slice(0, 6)) {
      const isCreator = /creator|showrunner|director|writer|author|producer/i.test(p.role || "");
      add(
        {
          key: `person:${p.name.toLowerCase()}`,
          kind: "person",
          name: p.name,
          image: p.image || null,
          role: p.role,
          tvmazePersonId: p.id || null,
          tmdbPersonId: p.tmdbPersonId || null,
          qid: p.qid || null,
        },
        isCreator ? "creator" : "cast",
        p.role || "Credit"
      );
    }
    if (includeWiki && rich.wikiDossier) {
      attachWikiLinksInto(node, rich.wikiDossier, addNodeOnly, addEdge);
    } else if (rich.wikiDossier?.basedOn) {
      for (const b of rich.wikiDossier.basedOn.slice(0, 2)) {
        add({ key: `source:${b.qid}`, kind: "source", qid: b.qid, name: b.name, size: 1.0 }, "adapted", "Adapted From");
      }
    }
    attachLocalSimilarMedia({ ...node, genres: rich.genres || node.genres || [], summary: rich.summary || node.summary || "" }, lib, addNodeOnly, addEdge, 6);
  }

  assignFastSpiralLayout3D([node, ...newNodes], newEdges, {
    lockSeed: Boolean(node?.seed || (Number.isFinite(node?.z) && node.z < -30)),
  });
  return { nodes: newNodes, edges: newEdges };
}

export async function searchEntities(db: D1Database, apiKey: string, q: string) {
  const query = String(q || "").trim();
  if (query.length < 2) return [];
  const [showsRes, peopleRes, moviesRes] = await Promise.all([
    tvmaze.searchShows(query).catch(() => []),
    tvmaze.searchPeople(query).catch(() => []),
    apiKey ? tmdb.searchMovies(apiKey, query).catch(() => []) : itunes.searchMovies(query, 4).catch(() => []),
  ]);
  const out: any[] = [];
  for (const s of showsRes.slice(0, 5)) {
    const slim = tvmaze.slimShow(s.show);
    out.push({ kind: "show", id: slim.id, tvmazeId: slim.id, name: slim.name, premiered: slim.premiered, poster: slim.poster, rating: slim.rating });
  }
  for (const m of moviesRes.slice(0, 4)) {
    out.push({
      kind: "movie",
      id: m.id,
      tmdbId: m.id < itunes.IMDB_MOVIE_BASE_ID ? m.id : null,
      imdbId: (m as any).imdbId || null,
      name: m.name,
      premiered: m.premiered,
      poster: m.poster,
      rating: m.rating,
    });
  }
  for (const p of peopleRes.slice(0, 4)) {
    out.push({ kind: "person", tvmazePersonId: p.tvmazePersonId, name: p.name, image: p.image, subtitle: p.country || "Person" });
  }
  return out;
}

export async function getRichItemDetails(
  db: D1Database,
  apiKey: string,
  {
    kind = "show",
    id = null,
    tvmazeId = null,
    tmdbId = null,
    imdbId = null,
    name = "",
    year = "",
  }: { kind?: string; id?: number | null; tvmazeId?: number | null; tmdbId?: number | null; imdbId?: string | null; name?: string; year?: string }
) {
  const k = kind === "movie" ? "movie" : "show";
  let tvId = k === "show" ? Number(tvmazeId || id) || null : null;
  let tmId = Number(tmdbId || (k === "movie" ? id : 0)) || null;
  let knownImdb = imdbId || null;
  let fallbackName = name;
  let fallbackYear = year;

  if (k === "show" && tvId) {
    const row = await store.getShowRow(db, tvId);
    if (row) {
      const sh = safeJsonParse<any>(row.data_json, {});
      fallbackName = fallbackName || sh.name || "";
      fallbackYear = fallbackYear || String(sh.premiered || "").slice(0, 4);
      knownImdb = knownImdb || sh.externals?.imdb || null;
    }
  }

  let base: any = {
    kind: k,
    tvmazeId: tvId,
    tmdbId: tmId,
    imdbId: knownImdb,
    name: fallbackName,
    premiered: fallbackYear,
    genres: [],
    studios: [],
    tagline: "",
    summary: "",
    castPeople: [],
    creatorPeople: [],
    keywords: [],
  };

  if (k === "show") {
    if (!tvId && fallbackName) {
      const resolved = await tvmaze.resolveShow({ imdbId: knownImdb, name: fallbackName, year: fallbackYear }).catch(() => null);
      if (resolved) tvId = resolved.id;
    }
    if (tvId) {
      const people = await tvmaze.fetchShowPeople(tvId).catch(() => null);
      if (people) {
        base = {
          ...base,
          tvmazeId: tvId,
          imdbId: people.show.externals?.imdb || knownImdb,
          name: people.show.name || fallbackName,
          premiered: people.show.premiered || fallbackYear,
          genres: people.show.genres || [],
          poster: people.show.poster,
          posterLarge: people.show.posterLarge,
          background: people.show.background,
          rating: people.show.rating,
          status: people.show.status,
          runtime: people.show.runtime,
          summary: people.show.summary || "",
          castPeople: people.castPeople,
          creatorPeople: people.crewPeople,
          studios: [people.show.network?.name || people.show.webChannel?.name].filter(Boolean),
        };
      }
    }
  } else {
    const lib = await loadLibraryIndex(db);
    const local = findInLibrary(lib, { kind: "movie", id: tmId, tmdbId: tmId, imdbId: knownImdb, name: fallbackName });
    if (local?.item) {
      const mv = local.item;
      base = {
        ...base,
        tmdbId: Number(mv.tmdbId || mv.id) || tmId,
        imdbId: mv.imdbId || knownImdb,
        name: mv.name || fallbackName,
        premiered: mv.premiered || mv.airdate || fallbackYear,
        genres: mv.genres || [],
        poster: mv.poster || null,
        posterLarge: mv.posterLarge || null,
        background: mv.background || null,
        rating: mv.rating ?? null,
        status: mv.status || null,
        runtime: mv.runtime ?? null,
        summary: mv.summary || "",
        studios: [mv.channelName, ...(mv.studios || [])].filter(Boolean),
      };
      knownImdb = base.imdbId || knownImdb;
      fallbackName = base.name || fallbackName;
      fallbackYear = String(base.premiered || fallbackYear || "").slice(0, 4);
    }
    if (apiKey) {
      if (!tmId && fallbackName) {
        tmId = await tmdb.findMovieByExternal(apiKey, { imdb: knownImdb, name: fallbackName, year: fallbackYear }).catch(() => null);
      }
      if (tmId && tmId < itunes.ITUNES_ID_MIN) {
        const deep = await tmdb.fetchDeepProfile(apiKey, "movie", tmId).catch(() => null);
        if (deep) {
          base = { ...base, ...deep, tmdbId: tmId };
        }
      }
    } else if (!base.poster && fallbackName) {
      const fresh =
        (tmId && tmId >= itunes.ITUNES_ID_MIN ? await itunes.lookupMovie(tmId).catch(() => null) : null) ||
        (await itunes.searchMovies(fallbackName, 2).catch(() => []))[0] ||
        null;
      if (fresh) {
        base = {
          ...base,
          tmdbId: base.tmdbId || fresh.id,
          imdbId: base.imdbId || (fresh as any).imdbId || null,
          name: base.name || fresh.name,
          premiered: base.premiered || fresh.premiered,
          genres: base.genres?.length ? base.genres : fresh.genres || [],
          poster: base.poster || fresh.poster,
          background: base.background || fresh.background,
          rating: base.rating ?? fresh.rating,
          summary: base.summary || fresh.summary || "",
          studios: base.studios?.length ? base.studios : [fresh.channelName].filter(Boolean),
        };
      }
    }
  }

  const dossier = await wiki.getWikiDossier(db, {
    kind: k,
    name: base.name || fallbackName,
    year: String(base.premiered || fallbackYear || "").slice(0, 4),
    imdbId: base.imdbId || knownImdb || null,
  });

  if (dossier?.found) {
    if (!base.summary && dossier.extract) base.summary = dossier.extract;
    const seenCreators = new Set((base.creatorPeople || []).map((p: any) => String(p.name || "").toLowerCase()));
    const pushWikiPerson = (name: string, role: string, qid?: string) => {
      const low = String(name || "").trim().toLowerCase();
      if (!low || seenCreators.has(low)) return;
      seenCreators.add(low);
      base.creatorPeople.push({ id: null, tmdbPersonId: null, qid: qid || null, name, image: null, role });
    };
    for (const d of dossier.directors || []) pushWikiPerson(d.name, "Director", d.qid);
    for (const w of dossier.writers || []) pushWikiPerson(w.name, "Writer", w.qid);
    for (const a of dossier.authors || []) pushWikiPerson(a.name, "Author", a.qid);
    for (const c of dossier.composers || []) pushWikiPerson(c.name, "Score Composer", c.qid);
  }

  const portraits = await wiki
    .fetchPeoplePortraits(
      db,
      [...(base.creatorPeople || []), ...(base.castPeople || [])].map((p: any) => p.name).slice(0, 12)
    )
    .catch(() => new Map());

  for (const p of [...(base.creatorPeople || []), ...(base.castPeople || [])]) {
    const hit = portraits.get(String(p.name || "").toLowerCase());
    if (hit && !p.image && hit.image) p.image = hit.image;
    if (hit && hit.wikiUrl) p.wikiUrl = hit.wikiUrl;
  }

  return { ...base, wikiDossier: dossier };
}
