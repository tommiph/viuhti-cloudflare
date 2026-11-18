import { runChunkedBatch, safeJsonParse, l1Cached, l1Invalidate } from "./db";

const MAX_ENTRIES = 120;

export const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where", "which", "while", "about",
  "after", "before", "their", "there", "these", "those", "have", "has", "had", "were", "been", "being",
  "will", "would", "could", "should", "must", "over", "under", "between", "through", "during", "against",
  "other", "some", "more", "most", "such", "only", "than", "then", "very", "just", "also", "even", "back",
  "they", "them", "what", "your", "life", "world", "story", "series", "show", "season", "episode", "episodes",
  "movie", "film", "finds", "find", "live", "lives", "year", "years", "time", "young", "woman", "man",
  "family", "home", "make", "makes", "takes", "take", "goes", "comes", "two", "three", "one", "new", "old",
  "high", "good", "great", "best", "real", "true", "help", "turns", "sets", "first", "last", "aftermath",
  "becomes", "discover", "discovers", "forced", "secret", "secrets", "begins", "following", "amid", "together",
  "television", "american", "british", "drama", "comedy", "action", "adventure",
]);

export interface WordPoolEntry {
  id: string;
  term: string;
  mode: "primary" | "fuzzy" | "exclude";
  aliases: string[];
  excludeTerms: string[];
  enabled: boolean;
  weight: number;
  createdAt: number;
  updatedAt: number;
}

export interface WordPoolMatchHit {
  entryId: string;
  mode: "primary" | "fuzzy";
  label: string;
  term: string;
  weight: number;
  field: string;
  matchedText: string;
  confidence: number;
  snippet: string;
}

export interface WordPoolResult {
  primary: boolean;
  fuzzy: boolean;
  excluded: boolean;
  primaryMatches: WordPoolMatchHit[];
  fuzzyMatches: WordPoolMatchHit[];
  excludeMatches: Array<{ entryId: string; term: string; field: string; matchedText: string; confidence: number; snippet: string }>;
}

