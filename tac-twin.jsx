import { useState, useEffect, useCallback } from "react";

// ─── Palette ─────────────────────────────────────────────────────────────────
// Same dark base as pp-twin but a cool teal accent so the two apps are
// visually distinct at a glance.
const K = {
  bg:"#080a0c", surface:"#0d1216", card:"#121820", border:"#1b242d",
  b2:"#26323e", gold:"#5fb3c4", green:"#5c8c45", blue:"#4d7fa8",
  red:"#b84f40", text:"#d2dae0", muted:"#4e5a64", dim:"#161c22", ink:"#0a0d10",
};

// ─── sql.js loader (CDN) ──────────────────────────────────────────────────────
let _sql=null;
const getSQL=()=>{
  if(_sql) return _sql;
  _sql=new Promise((ok,fail)=>{
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js";
    s.onload=()=>window.initSqlJs({locateFile:f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`}).then(ok).catch(fail);
    s.onerror=()=>fail(new Error("sql.js failed to load from CDN"));
    document.head.appendChild(s);
  });
  return _sql;
};

const execDb=(db,sql)=>{
  try{
    const r=db.exec(sql);
    if(!r?.length) return{cols:[],rows:[],err:null};
    const{columns:cols,values}=r[0];
    return{cols,rows:values.map(v=>Object.fromEntries(cols.map((c,i)=>[c,v[i]]))),err:null};
  }catch(e){return{cols:[],rows:[],err:e.message};}
};
const getDbTables=db=>execDb(db,"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map(r=>r.name);

// ─── Animated braille spinners ────────────────────────────────────────────────
const BRAILLE_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
function useTick(interval = 110) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(x => x + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  return t;
}
function Spinner({ offset = 0, color }) {
  const t = useTick(110);
  return <span style={{ color, fontFamily: "monospace", display: "inline-block", width: "1ch", textAlign: "center" }}>
    {BRAILLE_FRAMES[(t + offset) % BRAILLE_FRAMES.length]}
  </span>;
}

// ─── Hunter ───────────────────────────────────────────────────────────────────
const CLOUD_DB_URL = "https://raw.githubusercontent.com/jasonogrady/tac-twin/main/recovery/tac.db";

function Hunter({ db, onReload }) {
  const [state, setState] = useState(null);
  const [cloudDb, setCloudDb] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState(null);

  // Auto-fetch the cloud-managed recovery/tac.db when no local DB is loaded.
  // Same pattern as pp-twin; makes the Hunter tab mobile-native.
  useEffect(() => {
    if (db || cloudDb || cloudLoading) return;
    setCloudLoading(true);
    (async () => {
      try {
        const SQL = await getSQL();
        const r = await fetch(CLOUD_DB_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`fetch ${r.status}`);
        const buf = await r.arrayBuffer();
        setCloudDb(new SQL.Database(new Uint8Array(buf)));
      } catch (e) {
        setCloudError(String(e.message || e));
      } finally {
        setCloudLoading(false);
      }
    })();
  }, [db, cloudDb, cloudLoading]);

  const effectiveDb = db || cloudDb;
  const isCloudMode = !db && !!cloudDb;

  useEffect(() => {
    if (!effectiveDb) { setState(null); return; }
    const q = sql => { try { return execDb(effectiveDb, sql).rows || []; } catch (e) { return []; } };
    const scalar = (sql, d = 0) => q(sql)[0]?.n ?? d;
    const tableExists = name => q(`SELECT name n FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;

    const hasCandidates = tableExists("tac_recovery_candidates");
    const hasRecovered  = tableExists("tac_posts_recovered");
    const hasListing    = tableExists("tac_listing_queue");
    const hasRuns       = tableExists("tac_runs");

    setState({
      hasCandidates, hasRecovered, hasListing, hasRuns,
      candByStatus: hasCandidates ? q(`SELECT status, COUNT(*) n FROM tac_recovery_candidates GROUP BY status ORDER BY n DESC`) : [],
      candTotal:    hasCandidates ? scalar(`SELECT COUNT(*) n FROM tac_recovery_candidates`) : 0,
      candByHint:   hasCandidates ? q(`SELECT hint, COUNT(*) n FROM tac_recovery_candidates GROUP BY hint ORDER BY n DESC`) : [],
      candByYear:   hasCandidates ? q(`SELECT substr(cdx_timestamp,1,4) yr, COUNT(*) n FROM tac_recovery_candidates GROUP BY yr ORDER BY yr`) : [],
      candByConf:   hasCandidates ? q(`
        SELECT
          CASE WHEN confidence >= 0.9 THEN 'high (>=0.9)'
               WHEN confidence >= 0.7 THEN 'med  (>=0.7)'
               WHEN confidence >= 0.5 THEN 'low  (>=0.5)'
               ELSE 'minimal (<0.5)' END AS bucket,
          COUNT(*) n
        FROM tac_recovery_candidates WHERE status='pending' GROUP BY bucket`) : [],
      recovered: hasRecovered ? q(`
        SELECT id, zdnet_id, post_date, post_title, post_author, post_slug,
               source, source_url, source_original_url, confidence, reviewed, created_at
        FROM tac_posts_recovered ORDER BY id DESC LIMIT 50`) : [],
      recoveredCounts: hasRecovered ? q(`SELECT reviewed, COUNT(*) n FROM tac_posts_recovered GROUP BY reviewed`) : [],
      recoveredByYear: hasRecovered ? q(`SELECT substr(post_date,1,4) yr, COUNT(*) n FROM tac_posts_recovered WHERE post_date IS NOT NULL GROUP BY yr ORDER BY yr`) : [],
      activity: (hasRecovered || hasCandidates) ? q(`
        SELECT created_at ts, 'ok' kind, source, source_original_url url,
               post_title title, post_date date, NULL reason
          FROM tac_posts_recovered
          WHERE created_at IS NOT NULL
        UNION ALL
        SELECT created_at ts, 'fail' kind, 'wayback' source, original_url url,
               NULL title, inferred_date date, substr(fail_reason,1,80) reason
          FROM tac_recovery_candidates
          WHERE status='failed' AND fail_reason IS NOT NULL
        ORDER BY ts DESC
        LIMIT 40
      `) : [],
      latestTs: hasRecovered ? scalar(`SELECT MAX(created_at) n FROM tac_posts_recovered`, null) : null,
      listingTotal:   hasListing ? scalar(`SELECT COUNT(*) n FROM tac_listing_queue`) : 0,
      listingScraped: hasListing ? scalar(`SELECT COUNT(*) n FROM tac_listing_queue WHERE last_scraped_at IS NOT NULL`) : 0,
      runs: hasRuns ? q(`SELECT id, started_at, finished_at, kind, candidates_added, posts_recovered, failures, notes FROM tac_runs ORDER BY id DESC LIMIT 10`) : [],
    });
  }, [effectiveDb]);

  if (!effectiveDb) {
    if (cloudLoading) {
      return (
        <div style={{ textAlign: "center", padding: "70px 0", color: K.muted, fontFamily: "monospace", fontSize: 12 }}>
          <Spinner offset={0} color={K.gold}/> loading cloud snapshot…
          <div style={{ marginTop: 8, fontSize: 10, color: K.border }}>fetching recovery/tac.db from GitHub</div>
        </div>
      );
    }
    if (cloudError) {
      return (
        <div style={{ textAlign: "center", padding: "70px 0", color: K.muted }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🎯</div>
          <p style={{ fontFamily: "monospace", fontSize: 13, color: K.red }}>Couldn't load cloud snapshot: {cloudError}</p>
          <p style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6, color: K.border }}>
            Drop a local <code style={{ background: K.dim, padding: "1px 5px", borderRadius: 3, color: K.text }}>tac.db</code> via the 📂 button.
          </p>
        </div>
      );
    }
    return (
      <div style={{ textAlign: "center", padding: "70px 0", color: K.muted, fontFamily: "monospace", fontSize: 12 }}>
        <Spinner offset={0} color={K.gold}/> initializing…
      </div>
    );
  }
  if (!state) return <div style={{ color: K.muted, fontFamily: "monospace", fontSize: 12, padding: 20 }}>loading…</div>;

  if (!state.hasCandidates && !state.hasRecovered) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontFamily: "Georgia,serif", fontSize: 24, fontWeight: 700 }}>Hunter</h2>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>not yet initialized</span>
        </div>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "30px 32px", lineHeight: 1.65 }}>
          <p style={{ margin: "0 0 12px", fontFamily: "monospace", fontSize: 13, color: K.text }}>
            The recovery tables don't exist yet in this database.
          </p>
          <pre style={{ background: K.ink, border: `1px solid ${K.dim}`, borderRadius: 6, padding: "12px 14px", fontFamily: "monospace", fontSize: 12, color: K.gold, margin: "0 0 20px", overflowX: "auto" }}>
{`sqlite3 recovery/tac.db < sql/init.sql
bin/wayback-recover.py enumerate --from 20100101 --to 20100630
bin/wayback-recover.py fetch --limit 50`}
          </pre>
        </div>
      </div>
    );
  }

  const ageSec = state.latestTs
    ? Math.max(0, (Date.now() - new Date(state.latestTs.replace(" ", "T") + "Z").getTime()) / 1000)
    : null;
  const isActive = ageSec !== null && ageSec < 300;
  const ageLabel = ageSec === null ? "no fetches yet"
    : ageSec < 60   ? `${Math.round(ageSec)}s ago`
    : ageSec < 3600 ? `${Math.round(ageSec/60)}m ago`
    : ageSec < 86400 ? `${Math.round(ageSec/3600)}h ago`
    : `${Math.round(ageSec/86400)}d ago`;

  const pending  = state.candByStatus.find(r => r.status === "pending")?.n  || 0;
  const fetched  = state.candByStatus.find(r => r.status === "fetched")?.n  || 0;
  const failed   = state.candByStatus.find(r => r.status === "failed")?.n   || 0;
  const inReview = state.recoveredCounts.find(r => r.reviewed === 0)?.n  || 0;
  const accepted = state.recoveredCounts.find(r => r.reviewed === 1)?.n  || 0;
  const rejected = state.recoveredCounts.find(r => r.reviewed === -1)?.n || 0;

  const Card = ({ label, value, color }) => (
    <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: K.muted, textTransform: "uppercase", letterSpacing: 2, fontFamily: "monospace", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || K.text, fontFamily: "Georgia,serif" }}>{value}</div>
    </div>
  );
  const SectionHeader = ({ children, right }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
      <p style={{ margin: 0, fontSize: 9, fontWeight: 700, color: K.muted, textTransform: "uppercase", letterSpacing: 2, fontFamily: "monospace" }}>{children}</p>
      {right}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontFamily: "Georgia,serif", fontSize: 24, fontWeight: 700, letterSpacing: -.5 }}>Hunter</h2>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>
          The Apple Core · 2005-2014 · scraped → fetched → review
        </span>
        {isCloudMode && (
          <span style={{ fontFamily: "monospace", fontSize: 10, color: K.gold, border: `1px solid ${K.gold}`, padding: "2px 8px", borderRadius: 4, letterSpacing: 1 }}>
            ☁ CLOUD SNAPSHOT · read-only
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {isCloudMode && (
            <button onClick={() => { setCloudDb(null); setCloudError(null); }}
              style={{ cursor: "pointer", padding: "4px 12px", border: `1px solid ${K.b2}`, borderRadius: 5, fontSize: 11, color: K.gold, fontFamily: "monospace", background: "transparent" }}>
              ↻ Refetch cloud
            </button>
          )}
          <label style={{ cursor: "pointer", padding: "4px 12px", border: `1px solid ${K.b2}`, borderRadius: 5, fontSize: 11, color: K.muted, fontFamily: "monospace" }}>
            🔄 {isCloudMode ? "Load local" : "Reload DB"}
            <input type="file" accept=".db,.sqlite,.sqlite3" style={{ display: "none" }}
              onChange={e => onReload && e.target.files[0] && onReload(e.target.files[0])} />
          </label>
        </div>
      </div>

      {/* Live status strip */}
      <div style={{
        background: K.ink, border: `1px solid ${isActive ? K.gold : K.border}`, borderRadius: 10,
        padding: "12px 16px", marginBottom: 14, fontFamily: "monospace", fontSize: 12,
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap"
      }}>
        <Spinner offset={0} color={isActive ? K.gold : K.muted}/>
        <span style={{ color: isActive ? K.gold : K.muted, fontWeight: 700, letterSpacing: 1 }}>
          {isActive ? "ACTIVE" : "IDLE"}
        </span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.text }}>{state.candTotal.toLocaleString()} candidates</span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.blue }}><Spinner offset={3} color={K.blue}/> {fetched.toLocaleString()} fetched</span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.gold }}><Spinner offset={6} color={K.gold}/> {pending.toLocaleString()} pending</span>
        {failed > 0 && <>
          <span style={{ color: K.border }}>·</span>
          <span style={{ color: K.red }}>✗ {failed.toLocaleString()} failed</span>
        </>}
        <span style={{ marginLeft: "auto", color: K.muted, fontSize: 11 }}>
          last fetch: <span style={{ color: isActive ? K.gold : K.muted }}>{ageLabel}</span>
        </span>
      </div>

      {/* Top metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 14 }}>
        <Card label="Candidates"    value={state.candTotal.toLocaleString()} color={K.text} />
        <Card label="Pending Fetch" value={pending.toLocaleString()}         color={K.gold} />
        <Card label="Fetched"       value={fetched.toLocaleString()}         color={K.blue} />
        <Card label="Failed"        value={failed.toLocaleString()}          color={failed > 0 ? K.red : K.muted} />
        <Card label="In Review"     value={inReview.toLocaleString()}        color={inReview > 0 ? K.gold : K.muted} />
        <Card label="Accepted"      value={accepted.toLocaleString()}        color={K.green} />
        <Card label="Rejected"      value={rejected.toLocaleString()}        color={K.muted} />
      </div>

      {/* Live activity log */}
      {state.activity.length > 0 && (
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
          <SectionHeader right={
            <span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>
              tail · last {state.activity.length} events · snapshot at load time
            </span>
          }>Live Activity</SectionHeader>
          <div style={{ background: K.ink, border: `1px solid ${K.dim}`, borderRadius: 6, padding: "10px 12px", fontFamily: "monospace", fontSize: 11, maxHeight: 280, overflowY: "auto", lineHeight: 1.55 }}>
            {state.activity.map((row, i) => {
              const ok = row.kind === "ok";
              const ts = (row.ts || "").slice(11, 19);
              return (
                <div key={i} style={{ display: "flex", gap: 8, color: ok ? K.text : K.muted, whiteSpace: "nowrap", overflow: "hidden" }}>
                  <Spinner offset={i} color={ok ? K.green : K.red}/>
                  <span style={{ color: K.muted, minWidth: 72 }}>{ts}</span>
                  <span style={{ color: ok ? K.green : K.red, minWidth: 18 }}>{ok ? "✓" : "✗"}</span>
                  <span style={{ color: K.blue, minWidth: 60 }}>{row.source}</span>
                  <span style={{ color: K.muted, minWidth: 88 }}>{(row.date || "").slice(0, 10)}</span>
                  <span style={{ flex: 1, color: ok ? K.text : K.red, textOverflow: "ellipsis", overflow: "hidden" }}>
                    {ok ? (row.title || row.url) : `${row.url} → ${row.reason || "(no reason)"}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Listing queue + cron runs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 14 }}>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader>Listing Queue</SectionHeader>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: K.text }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
              <span>known pages</span><span style={{ color: K.gold }}>{state.listingTotal.toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
              <span>scraped</span><span style={{ color: K.green }}>{state.listingScraped.toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span>remaining</span><span style={{ color: K.muted }}>{(state.listingTotal - state.listingScraped).toLocaleString()}</span>
            </div>
          </div>
          <div style={{ marginTop: 10, fontFamily: "monospace", fontSize: 10, color: K.border }}>
            `/blog/apple/page/N/` URLs — each scrape yields 10-20 post candidates.
          </div>
        </div>

        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader right={<span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>last 10 cron runs · `tac_runs`</span>}>Hunter Runs</SectionHeader>
          {state.runs.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>no runs logged yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11 }}>
                <thead>
                  <tr style={{ color: K.muted, borderBottom: `1px solid ${K.border}` }}>
                    <th style={{ textAlign:"left", padding:"4px 6px" }}>Started</th>
                    <th style={{ textAlign:"left", padding:"4px 6px" }}>Window</th>
                    <th style={{ textAlign:"right", padding:"4px 6px" }}>+Cand</th>
                    <th style={{ textAlign:"right", padding:"4px 6px" }}>+Rec</th>
                    <th style={{ textAlign:"right", padding:"4px 6px" }}>Fail</th>
                  </tr>
                </thead>
                <tbody>
                  {state.runs.map(r => (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${K.dim}`, color: K.text }}>
                      <td style={{ padding:"4px 6px", color: K.muted }}>{(r.started_at || "").slice(5, 16)}</td>
                      <td style={{ padding:"4px 6px", color: K.gold }}>{r.notes || "—"}</td>
                      <td style={{ padding:"4px 6px", textAlign:"right" }}>{(r.candidates_added || 0).toLocaleString()}</td>
                      <td style={{ padding:"4px 6px", textAlign:"right", color: K.green }}>{(r.posts_recovered || 0).toLocaleString()}</td>
                      <td style={{ padding:"4px 6px", textAlign:"right", color: r.failures > 0 ? K.red : K.muted }}>{(r.failures || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Distributions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader>Confidence · pending</SectionHeader>
          {state.candByConf.length === 0
            ? <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>no pending candidates</div>
            : state.candByConf.map(r => (
                <div key={r.bucket} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
                  <span style={{ color: K.text }}>{r.bucket}</span>
                  <span style={{ color: K.gold }}>{r.n.toLocaleString()}</span>
                </div>
              ))}
        </div>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader>URL Patterns</SectionHeader>
          {state.candByHint.length === 0
            ? <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>nothing staged</div>
            : state.candByHint.map(r => (
                <div key={r.hint || "(none)"} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
                  <span style={{ color: K.text }}>{r.hint || <em style={{ color: K.muted }}>(none)</em>}</span>
                  <span style={{ color: K.gold }}>{r.n.toLocaleString()}</span>
                </div>
              ))}
        </div>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader>Recovered by Year</SectionHeader>
          {state.recoveredByYear.length === 0
            ? <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>none yet</div>
            : <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {state.recoveredByYear.map(r => (
                  <div key={r.yr} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 12, padding: "3px 0", borderBottom: `1px solid ${K.dim}` }}>
                    <span style={{ color: K.text }}>{r.yr}</span>
                    <span style={{ color: K.gold }}>{r.n.toLocaleString()}</span>
                  </div>
                ))}
              </div>}
        </div>
      </div>

      {/* Review queue */}
      <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "16px 18px" }}>
        <SectionHeader right={<span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>{inReview > 50 ? `showing 50 of ${inReview}` : `${state.recovered.length} total`}</span>}>
          Review Queue
        </SectionHeader>
        {state.recovered.length === 0 ? (
          <div style={{ fontFamily: "monospace", fontSize: 12, color: K.muted, padding: "10px 4px" }}>
            No recovered posts yet. Wait for the cloud Hunter cron, or run <code style={{ background: K.dim, padding: "1px 5px", borderRadius: 3, color: K.text }}>bin/wayback-recover.py fetch</code> locally.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
              <thead>
                <tr style={{ color: K.muted, borderBottom: `1px solid ${K.border}` }}>
                  <th style={{ textAlign: "left",  padding: "8px 6px" }}>Date</th>
                  <th style={{ textAlign: "right", padding: "8px 6px" }}>ID</th>
                  <th style={{ textAlign: "left",  padding: "8px 6px" }}>Title</th>
                  <th style={{ textAlign: "left",  padding: "8px 6px" }}>Author</th>
                  <th style={{ textAlign: "left",  padding: "8px 6px" }}>State</th>
                  <th style={{ textAlign: "left",  padding: "8px 6px" }}>Links</th>
                </tr>
              </thead>
              <tbody>
                {state.recovered.map(r => {
                  const stateLabel = r.reviewed === 1 ? "accepted" : r.reviewed === -1 ? "rejected" : "pending";
                  const stateColor = r.reviewed === 1 ? K.green : r.reviewed === -1 ? K.red : K.gold;
                  return (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${K.dim}`, color: K.text }}>
                      <td style={{ padding: "6px", color: K.muted, whiteSpace: "nowrap" }}>{(r.post_date || "").slice(0, 10)}</td>
                      <td style={{ padding: "6px", textAlign: "right", color: K.muted }}>{r.zdnet_id || "—"}</td>
                      <td style={{ padding: "6px", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.post_title || ""}>
                        {r.post_title || <em style={{ color: K.muted }}>(no title)</em>}
                      </td>
                      <td style={{ padding: "6px", color: K.muted }}>{r.post_author || "—"}</td>
                      <td style={{ padding: "6px", color: stateColor }}>{stateLabel}</td>
                      <td style={{ padding: "6px" }}>
                        {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color: K.blue, textDecoration: "none", marginRight: 8 }}>archive ↗</a>}
                        {r.source_original_url && <a href={r.source_original_url} target="_blank" rel="noreferrer" style={{ color: K.muted, textDecoration: "none" }}>orig</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 12, fontFamily: "monospace", fontSize: 10, color: K.border }}>
          Read-only. Apply decisions via SQL Explorer: <code style={{ background: K.dim, padding: "1px 5px", borderRadius: 3, color: K.muted, marginLeft: 6 }}>UPDATE tac_posts_recovered SET reviewed = 1 WHERE id = …</code>
        </div>
      </div>
    </div>
  );
}

// ─── SQL Explorer ─────────────────────────────────────────────────────────────
function Explorer({ db, tables, sql, setSql, result, onRun }) {
  const [hov, setHov] = useState(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 12, minHeight: "60vh" }}>
      <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: 12, overflowY: "auto" }}>
        <p style={{ margin: "0 0 8px", fontSize: 9, fontWeight: 700, color: K.muted, textTransform: "uppercase", letterSpacing: 2, fontFamily: "monospace" }}>
          Tables · {tables.length}
        </p>
        {tables.map(t => (
          <div key={t} onMouseEnter={() => setHov(t)} onMouseLeave={() => setHov(null)}
            onClick={() => setSql(`SELECT *\nFROM \`${t}\`\nLIMIT 50;`)}
            style={{ padding: "5px 8px", borderRadius: 4, cursor: "pointer", marginBottom: 1,
              background: hov === t ? K.surface : "transparent", color: hov === t ? K.gold : K.muted,
              fontFamily: "monospace", fontSize: 11 }}>
            ⊞ {t}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: 14 }}>
          <textarea value={sql} onChange={e => setSql(e.target.value)} spellCheck={false}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onRun(); } }}
            style={{ width: "100%", height: 110, padding: 12, resize: "vertical", background: K.surface,
              color: "#8dd4a8", border: `1px solid ${K.b2}`, borderRadius: 6,
              fontFamily: "monospace", fontSize: 13, lineHeight: 1.6, outline: "none", boxSizing: "border-box" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <span style={{ fontSize: 11, color: K.muted, fontFamily: "monospace" }}>⌘↵ to run</span>
            <button onClick={onRun} style={{ padding: "6px 20px", background: K.gold, color: K.ink, border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia,serif", fontWeight: 700, fontSize: 13 }}>
              ▶ Run
            </button>
          </div>
        </div>
        {result && (
          <div style={{ background: K.card, border: `1px solid ${result.err ? K.red : K.border}`, borderRadius: 10, overflow: "hidden" }}>
            {result.err ? (
              <div style={{ padding: 14, color: K.red, fontFamily: "monospace", fontSize: 12 }}>⚠ {result.err}</div>
            ) : (
              <>
                <div style={{ padding: "6px 14px", background: K.surface, borderBottom: `1px solid ${K.border}`, fontSize: 11, color: K.muted, fontFamily: "monospace" }}>
                  {result.rows.length.toLocaleString()} rows · {result.cols.length} cols
                </div>
                <div style={{ overflowX: "auto", maxHeight: 400 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: K.surface, position: "sticky", top: 0 }}>
                        {result.cols.map(c => (
                          <th key={c} style={{ padding: "7px 12px", textAlign: "left", color: K.gold, fontWeight: 600, borderBottom: `1px solid ${K.border}`, whiteSpace: "nowrap" }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 ? K.surface : "transparent" }}>
                          {result.cols.map(c => (
                            <td key={c} style={{ padding: "5px 12px", color: K.text, borderBottom: `1px solid ${K.border}`, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {row[c] == null ? <em style={{ color: K.muted }}>NULL</em> : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [dbInst, setDbInst] = useState(null);
  const [tables, setTables] = useState([]);
  const [tab, setTab] = useState("hunter");
  const [sql, setSql] = useState("SELECT * FROM tac_posts_recovered ORDER BY id DESC LIMIT 50;");
  const [qRes, setQRes] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadFile = useCallback(async file => {
    if (!file) return;
    setLoading(true);
    try {
      const SQL = await getSQL();
      const buf = await file.arrayBuffer();
      const d = new SQL.Database(new Uint8Array(buf));
      setDbInst(d);
      setTables(getDbTables(d));
    } catch (e) {
      console.error(e);
      alert("Failed to load DB: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const runQuery = useCallback(() => {
    if (!dbInst) return;
    setQRes(execDb(dbInst, sql));
  }, [dbInst, sql]);

  const TABS = [
    { id: "hunter",   label: "Hunter" },
    { id: "explorer", label: "SQL Explorer" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: K.bg, color: K.text }}>
      <div style={{ background: K.ink, borderBottom: `1px solid ${K.border}`, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1480, margin: "0 auto", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 50 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "Georgia,serif", fontWeight: 700, fontSize: 16, color: K.text }}>
              The&nbsp;Apple&nbsp;Core<span style={{ color: K.gold }}>.</span>
            </span>
            <span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>
              tac-twin · zdnet.com/blog/apple recovery
            </span>
            {loading && <span style={{ fontSize: 10, color: K.gold, fontFamily: "monospace" }}>loading…</span>}
          </div>
          <nav style={{ display: "flex", gap: 2 }}>
            {TABS.map(({ id, label }) => (
              <button key={id} onClick={() => setTab(id)} style={{
                padding: "5px 14px", background: tab === id ? K.gold : "transparent",
                color: tab === id ? K.ink : K.muted, border: "none", borderRadius: 5, cursor: "pointer",
                fontFamily: "monospace", fontSize: 12, fontWeight: tab === id ? "bold" : "normal",
              }}>{label}</button>
            ))}
          </nav>
          <label style={{ cursor: "pointer", padding: "4px 12px", border: `1px solid ${K.b2}`, borderRadius: 5, fontSize: 11, color: K.muted, fontFamily: "monospace" }}>
            📂 Load .db
            <input type="file" accept=".db,.sqlite,.sqlite3" style={{ display: "none" }}
              onChange={e => loadFile(e.target.files[0])} />
          </label>
        </div>
      </div>

      <div style={{ maxWidth: 1480, margin: "0 auto", padding: "20px 20px 60px" }}>
        {tab === "hunter" && <Hunter db={dbInst} onReload={loadFile} />}
        {tab === "explorer" && (
          dbInst ? (
            <Explorer db={dbInst} tables={tables} sql={sql} setSql={setSql} result={qRes} onRun={runQuery} />
          ) : (
            <div style={{ textAlign: "center", padding: "70px 0", color: K.muted }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🗄️</div>
              <p style={{ fontFamily: "monospace", fontSize: 13 }}>SQL Explorer needs a loaded database.</p>
              <p style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6, color: K.border }}>
                Drop a .db file via 📂 above to enable live querying.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
