/* Viuhti Client-Side Personalization, Word Pool, Discover & Backup Engine (localStorage) */
(function () {
  'use strict';

  const LS = {
    LIB: 'viuhti.v2.lib',
    WP: 'viuhti.v2.wordpool',
    TASTE: 'viuhti.v2.taste',
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* ignore quota edge */
    }
  }

  function getLib() {
    const raw = loadJson(LS.LIB, {}) || {};
    return {
      favShows: Array.isArray(raw.favShows) ? raw.favShows.map(Number).filter(Boolean) : [],
      favMovies: Array.isArray(raw.favMovies) ? raw.favMovies.map(Number).filter(Boolean) : [],
      hiddenShows: raw.hiddenShows && typeof raw.hiddenShows === 'object' ? raw.hiddenShows : {},
      hiddenMovies: raw.hiddenMovies && typeof raw.hiddenMovies === 'object' ? raw.hiddenMovies : {},
      addedShows: raw.addedShows && typeof raw.addedShows === 'object' ? raw.addedShows : {},
      addedMovies: raw.addedMovies && typeof raw.addedMovies === 'object' ? raw.addedMovies : {},
      watchedEp: Array.isArray(raw.watchedEp) ? raw.watchedEp.map(Number).filter(Boolean) : [],
      watchedMv: Array.isArray(raw.watchedMv) ? raw.watchedMv.map(Number).filter(Boolean) : [],
      extQueryShow: raw.extQueryShow && typeof raw.extQueryShow === 'object' ? raw.extQueryShow : {},
      extQueryMovie: raw.extQueryMovie && typeof raw.extQueryMovie === 'object' ? raw.extQueryMovie : {},
    };
  }

  function saveLib(lib) {
    saveJson(LS.LIB, lib);
  }

  function getTaste() {
    const raw = loadJson(LS.TASTE, {}) || {};
    return {
      feedback: {
        show: (raw.feedback && raw.feedback.show) || {},
        movie: (raw.feedback && raw.feedback.movie) || {},
      },
      overrides: {
        boost: Array.isArray(raw.overrides && raw.overrides.boost) ? raw.overrides.boost : [],
        mute: Array.isArray(raw.overrides && raw.overrides.mute) ? raw.overrides.mute : [],
      },
    };
  }

  function saveTaste(taste) {
    saveJson(LS.TASTE, taste);
  }

  // ---------------- Word Pool Engine (100% client-side) ----------------
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'which', 'while', 'about',
    'after', 'before', 'their', 'there', 'these', 'those', 'have', 'has', 'had', 'were', 'been', 'being',
    'will', 'would', 'could', 'should', 'must', 'over', 'under', 'between', 'through', 'during', 'against',
    'other', 'some', 'more', 'most', 'such', 'only', 'than', 'then', 'very', 'just', 'also', 'even', 'back',
    'they', 'them', 'what', 'your', 'life', 'world', 'story', 'series', 'show', 'season', 'episode', 'episodes',
    'movie', 'film', 'finds', 'find', 'live', 'lives', 'year', 'years', 'time', 'young', 'woman', 'man',
    'family', 'home', 'make', 'makes', 'takes', 'take', 'goes', 'comes', 'two', 'three', 'one', 'new', 'old',
    'high', 'good', 'great', 'best', 'real', 'true', 'help', 'turns', 'sets', 'first', 'last', 'aftermath',
    'becomes', 'discover', 'discovers', 'forced', 'secret', 'secrets', 'begins', 'following', 'amid', 'together',
    'television', 'american', 'british', 'drama', 'comedy', 'action', 'adventure',
  ]);

  function stripHtml(html) {
    return String(html || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normText(str) {
    return stripHtml(str)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitTokens(str) {
    const n = normText(str);
    return n ? n.split(' ') : [];
  }

  function damerauLevenshtein(a, b, maxDist = 2) {
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

  function bigramDice(a, b) {
    if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
    const mapA = new Map();
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

  function tokenSimilarity(qt, ct) {
    if (!qt || !ct) return 0;
    if (qt === ct) return 1;
    if (qt.length >= 4 && ct.length >= 4 && ct.startsWith(qt)) return 0.9;
    const maxDist = Math.max(qt.length, ct.length) >= 7 ? 2 : Math.max(qt.length, ct.length) >= 4 ? 1 : 0;
    if (maxDist > 0) {
      const d = damerauLevenshtein(qt, ct, maxDist);
      if (d <= maxDist) return Math.max(0.7, 1 - d * 0.14);
    }
    if (qt.length >= 5 && ct.length >= 5 && Math.abs(qt.length - ct.length) <= 3) {
      const dice = bigramDice(qt, ct);
      if (dice >= 0.78) return dice * 0.92;
    }
    return 0;
  }

  function makeSnippet(rawText, matchText) {
    const clean = stripHtml(rawText);
    if (!clean) return '';
    if (!matchText) return clean.slice(0, 120);
    const idx = clean.toLowerCase().indexOf(String(matchText).toLowerCase());
    if (idx < 0) return clean.slice(0, 120);
    const start = Math.max(0, idx - 36);
    const end = Math.min(clean.length, idx + String(matchText).length + 52);
    return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
  }

  function parseRuleInput(rawTerm, { excludeTerms = [], aliases = [] } = {}) {
    let termStr = String(rawTerm || '').trim();
    const inlineExcludes = [];
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
        (Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,;|]+/))
          .map((s) => String(s || '').trim())
          .filter(Boolean)
      ),
    ].slice(0, 12);
    const cleanExcludes = [
      ...new Set(
        [...(Array.isArray(excludeTerms) ? excludeTerms : String(excludeTerms || '').split(/[,;|]+/)), ...inlineExcludes]
          .map((s) => String(s || '').trim())
          .filter(Boolean)
      ),
    ].slice(0, 16);
    return { term: termStr, aliases: cleanAliases, excludeTerms: cleanExcludes };
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const mode = raw.mode === 'primary' || raw.mode === 'exclude' ? raw.mode : 'fuzzy';
    const parsed = parseRuleInput(raw.term, { excludeTerms: raw.excludeTerms, aliases: raw.aliases });
    if (!parsed.term || parsed.term.length < 2) return null;
    return {
      id: String(raw.id || `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
      term: parsed.term.slice(0, 80),
      mode,
      aliases: parsed.aliases,
      excludeTerms: parsed.excludeTerms,
      enabled: raw.enabled !== false,
      weight: Math.max(1, Math.min(5, Number(raw.weight) || (mode === 'primary' ? 5 : 2))),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  }

  function getWordPoolEntries() {
    const raw = loadJson(LS.WP, []);
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw && raw.entries) ? raw.entries : [];
    return arr.map(sanitizeEntry).filter(Boolean).slice(0, 120);
  }

  function saveWordPoolEntries(entries) {
    saveJson(LS.WP, entries.slice(0, 120));
  }

  function computeWordPoolStats(entries) {
    let primary = 0;
    let fuzzy = 0;
    let exclude = 0;
    for (const e of entries) {
      if (!e.enabled) continue;
      if (e.mode === 'primary') primary++;
      else if (e.mode === 'exclude') exclude++;
      else fuzzy++;
    }
    return { total: entries.length, active: primary + fuzzy + exclude, primary, fuzzy, exclude };
  }

  function buildSearchDoc(item = {}) {
    const rawTitle = String(item.name || item.title || '').trim();
    const rawSummary = stripHtml(item.summary || item.overview || item.showSummary || '');
    const peopleList = [];
    for (const p of item.creators || []) peopleList.push(typeof p === 'string' ? p : p && p.name);
    for (const p of item.crew || []) peopleList.push(typeof p === 'string' ? p : p && p.name);
    for (const p of item.cast || []) peopleList.push(typeof p === 'string' ? p : p && p.name);
    const tagList = [
      ...(item.genres || []),
      ...(item.keywords || []).map((k) => (typeof k === 'string' ? k : k && k.name)),
      ...(item.studios || []),
      item.channelName || (item.network && item.network.name) || (item.webChannel && item.webChannel.name) || '',
      item.language || '',
      item.type || '',
    ];
    const buckets = {
      title: rawTitle,
      people: peopleList.filter(Boolean).join(', '),
      tags: tagList.filter(Boolean).join(', '),
      summary: rawSummary,
    };
    const fields = [];
    for (const [field, raw] of Object.entries(buckets)) {
      if (!raw) continue;
      const norm = normText(raw);
      if (!norm) continue;
      fields.push({ field, raw, norm, padded: ` ${norm} `, tokens: norm.split(' ') });
    }
    return { rawTitle, fields };
  }

  function strictMatchPhrase(phrase, fields) {
    const nPhrase = normText(phrase);
    if (!nPhrase || nPhrase.length < 2) return null;
    const needle = ` ${nPhrase} `;
    for (const f of fields) {
      if (f.padded.includes(needle)) {
        return { field: f.field, matchedText: phrase, confidence: 100, snippet: makeSnippet(f.raw, phrase) };
      }
    }
    return null;
  }

  function fuzzyMatchPhrase(phrase, fields) {
    const qToks = splitTokens(phrase);
    if (!qToks.length) return null;
    const nPhrase = qToks.join(' ');
    const needle = ` ${nPhrase} `;
    for (const f of fields) {
      if (f.padded.includes(needle)) {
        return { field: f.field, matchedText: phrase, confidence: f.field === 'title' ? 98 : 94, snippet: makeSnippet(f.raw, phrase) };
      }
    }
    if (nPhrase.length >= 4) {
      for (const f of fields) {
        if (f.norm.includes(nPhrase)) {
          return { field: f.field, matchedText: phrase, confidence: 88, snippet: makeSnippet(f.raw, phrase) };
        }
      }
    }
    let best = null;
    for (const f of fields) {
      if (!f.tokens.length) continue;
      if (qToks.length === 1 && qToks[0].length >= 4) {
        for (const ct of f.tokens) {
          if (ct.length < 4) continue;
          const sim = tokenSimilarity(qToks[0], ct);
          if (sim >= 0.72) {
            const conf = Math.round(sim * 96);
            if (!best || conf > best.confidence) best = { field: f.field, matchedText: ct, confidence: conf, snippet: makeSnippet(f.raw, ct) };
          }
        }
      } else if (qToks.length > 1 && qToks.length <= 5) {
        let sum = 0;
        let hitCount = 0;
        const hitToks = [];
        for (const qt of qToks) {
          let top = 0;
          let topCt = '';
          for (const ct of f.tokens) {
            const sim = qt.length <= 2 ? (qt === ct ? 1 : 0) : tokenSimilarity(qt, ct);
            if (sim > top) { top = sim; topCt = ct; }
          }
          sum += top;
          if (top >= 0.72) { hitCount++; hitToks.push(topCt); }
        }
        const avg = sum / qToks.length;
        if (hitCount === qToks.length && avg >= 0.74) {
          const conf = Math.round(avg * 95);
          if (!best || conf > best.confidence) best = { field: f.field, matchedText: hitToks.join(' '), confidence: conf, snippet: makeSnippet(f.raw, hitToks[0]) };
        }
      }
    }
    return best;
  }

  function matchWordPool(entries, item) {
    const active = (entries || []).filter((e) => e.enabled);
    if (!active.length || !item) return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
    const doc = buildSearchDoc(item);
    if (!doc.fields.length) return { primary: false, fuzzy: false, excluded: false, primaryMatches: [], fuzzyMatches: [], excludeMatches: [] };
    const primaryMatches = [];
    const fuzzyMatches = [];
    const excludeMatches = [];
    for (const entry of active) {
      const phrases = [entry.term, ...(entry.aliases || [])].filter(Boolean);
      if (entry.mode === 'exclude') {
        for (const ph of phrases) {
          const m = strictMatchPhrase(ph, doc.fields);
          if (m) { excludeMatches.push({ entryId: entry.id, term: entry.term, ...m }); break; }
        }
        continue;
      }
      if (entry.excludeTerms && entry.excludeTerms.length) {
        let exHit = false;
        for (const ex of entry.excludeTerms) {
          if (strictMatchPhrase(ex, doc.fields)) { exHit = true; break; }
        }
        if (exHit) continue;
      }
      if (entry.mode === 'primary') {
        for (const ph of phrases) {
          const hit = strictMatchPhrase(ph, doc.fields);
          if (hit) {
            primaryMatches.push({ entryId: entry.id, mode: 'primary', label: 'Primary Override', term: entry.term, weight: entry.weight, ...hit });
            break;
          }
        }
      } else {
        let best = null;
        for (const ph of phrases) {
          const hit = fuzzyMatchPhrase(ph, doc.fields);
          if (hit && (!best || hit.confidence > best.confidence)) {
            best = { entryId: entry.id, mode: 'fuzzy', label: 'Fuzzy Match', term: entry.term, weight: entry.weight, ...hit };
          }
        }
        if (best) fuzzyMatches.push(best);
      }
    }
    const primary = primaryMatches.length > 0;
    const fuzzy = !primary && excludeMatches.length === 0 ? fuzzyMatches.length > 0 : primary && fuzzyMatches.length > 0;
    const excluded = !primary && excludeMatches.length > 0;
    return { primary, fuzzy, excluded, primaryMatches, fuzzyMatches, excludeMatches };
  }

  function suggestWordPool(entries, shows = [], movies = [], limit = 16) {
    const existing = new Set((entries || []).map((e) => normText(e.term)));
    const counts = new Map();
    const bump = (raw, category, w = 1) => {
      const clean = String(raw || '').trim();
      const n = normText(clean);
      if (!n || n.length < 3 || STOPWORDS.has(n) || existing.has(n)) return;
      const cur = counts.get(n) || { term: clean, category, count: 0, score: 0 };
      cur.count++;
      cur.score += w;
      counts.set(n, cur);
    };
    for (const s of [...shows, ...movies]) {
      const w = s.favorite ? 2.5 : 1;
      for (const g of s.genres || []) bump(g, 'genre', w);
      for (const tok of splitTokens(stripHtml(s.summary || ''))) {
        if (tok.length >= 6 && !STOPWORDS.has(tok)) bump(tok, 'theme', 0.6);
      }
    }
    return [...counts.values()]
      .filter((x) => x.count >= 2 || x.score >= 2.2)
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, limit);
  }

  // ---------------- Client Catalog Overlay ----------------
  function buildHiddenList(lib) {
    const out = [];
    for (const [id, m] of Object.entries(lib.hiddenShows || {})) out.push({ ...(m || {}), id: Number(id), kind: 'show' });
    for (const [id, m] of Object.entries(lib.hiddenMovies || {})) out.push({ ...(m || {}), id: Number(id), kind: 'movie' });
    out.sort((a, b) => (b.hiddenAt || 0) - (a.hiddenAt || 0));
    return out;
  }

  function applyToCatalog(serverShows, serverMovies, includeHidden = false) {
    const lib = getLib();
    const wpEntries = getWordPoolEntries();
    const favS = new Set(lib.favShows);
    const favM = new Set(lib.favMovies);
    const wpActive = wpEntries.some((e) => e.enabled);

    const shows = [];
    const seenS = new Set();
    for (const raw of serverShows || []) {
      const id = Number(raw.id);
      seenS.add(id);
      const isHid = Boolean(lib.hiddenShows[String(id)]);
      if (isHid && !includeHidden) continue;
      const item = {
        ...raw,
        kind: 'show',
        favorite: favS.has(id),
        hidden: isHid,
        extQuery: lib.extQueryShow[String(id)] ?? raw.extQuery ?? null,
      };
      if (wpActive) {
        const hit = matchWordPool(wpEntries, item);
        if (hit.primary || hit.fuzzy) item.wordPool = hit;
      }
      shows.push(item);
    }

    const movies = [];
    for (const raw of serverMovies || []) {
      const id = Number(raw.id);
      const isHid = Boolean(lib.hiddenMovies[String(id)]);
      if (isHid && !includeHidden) continue;
      const item = {
        ...raw,
        kind: 'movie',
        favorite: favM.has(id),
        hidden: isHid,
        extQuery: lib.extQueryMovie[String(id)] ?? raw.extQuery ?? null,
      };
      if (wpActive) {
        const hit = matchWordPool(wpEntries, item);
        if (hit.primary || hit.fuzzy) item.wordPool = hit;
      }
      movies.push(item);
    }

    return { shows, movies, hiddenItems: buildHiddenList(lib) };
  }

  function applyToSchedule(serverEpisodes, serverMovies, showsMap, moviesMap, _unusedCache, from, to, { includeHidden = false } = {}) {
    const lib = getLib();
    const wpEntries = getWordPoolEntries();
    const wpActive = wpEntries.some((e) => e.enabled);
    const watchedEpSet = new Set(lib.watchedEp);
    const watchedMvSet = new Set(lib.watchedMv);

    const epsOut = [];
    for (const e of serverEpisodes || []) {
      const sId = Number(e.showId);
      const isHid = Boolean(lib.hiddenShows[String(sId)]);
      if (isHid && !includeHidden) continue;
      const sh = showsMap.get(sId);
      const item = {
        ...e,
        hidden: isHid,
        watched: watchedEpSet.has(Number(e.id)),
      };
      if (wpActive) {
        const shWp = sh && sh.wordPool;
        const epWp = e.summary || e.name ? matchWordPool(wpEntries, { name: e.name, summary: e.summary }) : null;
        if ((epWp && (epWp.primary || epWp.fuzzy)) || (shWp && (shWp.primary || shWp.fuzzy))) {
          item.wordPool = {
            primary: Boolean((epWp && epWp.primary) || (shWp && shWp.primary)),
            fuzzy: Boolean((epWp && epWp.fuzzy) || (shWp && shWp.fuzzy)),
            primaryMatches: [...((epWp && epWp.primaryMatches) || []), ...((shWp && shWp.primaryMatches) || [])],
            fuzzyMatches: [...((epWp && epWp.fuzzyMatches) || []), ...((shWp && shWp.fuzzyMatches) || [])],
          };
        }
      }
      epsOut.push(item);
    }

    const mvOut = [];
    for (const me of serverMovies || []) {
      const mId = Number(me.movieId);
      const isHid = Boolean(lib.hiddenMovies[String(mId)]);
      if (isHid && !includeHidden) continue;
      const mv = moviesMap.get(mId);
      const item = { ...me, hidden: isHid, watched: watchedMvSet.has(mId) };
      if (wpActive && mv && mv.wordPool) item.wordPool = mv.wordPool;
      mvOut.push(item);
    }

    epsOut.sort((a, b) => (a.airdate || '').localeCompare(b.airdate || '') || (a.airtime || '').localeCompare(b.airtime || ''));
    return { episodes: epsOut, movies: mvOut };
  }

  function applyToDiscover(data, showsMap, moviesMap, media = 'all', lens = 'mix') {
    const lib = getLib();
    const taste = getTaste();
    const wpEntries = getWordPoolEntries();
    const wpActive = wpEntries.some((e) => e.enabled);
    const boostSet = new Set(taste.overrides.boost);
    const muteSet = new Set(taste.overrides.mute);
    const today = new Date().toISOString().slice(0, 10);

    const lovesWeights = new Map();
    const bump = (k, w) => lovesWeights.set(k, (lovesWeights.get(k) || 0) + w);
    for (const s of [...showsMap.values(), ...moviesMap.values()]) {
      if (s.hidden) continue;
      const mult = s.favorite ? 3.2 : 1.0;
      for (const g of s.genres || []) bump(`genre:${String(g).toLowerCase()}`, mult);
    }
    for (const fb of [...Object.values(taste.feedback.show), ...Object.values(taste.feedback.movie)]) {
      if (!fb || !fb.action) continue;
      const w = fb.action === 'liked' ? 2.4 : fb.action === 'seen' ? 1.4 : fb.action === 'dislike' ? -2.2 : 0;
      for (const g of fb.genres || []) bump(`genre:${String(g).toLowerCase()}`, w);
    }
    for (const b of boostSet) bump(b, 5.5);
    for (const m of muteSet) bump(m, -6.5);

    const rawItems = (data && data.items) || [];
    const filtered = rawItems.filter((c) => {
      if (!c) return false;
      const isMv = c.kind === 'movie';
      const id = isMv ? Number(c.tmdbId || c.id) : Number(c.tvmazeId || c.id);
      if (isMv && (lib.hiddenMovies[String(id)] || taste.feedback.movie[String(id)])) return false;
      if (!isMv && (lib.hiddenShows[String(id)] || taste.feedback.show[String(id)])) return false;
      if (media === 'show' && isMv) return false;
      if (media === 'movie' && !isMv) return false;
      const wpHit = wpActive ? matchWordPool(wpEntries, c) : null;
      if (wpHit && wpHit.excluded) return false;
      c._wpHit = wpHit;
      if (wpHit && wpHit.primary) return true;
      if (lens === 'binge' && !(c.kind === 'show' && /ended|canceled/i.test(c.status || ''))) return false;
      if (lens === 'upcoming' && !((c.upcomingDate && c.upcomingDate >= today) || (c.premiered && c.premiered >= today))) return false;
      if (lens === 'gems' && ((c.popularity || 0) > 180 || ((c.rating || 0) > 0 && c.rating < 7.2))) return false;
      return true;
    });

    const rescored = filtered
      .map((c) => {
        let score = (c.rating ? (c.rating - 6.5) * 0.9 : 0);
        const reasons = [];
        for (const g of c.genres || []) {
          const w = lovesWeights.get(`genre:${String(g).toLowerCase()}`) || 0;
          score += w;
          if (w > 1.2) reasons.push(g);
        }
        const wpHit = c._wpHit;
        delete c._wpHit;
        if (wpHit && wpHit.primary) {
          score = Math.max(score, 0) + 32;
        } else if (wpHit && wpHit.fuzzy) {
          score += 5;
        }
        return {
          ...c,
          rawScore: score,
          reasons: reasons.length ? [`Matches: ${reasons.slice(0, 3).join(' · ')}`, ...(c.reasons || [])].slice(0, 3) : c.reasons || [],
          ...(wpHit && (wpHit.primary || wpHit.fuzzy)
            ? { wordPool: wpHit, primaryOverride: Boolean(wpHit.primary), fuzzyMatch: Boolean(wpHit.fuzzy) }
            : {}),
        };
      })
      .sort((a, b) => Number(Boolean(b.primaryOverride)) - Number(Boolean(a.primaryOverride)) || b.rawScore - a.rawScore);

    const loves = [...lovesWeights.entries()]
      .filter(([, w]) => w > 1.2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([key, weight]) => ({ key, label: key.replace(/^genre:/, '').replace(/\b\w/g, (m) => m.toUpperCase()), weight: Math.round(weight * 10) / 10 }));
    const avoids = [...lovesWeights.entries()]
      .filter(([, w]) => w < -1.0)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 8)
      .map(([key, weight]) => ({ key, label: key.replace(/^genre:/, '').replace(/\b\w/g, (m) => m.toUpperCase()), weight: Math.round(weight * 10) / 10 }));

    return {
      ...data,
      items: rescored.slice(0, 48).map((x, idx, arr) => ({
        ...x,
        matchPct: x.primaryOverride ? 100 : Math.round(97 - (idx / Math.max(1, arr.length)) * 32),
      })),
      profile: {
        ...(data.profile || {}),
        loves,
        avoids,
      },
    };
  }

  function buildPersonalBackup(settings) {
    const lib = getLib();
    const wp = getWordPoolEntries();
    const taste = getTaste();
    return {
      version: 1,
      origin: 'viuhti',
      exportedAt: new Date().toISOString(),
      shows: [
        ...Object.keys(lib.addedShows).map((id) => ({ id: Number(id), ...(lib.addedShows[id] || {}) })),
        ...lib.favShows.map((id) => ({ id, favorite: true })),
      ],
      movies: [
        ...Object.keys(lib.addedMovies).map((id) => ({ id: Number(id), ...(lib.addedMovies[id] || {}) })),
        ...lib.favMovies.map((id) => ({ id, favorite: true })),
      ],
      hidden: {
        ids: { show: Object.keys(lib.hiddenShows).map(Number), movie: Object.keys(lib.hiddenMovies).map(Number) },
        items: buildHiddenList(lib),
      },
      watched: { episodes: lib.watchedEp, movies: lib.watchedMv },
      wordpool: { entries: wp },
      taste,
      settings: {
        style: settings.style,
        interests: settings.interests || [],
        showHidden: Boolean(settings.showHidden),
        hideWatched: Boolean(settings.hideWatched),
        notifyBrowser: Boolean(settings.notifyBrowser),
        extSearchUrl: settings.extSearchUrl || '',
      },
    };
  }

  function importPersonalBackup(data) {
    const lib = getLib();
    const replace = data.replace !== false;
    const nextLib = replace
      ? {
          favShows: [], favMovies: [], hiddenShows: {}, hiddenMovies: {},
          addedShows: {}, addedMovies: {}, watchedEp: [], watchedMv: [],
          extQueryShow: {}, extQueryMovie: {},
        }
      : lib;

    const showIdsToHydrate = [];
    const movieIdsToHydrate = [];
    for (const raw of data.shows || []) {
      const id = Number(typeof raw === 'number' ? raw : raw && raw.id);
      if (!id) continue;
      showIdsToHydrate.push(id);
      nextLib.addedShows[String(id)] = { id, source: (raw && raw.source) || 'backup', addedAt: Date.now() };
      if (raw && raw.favorite && !nextLib.favShows.includes(id)) nextLib.favShows.push(id);
      if (raw && raw.extQuery) nextLib.extQueryShow[String(id)] = raw.extQuery;
    }
    for (const raw of data.movies || []) {
      const id = Number(typeof raw === 'number' ? raw : raw && raw.id);
      if (!id) continue;
      movieIdsToHydrate.push(id);
      nextLib.addedMovies[String(id)] = { id, source: (raw && raw.source) || 'backup', addedAt: Date.now() };
      if (raw && raw.favorite && !nextLib.favMovies.includes(id)) nextLib.favMovies.push(id);
      if (raw && raw.extQuery) nextLib.extQueryMovie[String(id)] = raw.extQuery;
    }
    if (data.hidden) {
      for (const it of data.hidden.items || []) {
        if (!it || !Number(it.id)) continue;
        if (it.kind === 'movie') nextLib.hiddenMovies[String(it.id)] = it;
        else nextLib.hiddenShows[String(it.id)] = it;
      }
      for (const id of (data.hidden.ids && data.hidden.ids.show) || []) {
        if (!nextLib.hiddenShows[String(id)]) nextLib.hiddenShows[String(id)] = { id: Number(id), kind: 'show', name: `Show #${id}`, hiddenAt: Date.now() };
      }
      for (const id of (data.hidden.ids && data.hidden.ids.movie) || []) {
        if (!nextLib.hiddenMovies[String(id)]) nextLib.hiddenMovies[String(id)] = { id: Number(id), kind: 'movie', name: `Movie #${id}`, hiddenAt: Date.now() };
      }
    }
    if (data.watched) {
      nextLib.watchedEp = [...new Set([...nextLib.watchedEp, ...(data.watched.episodes || []).map(Number).filter(Boolean)])];
      nextLib.watchedMv = [...new Set([...nextLib.watchedMv, ...(data.watched.movies || []).map(Number).filter(Boolean)])];
    }
    saveLib(nextLib);
    if (data.wordpool) {
      const rawWp = Array.isArray(data.wordpool) ? data.wordpool : data.wordpool.entries || [];
      saveWordPoolEntries(rawWp.map(sanitizeEntry).filter(Boolean));
    }
    if (data.taste) saveTaste({ ...getTaste(), ...data.taste });
    return { showIdsToHydrate, movieIdsToHydrate, lib: nextLib };
  }

  function buildPersonalIcs(episodes, movieEvents, showsMap, moviesMap) {
    const escIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Viuhti//Personal Browser Calendar//EN', 'CALSCALE:GREGORIAN'];
    for (const e of episodes || []) {
      const s = showsMap.get(Number(e.showId));
      if (!s || e.hidden || !e.airdate) continue;
      const code = e.season != null && e.number != null ? `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}` : 'Special';
      const day = e.airdate.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:viuhti-ep-${e.id}@viuhti.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `SUMMARY:${escIcs(`${s.name} · ${code} — ${e.name}`)}`, 'END:VEVENT');
    }
    for (const me of movieEvents || []) {
      const m = moviesMap.get(Number(me.movieId));
      if (!m || me.hidden || !me.airdate) continue;
      const day = me.airdate.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:viuhti-mv-${m.id}@viuhti.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, `SUMMARY:${escIcs(`${m.name} — ${me.name}`)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  window.ViuhtiClient = {
    getLib,
    saveLib,
    getTaste,
    saveTaste,
    getWordPoolEntries,
    saveWordPoolEntries,
    computeWordPoolStats,
    sanitizeEntry,
    matchWordPool,
    suggestWordPool,
    applyToCatalog,
    applyToSchedule,
    applyToDiscover,
    buildPersonalBackup,
    importPersonalBackup,
    buildPersonalIcs,
  };
})();
