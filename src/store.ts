import * as tvmaze from "./tvmaze";
import * as state from "./state";
import * as wp from "./wordpool";
import { getKv, setKv, runChunkedBatch, safeJsonParse, todayYmd, l1Cached, l1Invalidate } from "./db";
import type { SlimEpisode, SlimShow } from "./tvmaze";

export interface ShowRecord {
  id: number;
  source?: string | null;
  addedAt?: number;
  favorite?: boolean;
  alias?: string | null;
  extQuery?: string | null;
  tdQuery?: string | null;
}

export interface DiscoveryRules {
  genres: string[];
  languages: string[];
  types: string[];
  minWeight: number;
  releaseTypes?: string;
}

export const DEFAULT_DISCOVERY_RULES: DiscoveryRules = {
  genres: [],
  languages: ["English"],
  types: ["Scripted", "Animation", "Documentary"],
  minWeight: 60,
  releaseTypes: "4|5|6",
};

function channelOf(s: SlimShow) {
  return (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null;
}

function channelKindOf(s: SlimShow) {
  return s.network ? "tv" : "stream";
}

/**
 * Diff-based show & episode upsert so refreshing long-running shows only writes changed/new rows.
 */
export async function upsertShowRecord(
  db: D1Database,
  full: { show: SlimShow; episodes: SlimEpisode[]; fetchedAt?: number },
  rec: ShowRecord,
  { hiddenFlag = 0 }: { hiddenFlag?: number } = {}
) {
  const s = full.show;
  const dcEnabled = 0;
  const now = full.fetchedAt || Date.now();
  const slimNoSummary = { ...s };
  const favFlag = rec.favorite ? 1 : 0;
  const chName = channelOf(s);
  const chKind = channelKindOf(s);
  const statusVal = s.status || null;
  const premVal = s.premiered || null;
  const ratingVal = s.rating ?? null;
  const genresJson = JSON.stringify(s.genres || []);
  const recJson = JSON.stringify(rec);
  const dataJson = JSON.stringify(slimNoSummary);

  const [existingShow, existingEpRes] = await db.batch([
    db
      .prepare(
        "SELECT name, favorite, hidden, directors_choice, channel_name, channel_kind, status, premiered, rating, genres_json, record_json, data_json FROM shows WHERE id = ?1"
      )
      .bind(s.id),
    db
      .prepare(
        "SELECT id, airdate, airtime, airstamp, season, number, episode_type, name, runtime, summary, url, image FROM episodes WHERE show_id = ?1"
      )
      .bind(s.id),
  ]);

  const prevShow = (existingShow?.results?.[0] as any) || null;
  const existingEps = new Map<number, any>();
  for (const r of (existingEpRes?.results || []) as any[]) {
    existingEps.set(Number(r.id), r);
  }

  const showUnchanged =
    Boolean(prevShow) &&
    prevShow.name === s.name &&
    Number(prevShow.favorite) === favFlag &&
    Number(prevShow.hidden) === hiddenFlag &&
    Number(prevShow.directors_choice) === dcEnabled &&
    (prevShow.channel_name ?? null) === chName &&
    (prevShow.channel_kind ?? null) === chKind &&
    (prevShow.status ?? null) === statusVal &&
    (prevShow.premiered ?? null) === premVal &&
    (prevShow.rating ?? null) === ratingVal &&
    prevShow.genres_json === genresJson &&
    prevShow.record_json === recJson &&
    prevShow.data_json === dataJson;

  const stmts: D1PreparedStatement[] = [];
  if (showUnchanged) {
    stmts.push(db.prepare("UPDATE shows SET updated_at = ?1 WHERE id = ?2").bind(now, s.id));
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO shows (id, name, favorite, hidden, directors_choice, channel_name, channel_kind, status, premiered, rating, genres_json, record_json, data_json, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, favorite=excluded.favorite, hidden=excluded.hidden, directors_choice=excluded.directors_choice,
             channel_name=excluded.channel_name, channel_kind=excluded.channel_kind, status=excluded.status, premiered=excluded.premiered,
             rating=excluded.rating, genres_json=excluded.genres_json, record_json=excluded.record_json, data_json=excluded.data_json, updated_at=excluded.updated_at`
        )
        .bind(s.id, s.name, favFlag, hiddenFlag, dcEnabled, chName, chKind, statusVal, premVal, ratingVal, genresJson, recJson, dataJson, now)
    );
  }

  const seenEpIds = new Set<number>();
  for (const e of full.episodes || []) {
    if (!e || !e.id || !e.airdate) continue;
    const epId = Number(e.id);
    seenEpIds.add(epId);
    const airtime = e.airtime || null;
    const airstamp = e.airstamp || null;
    const season = e.season ?? null;
    const number = e.number ?? null;
    const epType = e.type || null;
    const epName = e.name || "";
    const runtime = e.runtime ?? null;
    const summary = e.summary || "";
    const url = e.url || null;
    const image = e.image || null;

    const prev = existingEps.get(epId);
    if (
      prev &&
      prev.airdate === e.airdate &&
      (prev.airtime ?? null) === airtime &&
      (prev.airstamp ?? null) === airstamp &&
      (prev.season ?? null) === season &&
      (prev.number ?? null) === number &&
      (prev.episode_type ?? null) === epType &&
      (prev.name || "") === epName &&
      (prev.runtime ?? null) === runtime &&
      (prev.summary || "") === summary &&
      (prev.url ?? null) === url &&
      (prev.image ?? null) === image
    ) {
      continue;
    }

    stmts.push(
      db
        .prepare(
          `INSERT INTO episodes (id, show_id, airdate, airtime, airstamp, season, number, episode_type, name, runtime, summary, url, image)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
           ON CONFLICT(id) DO UPDATE SET
             show_id=excluded.show_id, airdate=excluded.airdate, airtime=excluded.airtime, airstamp=excluded.airstamp,
             season=excluded.season, number=excluded.number, episode_type=excluded.episode_type, name=excluded.name,
             runtime=excluded.runtime, summary=excluded.summary, url=excluded.url, image=excluded.image`
        )
        .bind(epId, s.id, e.airdate, airtime, airstamp, season, number, epType, epName, runtime, summary, url, image)
    );
  }

  const staleIds: number[] = [];
  for (const prevId of existingEps.keys()) {
    if (!seenEpIds.has(prevId)) staleIds.push(prevId);
  }
  for (let i = 0; i < staleIds.length; i += 70) {
    const chunk = staleIds.slice(i, i + 70);
    const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(", ");
    stmts.push(db.prepare(`DELETE FROM episodes WHERE show_id = ?1 AND id IN (${placeholders})`).bind(s.id, ...chunk));
  }

  await runChunkedBatch(db, stmts);
  l1Invalidate("shows:");
}

export async function isTrackedShow(db: D1Database, id: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM shows WHERE id = ?1 AND hidden = 0").bind(Number(id)).first();
  return Boolean(row);
}

export async function countActiveShows(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM shows WHERE hidden = 0").first<{ c: number }>();
  return Number(row?.c || 0);
}

export async function getShowRow(db: D1Database, id: number) {
  return await db
    .prepare("SELECT * FROM shows WHERE id = ?1")
    .bind(Number(id))
    .first<{
      id: number;
      name: string;
      favorite: number;
      hidden: number;
      directors_choice: number;
      record_json: string;
      data_json: string;
      updated_at: number;
    }>();
}

function episodeTimeMs(e: { airstamp?: string | null; airdate?: string | null }): number {
  if (e.airstamp) {
    const t = Date.parse(e.airstamp);
    if (Number.isFinite(t)) return t;
  }
  return e.airdate ? Date.parse(`${e.airdate}T23:59:59Z`) : NaN;
}

export async function addShow(
  db: D1Database,
  id: number,
  source = "search",
  { record, hiddenFlag = 0 }: { record?: Partial<ShowRecord>; hiddenFlag?: number } = {}
) {
  const showId = Number(id);
  const full = await tvmaze.fetchShowFull(showId);
  if (!full) throw new Error(`Show ${showId} not found on TVmaze`);
  const existing = await getShowRow(db, showId);
  const prevRec = existing ? safeJsonParse<ShowRecord>(existing.record_json, { id: showId }) : { id: showId };
  const rec: ShowRecord = {
    ...prevRec,
    ...(record || {}),
    id: showId,
    source: record?.source ?? prevRec.source ?? source,
    addedAt: prevRec.addedAt || Date.now(),
  };
  const nextHidden = existing ? Number(existing.hidden) : hiddenFlag;
  if (nextHidden === 0) {
    await state.removeHidden(db, "show", showId);
  }
  await upsertShowRecord(db, full, rec, { hiddenFlag: nextHidden });
  if (!existing && nextHidden === 0) {
    const net = channelOf(full.show);
    await state.recordDigest(db, {
      kind: "show",
      itemId: showId,
      event: "added",
      title: full.show.name,
      detail: `${full.show.genres?.slice(0, 2).join(", ") || "Show"}${net ? ` · ${net}` : ""}`,
    });
  }
  return await formatShowSummary(db, showId);
}

export async function restoreShow(db: D1Database, rec: ShowRecord) {
  const showId = Number(rec.id);
  const existing = await getShowRow(db, showId);
  if (existing) {
    const merged: ShowRecord = { ...safeJsonParse<ShowRecord>(existing.record_json, { id: showId }), ...rec, id: showId };
    await db
      .prepare("UPDATE shows SET hidden = 0, favorite = ?1, directors_choice = 0, record_json = ?2 WHERE id = ?3")
      .bind(merged.favorite ? 1 : 0, JSON.stringify(merged), showId)
      .run();
    l1Invalidate("shows:");
    return await formatShowSummary(db, showId);
  }
  return await addShow(db, showId, rec.source || "restored", { record: rec });
}

export async function formatShowSummary(
  db: D1Database,
  id: number,
  { publicOnly = false }: { publicOnly?: boolean } = {}
) {
  const row = await getShowRow(db, id);
  if (!row || (publicOnly && Number(row.hidden) !== 0)) return null;
  const s = safeJsonParse<SlimShow>(row.data_json, { id, name: row.name } as SlimShow);
  const t = safeJsonParse<ShowRecord>(row.record_json, { id });
  const today = todayYmd();
  const [nextRes, pastRes] = await db.batch([
    db
      .prepare("SELECT season, number, name, airstamp, airdate FROM episodes WHERE show_id = ?1 AND airdate >= ?2 ORDER BY airdate ASC, id ASC LIMIT 1")
      .bind(id, today),
    db
      .prepare("SELECT season, number, name, airstamp, airdate FROM episodes WHERE show_id = ?1 AND airdate < ?2 ORDER BY airdate DESC, id DESC LIMIT 1")
      .bind(id, today),
  ]);
  const next = (nextRes?.results?.[0] as any) || null;
  const last = (pastRes?.results?.[0] as any) || null;
  const useAlias = t.alias && t.alias !== s.name;
  return {
    ...s,
    ...(useAlias ? { name: t.alias, originalName: s.name } : {}),
    favorite: Boolean(t.favorite),
    extQuery: t.extQuery || t.tdQuery || null,
    source: t.source || null,
    addedAt: t.addedAt || null,
    hidden: Number(row.hidden) === 1,
    nextEpisode: next ? { season: next.season, number: next.number, name: next.name, airstamp: next.airstamp, airdate: next.airdate } : null,
    lastEpisode: last ? { season: last.season, number: last.number, name: last.name, airstamp: last.airstamp, airdate: last.airdate } : null,
  };
}

export async function listShows(
  db: D1Database,
  { includeHidden = false, includeNextEpisode = true }: { includeHidden?: boolean; includeNextEpisode?: boolean } = {}
) {
  if (!includeHidden) {
    return await l1Cached(`shows:active:${includeNextEpisode ? "next" : "plain"}`, 90_000, () =>
      loadShowsUncached(db, { includeHidden: false, includeNextEpisode })
    );
  }
  return await loadShowsUncached(db, { includeHidden, includeNextEpisode });
}

async function loadShowsUncached(
  db: D1Database,
  { includeHidden = false, includeNextEpisode = true }: { includeHidden?: boolean; includeNextEpisode?: boolean } = {}
) {
  const { results } = await db
    .prepare(
      includeHidden
        ? "SELECT id, name, favorite, hidden, directors_choice, record_json, data_json FROM shows ORDER BY name ASC"
        : "SELECT id, name, favorite, hidden, directors_choice, record_json, data_json FROM shows WHERE hidden = 0 ORDER BY name ASC"
    )
    .all<{
      id: number;
      name: string;
      favorite: number;
      hidden: number;
      directors_choice: number;
      record_json: string;
      data_json: string;
    }>();

  const nextMap = new Map<number, string>();
  if (includeNextEpisode) {
    const today = todayYmd();
    // Fetch next upcoming episode date per show in one batched query cleanly
    const { results: nextRows } = await db
      .prepare(
        `SELECT show_id, MIN(airdate) as next_airdate
         FROM episodes
         WHERE airdate >= ?1
         GROUP BY show_id`
      )
      .bind(today)
      .all<{ show_id: number; next_airdate: string }>();
    for (const r of nextRows || []) nextMap.set(Number(r.show_id), r.next_airdate);
  }

  const out: any[] = [];
  const seenIds = new Set<number>();
  for (const r of results || []) {
    seenIds.add(Number(r.id));
    const s = safeJsonParse<SlimShow>(r.data_json, { id: r.id, name: r.name } as SlimShow);
    const t = safeJsonParse<ShowRecord>(r.record_json, { id: r.id });
    const nextAir = nextMap.get(Number(r.id)) || null;
    out.push({
      ...s,
      ...(t.alias && t.alias !== s.name ? { name: t.alias, originalName: s.name } : {}),
      favorite: Boolean(r.favorite || t.favorite),
      extQuery: t.extQuery || t.tdQuery || null,
      source: t.source || null,
      addedAt: t.addedAt || null,
      hidden: Boolean(r.hidden),
      nextEpisode: nextAir ? { airdate: nextAir, airstamp: `${nextAir}T12:00:00Z` } : null,
      lastEpisode: null,
    });
  }

  if (includeHidden) {
    const hiddenItems = await state.listHidden(db);
    for (const h of hiddenItems) {
      if (h.kind !== "show" || seenIds.has(h.id)) continue;
      out.push({
        id: h.id,
        name: h.name,
        poster: h.poster,
        banner: h.banner,
        background: h.background,
        logo: h.logo,
        channelName: h.channelName,
        premiered: h.premiered,
        status: h.status,
        favorite: h.favorite,
        extQuery: h.extQuery,
        hidden: true,
        genres: [],
      });
    }
  }
  return out;
}

export async function getShowDetails(
  db: D1Database,
  id: number,
  epId: number | null = null,
  includeEpisodes = false
) {
  const row = await getShowRow(db, id);
  if (!row || Number(row.hidden) !== 0) return null;
  const s = safeJsonParse<SlimShow>(row.data_json, { id, name: row.name } as SlimShow);
  let epSummary = "";
  let epUrl: string | null = null;
  if (epId) {
    const ep = await db
      .prepare("SELECT summary, url FROM episodes WHERE id = ?1 AND show_id = ?2")
      .bind(Number(epId), Number(id))
      .first<{ summary: string; url: string | null }>();
    if (ep) {
      epSummary = ep.summary || "";
      epUrl = ep.url || null;
    }
  }
  let episodes: any[] | undefined;
  if (includeEpisodes) {
    const { results } = await db
      .prepare(
        "SELECT id, season, number, name, episode_type as type, airdate, airtime, airstamp, runtime, summary, url FROM episodes WHERE show_id = ?1 ORDER BY airdate ASC, season ASC, number ASC LIMIT 500"
      )
      .bind(Number(id))
      .all<any>();
    episodes = results || [];
  }
  return {
    summary: s.summary || "",
    background: s.background || null,
    posterLarge: s.posterLarge || null,
    episodeSummary: epSummary,
    episodeUrl: epUrl,
    ...(episodes ? { episodes } : {}),
  };
}

export async function setShowFavorite(db: D1Database, id: number, fav?: boolean) {
  const showId = Number(id);
  const row = await getShowRow(db, showId);
  if (row) {
    const t = safeJsonParse<ShowRecord>(row.record_json, { id: showId });
    const next = fav === undefined ? !Boolean(t.favorite) : Boolean(fav);
    if (next) t.favorite = true;
    else delete t.favorite;
    await db
      .prepare("UPDATE shows SET favorite = ?1, record_json = ?2 WHERE id = ?3")
      .bind(next ? 1 : 0, JSON.stringify(t), showId)
      .run();
    l1Invalidate("shows:");
    return await formatShowSummary(db, showId);
  }
  const h = await state.takeHiddenEntry(db, "show", showId);
  if (h) {
    const rec: ShowRecord = { ...(h.record || { id: showId }), id: showId };
    const next = fav === undefined ? !Boolean(rec.favorite) : Boolean(fav);
    rec.favorite = next;
    h.record = rec;
    await state.addHiddenEntry(db, h);
    return { ...h, favorite: next, hidden: true };
  }
  return null;
}

export async function setShowExtQuery(db: D1Database, id: number, extQuery: unknown) {
  const showId = Number(id);
  const q = String(extQuery || "").trim().slice(0, 120);
  const row = await getShowRow(db, showId);
  if (row) {
    const t = safeJsonParse<ShowRecord>(row.record_json, { id: showId });
    if (q) t.extQuery = q;
    else delete t.extQuery;
    delete t.tdQuery;
    await db.prepare("UPDATE shows SET record_json = ?1 WHERE id = ?2").bind(JSON.stringify(t), showId).run();
    l1Invalidate("shows:");
    return await formatShowSummary(db, showId);
  }
  return null;
}

export async function hideShow(db: D1Database, id: number, fallbackMeta: { id: number; name?: string; premiered?: string | null } | null = null) {
  const showId = Number(id);
  const row = await getShowRow(db, showId);
  let snap: state.HiddenEntry | null = null;
  if (row) {
    const s = safeJsonParse<SlimShow>(row.data_json, { id: showId, name: row.name } as SlimShow);
    const t = safeJsonParse<ShowRecord>(row.record_json, { id: showId });
    snap = {
      id: showId,
      kind: "show",
      name: s.name,
      poster: s.poster || null,
      banner: s.banner || null,
      background: s.background || null,
      logo: s.logo || null,
      channelName: channelOf(s),
      channelKind: channelKindOf(s),
      premiered: s.premiered || null,
      status: s.status || null,
      hiddenAt: Date.now(),
      record: t,
    };
    await db.prepare("UPDATE shows SET hidden = 1 WHERE id = ?1").bind(showId).run();
  l1Invalidate("shows:");
  } else if (fallbackMeta) {
    snap = {
      id: showId,
      kind: "show",
      name: fallbackMeta.name || `Show #${showId}`,
      premiered: fallbackMeta.premiered || null,
      hiddenAt: Date.now(),
      record: { id: showId, addedAt: Date.now() },
    };
  }
  if (snap) await state.addHiddenEntry(db, snap);
  return { ok: Boolean(row), id: showId, name: snap ? snap.name : `Show #${showId}` };
}

function formatScheduleEpisodeRow(
  r: any,
  s: SlimShow,
  t: ShowRecord,
  watchedSet: Set<number>,
  withSummaries: boolean,
  now: number
) {
  const primMs = s.premiered ? Date.parse(`${s.premiered}T12:00:00Z`) : NaN;
  const diffPrem = Number.isFinite(primMs) ? (Date.parse(`${r.airdate}T12:00:00Z`) - primMs) / 86_400_000 : NaN;
  const premiere = r.number === 1 && r.season != null ? (r.season === 1 ? "series" : "season") : null;
  const special = r.episode_type === "significant_special" || (r.season != null && r.number == null);
  const isNew = Boolean(
    r.season === 1 &&
      ((Number.isFinite(diffPrem) && diffPrem >= -1 && diffPrem <= 21) ||
        ((t.source === "auto-weekly" || t.source === "auto-bimonthly") && t.addedAt && now - t.addedAt <= 21 * 86_400_000))
  );
  return {
    showId: Number(r.show_id),
    id: Number(r.id),
    season: r.season,
    number: r.number,
    name: r.name,
    type: r.episode_type,
    airdate: r.airdate,
    airtime: r.airtime,
    airstamp: r.airstamp,
    runtime: r.runtime,
    premiere,
    finale: null,
    special,
    isNew,
    hidden: Number(r.show_hidden) === 1,
    watched: watchedSet.has(Number(r.id)),
    ...(withSummaries ? { summary: r.summary || "", showSummary: s.summary || "" } : {}),
  };
}

export async function scheduleShowsForIds(
  db: D1Database,
  from: string,
  to: string,
  showIds: number[],
  { withSummaries = false }: { withSummaries?: boolean } = {}
) {
  const cleanIds = [...new Set((showIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0))].slice(0, 40);
  if (!cleanIds.length) return [];
  const { episodes: watchedSet } = await state.getWatchedSets(db);
  const placeholders = cleanIds.map((_, idx) => `?${idx + 3}`).join(", ");
  const { results: rows } = await db
    .prepare(
      `SELECT e.id, e.show_id, e.airdate, e.airtime, e.airstamp, e.season, e.number, e.episode_type, e.name, e.runtime,
              ${withSummaries ? "e.summary," : ""}
              s.hidden as show_hidden, s.record_json, s.data_json
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.airdate >= ?1 AND e.airdate <= ?2
         AND s.id IN (${placeholders})
       ORDER BY e.airdate ASC, e.airtime ASC, e.id ASC`
    )
    .bind(from, to, ...cleanIds)
    .all<any>();

  const now = Date.now();
  const showCache = new Map<number, { s: SlimShow; t: ShowRecord }>();
  return (rows || []).map((r: any) => {
    let parsed = showCache.get(Number(r.show_id));
    if (!parsed) {
      parsed = {
        s: safeJsonParse<SlimShow>(r.data_json, { id: r.show_id, name: `Show #${r.show_id}` } as SlimShow),
        t: safeJsonParse<ShowRecord>(r.record_json, { id: r.show_id }),
      };
      showCache.set(Number(r.show_id), parsed);
    }
    return formatScheduleEpisodeRow(r, parsed.s, parsed.t, watchedSet, withSummaries, now);
  });
}

export async function scheduleShows(
  db: D1Database,
  from: string,
  to: string,
  {
    withSummaries = false,
    includeHidden = false,
  }: { withSummaries?: boolean; includeHidden?: boolean } = {}
) {
  const { episodes: watchedSet } = await state.getWatchedSets(db);
  const now = Date.now();
  const out: any[] = [];

  const hiddenFilter = includeHidden ? "" : "AND s.hidden = 0";
  const { results: rows } = await db
    .prepare(
      `SELECT e.id, e.show_id, e.airdate, e.airtime, e.airstamp, e.season, e.number, e.episode_type, e.name, e.runtime,
              ${withSummaries ? "e.summary," : ""}
              s.hidden as show_hidden, s.record_json, s.data_json
       FROM episodes e
       JOIN shows s ON s.id = e.show_id
       WHERE e.airdate >= ?1 AND e.airdate <= ?2
         ${hiddenFilter}
       ORDER BY e.airdate ASC, e.airtime ASC, e.id ASC`
    )
    .bind(from, to)
    .all<any>();

  const showCache = new Map<number, { s: SlimShow; t: ShowRecord }>();
  const getShowParsed = (r: any) => {
    let parsed = showCache.get(Number(r.show_id));
    if (!parsed) {
      parsed = {
        s: safeJsonParse<SlimShow>(r.data_json, { id: r.show_id, name: `Show #${r.show_id}` } as SlimShow),
        t: safeJsonParse<ShowRecord>(r.record_json, { id: r.show_id }),
      };
      showCache.set(Number(r.show_id), parsed);
    }
    return parsed;
  };

  for (const r of rows || []) {
    const { s, t } = getShowParsed(r);
    out.push(formatScheduleEpisodeRow(r, s, t, watchedSet, withSummaries, now));
  }

  out.sort((a, b) => (a.airdate || "").localeCompare(b.airdate || "") || (a.airtime || "").localeCompare(b.airtime || ""));
  return out;
}

export async function refreshStaleShowsStep(db: D1Database, { force = false, maxCount = 4 }: { force?: boolean; maxCount?: number } = {}) {
  // Rely on TVmaze weekly updates feed so unchanged/ended shows don't rewrite D1 unnecessarily.
  const activeFallbackMs = 14 * 24 * 60 * 60 * 1000;
  const endedFallbackMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const [{ results: shows }, prevSync] = await Promise.all([
    db
      .prepare("SELECT id, status, updated_at, record_json FROM shows WHERE hidden = 0 ORDER BY updated_at ASC LIMIT 120")
      .all<{ id: number; status: string | null; updated_at: number; record_json: string }>(),
    getKv<{ lastSync?: number }>(db, "sync_status", {}),
  ]);

  let updatesMap: Record<string, number> = {};
  try {
    updatesMap = await tvmaze.fetchUpdates("week");
  } catch {
    try {
      updatesMap = await tvmaze.fetchUpdates("day");
    } catch {
      updatesMap = {};
    }
  }

  const toRefresh = (shows || []).filter((r) => {
    const extUpdated = (updatesMap[String(r.id)] || 0) * 1000;
    const age = now - Number(r.updated_at || 0);
    if (force) return age > 5 * 60_000;
    if (extUpdated > Number(r.updated_at || 0)) return true;
    const isEnded = String(r.status || "").toLowerCase() === "ended";
    return age > (isEnded ? endedFallbackMs : activeFallbackMs);
  });

  let refreshed = 0;
  for (const r of toRefresh.slice(0, maxCount)) {
    const full = await tvmaze.fetchShowFull(Number(r.id)).catch(() => null);
    if (!full) continue;
    const rec = safeJsonParse<ShowRecord>(r.record_json, { id: r.id });
    await upsertShowRecord(db, full, rec, { hiddenFlag: 0 });
    refreshed++;
  }
  const syncStatus = { running: false, total: toRefresh.length, done: refreshed, lastSync: now, error: null };
  if (refreshed > 0 || !prevSync?.lastSync || now - Number(prevSync.lastSync) > 6 * 3600_000) {
    await setKv(db, "sync_status", syncStatus);
  }
  return syncStatus;
}

export async function exportShowsBackup(db: D1Database, { includeKeys = false }: { includeKeys?: boolean } = {}, envTmdbKey = "") {
  const { results } = await db.prepare("SELECT record_json FROM shows WHERE hidden = 0").all<{ record_json: string }>();
  const shows = (results || []).map((r) => safeJsonParse<ShowRecord>(r.record_json, { id: 0 })).filter((x) => x.id);
  const rawSettings = await state.getRawSettings(db);
  const settingsOut = {
    extSearchUrl: rawSettings.extSearchUrl,
    interests: [...rawSettings.interests],
    installDate: rawSettings.installDate,
    style: rawSettings.style,
    showHidden: Boolean(rawSettings.showHidden),
    hideWatched: Boolean(rawSettings.hideWatched),
    notifyBrowser: Boolean(rawSettings.notifyBrowser),
    webhookUrl: rawSettings.webhookUrl || "",
    ...(includeKeys ? { tmdbApiKey: rawSettings.tmdbApiKey || envTmdbKey || "", tvmazeApiKey: rawSettings.tvmazeApiKey || "" } : {}),
  };
  return { shows, settings: settingsOut };
}