export function stripHtml(html: unknown): string {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function normText(str: unknown): string {
  return stripHtml(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(str: unknown): string[] {
  const n = normText(str);
  return n ? n.split(" ") : [];
}

function damerauLevenshtein(a: string, b: string, maxDist = 2): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  if (a === b) return 0;
  const dp = Array.from({ length: al + 1 }, () => new Int16Array(bl + 1));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    let rowMin = maxDist + 1;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[al][bl];
}

function bigramDice(a: string, b: string): number {
  if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
  const mapA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    mapA.set(bg, (mapA.get(bg) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const c = mapA.get(bg) || 0;
    if (c > 0) {
      hits++;
      mapA.set(bg, c - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function tokenSimilarity(queryTok: string, candTok: string): number {
  if (!queryTok || !candTok) return 0;
  if (queryTok === candTok) return 1;
  const qLen = queryTok.length;
  const cLen = candTok.length;
  if (qLen >= 4 && cLen >= 4 && candTok.startsWith(queryTok)) return 0.9;
  const maxDist = Math.max(qLen, cLen) >= 7 ? 2 : Math.max(qLen, cLen) >= 4 ? 1 : 0;
  if (maxDist > 0) {
    const dist = damerauLevenshtein(queryTok, candTok, maxDist);
    if (dist <= maxDist) return Math.max(0.7, 1 - dist * 0.14);
  }
  if (qLen >= 5 && cLen >= 5 && Math.abs(qLen - cLen) <= 3) {
    const dice = bigramDice(queryTok, candTok);
    if (dice >= 0.78) return dice * 0.92;
  }
  return 0;
}

function makeSnippet(rawText: string, matchText: string): string {
  const clean = stripHtml(rawText);
  if (!clean) return "";
  if (!matchText) return clean.slice(0, 120);
  const idx = clean.toLowerCase().indexOf(String(matchText).toLowerCase());
  if (idx < 0) return clean.slice(0, 120);
  const start = Math.max(0, idx - 36);
  const end = Math.min(clean.length, idx + String(matchText).length + 52);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

export function parseRuleInput(rawTerm: unknown, { excludeTerms = [], aliases = [] }: { excludeTerms?: unknown; aliases?: unknown } = {}) {
  let termStr = String(rawTerm || "").trim();
  const inlineExcludes: string[] = [];
  const noSplit = termStr.match(/^(.+?)\s+\bNO\b(?::|\s)+(.+)$/);
  if (noSplit) {
    termStr = noSplit[1].trim();
    for (const part of noSplit[2].split(/[,;|]+/)) {
      const cleaned = part.trim();
      if (cleaned) inlineExcludes.push(cleaned);
    }
  }
  const cleanAliases = [
    ...new Set(
      (Array.isArray(aliases) ? aliases : String(aliases || "").split(/[,;|]+/))
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    ),
  ].slice(0, 12);
  const cleanExcludes = [
    ...new Set(
      [...(Array.isArray(excludeTerms) ? excludeTerms : String(excludeTerms || "").split(/[,;|]+/)), ...inlineExcludes]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    ),
  ].slice(0, 16);
  return { term: termStr, aliases: cleanAliases, excludeTerms: cleanExcludes };
}

export function sanitizeEntry(raw: any): WordPoolEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const mode: WordPoolEntry["mode"] = raw.mode === "primary" || raw.mode === "exclude" ? raw.mode : "fuzzy";
  const parsed = parseRuleInput(raw.term, { excludeTerms: raw.excludeTerms, aliases: raw.aliases });
  if (!parsed.term || parsed.term.length < 2) return null;
  return {
    id: String(raw.id || `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    term: parsed.term.slice(0, 80),
    mode,
    aliases: parsed.aliases,
    excludeTerms: parsed.excludeTerms,
    enabled: raw.enabled !== false,
    weight: Math.max(1, Math.min(5, Number(raw.weight) || (mode === "primary" ? 5 : 2))),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export async function loadEntries(db: D1Database): Promise<WordPoolEntry[]> {
  return await l1Cached("wordpool:entries", 60_000, async () => {
    const { results } = await db
      .prepare("SELECT id, word, mode, data_json, created_at, updated_at FROM wordpool ORDER BY created_at DESC LIMIT ?1")
      .bind(MAX_ENTRIES)
      .all<{ id: string; word: string; mode: string; data_json: string; created_at: number; updated_at: number }>();
    const list: WordPoolEntry[] = [];
    for (const r of results || []) {
      const parsed = safeJsonParse<Partial<WordPoolEntry>>(r.data_json, {});
      const e = sanitizeEntry({
        id: r.id,
        term: parsed.term || r.word,
        mode: parsed.mode || r.mode,
        aliases: parsed.aliases || [],
        excludeTerms: parsed.excludeTerms || [],
        enabled: parsed.enabled !== false,
        weight: parsed.weight,
        createdAt: parsed.createdAt || r.created_at,
        updatedAt: parsed.updatedAt || r.updated_at,
      });
      if (e) list.push(e);
    }
    return list;
  });
}

export function computeStats(entries: WordPoolEntry[]) {
  let primary = 0;
  let fuzzy = 0;
  let exclude = 0;
  for (const e of entries) {
    if (!e.enabled) continue;
    if (e.mode === "primary") primary++;
    else if (e.mode === "exclude") exclude++;
    else fuzzy++;
  }
  return { total: entries.length, active: primary + fuzzy + exclude, primary, fuzzy, exclude };
}

export async function addWordPoolEntry(db: D1Database, raw: any): Promise<WordPoolEntry | null> {
  const entry = sanitizeEntry(raw);
  if (!entry) return null;
  await db
    .prepare(
      `INSERT INTO wordpool (id, word, mode, data_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET word=excluded.word, mode=excluded.mode, data_json=excluded.data_json, updated_at=excluded.updated_at`
    )
    .bind(entry.id, entry.term, entry.mode, JSON.stringify(entry), entry.createdAt, entry.updatedAt)
    .run();
  l1Invalidate("wordpool:");
  return entry;
}

export async function updateWordPoolEntry(db: D1Database, id: string, patch: any): Promise<WordPoolEntry | null> {
  const entries = await loadEntries(db);
  const existing = entries.find((e) => e.id === String(id));
  if (!existing) return null;
  const merged = sanitizeEntry({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() });
  if (!merged) return null;
  await db
    .prepare("UPDATE wordpool SET word=?1, mode=?2, data_json=?3, updated_at=?4 WHERE id=?5")
    .bind(merged.term, merged.mode, JSON.stringify(merged), merged.updatedAt, merged.id)
    .run();
  l1Invalidate("wordpool:");
  return merged;
}

export async function removeWordPoolEntry(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM wordpool WHERE id = ?1").bind(String(id)).run();
  l1Invalidate("wordpool:");
  return Boolean(res.meta && res.meta.changes > 0);
}

export async function importWordPoolData(db: D1Database, raw: any = {}, { replace = false } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.entries) ? raw.entries : [];
  const stmts: D1PreparedStatement[] = [];
  if (replace) stmts.push(db.prepare("DELETE FROM wordpool"));
  for (const item of list.slice(0, MAX_ENTRIES)) {
    const entry = sanitizeEntry(item);
    if (!entry) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO wordpool (id, word, mode, data_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET word=excluded.word, mode=excluded.mode, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(entry.id, entry.term, entry.mode, JSON.stringify(entry), entry.createdAt, entry.updatedAt)
    );
  }
  await runChunkedBatch(db, stmts);
  l1Invalidate("wordpool:");
}

export function buildSearchDoc(item: any = {}, { wikiDossier = null, episodeSummaries = [] }: { wikiDossier?: any; episodeSummaries?: string[] } = {}) {
  const rawTitle = String(item.name || item.title || "").trim();
  const rawSummary = stripHtml(item.summary || item.overview || "");
  const epText = Array.isArray(episodeSummaries) ? episodeSummaries.map(stripHtml).filter(Boolean).join(" · ") : "";

  const peopleList: string[] = [];
  for (const p of item.creators || []) peopleList.push(typeof p === "string" ? p : p && p.name);
  for (const p of item.crew || []) peopleList.push(typeof p === "string" ? p : p && p.name);
  for (const p of item.cast || []) peopleList.push(typeof p === "string" ? p : p && p.name);

  const tagList = [
    ...(item.genres || []),
    ...(item.keywords || []).map((k: any) => (typeof k === "string" ? k : k && k.name)),
    ...(item.studios || []),
    item.channelName || (item.network && item.network.name) || (item.webChannel && item.webChannel.name) || "",
    item.language || "",
    item.type || "",
  ];

  const wikiParts: string[] = [];
  if (wikiDossier && wikiDossier.found) {
    if (wikiDossier.extract) wikiParts.push(wikiDossier.extract);
    if (wikiDossier.description) wikiParts.push(wikiDossier.description);
    for (const a of wikiDossier.awards || []) wikiParts.push(a);
    for (const b of wikiDossier.basedOn || []) wikiParts.push(b && b.name);
    for (const a of wikiDossier.authors || []) wikiParts.push(a && a.name);
    for (const l of wikiDossier.locations || []) wikiParts.push(l);
    for (const l of wikiDossier.filmingLocations || []) wikiParts.push(l);
  }

  const rawByField: Record<string, string> = {
    title: rawTitle,
    people: peopleList.filter(Boolean).join(", "),
    tags: tagList.filter(Boolean).join(", "),
    episode: epText,
    summary: rawSummary,
    wiki: wikiParts.filter(Boolean).join(" · "),
  };

  const fields: Array<{ field: string; raw: string; norm: string; padded: string; tokens: string[] }> = [];
  for (const field of ["title", "people", "tags", "episode", "summary", "wiki"]) {
    const raw = rawByField[field];
    if (!raw) continue;
    const norm = normText(raw);
    if (!norm) continue;
    fields.push({ field, raw, norm, padded: ` ${norm} `, tokens: norm.split(" ") });
  }
  return { rawTitle, fields };
}

function strictMatchPhrase(phrase: string, fields: ReturnType<typeof buildSearchDoc>["fields"]) {
  const nPhrase = normText(phrase);
  if (!nPhrase || nPhrase.length < 2) return null;
  const needle = ` ${nPhrase} `;
  for (const f of fields) {
    if (f.padded.includes(needle)) {
      return {
        field: f.field,
        matchedText: phrase,
        confidence: 100,
        snippet: makeSnippet(f.raw, phrase),
      };
    }
  }
  return null;
}

function fuzzyMatchPhrase(phrase: string, fields: ReturnType<typeof buildSearchDoc>["fields"]) {
  const qToks = splitTokens(phrase);
  if (!qToks.length) return null;
  const nPhrase = qToks.join(" ");
  const needle = ` ${nPhrase} `;

  for (const f of fields) {
    if (f.padded.includes(needle)) {
      return {
        field: f.field,
        matchedText: phrase,
        confidence: f.field === "title" ? 98 : 94,
        snippet: makeSnippet(f.raw, phrase),
      };
    }
  }
  if (nPhrase.length >= 4) {
    for (const f of fields) {
      if (f.norm.includes(nPhrase)) {
        return {
          field: f.field,
          matchedText: phrase,
          confidence: 88,
          snippet: makeSnippet(f.raw, phrase),
        };
      }
    }
  }
  let best: { field: string; matchedText: string; confidence: number; snippet: string } | null = null;
  for (const f of fields) {
    if (!f.tokens.length) continue;
    if (qToks.length === 1) {
      const qt = qToks[0];
      if (qt.length < 4) continue;
      for (const ct of f.tokens) {
        if (ct.length < 4) continue;
        const sim = tokenSimilarity(qt, ct);
        if (sim >= 0.72) {
          const conf = Math.round(sim * 96);
          if (!best || conf > best.confidence) {
            best = { field: f.field, matchedText: ct, confidence: conf, snippet: makeSnippet(f.raw, ct) };
          }
        }
      }
    } else if (qToks.length <= 5) {
      let sum = 0;
      let matchedAny = 0;
      const hitToks: string[] = [];
      for (const qt of qToks) {
        let top = 0;
        let topCt = "";
        for (const ct of f.tokens) {
          const sim = qt.length <= 2 ? (qt === ct ? 1 : 0) : tokenSimilarity(qt, ct);
          if (sim > top) {
            top = sim;
            topCt = ct;
          }
        }
        sum += top;
        if (top >= 0.72) {
          matchedAny++;
          hitToks.push(topCt);
        }
      }
      const avg = sum / qToks.length;
      if (matchedAny === qToks.length && avg >= 0.74) {
        const conf = Math.round(avg * 95);
        if (!best || conf > best.confidence) {
          best = { field: f.field, matchedText: hitToks.join(" "), confidence: conf, snippet: makeSnippet(f.raw, hitToks[0]) };
        }
      }
    }
  }
  return best;
}

function docMatchesExclusion(terms: string[], fields: ReturnType<typeof buildSearchDoc>["fields"]): string | null {
  for (const ex of terms || []) {
    if (!ex) continue;
    const hit = strictMatchPhrase(ex, fields) || (splitTokens(ex).length <= 3 && fuzzyMatchPhrase(ex, fields));
    if (hit && hit.confidence >= 84) return ex;
  }
  return null;
}

export function matchItemWithEntries(
  entries: WordPoolEntry[],
  item: any = {},
  opts: { wikiDossier?: any; episodeSummaries?: string[] } = {}
): WordPoolResult {
  const active = entries.filter((e) => e.enabled);
  if (!active.length) {
    return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
  }
  const doc = buildSearchDoc(item, opts);
  if (!doc.fields.length) {
    return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
  }

  const primaryMatches: WordPoolMatchHit[] = [];
  const fuzzyMatches: WordPoolMatchHit[] = [];
  const excludeMatches: WordPoolResult["excludeMatches"] = [];

  for (const entry of active) {
    const phrases = [entry.term, ...(entry.aliases || [])].filter(Boolean);
    if (entry.mode === "exclude") {
      for (const ph of phrases) {
        const m = strictMatchPhrase(ph, doc.fields);
        if (m) {
          excludeMatches.push({ entryId: entry.id, term: entry.term, ...m });
          break;
        }
      }
      continue;
    }
    if (entry.excludeTerms.length && docMatchesExclusion(entry.excludeTerms, doc.fields)) continue;

    if (entry.mode === "primary") {
      for (const ph of phrases) {
        const hit = strictMatchPhrase(ph, doc.fields);
        if (hit) {
          primaryMatches.push({
            entryId: entry.id,
            mode: "primary",
            label: "Primary Override",
            term: entry.term,
            weight: entry.weight,
            ...hit,
          });
          break;
        }
      }
    } else {
      let bestFuzzy: WordPoolMatchHit | null = null;
      for (const ph of phrases) {
        const hit = fuzzyMatchPhrase(ph, doc.fields);
        if (hit && (!bestFuzzy || hit.confidence > bestFuzzy.confidence)) {
          bestFuzzy = {
            entryId: entry.id,
            mode: "fuzzy",
            label: "Fuzzy Match",
            term: entry.term,
            weight: entry.weight,
            ...hit,
          };
        }
      }
      if (bestFuzzy) fuzzyMatches.push(bestFuzzy);
    }
  }

  const primary = primaryMatches.length > 0;
  const fuzzy = !primary && excludeMatches.length === 0 ? fuzzyMatches.length > 0 : primary && fuzzyMatches.length > 0;
  const excluded = !primary && excludeMatches.length > 0;
  return { primary, fuzzy, excluded, primaryMatches, fuzzyMatches, excludeMatches };
}

export function searchLocalFuzzy(query: string, items: any[] = [], { limit = 8 }: { limit?: number } = {}) {
  const qNorm = normText(query);
  if (qNorm.length < 2) return [];
  const out: Array<{ item: any; confidence: number; field: string; snippet: string; fuzzyLabel: string }> = [];
  for (const item of items) {
    if (!item || !item.name) continue;
    const doc = buildSearchDoc(item);
    const hit = fuzzyMatchPhrase(query, doc.fields);
    if (!hit || hit.confidence < 72) continue;
    const titleExact = normText(item.name).includes(qNorm);
    out.push({
      item,
      confidence: titleExact ? 99 : hit.confidence,
      field: hit.field,
      snippet: hit.snippet,
      fuzzyLabel: "Fuzzy Match",
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, limit);
}

export function suggestFromLibrary({
  entries,
  shows = [],
  movies = [],
  poolItems = [],
  limit = 16,
}: {
  entries: WordPoolEntry[];
  shows?: any[];
  movies?: any[];
  poolItems?: any[];
  limit?: number;
}) {
  const existing = new Set(entries.map((e) => normText(e.term)));
  const counts = new Map<string, { term: string; category: string; count: number; score: number }>();
  const bump = (rawTerm: unknown, category: string, weight = 1) => {
    const clean = String(rawTerm || "").trim();
    const n = normText(clean);
    if (!n || n.length < 3 || STOPWORDS.has(n) || existing.has(n)) return;
    const cur = counts.get(n) || { term: clean, category, count: 0, score: 0 };
    cur.count++;
    cur.score += weight;
    counts.set(n, cur);
  };

  for (const s of shows) {
    const w = s.favorite ? 2.5 : 1;
    for (const g of s.genres || []) bump(g, "genre", w);
    for (const kw of s.keywords || []) bump(typeof kw === "string" ? kw : kw.name, "keyword", w * 1.3);
    for (const c of (s.creators || []).slice(0, 3)) bump(typeof c === "string" ? c : c.name, "person", w * 1.4);
    for (const a of (s.cast || []).slice(0, 4)) bump(typeof a === "string" ? a : a.name, "person", w);
    const words = splitTokens(stripHtml(s.summary || ""));
    for (const tok of words) if (tok.length >= 6 && !STOPWORDS.has(tok)) bump(tok, "theme", 0.5);
  }
  for (const m of movies) {
    const w = m.favorite ? 2.5 : 1;
    for (const g of m.genres || []) bump(g, "genre", w);
    for (const kw of m.keywords || []) bump(typeof kw === "string" ? kw : kw.name, "keyword", w * 1.3);
  }
  for (const p of poolItems.slice(0, 60)) {
    for (const kw of p.keywords || []) bump(typeof kw === "string" ? kw : kw.name, "keyword", 0.8);
    for (const c of (p.creators || []).slice(0, 2)) bump(typeof c === "string" ? c : c.name, "person", 0.9);
  }

  return [...counts.values()]
    .filter((x) => x.count >= 2 || x.score >= 2.2)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, limit);
}
