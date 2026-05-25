# Morning summary — tac-twin v0.1

> **🔔 Your reminder to yourself:** *use the Mac mini, not the MacBook, for the next overnight session.* The MacBook sleeps with the lid closed (no external display) and that risks suspending my session — the Mac mini stays awake 24/7. Saved to memory so I'll surface it proactively next time too.

You went to bed with a sanity-check + scaffold; you wake up to a working autonomous system.

## What shipped

| | URL |
|---|---|
| **Repo (public)** | https://github.com/jasonogrady/tac-twin |
| **Live app** | https://tac-twin.pages.dev |
| **Cron workflow** | https://github.com/jasonogrady/tac-twin/actions/workflows/hunter.yml |
| **Cloud DB** | https://raw.githubusercontent.com/jasonogrady/tac-twin/main/recovery/tac.db |
| **v0.1 release** | https://github.com/jasonogrady/tac-twin/releases/tag/v0.1 |

Open https://tac-twin.pages.dev on your phone — Hunter tab auto-loads the cloud DB. Mobile-native, no file picker, ☁ CLOUD SNAPSHOT chip in teal so you know it's read-only public data.

## What's running on its own

**GitHub Actions cron, every 2 hours at :37.** Each tick:
1. Advances a 2005-2014 half-year cursor (H1 2005 → H2 2005 → H1 2006 → … → H2 2014 → wrap).
2. Enumerates that half-year via Wayback CDX.
3. Fetches up to 30 candidates with `--no-body` (keeps the committed DB small).
4. Commits `recovery/tac.db` back to main with a `hunter tick — recovered=N cand=…` message.

Concurrency-locked (`group: hunter`). Idempotent. Cron continues even if your Mac sleeps.

Full 2005-2014 sweep takes 20 ticks (10 years × 2 halves) = ~40 hours = ~2 days. By end of next week you'll have most of TAC enumerated. Then it shifts to draining the pending fetch queue (~1k+ candidates).

## What's already in the DB

State as of last sync (the numbers keep growing as cron ticks land):

- **583 candidates** staged from Wayback's H1 2010 capture (the cold-start sweep)
- **79 recovered posts** so far — 5 from the smoke test + 74 across 4 successful cron ticks
- **458 still pending fetch**, **44 transient failures** (Wayback rate-limited — retry/backoff handles)
- Half-year cursor at **2006-H2** — cron has done H1 2005, H2 2005, H1 2006, H2 2006

The first manual dispatch I triggered hit a push race against my own `MORNING.md` commit and failed. I fixed the workflow to retry-rebase on race, and every subsequent scheduled tick has succeeded.

Cron commit history visible at https://github.com/jasonogrady/tac-twin/commits/main — each `hunter tick —` line gives the deltas.

## Bonus: cross-link enrichment from pp-twin

Wrote `bin/crosslink-from-pp.py` which scans your existing PowerPage archive for `zdnet.com/blog/apple/{slug}/{id}` URLs in post bodies. Each link is independent evidence a TAC post existed. First run found **16 unique TAC URLs** referenced in 20 PowerPage posts, all from 2010-2013 and none overlapping with the H1 2010 CDX enumeration. Staged as 0.90-confidence candidates.

Sample (zdnet_id + slug + earliest PowerPage reference):
- 7610 · `apples-antennagate-mea-culpa-free-case-until-sept-30-updated` · 2010-07-16
- 12473 · `the-sheer-and-utter-failure-of-apples-online-store` · 2012-03-09
- 12813 · `nike-fuelband-the-wearable-fitness-computer` · 2012-05-16

Re-run any time more PowerPage data is recovered/merged: `bin/crosslink-from-pp.py`. Idempotent (`INSERT OR IGNORE` on the unique URL constraint).

## Architecture (the divergence from pp-twin)

