#!/usr/bin/env python3
"""
Cross-link enrichment: scan pp-twin's powerpage.db for any references to
zdnet.com/blog/apple/ URLs and seed them as high-confidence candidates in tac.db.

Each link in a PowerPage post is independent evidence that the TAC post existed.
PowerPage post_date gives a useful upper bound on when the TAC post was published.

Usage:
    bin/crosslink-from-pp.py [--pp-db PATH] [--tac-db PATH] [--dry-run]
"""
import os, sys, re, sqlite3, argparse
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TAC_DB = PROJECT_DIR / "recovery" / "tac.db"
DEFAULT_PP_DB  = Path(os.environ.get("PP_DB", PROJECT_DIR / ".." / "pp-twin" / "powerpage.db"))

# Match TAC post URLs in HTML content. Permissive: any zdnet host, any sub-path.
URL_RE = re.compile(
    r"https?://(?:www\.|blogs\.)?zdnet\.com/blog/apple/([^\s/?#\"<>]+)/(\d+)",
    re.I
)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pp-db", default=str(DEFAULT_PP_DB))
    ap.add_argument("--tac-db", default=str(DEFAULT_TAC_DB))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pp = sqlite3.connect(args.pp_db)
    tac = sqlite3.connect(args.tac_db)

    rows = pp.execute("""
        SELECT post_date, post_content
        FROM peq_posts
        WHERE post_content LIKE '%zdnet.com/blog/apple/%'
          AND post_status = 'publish' AND post_type = 'post'
    """).fetchall()

    seen = {}   # zdnet_id → {slug, evidence_date, original_url}
    for post_date, content in rows:
        for m in URL_RE.finditer(content or ""):
            slug, zid_str = m.group(1), m.group(2)
            try: zid = int(zid_str)
            except: continue
            url = f"http://www.zdnet.com/blog/apple/{slug}/{zid}"
            if zid in seen:
                # Keep the EARLIEST PowerPage reference (closer to actual publication)
                if post_date and (not seen[zid]["evidence_date"] or post_date < seen[zid]["evidence_date"]):
                    seen[zid]["evidence_date"] = post_date
            else:
                seen[zid] = {"slug": slug, "url": url, "evidence_date": post_date}

    print(f"Found {len(seen)} unique TAC URLs referenced in {len(rows)} PowerPage posts")
    if args.dry_run:
        for zid, info in sorted(seen.items()):
            print(f"  {zid}  {info['evidence_date'][:10] if info['evidence_date'] else '---'}  {info['slug']}")
        return

    # Insert as candidates. Use a synthetic CDX timestamp anchored to the evidence date
    # so the candidate sorts correctly in year-distribution panels.
    inserted = 0
    skipped = 0
    for zid, info in seen.items():
        ts = (info["evidence_date"] or "20100101000000").replace("-", "").replace(" ", "").replace(":", "")[:14].ljust(14, "0")
        try:
            cur = tac.execute("""
                INSERT OR IGNORE INTO tac_recovery_candidates
                  (original_url, zdnet_id, cdx_timestamp, confidence, hint, digest, status)
                VALUES (?, ?, ?, ?, 'crosslink-from-pp', NULL, 'pending')
            """, (info["url"], zid, ts, 0.90))
            if cur.rowcount: inserted += 1
            else: skipped += 1
        except Exception as e:
            print(f"  insert error for {info['url']}: {e}", file=sys.stderr)
    tac.commit()
    print(f"Inserted {inserted} new candidates; {skipped} already existed.")

if __name__ == "__main__":
    main()
