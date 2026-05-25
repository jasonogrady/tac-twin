#!/usr/bin/env python3
"""
tac-twin Wayback Machine recovery scraper.

The Apple Core ran on ZDNet 2005-2014. Every post is missing — recovery is
the entire content pipeline.

Stages candidate URLs from archive.org's CDX index into tac_recovery_candidates,
fetches each snapshot, extracts {title, body, author, date, zdnet_id} and inserts
into tac_posts_recovered for human review in tac-twin.

Usage:
    bin/wayback-recover.py enumerate                       # CDX scan for the whole 2005-2014 era
    bin/wayback-recover.py enumerate --from 20060101 --to 20061231
    bin/wayback-recover.py fetch [--limit N] [--no-body]
    bin/wayback-recover.py tick                            # one bounded enumerate + fetch (for cron)
    bin/wayback-recover.py status
    bin/wayback-recover.py retry-failed
    bin/wayback-recover.py reset-candidates

Requires: pip install requests beautifulsoup4
"""

import os
import sys

# Self-bootstrap into the project venv.
_VENV_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".venv"))
_VENV_PY = os.path.join(_VENV_DIR, "bin", "python")
if os.path.exists(_VENV_PY) and os.path.realpath(sys.prefix) != _VENV_DIR:
    os.execv(_VENV_PY, [_VENV_PY] + sys.argv)

import argparse
import json
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Missing deps. Run setup once:\n  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt")

# ─── config ───────────────────────────────────────────────────────────────────
PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = PROJECT_DIR / "recovery" / "tac.db"
DB_PATH = Path(os.environ.get("TAC_DB", DEFAULT_DB_PATH))
HOST = "zdnet.com"
HOST_PATH_PREFIX = "blog/apple"   # narrow CDX scans to The Apple Core
# UA for Wayback: identifying string is fine, Wayback is the public archive
WAYBACK_USER_AGENT = "tac-twin-recovery/1.0 (zdnet.com/blog/apple archive reconstruction by original author Jason O'Grady)"
# UA for any live-zdnet.com fetches: must look like a normal browser per the licensing
# terms (content is non-exclusive license to the author, permitted self-host, requires
# pages be downloaded one at a time as a human would).
ZDNET_LIVE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
USER_AGENT = WAYBACK_USER_AGENT   # default for module-level fetches
REQUEST_TIMEOUT = 60
CDX_TIMEOUT = 180
RATE_LIMIT_SECONDS = 1.0           # Wayback default
ZDNET_LIVE_RATE_LIMIT = 4.0        # for any live-zdnet fetches (sequential, human-paced)
MAX_WINDOW_DAYS = 365              # CDX prefix queries 504 on multi-year ranges

# ─── URL classification ───────────────────────────────────────────────────────
# Asset extensions to skip wholesale.
SKIP_EXT_RE = re.compile(r"\.(jpg|jpeg|gif|png|webp|css|js|ico|svg|woff|ttf|pdf|zip|mp3|mp4|mov|avi)(\?|$)", re.I)
# Non-post URL paths under /blog/apple/.
SKIP_PATH_RE = re.compile(r"/blog/apple/(?:tag|category|author|search|feed|rss)(?:/|$)", re.I)

# Order matters — listing patterns checked BEFORE generic post-noid so /blog/apple/3/ goes to listings.
POST_HINTS = [
    # Pagination listings — staged in tac_listing_queue, not the candidate queue.
    (re.compile(r"/blog/apple/page/(\d+)/?$", re.I),               0.0,  "zdnet-listing"),
    (re.compile(r"/blog/apple/(\d{1,3})/?$", re.I),                0.0,  "zdnet-listing-numbered"),
    # Canonical ZDNet 2008-2014 shape: /blog/apple/{slug}/{numeric-id}
    (re.compile(r"/blog/apple/([^/?#]+)/(\d+)(?:[?/#]|$)", re.I),  0.95, "zdnet-post"),
    # Older shape with no trailing ID: /blog/apple/{slug}/
    (re.compile(r"/blog/apple/([^/?#]+)/?(?:[?#]|$)", re.I),       0.70, "zdnet-post-noid"),
    # Earliest era (2005-2007) often at blogs.zdnet.com/apple/?p=N
    (re.compile(r"blogs\.zdnet\.com/apple/\?p=(\d+)", re.I),       0.80, "zdnet-legacy-pid"),
]

LISTING_HINTS = ("zdnet-listing", "zdnet-listing-numbered")

