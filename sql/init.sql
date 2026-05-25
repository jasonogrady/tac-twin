-- tac-twin schema
-- Unlike pp-twin (which has a WordPress dump as its primary source), tac-twin starts
-- from zero: every post has to be recovered. So there is no separate "primary" table;
-- tac_posts_recovered IS the canonical store, with `reviewed` as the editorial gate.

-- Recovered posts. Numeric ZDNet ID (the last path segment) is the canonical identifier.
CREATE TABLE IF NOT EXISTS tac_posts_recovered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zdnet_id            INTEGER,
  post_date           TEXT,
  post_title          TEXT,
  post_slug           TEXT,
  post_content        TEXT,
  post_author         TEXT,
  source              TEXT,        -- 'wayback' | 'listing-page' | 'crosslink' | 'manual'
  source_url          TEXT,        -- snapshot URL we extracted from
  source_original_url TEXT,        -- the original zdnet.com URL
  source_snapshot_ts  TEXT,        -- 14-digit CDX timestamp
  confidence          REAL,
  reviewed            INTEGER DEFAULT 0,    -- 0=pending, 1=accepted, -1=rejected
  reviewer_notes      TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(zdnet_id)
);
CREATE INDEX IF NOT EXISTS idx_tac_posts_date     ON tac_posts_recovered(post_date);
CREATE INDEX IF NOT EXISTS idx_tac_posts_reviewed ON tac_posts_recovered(reviewed);

-- Discovered candidate URLs from CDX or listing-page scrapes.
CREATE TABLE IF NOT EXISTS tac_recovery_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_url        TEXT NOT NULL,
  zdnet_id            INTEGER,         -- extracted from URL when present
  cdx_timestamp       TEXT NOT NULL,
  inferred_date       TEXT,
  confidence          REAL,
  hint                TEXT,            -- 'zdnet-post' | 'zdnet-listing' | 'zdnet-tagged' | etc
  digest              TEXT,
  status              TEXT DEFAULT 'pending',  -- pending | fetched | failed | skipped
  fail_reason         TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(original_url, cdx_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_tac_cand_status ON tac_recovery_candidates(status);
CREATE INDEX IF NOT EXISTS idx_tac_cand_zdnet_id ON tac_recovery_candidates(zdnet_id);

-- Paginated listing pages to scrape for post URL discovery.
-- e.g. http://www.zdnet.com/blog/apple/page/3/ or /blog/apple/?paged=3
CREATE TABLE IF NOT EXISTS tac_listing_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_url            TEXT UNIQUE,
  page_number         INTEGER,
  last_scraped_at     DATETIME,
  posts_discovered    INTEGER DEFAULT 0,
  fail_reason         TEXT
);

-- Cron audit log.
CREATE TABLE IF NOT EXISTS tac_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         DATETIME NOT NULL,
  finished_at        DATETIME,
  kind               TEXT,            -- 'tick' | 'enumerate' | 'fetch' | 'listing'
  candidates_added   INTEGER DEFAULT 0,
  posts_recovered    INTEGER DEFAULT 0,
  failures           INTEGER DEFAULT 0,
  notes              TEXT
);
