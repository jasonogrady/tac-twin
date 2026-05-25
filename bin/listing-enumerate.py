#!/usr/bin/env python3
"""
tac-twin listing-page enumerator.

ZDNet's /blog/apple/ archives are paginated (page/1, page/2, ...). Each page lists
~10-20 posts with title + URL + date. Scraping these from Wayback snapshots is
dramatically cheaper than wildcarding CDX for the entire blog space, because each
listing page can yield 10-20 candidate posts in one fetch.

This script:
  1. Pulls listing-page URLs from tac_listing_queue (populated by `wayback-recover enumerate`)
  2. Fetches each from its most-recent Wayback snapshot
  3. Parses out post URLs + titles + dates
  4. Inserts discovered posts directly into tac_recovery_candidates (with hint='zdnet-listing-discovered')

Usage:
    bin/listing-enumerate.py [--limit N]
"""
import os, sys, re, time, sqlite3, argparse
from pathlib import Path
from urllib.parse import unquote, urljoin
from datetime import datetime

_VENV_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".venv"))
_VENV_PY = os.path.join(_VENV_DIR, "bin", "python")
if os.path.exists(_VENV_PY) and os.path.realpath(sys.prefix) != _VENV_DIR:
    os.execv(_VENV_PY, [_VENV_PY] + sys.argv)

import requests
from bs4 import BeautifulSoup

PROJECT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("TAC_DB", PROJECT_DIR / "recovery" / "tac.db"))
USER_AGENT = "tac-twin-recovery/1.0 (zdnet.com/blog/apple archive reconstruction)"
TIMEOUT = 60
RATE_LIMIT_SECONDS = 1.0
POST_URL_RE = re.compile(r"/blog/apple/([^/?#]+)/(\d+)/?$", re.I)

def newest_snapshot_url(original_url):
    """Get the most-recent Wayback snapshot URL for the page (no `id_` so we get a rendered page)."""
    r = requests.get(
        "https://archive.org/wayback/available",
        params={"url": original_url},
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    r.raise_for_status()
    snap = r.json().get("archived_snapshots", {}).get("closest", {})
    if not snap.get("available"):
        return None, None
    return snap["url"], snap["timestamp"]

def parse_listing(html, page_url):
    soup = BeautifulSoup(html, "html.parser")
    discovered = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        # Strip Wayback prefix if present
        href = re.sub(r"^https?://web\.archive\.org/web/\d+(?:id_)?/", "", href)
        m = POST_URL_RE.search(href)
        if not m:
            continue
        slug, zdnet_id = m.group(1), int(m.group(2))
        # Try to find a date next to this link (best-effort, varies by template era)
        date_str = None
        parent = a.parent
        for _ in range(3):
            if not parent: break
            time_el = parent.find("time") if hasattr(parent, "find") else None
            if time_el and time_el.get("datetime"):
                date_str = time_el["datetime"]
                break
            parent = getattr(parent, "parent", None)
        # Canonical URL form (drop query string)
        original = f"http://www.zdnet.com/blog/apple/{slug}/{zdnet_id}"
        discovered.append({
            "url": original, "zdnet_id": zdnet_id, "title": a.get_text(strip=True) or None,
            "date": date_str, "slug": slug,
        })
    # Dedupe by zdnet_id within this page
    seen = set()
    deduped = []
    for d in discovered:
        if d["zdnet_id"] in seen: continue
        seen.add(d["zdnet_id"])
        deduped.append(d)
    return deduped

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10, help="How many listing pages to scrape this run")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT id, page_url FROM tac_listing_queue
        WHERE last_scraped_at IS NULL
        ORDER BY page_number ASC NULLS LAST, id ASC
        LIMIT ?
    """, (args.limit,)).fetchall()

    if not rows:
        print("No unscraped listing pages. Run `wayback-recover enumerate` first.")
        return

    print(f"Scraping {len(rows)} listing pages…")
    total_discovered = 0
    for lid, page_url in rows:
        try:
            snap_url, ts = newest_snapshot_url(page_url)
            if not snap_url:
                conn.execute("UPDATE tac_listing_queue SET fail_reason='no snapshot', last_scraped_at=CURRENT_TIMESTAMP WHERE id=?", (lid,))
                print(f"  ✗ {page_url} → no snapshot")
                continue
            r = requests.get(snap_url, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
            r.raise_for_status()
            posts = parse_listing(r.text, page_url)
            inserted = 0
            for p in posts:
                cur = conn.execute("""
                    INSERT OR IGNORE INTO tac_recovery_candidates
                      (original_url, zdnet_id, cdx_timestamp, confidence, hint, digest)
                    VALUES (?, ?, ?, ?, 'zdnet-listing-discovered', NULL)
                """, (p["url"], p["zdnet_id"], ts, 0.92))
                if cur.rowcount: inserted += 1
            conn.execute("""
                UPDATE tac_listing_queue
                SET last_scraped_at=CURRENT_TIMESTAMP, posts_discovered=?
                WHERE id=?
            """, (len(posts), lid))
            conn.commit()
            print(f"  ✓ {page_url}  →  {len(posts)} posts seen, {inserted} new")
            total_discovered += inserted
        except Exception as e:
            conn.execute("UPDATE tac_listing_queue SET fail_reason=?, last_scraped_at=CURRENT_TIMESTAMP WHERE id=?",
                         (str(e)[:200], lid))
            conn.commit()
            print(f"  ✗ {page_url} → {e}", file=sys.stderr)
        time.sleep(RATE_LIMIT_SECONDS)

    print(f"\nDone. {total_discovered} new candidate posts staged.")

if __name__ == "__main__":
    main()
