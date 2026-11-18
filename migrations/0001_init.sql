-- Viuhti Cloudflare Free Tier D1 Schema

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  directors_choice INTEGER NOT NULL DEFAULT 0,
  channel_name TEXT,
  channel_kind TEXT,
  status TEXT,
  premiered TEXT,
  rating REAL,
  genres_json TEXT NOT NULL DEFAULT '[]',
  record_json TEXT NOT NULL DEFAULT '{}',
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shows_favorite ON shows(favorite, hidden);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL,
  airdate TEXT NOT NULL,
  airtime TEXT,
  airstamp TEXT,
  season INTEGER,
  number INTEGER,
  episode_type TEXT,
  name TEXT,
  runtime INTEGER,
  summary TEXT,
  url TEXT,
  image TEXT,
  UNIQUE(show_id, season, number, airdate, id)
);
CREATE INDEX IF NOT EXISTS idx_episodes_airdate ON episodes(airdate);
CREATE INDEX IF NOT EXISTS idx_episodes_show_id ON episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_episodes_show_airdate ON episodes(show_id, airdate);

CREATE TABLE IF NOT EXISTS watched_episodes (
  ep_id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL,
  watched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watched_episodes_show ON watched_episodes(show_id);

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  release_date TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  directors_choice INTEGER NOT NULL DEFAULT 0,
  channel_name TEXT,
  status TEXT,
  rating REAL,
  genres_json TEXT NOT NULL DEFAULT '[]',
  record_json TEXT NOT NULL DEFAULT '{}',
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movies_release ON movies(release_date);

CREATE TABLE IF NOT EXISTS watched_movies (
  movie_id INTEGER PRIMARY KEY,
  watched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hidden_items (
  kind TEXT NOT NULL CHECK(kind IN ('show', 'movie')),
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_hidden_at ON hidden_items(hidden_at DESC);

CREATE TABLE IF NOT EXISTS wordpool (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('primary', 'fuzzy', 'exclude')),
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wordpool_mode ON wordpool(mode, created_at DESC);

CREATE TABLE IF NOT EXISTS digest_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('show', 'movie')),
  item_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_at ON digest_items(at DESC);

CREATE TABLE IF NOT EXISTS taste_items (
  item_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('show', 'movie', 'dismissed', 'skipped', 'profile')),
  id INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taste_kind_score ON taste_items(kind, score DESC);

CREATE TABLE IF NOT EXISTS wiki_cache (
  cache_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_cache (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