def classify_url(url):
    """Return (confidence, hint, groups) or None."""
    if SKIP_EXT_RE.search(url) or SKIP_PATH_RE.search(url):
        return None
    for pat, conf, hint in POST_HINTS:
        m = pat.search(url)
        if m:
            return (conf, hint, m.groups())
    return None

def extract_zdnet_id(url, groups, hint):
    """Pull the numeric post ID from a classified URL, or None for listings/old style."""
    if hint == "zdnet-post" and len(groups) >= 2:
        try: return int(groups[1])
        except: return None
    if hint == "zdnet-legacy-pid" and len(groups) >= 1:
        try: return int(groups[0])
        except: return None
    return None

# ─── schema bootstrap ─────────────────────────────────────────────────────────
def open_db():
    if not DB_PATH.exists():
        sys.exit(f"Database not found at {DB_PATH}. Run `sqlite3 {DB_PATH} < sql/init.sql` first.")
    conn = sqlite3.connect(DB_PATH)
    return conn

# ─── CDX ──────────────────────────────────────────────────────────────────────
def cdx_query(url_pattern, ts_from, ts_to, retries=3):
    """Returns a list of dicts of CDX rows for the given URL prefix pattern."""
    params = {
        "url": url_pattern,
        "from": ts_from,
        "to": ts_to,
        "output": "json",
        "filter": ["statuscode:200", "mimetype:text/html"],
        "collapse": "urlkey",
    }
    url = "https://web.archive.org/cdx/search/cdx"
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=CDX_TIMEOUT,
                             headers={"User-Agent": USER_AGENT})
            r.raise_for_status()
            data = r.json()
            if not data:
                return []
            header, *rows = data
            return [dict(zip(header, row)) for row in rows]
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"  CDX retry {attempt+1}/{retries} after error: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)

# ─── enumerate ────────────────────────────────────────────────────────────────
def _chunk_window(start_iso_8, end_iso_8, max_days=MAX_WINDOW_DAYS):
    """Split YYYYMMDD..YYYYMMDD into ≤max_days sub-ranges."""
    a = datetime.strptime(start_iso_8, "%Y%m%d").date()
    b = datetime.strptime(end_iso_8,   "%Y%m%d").date()
    out = []
    cur = a
    while cur <= b:
        nxt = min(cur + timedelta(days=max_days - 1), b)
        out.append((cur.strftime("%Y%m%d"), nxt.strftime("%Y%m%d")))
        cur = nxt + timedelta(days=1)
    return out

