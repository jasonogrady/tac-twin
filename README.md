# tac-twin

A recovery + review pipeline for **The Apple Core** — Jason O'Grady's ZDNet blog at `zdnet.com/blog/apple/` from 2005-2014. ZDNet has discontinued the URL space (old links 301 to `/topic/apple/`), so most posts have to be reconstructed from Wayback Machine snapshots.

Sibling project of [`pp-twin`](https://github.com/jasonogrady/pp-twin) which recovers `powerpage.org` posts. Same pipeline shape; different data model because tac-twin starts from zero.

## Rights and crawling etiquette

Jason O'Grady authored these posts under a **non-exclusive license to ZDNet** and retains the right to download and host the content on his own sites. The only condition is that pages be **fetched one at a time, sequentially, at a human pace** — no parallel scraping, no aggressive crawling.

Operational implications:
- Primary source remains **Wayback Machine** (most original URLs no longer resolve on live ZDNet anyway)
- Any live-zdnet.com fetches use a real browser UA (`ZDNET_LIVE_USER_AGENT` in `bin/wayback-recover.py`) and a 4s sequential rate limit (`ZDNET_LIVE_RATE_LIMIT`)
- Wayback fetches use a 1s rate limit (their standard tolerance)
- No `robots.txt` violations: zdnet.com generally allows crawling of `/blog/apple/`; verify before any live scrape

![status](https://img.shields.io/badge/status-v0.1-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## What's different from pp-twin

| | pp-twin | tac-twin |
|---|---|---|
| Source of truth | WordPress dump (1.2 GB) | Nothing — 100% recovered |
| Primary table | `wp_posts` | `tac_posts_recovered` IS the canonical store |
| Gap analysis | Compare WP vs calendar | Whole 2005-2014 era is a gap |
| URL classifier | `/YYYY/MM/slug` WordPress shapes | `/blog/apple/{slug}/{numeric-id}` |
| Discovery mode | CDX wildcard | CDX wildcard **+** listing-page scrape (multiplier) |
| Author | Single (mostly) | Mostly Jason, some guests late |

## Architecture

```
recovery/tac.db                  cloud-managed SQLite (committed every 2h via GH Actions)
sql/init.sql                     schema
bin/
  wayback-recover.py             CDX scan + snapshot fetch + extract → tac_posts_recovered
  listing-enumerate.py           scrape /blog/apple/page/N listing pages for post URLs
  deploy-pages.sh                Cloudflare Pages build + deploy
.github/workflows/hunter.yml     2h cron: bounded enumerate + fetch + commit
tac-twin.jsx                     React app (to be added)
```

## Quick start

```zsh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# One-time: seed the DB with the schema
sqlite3 recovery/tac.db < sql/init.sql

# Pre-flight: scope check
curl 'https://web.archive.org/cdx/search/cdx?url=zdnet.com/blog/apple/*&from=20050101&to=20141231&output=json&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey&showNumPages=true'

# Enumerate the 2010 window (manageable starting point)
bin/wayback-recover.py enumerate --from 20100101 --to 20101231

# Fetch a small batch end-to-end
bin/wayback-recover.py fetch --limit 20 --no-body

# Status
bin/wayback-recover.py status
```

## Cloud Hunter

Once `recovery/tac.db` is committed to a public GitHub repo, the workflow at `.github/workflows/hunter.yml` will fire every 2h: one bounded enumerate (advancing a 2005→2014 cursor monthly) + up to 30 fetches per tick. Results commit back to `recovery/tac.db` so a future browser-side UI can fetch it via `raw.githubusercontent.com` — same pattern as pp-twin.

## ZDNet URL classification

| Pattern | Confidence | Hint | Era |
|---|---|---|---|
| `/blog/apple/{slug}/{numeric-id}` | 0.95 | `zdnet-post` | 2008-2014 (canonical) |
| `/blog/apple/{slug}/` (no ID) | 0.70 | `zdnet-post-noid` | older era |
| `blogs.zdnet.com/apple/?p={n}` | 0.80 | `zdnet-legacy-pid` | 2005-2007 |
| `/blog/apple/page/{n}/` | n/a | `zdnet-listing` | all eras (queued separately) |

Numeric ID at the end of post URLs is the canonical identifier — `UNIQUE(zdnet_id)` is the dedup key for recovered posts.

## License

MIT