| | pp-twin | tac-twin |
|---|---|---|
| Source-of-truth | WordPress dump (1.2 GB local) | None — `tac_posts_recovered` IS canonical |
| Daily Bluehost sync | Yes | N/A removed |
| Gap analysis | Yes (`gap_*` views) | Removed — whole era is the gap |
| Cloud DB shape | Body-less mirror of local | Single source |
| Discovery | CDX wildcard | CDX wildcard + listing-page enumerator (multiplier) |
| Tabs | Dashboard, SQL Explorer, Calendar, Gaps, Hunter | **Hunter + SQL Explorer only** |
| Color accent | Gold | Teal |

The `bin/listing-enumerate.py` script is the discovery multiplier — instead of CDX'ing the whole blog space, it scrapes `/blog/apple/page/N/` Wayback snapshots and each one yields 10-20 post URLs in a single fetch. The cron doesn't invoke it yet (the half-year CDX enumeration is doing fine); it's available for manual use once listing pages get staged from later windows.

## Permissions context (saved to memory)

You're the original author with non-exclusive license; you have the right to download and host TAC content. The only requirement is one-at-a-time, human-paced fetches when going to live ZDNet. This is encoded:

- `WAYBACK_USER_AGENT` + 1s rate for Wayback (their tolerance)
- `ZDNET_LIVE_USER_AGENT` (real Safari UA) + 4s rate for any live-zdnet.com fetches

## Known limitations

1. **Dates are snapshot-based, not real publication times.** I dissected a sample ZDNet 2010 page — there is *no* `<time>` tag, `article:published_time`, or visible "Posted on" string in the markup that gets captured. The date is rendered by JavaScript after page load. Wayback snapshot timestamp is the best available proxy; typically within a few days of actual publication for an active blog. The numeric post ID provides ordering when you need to disambiguate.
2. **Listing-page enumerator isn't wired into the cron yet.** It exists as a manual command. Cron uses CDX-only enumeration for now. Worth adding to tick once the half-year cursor advances out of cold-start.
3. **No accept/reject UI controls yet.** Review queue is read-only in the Hunter tab. Apply decisions via SQL Explorer for now: `UPDATE tac_posts_recovered SET reviewed=1 WHERE id=?`.
4. **No body extraction in the cloud committed DB.** `--no-body` is on for cron runs (keeps `recovery/tac.db` small). Bodies are fetched on demand locally at accept-time — same pattern as pp-twin.
5. **Pages auto-deploy on git push isn't wired up.** I deployed the first build manually. To get auto-deploys: Cloudflare dashboard → Workers & Pages → tac-twin → Settings → Builds & deployments → Connect Git → set build command `cd tac-twin-dev && npm install && npm run build`, output `tac-twin-dev/dist`.
6. **Initial workflow push had a race bug.** First manual cron dispatch failed because its push lost a race against my unrelated docs commit (it printed `hunter tick — recovered=43` then failed to push). Fixed in `d2cf055` with a retry-rebase loop. Subsequent ticks all succeeded.

## When you wake up, in priority order

1. **Open https://tac-twin.pages.dev on your phone.** Verify it loads the cloud DB.
2. **Check https://github.com/jasonogrady/tac-twin/commits/main** to see how many `hunter tick` commits landed overnight (rough estimate: 5-6 if the Mac slept right after handoff).
3. If a cron tick failed (red ✗ in Actions), the most likely cause is Wayback being moody — retry-with-backoff handles it but persistent failures are worth investigating.
4. Optional: trigger a workflow_dispatch with `limit=200` to drain pending faster, since the cold-start period has minimal new enumeration work.

## Files of note

```
tac-twin/
├── tac-twin.jsx                       # React app (single-file artifact)
├── tac-twin-dev/                      # Vite workspace (App.jsx is a copy)
├── recovery/tac.db                    # cloud-managed SQLite
├── sql/init.sql                       # schema
├── bin/
│   ├── wayback-recover.py             # CDX + fetch + extract + tick
│   └── listing-enumerate.py           # /blog/apple/page/N scraper (manual)
├── .github/workflows/hunter.yml       # 2h cron
├── wrangler.jsonc                     # Cloudflare Pages config
├── README.md                          # operate guide
└── MORNING.md                         # this file
```

Memory updated: `tac-twin-project.md`, new `feedback-autonomous-priorities.md`.

— end of summary —