def enumerate_window(conn, ts_from, ts_to):
    url_pattern = f"{HOST}/{HOST_PATH_PREFIX}/*"
    print(f"  CDX {url_pattern} {ts_from} → {ts_to}")
    rows = cdx_query(url_pattern, ts_from, ts_to)
    print(f"  CDX returned {len(rows)} crawled URLs", file=sys.stderr)
    inserted = skipped = 0
    listing = 0
    cur = conn.cursor()
    for row in rows:
        original = unquote(row["original"])
        cls = classify_url(original)
        if not cls:
            skipped += 1
            continue
        confidence, hint, groups = cls
        zdnet_id = extract_zdnet_id(original, groups, hint)
        # Listing pages get inserted into the listing queue, not the candidate queue
        if hint in LISTING_HINTS:
            try:
                cur.execute("""
                    INSERT OR IGNORE INTO tac_listing_queue (page_url, page_number)
                    VALUES (?, ?)
                """, (original, int(groups[0]) if groups and groups[0].isdigit() else None))
                if cur.rowcount: listing += 1
            except Exception as e:
                print(f"  listing insert error: {e}", file=sys.stderr)
            continue
        try:
            cur.execute("""
                INSERT OR IGNORE INTO tac_recovery_candidates
                  (original_url, zdnet_id, cdx_timestamp, confidence, hint, digest)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (original, zdnet_id, row["timestamp"], confidence, hint, row.get("digest")))
            if cur.rowcount: inserted += 1
        except Exception as e:
            print(f"  insert error for {original}: {e}", file=sys.stderr)
    conn.commit()
    print(f"  staged {inserted} new posts · {listing} listing pages · skipped {skipped}")
    return inserted

def cmd_enumerate(args):
    conn = open_db()
    if args.from_ts and args.to_ts:
        windows = [(args.from_ts, args.to_ts)]
    else:
        windows = _chunk_window("20050101", "20141231")
        print(f"Scanning entire 2005-2014 era in {len(windows)} chunks")
    total = 0
    for i, (ts_from, ts_to) in enumerate(windows, 1):
        print(f"\n[{i}/{len(windows)}] window {ts_from}–{ts_to}")
        try:
            total += enumerate_window(conn, ts_from, ts_to)
        except Exception as e:
            print(f"  window failed: {e}", file=sys.stderr)
        time.sleep(RATE_LIMIT_SECONDS)
    print(f"\nDone. {total} new candidates staged.")

# ─── fetch + extract ──────────────────────────────────────────────────────────
def fetch_snapshot(timestamp, original_url, retries=4):
    """GET an archived snapshot with retry/backoff."""
    snap_url = f"https://web.archive.org/web/{timestamp}id_/{original_url}"
    last_err = None
    for attempt in range(retries):
        try:
            r = requests.get(snap_url, timeout=REQUEST_TIMEOUT,
                             headers={"User-Agent": USER_AGENT}, allow_redirects=True)
            if r.status_code in (429, 503, 504):
                raise requests.HTTPError(f"{r.status_code} transient from Wayback", response=r)
            r.raise_for_status()
            return r.text, snap_url
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            last_err = e
            if attempt == retries - 1:
                break
            time.sleep(2 ** attempt)
    raise last_err

def _title_from_slug(original_url):
    """Derive a human title from a URL slug (e.g. /blog/apple/some-post-title/1234 → 'Some Post Title')."""
    path = urlparse(original_url).path
    # Strip trailing numeric ID if present
    parts = [p for p in path.rstrip("/").split("/") if p]
    # Drop the numeric ID at the end
    if parts and parts[-1].isdigit():
        parts = parts[:-1]
    if not parts:
        return None
    slug = parts[-1]
    slug = re.sub(r"\.(html?|php)$", "", slug, flags=re.I)
    if not slug or slug.isdigit():
        return None
    return slug.replace("-", " ").replace("_", " ").strip().title() or None

def extract_post(html, original_url):
    soup = BeautifulSoup(html, "html.parser")
    # Strip wayback chrome
    for tag in soup.find_all(id=re.compile(r"^(wm-|wayback|donato)", re.I)):
        tag.decompose()
    for tag in soup.find_all(class_=re.compile(r"^(wm-|wayback)", re.I)):
        tag.decompose()

    def pick(*candidates):
        for c in candidates:
            if c: return c
        return None

    # Title — ZDNet templates across eras
    title_el = pick(
        soup.find("h1", class_=re.compile(r"(article|post|entry|title)-?(title|header)", re.I)),
        soup.find("meta", attrs={"property": "og:title"}),
        soup.find("meta", attrs={"name": "title"}),
        soup.find("h1"),
        soup.find("h2", class_=re.compile(r"(article|post|entry)-?title", re.I)),
    )
    title = None
    if title_el is not None:
        title = title_el.get("content") if title_el.name == "meta" else title_el.get_text(strip=True)
    # ZDNet site-wide chrome titles to skip
    if title and re.search(r"^\s*ZDNet\s*$|^\s*The Apple Core\s*\|", title, re.I):
        title = None
    if not title:
        title = _title_from_slug(original_url)

    # Body — ZDNet has had several template eras; cast wide
    body_el = pick(
        soup.find("div", class_=re.compile(r"article-body|post-body|entry-content|story-body|content-body", re.I)),
        soup.find("article"),
        soup.find("div", attrs={"itemprop": "articleBody"}),
        soup.find("div", id=re.compile(r"article-?content|post-?\d+", re.I)),
    )
    body = str(body_el) if body_el else None

    # Author
    author_el = pick(
        soup.find("a", rel="author"),
        soup.find(["a","span","div"], class_=re.compile(r"author(-name)?|byline", re.I)),
        soup.find("meta", attrs={"property": "article:author"}),
        soup.find("meta", attrs={"name": "author"}),
    )
    author = None
    if author_el is not None:
        author = author_el.get("content") if author_el.name == "meta" else author_el.get_text(strip=True)

    # Date
    date_el = pick(
        soup.find("meta", attrs={"property": "article:published_time"}),
        soup.find("meta", attrs={"name": "date"}),
        soup.find("time"),
        soup.find(class_=re.compile(r"post-date|publish(ed)?-?date|article-date", re.I)),
    )
    date_str = None
    if date_el is not None:
        date_str = date_el.get("datetime") or date_el.get("content") or date_el.get_text(strip=True)

    return {"title": title, "body": body, "author": author, "date": date_str}

def normalize_date(s):
    if not s: return None
    s = s.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s[:len(fmt)+5], fmt).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
    return None

def cmd_fetch(args):
    conn = open_db()
    where = "status='pending'"
    if args.min_confidence:
        where += f" AND confidence >= {float(args.min_confidence)}"
    sql = f"""SELECT id, original_url, zdnet_id, cdx_timestamp, confidence, hint
              FROM tac_recovery_candidates
              WHERE {where}
              ORDER BY confidence DESC, cdx_timestamp ASC
              LIMIT ?"""
    rows = conn.execute(sql, (args.limit,)).fetchall()
    if not rows:
        print("No pending candidates. Run `enumerate` first.")
        return
    no_body = bool(getattr(args, "no_body", False))
    print(f"Fetching {len(rows)} candidates (min confidence={args.min_confidence or 'any'}, no_body={no_body})…")
    ok = failed = 0
    for cand_id, url, zdnet_id, ts, conf, hint in rows:
        try:
            html, snap_url = fetch_snapshot(ts, url)
            data = extract_post(html, url)
            in_page_date = normalize_date(data["date"])
            snap_date = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]} {ts[8:10]}:{ts[10:12]}:{ts[12:14]}"
            best_date = in_page_date or snap_date
            slug = None
            m = re.search(r"/blog/apple/([^/?#]+)/", url)
            if m: slug = m.group(1)
            conn.execute("""
                INSERT OR IGNORE INTO tac_posts_recovered
                  (zdnet_id, post_date, post_title, post_slug, post_content,
                   post_author, source, source_url, source_original_url, source_snapshot_ts, confidence)
                VALUES (?, ?, ?, ?, ?, ?, 'wayback', ?, ?, ?, ?)
            """, (zdnet_id, best_date, data["title"], slug,
                  None if no_body else data["body"],
                  data["author"], snap_url, url, ts, conf))
            conn.execute("UPDATE tac_recovery_candidates SET status='fetched' WHERE id=?", (cand_id,))
            ok += 1
            print(f"  ✓ {best_date[:10]} · {(data['title'] or '(no title)')[:80]}")
        except Exception as e:
            conn.execute("UPDATE tac_recovery_candidates SET status='failed', fail_reason=? WHERE id=?",
                         (str(e)[:200], cand_id))
            failed += 1
            print(f"  ✗ {url[:80]} → {e}", file=sys.stderr)
        conn.commit()
        time.sleep(RATE_LIMIT_SECONDS)
    print(f"\nDone. {ok} fetched, {failed} failed.")

# ─── tick (one bounded cron iteration) ────────────────────────────────────────
def cmd_tick(args):
    conn = open_db()
    started = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    run_id = conn.execute(
        "INSERT INTO tac_runs (started_at, kind) VALUES (?, 'tick')", (started,)
    ).lastrowid
    conn.commit()

    recovered_before = conn.execute("SELECT COUNT(*) FROM tac_posts_recovered").fetchone()[0]
    failures_before  = conn.execute("SELECT COUNT(*) FROM tac_recovery_candidates WHERE status='failed'").fetchone()[0]
    candidates_added = 0

    # Pick one month-sized window per tick from the cold-start sweep.
    # Start at 2005-01 and advance monthly using tac_runs.notes as a cursor.
    last = conn.execute(
        "SELECT notes FROM tac_runs WHERE kind='tick' AND notes IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if last and last[0]:
        try:
            cursor_y, cursor_m = map(int, last[0].split("-"))
            cursor_y, cursor_m = (cursor_y, cursor_m + 1) if cursor_m < 12 else (cursor_y + 1, 1)
        except Exception:
            cursor_y, cursor_m = 2005, 1
    else:
        cursor_y, cursor_m = 2005, 1
    if cursor_y > 2014:
        cursor_y, cursor_m = 2005, 1   # wrap and re-sweep
    ts_from = f"{cursor_y:04d}{cursor_m:02d}01"
    ts_to   = f"{cursor_y:04d}{cursor_m:02d}28"
    print(f"[tick] enumerating {ts_from}–{ts_to}")
    try:
        candidates_added += enumerate_window(conn, ts_from, ts_to)
    except Exception as e:
        print(f"  window failed: {e}", file=sys.stderr)

    cursor_label = f"{cursor_y:04d}-{cursor_m:02d}"
    conn.execute("UPDATE tac_runs SET notes=? WHERE id=?", (cursor_label, run_id))
    conn.commit()

    print(f"[tick] fetching up to {args.limit} candidates")
    fetch_args = argparse.Namespace(limit=args.limit, min_confidence=args.min_confidence, no_body=args.no_body)
    cmd_fetch(fetch_args)

    recovered_after = conn.execute("SELECT COUNT(*) FROM tac_posts_recovered").fetchone()[0]
    failures_after  = conn.execute("SELECT COUNT(*) FROM tac_recovery_candidates WHERE status='failed'").fetchone()[0]
    conn.execute("""
        UPDATE tac_runs SET finished_at=?, candidates_added=?, posts_recovered=?, failures=?
        WHERE id=?
    """, (datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
          candidates_added,
          recovered_after - recovered_before,
          failures_after - failures_before, run_id))
    conn.commit()
    print(f"[tick] done · +{candidates_added} candidates · "
          f"+{recovered_after - recovered_before} recovered · "
          f"+{failures_after - failures_before} new failures")

# ─── status ───────────────────────────────────────────────────────────────────
def cmd_status(args):
    conn = open_db()
    print("=== Recovery candidates ===")
    for row in conn.execute("SELECT status, COUNT(*) n FROM tac_recovery_candidates GROUP BY status ORDER BY n DESC"):
        print(f"  {row[0]:10} {row[1]:>6}")
    print(f"  {'TOTAL':10} {conn.execute('SELECT COUNT(*) FROM tac_recovery_candidates').fetchone()[0]:>6}")

    print("\n=== Listing queue ===")
    print(f"  total: {conn.execute('SELECT COUNT(*) FROM tac_listing_queue').fetchone()[0]}")
    print(f"  scraped: {conn.execute('SELECT COUNT(*) FROM tac_listing_queue WHERE last_scraped_at IS NOT NULL').fetchone()[0]}")

    print("\n=== Recovered posts ===")
    for row in conn.execute("SELECT reviewed, COUNT(*) n FROM tac_posts_recovered GROUP BY reviewed"):
        label = {0:"pending", 1:"accepted", -1:"rejected"}.get(row[0], str(row[0]))
        print(f"  {label:10} {row[1]:>6}")
    print(f"  {'TOTAL':10} {conn.execute('SELECT COUNT(*) FROM tac_posts_recovered').fetchone()[0]:>6}")

    print("\n=== Year distribution (recovered) ===")
    for row in conn.execute("""
        SELECT substr(post_date,1,4) yr, COUNT(*) n
        FROM tac_posts_recovered
        WHERE post_date IS NOT NULL
        GROUP BY yr ORDER BY yr"""):
        print(f"  {row[0]}  {row[1]:>6}")

def cmd_reset_candidates(args):
    conn = open_db()
    n = conn.execute("DELETE FROM tac_recovery_candidates WHERE status='pending'").rowcount
    conn.commit()
    print(f"Cleared {n} pending candidates")

def cmd_retry_failed(args):
    conn = open_db()
    n = conn.execute("UPDATE tac_recovery_candidates SET status='pending', fail_reason=NULL WHERE status='failed'").rowcount
    conn.commit()
    print(f"Re-queued {n} failed candidates")

# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_enum = sub.add_parser("enumerate", help="Stage CDX candidates")
    p_enum.add_argument("--from", dest="from_ts", help="YYYYMMDD start")
    p_enum.add_argument("--to",   dest="to_ts",   help="YYYYMMDD end")
    p_enum.set_defaults(func=cmd_enumerate)

    p_fetch = sub.add_parser("fetch", help="Fetch & extract pending candidates")
    p_fetch.add_argument("--limit", type=int, default=50)
    p_fetch.add_argument("--min-confidence", type=float, default=0.7)
    p_fetch.add_argument("--no-body", action="store_true")
    p_fetch.set_defaults(func=cmd_fetch)

    p_tick = sub.add_parser("tick", help="One bounded iteration (for cron)")
    p_tick.add_argument("--limit", type=int, default=30)
    p_tick.add_argument("--min-confidence", type=float, default=0.7)
    p_tick.add_argument("--no-body", action="store_true", default=True)
    p_tick.set_defaults(func=cmd_tick)

    p_status = sub.add_parser("status")
    p_status.set_defaults(func=cmd_status)

    p_reset = sub.add_parser("reset-candidates")
    p_reset.set_defaults(func=cmd_reset_candidates)

    p_retry = sub.add_parser("retry-failed")
    p_retry.set_defaults(func=cmd_retry_failed)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
