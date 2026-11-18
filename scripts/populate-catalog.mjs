#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MOVIES_JSON = path.resolve(ROOT, "../tv-calendar/data/movies.json");
const MOVIES_CACHE_DIR = path.resolve(ROOT, "../tv-calendar/data/movies-cache");
const DB_ID =
  process.argv.find((a) => a.startsWith("--db="))?.slice(5) ||
  process.env.VIUHTI_D1_ID ||
  "";
const CF_BIN = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "cf.cmd" : "cf");
const USER_AGENT = "Viuhti/1.0 (https://github.com/tommiph/viuhti-cloudflare)";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SKIP_TASTE = args.has("--no-taste");
const TASTE_MOVIES_ONLY = args.has("--taste-movies");

const ALLOWED_TYPES = new Set(["Scripted", "Animation", "Documentary", "Reality"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function slimShow(s) {
  if (!s || !s.id) return null;
  const net = s.network
    ? {
        id: s.network.id,
        name: s.network.name,
        country: s.network.country ? s.network.country.code : null,
        timezone: s.network.country ? s.network.country.timezone : null,
      }
    : null;
  const web = s.webChannel
    ? {
        id: s.webChannel.id,
        name: s.webChannel.name,
        country: s.webChannel.country ? s.webChannel.country.code : null,
        timezone: s.webChannel.country ? s.webChannel.country.timezone : null,
      }
    : null;
  return {
    id: Number(s.id),
    name: s.name || "Untitled",
    url: s.url || null,
    type: s.type || null,
    language: s.language || null,
    genres: Array.isArray(s.genres) ? s.genres : [],
    status: s.status || null,
    premiered: s.premiered || null,
    ended: s.ended || null,
    runtime: s.runtime ?? s.averageRuntime ?? null,
    officialSite: s.officialSite || null,
    rating: s.rating && s.rating.average != null ? Number(s.rating.average) : null,
    network: net,
    webChannel: web,
    schedule: s.schedule || { time: "", days: [] },
    poster: s.image ? s.image.medium || s.image.original : null,
    background: s.image ? s.image.original || s.image.medium : null,
    summary: s.summary || "",
    externals: s.externals || {},
    weight: Number(s.weight || 0),
  };
}

function slimEpisode(ep, showId) {
  if (!ep || !ep.id || !ep.airdate) return null;
  return {
    id: Number(ep.id),
    show_id: Number(showId),
    airdate: String(ep.airdate).slice(0, 10),
    airtime: ep.airtime || null,
    airstamp: ep.airstamp || null,
    season: ep.season ?? null,
    number: ep.number ?? null,
    type: ep.type || null,
    name: ep.name || "",
    runtime: ep.runtime ?? null,
    summary: ep.summary || "",
    url: ep.url || null,
    image: ep.image ? ep.image.medium || ep.image.original : null,
  };
}

function sanitizePublicMovie(raw) {
  if (!raw || !raw.id || !raw.name) return null;
  return {
    id: Number(raw.id),
    kind: "movie",
    name: String(raw.name),
    originalName: raw.originalName || null,
    url: raw.url || `https://www.themoviedb.org/movie/${Number(raw.id)}`,
    language: raw.language || null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    status: raw.status || null,
    premiered: raw.premiered || null,
    airdate: raw.airdate || raw.premiered || null,
    releaseKind: raw.releaseKind || "stream",
    channelName: raw.channelName || null,
    channelCountry: raw.channelCountry || null,
    runtime: raw.runtime ?? null,
    officialSite: raw.officialSite || null,
    imdbUrl: raw.imdbUrl || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    popularity: raw.popularity != null ? Number(raw.popularity) : null,
    poster: raw.poster || null,
    posterLarge: raw.posterLarge || raw.poster || null,
    logo: raw.logo || null,
    background: raw.background || null,
    summary: raw.summary || "",
    tagline: raw.tagline || "",
  };
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  }
  throw new Error(`Exhausted retries for ${url}`);
}

function ymdRange(startYmd, days) {
  const out = [];
  const startMs = Date.parse(`${startYmd}T12:00:00Z`);
  for (let i = 0; i < days; i++) {
    out.push(new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function runD1Batch(stmts) {
  if (!DB_ID) {
    throw new Error("Missing D1 database ID. Pass --db=<your-d1-id> or set VIUHTI_D1_ID.");
  }
  const tmpFile = path.join(ROOT, `.tmp-d1-batch-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(stmts), "utf8");
  try {
    const raw = execFileSync(
      CF_BIN,
      ["d1", "query", DB_ID, "--batch", `@${tmpFile}`],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" }
    );
    const parsed = JSON.parse(raw);
    let written = 0;
    let read = 0;
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (!item.success) throw new Error(`D1 batch item failed: ${JSON.stringify(item)}`);
      written += Number(item.meta?.rows_written || 0);
      read += Number(item.meta?.rows_read || 0);
    }
    return { written, read };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function normMovieTitle(name) {
  return String(name || "")
    .replace(/\(\d{4}\)\s*$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapItunesGenres(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  if (s === "Action & Adventure") return ["Action", "Adventure"];
  if (s === "Sci-Fi & Fantasy") return ["Science-Fiction", "Fantasy"];
  if (s === "Kids & Family") return ["Family"];
  if (s === "Independent") return ["Indie"];
  return s.split(/\s*[&,]\s*/).map((x) => x.trim()).filter(Boolean);
}

async function fetchItunesTasteMovies(trackedMovieTitles) {
  const out = [];
  const seenIds = new Set();
  for (const country of ["us", "gb"]) {
    const data = await fetchJson(`https://itunes.apple.com/${country}/rss/topmovies/limit=50/json`).catch(() => null);
    const entries = data?.feed?.entry || [];
    for (const [idx, e] of entries.entries()) {
      const id = Number(e?.id?.attributes?.["im:id"] || 0);
      const name = String(e?.["im:name"]?.label || "").trim();
      const norm = normMovieTitle(name);
      if (!id || !norm || seenIds.has(id) || trackedMovieTitles.has(norm)) continue;
      seenIds.add(id);
      trackedMovieTitles.add(norm);
      const imgs = Array.isArray(e?.["im:image"]) ? e["im:image"] : [];
      const lastImg = imgs[imgs.length - 1]?.label || imgs[0]?.label || null;
      const up = (w, h) => (lastImg ? String(lastImg).replace(/\/\d+x\d+bb[^/]*$/, `/${w}x${h}bb.jpg`) : null);
      const relRaw = String(e?.["im:releaseDate"]?.label || "").slice(0, 10);
      const premiered = /^\d{4}-\d{2}-\d{2}$/.test(relRaw) ? relRaw : null;
      const score = Math.max(95, 142 - idx);
      out.push({
        item_key: `itunes:movie:${id}`,
        kind: "movie",
        id,
        score,
        data: {
          key: `itunes:movie:${id}`,
          kind: "movie",
          id,
          tmdbId: null,
          name,
          poster: up(342, 513),
          backdrop: up(780, 1170),
          premiered,
          language: "English",
          genres: mapItunesGenres(e?.category?.attributes?.label),
          rating: null,
          popularity: score,
          summary: stripHtml(e?.summary?.label).slice(0, 320),
          channelName: "Apple TV",
          keywords: [],
          creators: [],
          cast: [],
        },
      });
    }
    await sleep(150);
  }
  return out;
}

async function main() {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const twoWeeksStart = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

  if (TASTE_MOVIES_ONLY) {
    console.log("Fetching public iTunes US/GB chart movies for Discover pool...");
    const trackedTitles = new Set();
    if (fs.existsSync(MOVIES_JSON) && fs.existsSync(MOVIES_CACHE_DIR)) {
      const rawMovies = JSON.parse(fs.readFileSync(MOVIES_JSON, "utf8"));
      for (const rec of Object.values(rawMovies.movies || rawMovies || {})) {
        const cp = path.join(MOVIES_CACHE_DIR, `${Number(rec?.id || 0)}.json`);
        if (fs.existsSync(cp)) {
          const mv = JSON.parse(fs.readFileSync(cp, "utf8"))?.movie;
          if (mv?.name) trackedTitles.add(normMovieTitle(mv.name));
        }
      }
    }
    const tasteMovies = await fetchItunesTasteMovies(trackedTitles);
    const stmts = tasteMovies.map((t) => ({
      sql: `INSERT INTO taste_items (item_key, kind, id, score, data_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(item_key) DO UPDATE SET
              score=excluded.score, data_json=excluded.data_json, updated_at=excluded.updated_at`,
      params: [t.item_key, t.kind, t.id, t.score, JSON.stringify(t.data), now],
    }));
    console.log(JSON.stringify({ dryRun: DRY_RUN, tasteMovies: tasteMovies.length }));
    if (!DRY_RUN && stmts.length) {
      const { written, read } = runD1Batch(stmts);
      console.log(`Done! Seeded ${stmts.length} Discover movies (rows_written=${written}, rows_read=${read}).`);
    }
    return;
  }

  console.log("[1/4] Fetching TVmaze full schedule...");
  const fullSched = await fetchJson("https://api.tvmaze.com/schedule/full");

  console.log("[2/4] Fetching TVmaze streaming/web schedule (16 days)...");
  const webDates = ymdRange(twoWeeksStart, 16);
  const webRows = [];
  for (const d of webDates) {
    try {
      const rows = await fetchJson(`https://api.tvmaze.com/schedule/web?date=${d}`);
      if (Array.isArray(rows)) webRows.push(...rows);
    } catch (err) {
      console.warn(`  web schedule skip ${d}: ${err.message}`);
    }
    await sleep(160);
  }

  const showMap = new Map();
  const epByShow = new Map();

  for (const row of [...fullSched, ...webRows]) {
    if (!row || !row.id || !row.airdate) continue;
    const rawShow = row._embedded?.show || row.show;
    if (!rawShow || !rawShow.id) continue;
    const w = Number(rawShow.weight || 0);
    const lang = rawShow.language || "";
    const tp = rawShow.type || "";
    const qualifies =
      w >= 65 &&
      (lang === "English" || w >= 88) &&
      (ALLOWED_TYPES.has(tp) || w >= 85);
    if (!qualifies) continue;

    if (!showMap.has(rawShow.id)) {
      const ss = slimShow(rawShow);
      if (ss) showMap.set(ss.id, ss);
    }
    const se = slimEpisode(row, rawShow.id);
    if (!se) continue;
    if (!epByShow.has(se.show_id)) epByShow.set(se.show_id, new Map());
    epByShow.get(se.show_id).set(se.id, se);
  }

  // Keep up to 700 highest-priority shows (preferring shows with episodes around today..+21d and high weight)
  const nearEnd = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const rankedShows = [...showMap.values()].map((s) => {
    const eps = [...(epByShow.get(s.id)?.values() || [])];
    const hasNear = eps.some((e) => e.airdate >= twoWeeksStart && e.airdate <= nearEnd);
    return { show: s, eps, hasNear };
  });
  rankedShows.sort(
    (a, b) =>
      Number(b.hasNear) - Number(a.hasNear) ||
      (b.show.weight || 0) - (a.show.weight || 0) ||
      (b.show.rating || 0) - (a.show.rating || 0)
  );
  const selectedShows = rankedShows.slice(0, 700);
  const selectedShowIds = new Set(selectedShows.map((x) => x.show.id));
  const selectedEpisodes = [];
  for (const { eps } of selectedShows) {
    for (const e of eps) selectedEpisodes.push(e);
  }

  console.log("[3/4] Collecting sanitized public auto-weekly movies...");
  const publicMovies = [];
  if (fs.existsSync(MOVIES_JSON) && fs.existsSync(MOVIES_CACHE_DIR)) {
    const rawMovies = JSON.parse(fs.readFileSync(MOVIES_JSON, "utf8"));
    const records = Object.values(rawMovies.movies || rawMovies || {});
    for (const rec of records) {
      if (!rec || rec.source !== "auto-weekly" || !rec.id) continue;
      const cachePath = path.join(MOVIES_CACHE_DIR, `${Number(rec.id)}.json`);
      if (!fs.existsSync(cachePath)) continue;
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const m = sanitizePublicMovie(cached?.movie);
      if (m) {
        publicMovies.push({
          movie: m,
          addedAt: Number(rec.addedAt || now),
        });
      }
    }
  }

  console.log("[4/4] Fetching TVmaze catalog pages for Discover / Taste Nebula...");
  const tasteShows = [];
  if (!SKIP_TASTE) {
    const seenTaste = new Set();
    for (let page = 0; page < 4; page++) {
      try {
        const pageRows = await fetchJson(`https://api.tvmaze.com/shows?page=${page}`);
        for (const raw of pageRows || []) {
          if (!raw || !raw.id) continue;
          if (selectedShowIds.has(raw.id) || seenTaste.has(raw.id)) continue;
          const s = slimShow(raw);
          if (!s) continue;
          if ((s.weight || 0) < 60 && (s.rating || 0) < 7.8) continue;
          seenTaste.add(s.id);
          const score = Math.round((s.weight || 0) + (s.rating || 0) * 5);
          tasteShows.push({
            item_key: `tvmaze:${s.id}`,
            kind: "show",
            id: s.id,
            score,
            data: {
              key: `tvmaze:${s.id}`,
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
              summary: stripHtml(s.summary).slice(0, 320),
              channelName: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
              keywords: [],
              creators: [],
              cast: [],
            },
          });
        }
      } catch (err) {
        console.warn(`  shows page=${page} skip: ${err.message}`);
      }
      await sleep(160);
    }
  }
  tasteShows.sort((a, b) => b.score - a.score);
  const topTasteShows = tasteShows.slice(0, 220);
  const trackedMovieTitles = new Set(publicMovies.map((x) => normMovieTitle(x.movie.name)));
  const tasteMovies = SKIP_TASTE ? [] : await fetchItunesTasteMovies(trackedMovieTitles);

  const stmts = [];
  for (const { show: s } of selectedShows) {
    const chName = (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null;
    const chKind = s.network ? "tv" : "stream";
    const rec = { id: s.id, source: "catalog-seed", addedAt: now };
    stmts.push({
      sql: `INSERT INTO shows (id, name, favorite, hidden, directors_choice, channel_name, channel_kind, status, premiered, rating, genres_json, record_json, data_json, updated_at)
            VALUES (?1, ?2, 0, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, channel_name=excluded.channel_name, channel_kind=excluded.channel_kind,
              status=excluded.status, premiered=excluded.premiered, rating=excluded.rating,
              genres_json=excluded.genres_json, data_json=excluded.data_json, updated_at=excluded.updated_at
            WHERE shows.hidden != 2`,
      params: [
        s.id,
        s.name,
        chName,
        chKind,
        s.status || null,
        s.premiered || null,
        s.rating ?? null,
        JSON.stringify(s.genres || []),
        JSON.stringify(rec),
        JSON.stringify(s),
        now,
      ],
    });
  }

  for (const e of selectedEpisodes) {
    stmts.push({
      sql: `INSERT INTO episodes (id, show_id, airdate, airtime, airstamp, season, number, episode_type, name, runtime, summary, url, image)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
              show_id=excluded.show_id, airdate=excluded.airdate, airtime=excluded.airtime, airstamp=excluded.airstamp,
              season=excluded.season, number=excluded.number, episode_type=excluded.episode_type, name=excluded.name,
              runtime=excluded.runtime, summary=excluded.summary, url=excluded.url, image=excluded.image`,
      params: [
        e.id,
        e.show_id,
        e.airdate,
        e.airtime,
        e.airstamp,
        e.season,
        e.number,
        e.type,
        e.name,
        e.runtime,
        e.summary,
        e.url,
        e.image,
      ],
    });
  }

  for (const { movie: m, addedAt } of publicMovies) {
    const rel = m.airdate || m.premiered || null;
    const rec = { id: m.id, source: "catalog-seed", addedAt };
    stmts.push({
      sql: `INSERT INTO movies (id, name, release_date, favorite, hidden, directors_choice, channel_name, status, rating, genres_json, record_json, data_json, updated_at)
            VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, release_date=excluded.release_date,
              channel_name=excluded.channel_name, status=excluded.status, rating=excluded.rating,
              genres_json=excluded.genres_json, data_json=excluded.data_json, updated_at=excluded.updated_at
            WHERE movies.hidden != 2`,
      params: [
        m.id,
        m.name,
        rel,
        m.channelName,
        m.status,
        m.rating,
        JSON.stringify(m.genres || []),
        JSON.stringify(rec),
        JSON.stringify(m),
        now,
      ],
    });
  }

  for (const t of [...topTasteShows, ...tasteMovies]) {
    stmts.push({
      sql: `INSERT INTO taste_items (item_key, kind, id, score, data_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(item_key) DO UPDATE SET
              score=excluded.score, data_json=excluded.data_json, updated_at=excluded.updated_at`,
      params: [t.item_key, t.kind, t.id, t.score, JSON.stringify(t.data), now],
    });
  }

  const thisWeekCount = selectedEpisodes.filter((e) => e.airdate >= twoWeeksStart && e.airdate <= today).length;
  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        shows: selectedShows.length,
        episodes: selectedEpisodes.length,
        recentEpisodesSample: thisWeekCount,
        movies: publicMovies.length,
        tasteShows: topTasteShows.length,
        totalStatements: stmts.length,
      },
      null,
      2
    )
  );

  if (DRY_RUN) {
    console.log("Dry run complete. Re-run without --dry-run to apply to remote D1.");
    return;
  }

  const BATCH_SIZE = 100;
  let totalWritten = 0;
  let totalRead = 0;
  const totalBatches = Math.ceil(stmts.length / BATCH_SIZE);
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    const idx = Math.floor(i / BATCH_SIZE) + 1;
    const chunk = stmts.slice(i, i + BATCH_SIZE);
    const { written, read } = runD1Batch(chunk);
    totalWritten += written;
    totalRead += read;
    if (idx % 5 === 0 || idx === totalBatches) {
      console.log(`  Batch ${idx}/${totalBatches} committed (cumulative rows_written=${totalWritten}, rows_read=${totalRead})`);
    }
  }
  console.log(`Done! Applied ${stmts.length} statements (rows_written=${totalWritten}, rows_read=${totalRead}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
