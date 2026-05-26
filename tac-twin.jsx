import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";

// ─── Palettes ─────────────────────────────────────────────────────────────────
const DARK = {
  bg:"#080a0c", surface:"#0d1216", card:"#121820", border:"#1b242d",
  b2:"#26323e", gold:"#5fb3c4", green:"#5c8c45", blue:"#4d7fa8",
  red:"#b84f40", text:"#d2dae0", muted:"#4e5a64", dim:"#161c22", ink:"#0a0d10",
};
const LIGHT = {
  bg:"#f4f6f8", surface:"#ffffff", card:"#ffffff", border:"#d4dce6",
  b2:"#b0bec8", gold:"#2a8fa8", green:"#3a7232", blue:"#2a5f8a",
  red:"#c0392b", text:"#1a2530", muted:"#5a6875", dim:"#e8edf2", ink:"#eaf0f5",
};

const ThemeCtx = createContext({ K: DARK, mode: "system", setTheme: () => {} });
const useK = () => useContext(ThemeCtx).K;

function useTheme() {
  const [mode, setMode] = useState(() => localStorage.getItem("tac-theme") || "system");
  const [sysDark, setSysDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = e => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const setTheme = m => { setMode(m); localStorage.setItem("tac-theme", m); };
  const isDark = mode === "dark" || (mode === "system" && sysDark);
  return { mode, setTheme, K: isDark ? DARK : LIGHT, isDark };
}

// ─── sql.js loader ────────────────────────────────────────────────────────────
let _sql = null;
const getSQL = () => {
  if (_sql) return _sql;
  _sql = new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js";
    s.onload = () => window.initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}` }).then(ok).catch(fail);
    s.onerror = () => fail(new Error("sql.js failed to load"));
    document.head.appendChild(s);
  });
  return _sql;
};

const execDb = (db, sql) => {
  try {
    const r = db.exec(sql);
    if (!r?.length) return { cols: [], rows: [], err: null };
    const { columns: cols, values } = r[0];
    return { cols, rows: values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]]))), err: null };
  } catch (e) { return { cols: [], rows: [], err: e.message }; }
};

// Parameterized query — sql.js exec() doesn't support params, so use prepare/bind
const queryDb = (db, sql, params = []) => {
  try {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return { cols, rows, err: null };
  } catch (e) { return { cols: [], rows: [], err: e.message }; }
};

const execDbRun = (db, sql, params = []) => {
  try { db.run(sql, params); return null; } catch (e) { return e.message; }
};

const getDbTables = db => execDb(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map(r => r.name);

const downloadDb = (db, filename = "tac.db") => {
  const data = db.export();
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// ─── Braille spinner ──────────────────────────────────────────────────────────
const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
function useTick(ms = 110) {
  const [t, setT] = useState(0);
  useEffect(() => { const id = setInterval(() => setT(x => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return t;
}
function Spinner({ offset = 0, color }) {
  const t = useTick();
  return <span style={{ color, fontFamily: "monospace", display: "inline-block", width: "1ch", textAlign: "center" }}>{FRAMES[(t + offset) % FRAMES.length]}</span>;
}

// ─── Shared sub-components ────────────────────────────────────────────────────
function SectionHeader({ children, right }) {
  const K = useK();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 6 }}>
      <p style={{ margin: 0, fontSize: 9, fontWeight: 700, color: K.muted, textTransform: "uppercase", letterSpacing: 2, fontFamily: "monospace" }}>{children}</p>
      {right}
    </div>
  );
}

function StatCard({ label, value, color }) {
  const K = useK();
  return (
    <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: K.muted, textTransform: "uppercase", letterSpacing: 2, fontFamily: "monospace", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || K.text, fontFamily: "Georgia,serif" }}>{value}</div>
    </div>
  );
}

// ─── Hunter ───────────────────────────────────────────────────────────────────
const CLOUD_DB_URL = "https://raw.githubusercontent.com/jasonogrady/tac-twin/main/recovery/tac.db";

function Hunter({ db, onReload, onDbChange }) {
  const K = useK();
  const [state, setState] = useState(null);
  const [cloudDb, setCloudDb] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (db || cloudDb || cloudLoading) return;
    setCloudLoading(true);
    (async () => {
      try {
        const SQL = await getSQL();
        const r = await fetch(CLOUD_DB_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

  const refresh = useCallback(() => {
    if (!effectiveDb) { setState(null); return; }
    const q = sql => { try { return execDb(effectiveDb, sql).rows || []; } catch { return []; } };
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
      candByConf: hasCandidates ? q(`
        SELECT
          CASE WHEN confidence >= 0.9 THEN 'high (≥0.9)'
               WHEN confidence >= 0.7 THEN 'med  (≥0.7)'
               WHEN confidence >= 0.5 THEN 'low  (≥0.5)'
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
          FROM tac_posts_recovered WHERE created_at IS NOT NULL
        UNION ALL
        SELECT created_at ts, 'fail' kind, 'wayback' source, original_url url,
               NULL title, inferred_date date, substr(fail_reason,1,80) reason
          FROM tac_recovery_candidates WHERE status='failed' AND fail_reason IS NOT NULL
        ORDER BY ts DESC LIMIT 40`) : [],
      latestTs: hasRecovered ? scalar(`SELECT MAX(created_at) n FROM tac_posts_recovered`, null) : null,
      listingTotal:   hasListing ? scalar(`SELECT COUNT(*) n FROM tac_listing_queue`) : 0,
      listingScraped: hasListing ? scalar(`SELECT COUNT(*) n FROM tac_listing_queue WHERE last_scraped_at IS NOT NULL`) : 0,
      runs: hasRuns ? q(`SELECT id, started_at, finished_at, kind, candidates_added, posts_recovered, failures, notes FROM tac_runs ORDER BY id DESC LIMIT 10`) : [],
    });
  }, [effectiveDb]);

  useEffect(() => { refresh(); }, [refresh]);

  const setReview = useCallback((id, val) => {
    if (!effectiveDb || isCloudMode) return;
    const err = execDbRun(effectiveDb, `UPDATE tac_posts_recovered SET reviewed=? WHERE id=?`, [val, id]);
    if (!err) { setDirty(true); onDbChange && onDbChange(); refresh(); }
  }, [effectiveDb, isCloudMode, onDbChange, refresh]);

  if (!effectiveDb) {
    if (cloudLoading) return (
      <div style={{ textAlign: "center", padding: "70px 0", color: K.muted, fontFamily: "monospace", fontSize: 12 }}>
        <Spinner offset={0} color={K.gold}/> loading cloud snapshot…
        <div style={{ marginTop: 8, fontSize: 10, color: K.border }}>⠿ fetching recovery/tac.db from GitHub</div>
      </div>
    );
    if (cloudError) return (
      <div style={{ textAlign: "center", padding: "70px 0", color: K.muted }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🎯</div>
        <p style={{ fontFamily: "monospace", fontSize: 13, color: K.red }}>⚠ Couldn't load cloud snapshot: {cloudError}</p>
        <p style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6, color: K.border }}>
          Drop a local <code style={{ background: K.dim, padding: "1px 5px", borderRadius: 3, color: K.text }}>tac.db</code> via 📂.
        </p>
      </div>
    );
    return (
      <div style={{ textAlign: "center", padding: "70px 0", color: K.muted, fontFamily: "monospace", fontSize: 12 }}>
        <Spinner offset={0} color={K.gold}/> initializing…
      </div>
    );
  }
  if (!state) return <div style={{ color: K.muted, fontFamily: "monospace", fontSize: 12, padding: 20 }}><Spinner offset={0} color={K.gold}/> loading…</div>;

  if (!state.hasCandidates && !state.hasRecovered) return (
    <div>
      <h2 style={{ margin: "0 0 18px", fontFamily: "Georgia,serif", fontSize: 24, fontWeight: 700 }}>🎯 Hunter</h2>
      <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "30px 32px" }}>
        <p style={{ margin: "0 0 12px", fontFamily: "monospace", fontSize: 13, color: K.text }}>Recovery tables not yet initialized.</p>
        <pre style={{ background: K.ink, border: `1px solid ${K.dim}`, borderRadius: 6, padding: "12px 14px", fontFamily: "monospace", fontSize: 12, color: K.gold, margin: 0, overflowX: "auto" }}>
{`sqlite3 recovery/tac.db < sql/init.sql
bin/wayback-recover.py enumerate --from 20100101 --to 20100630
bin/wayback-recover.py fetch --limit 50`}
        </pre>
      </div>
    </div>
  );

  const ageSec = state.latestTs
    ? Math.max(0, (Date.now() - new Date(state.latestTs.replace(" ", "T") + "Z").getTime()) / 1000)
    : null;
  const isActive = ageSec !== null && ageSec < 300;
  const ageLabel = ageSec === null ? "no fetches yet"
    : ageSec < 60    ? `${Math.round(ageSec)}s ago`
    : ageSec < 3600  ? `${Math.round(ageSec/60)}m ago`
    : ageSec < 86400 ? `${Math.round(ageSec/3600)}h ago`
    : `${Math.round(ageSec/86400)}d ago`;

  const pending  = state.candByStatus.find(r => r.status === "pending")?.n  || 0;
  const fetched  = state.candByStatus.find(r => r.status === "fetched")?.n  || 0;
  const failed   = state.candByStatus.find(r => r.status === "failed")?.n   || 0;
  const inReview = state.recoveredCounts.find(r => r.reviewed === 0)?.n   || 0;
  const accepted = state.recoveredCounts.find(r => r.reviewed === 1)?.n   || 0;
  const rejected = state.recoveredCounts.find(r => r.reviewed === -1)?.n  || 0;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontFamily: "Georgia,serif", fontSize: 24, fontWeight: 700, letterSpacing: -.5 }}>🎯 Hunter</h2>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>The Apple Core · 2005-2014 · scraped → fetched → review</span>
        {isCloudMode && (
          <span style={{ fontFamily: "monospace", fontSize: 10, color: K.gold, border: `1px solid ${K.gold}`, padding: "2px 8px", borderRadius: 4, letterSpacing: 1 }}>
            ☁ CLOUD SNAPSHOT · read-only
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {dirty && !isCloudMode && (
            <button onClick={() => { downloadDb(effectiveDb); setDirty(false); }}
              style={{ cursor: "pointer", padding: "4px 12px", border: `1px solid ${K.green}`, borderRadius: 5, fontSize: 11, color: K.green, fontFamily: "monospace", background: "transparent", fontWeight: 700 }}>
              ⬇ Download .db
            </button>
          )}
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

      {/* Status strip */}
      <div style={{
        background: K.ink, border: `1px solid ${isActive ? K.gold : K.border}`, borderRadius: 10,
        padding: "12px 16px", marginBottom: 14, fontFamily: "monospace", fontSize: 12,
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap"
      }}>
        <Spinner offset={0} color={isActive ? K.gold : K.muted}/>
        <span style={{ color: isActive ? K.gold : K.muted, fontWeight: 700, letterSpacing: 1 }}>{isActive ? "⚡ ACTIVE" : "— IDLE"}</span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.text }}>📦 {state.candTotal.toLocaleString()} candidates</span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.blue }}><Spinner offset={3} color={K.blue}/> {fetched.toLocaleString()} fetched</span>
        <span style={{ color: K.border }}>·</span>
        <span style={{ color: K.gold }}><Spinner offset={6} color={K.gold}/> {pending.toLocaleString()} pending</span>
        {failed > 0 && <><span style={{ color: K.border }}>·</span><span style={{ color: K.red }}>✗ {failed.toLocaleString()} failed</span></>}
        <span style={{ marginLeft: "auto", color: K.muted, fontSize: 11 }}>
          🕐 last fetch: <span style={{ color: isActive ? K.gold : K.muted }}>{ageLabel}</span>
        </span>
      </div>

      {/* Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 14 }}>
        <StatCard label="📦 Candidates"    value={state.candTotal.toLocaleString()} color={K.text} />
        <StatCard label="⏳ Pending Fetch" value={pending.toLocaleString()}         color={K.gold} />
        <StatCard label="✅ Fetched"       value={fetched.toLocaleString()}         color={K.blue} />
        <StatCard label="❌ Failed"        value={failed.toLocaleString()}          color={failed > 0 ? K.red : K.muted} />
        <StatCard label="🔍 In Review"     value={inReview.toLocaleString()}        color={inReview > 0 ? K.gold : K.muted} />
        <StatCard label="✓ Accepted"      value={accepted.toLocaleString()}        color={K.green} />
        <StatCard label="✗ Rejected"      value={rejected.toLocaleString()}        color={K.muted} />
      </div>

      {/* Activity log */}
      {state.activity.length > 0 && (
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
          <SectionHeader right={<span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>tail · last {state.activity.length} events</span>}>
            📡 Live Activity
          </SectionHeader>
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
          <SectionHeader>📋 Listing Queue</SectionHeader>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: K.text }}>
            {[["known pages", state.listingTotal, K.gold], ["scraped", state.listingScraped, K.green], ["remaining", state.listingTotal - state.listingScraped, K.muted]].map(([label, val, color]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
                <span>{label}</span><span style={{ color }}>{val.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontFamily: "monospace", fontSize: 10, color: K.border }}>
            /blog/apple/page/N/ — each page yields 10-20 candidates.
          </div>
        </div>

        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader right={<span style={{ fontFamily: "monospace", fontSize: 10, color: K.muted }}>last 10 · tac_runs</span>}>⚙ Hunter Runs</SectionHeader>
          {state.runs.length === 0 ? (
            <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>no runs logged yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11 }}>
                <thead>
                  <tr style={{ color: K.muted, borderBottom: `1px solid ${K.border}` }}>
                    {["Started","Window","+Cand","+Rec","Fail"].map((h,i) => (
                      <th key={h} style={{ textAlign: i >= 2 ? "right" : "left", padding: "4px 6px" }}>{h}</th>
                    ))}
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
        {[
          { title: "🎯 Confidence · pending", rows: state.candByConf, key: "bucket" },
          { title: "🔗 URL Patterns", rows: state.candByHint, key: "hint" },
        ].map(({ title, rows, key }) => (
          <div key={title} style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <SectionHeader>{title}</SectionHeader>
            {rows.length === 0
              ? <div style={{ fontFamily: "monospace", fontSize: 11, color: K.muted }}>none</div>
              : rows.map(r => (
                  <div key={r[key] || "(none)"} style={{ display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${K.dim}` }}>
                    <span style={{ color: K.text }}>{r[key] || <em style={{ color: K.muted }}>(none)</em>}</span>
                    <span style={{ color: K.gold }}>{r.n.toLocaleString()}</span>
                  </div>
                ))}
          </div>
        ))}
        <div style={{ background: K.card, border: `1px solid ${K.border}`, borderRadius: 10, padding: "14px 16px" }}>
          <SectionHeader>📅 Recovered by Year</SectionHeader>
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
          🔍 Review Queue
        </SectionHeader>
        {state.recovered.length === 0 ? (
          <div style={{ fontFamily: "monospace", fontSize: 12, color: K.muted, padding: "10px 4px" }}>
            No recovered posts yet. Wait for the cloud Hunter cron, or run{" "}
            <code style={{ background: K.dim, padding: "1px 5px", borderRadius: 3, color: K.text }}>bin/wayback-recover.py fetch</code> locally.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
              <thead>
                <tr style={{ color: K.muted, borderBottom: `1px solid ${K.border}` }}>
                  <th style={{ textAlign:"left",   padding:"8px 6px" }}>📅 Date</th>
                  <th style={{ textAlign:"right",  padding:"8px 6px" }}>#</th>
                  <th style={{ textAlign:"left",   padding:"8px 6px" }}>Title</th>
                  <th style={{ textAlign:"left",   padding:"8px 6px" }}>Author</th>
                  <th style={{ textAlign:"left",   padding:"8px 6px" }}>State</th>
                  {!isCloudMode && <th style={{ textAlign:"center", padding:"8px 6px" }}>Action</th>}
                  <th style={{ textAlign:"left",   padding:"8px 6px" }}>Links</th>
                </tr>
              </thead>
              <tbody>
                {state.recovered.map(r => {
                  const stateLabel = r.reviewed === 1 ? "✓ accepted" : r.reviewed === -1 ? "✗ rejected" : "⏳ pending";
                  const stateColor = r.reviewed === 1 ? K.green : r.reviewed === -1 ? K.red : K.gold;
                  return (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${K.dim}`, color: K.text }}>
                      <td style={{ padding:"6px", color:K.muted, whiteSpace:"nowrap" }}>{(r.post_date || "").slice(0,10)}</td>
                      <td style={{ padding:"6px", textAlign:"right", color:K.muted }}>{r.zdnet_id || "—"}</td>
                      <td style={{ padding:"6px", maxWidth:320, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={r.post_title || ""}>
                        {r.post_title || <em style={{ color:K.muted }}>(no title)</em>}
                      </td>
                      <td style={{ padding:"6px", color:K.muted }}>{r.post_author || "—"}</td>
                      <td style={{ padding:"6px", color:stateColor }}>{stateLabel}</td>
                      {!isCloudMode && (
                        <td style={{ padding:"4px 6px", whiteSpace:"nowrap" }}>
                          <button onClick={() => setReview(r.id, r.reviewed === 1 ? 0 : 1)} title="Accept"
                            style={{ cursor:"pointer", border:`1px solid ${r.reviewed === 1 ? K.green : K.b2}`, borderRadius:4, padding:"2px 8px", fontSize:12, marginRight:4,
                              background: r.reviewed === 1 ? K.green : "transparent", color: r.reviewed === 1 ? K.ink : K.green, fontFamily:"monospace" }}>✓</button>
                          <button onClick={() => setReview(r.id, r.reviewed === -1 ? 0 : -1)} title="Reject"
                            style={{ cursor:"pointer", border:`1px solid ${r.reviewed === -1 ? K.red : K.b2}`, borderRadius:4, padding:"2px 8px", fontSize:12,
                              background: r.reviewed === -1 ? K.red : "transparent", color: r.reviewed === -1 ? K.ink : K.red, fontFamily:"monospace" }}>✗</button>
                        </td>
                      )}
                      <td style={{ padding:"6px" }}>
                        {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color:K.blue, textDecoration:"none", marginRight:8 }}>⏮ archive</a>}
                        {r.source_original_url && <a href={r.source_original_url} target="_blank" rel="noreferrer" style={{ color:K.muted, textDecoration:"none" }}>orig</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 12, fontFamily: "monospace", fontSize: 10, color: K.border }}>
          {isCloudMode
            ? "☁ Read-only in cloud mode. Load a local .db to enable ✓/✗ controls."
            : "✓/✗ updates the in-memory DB. Click ⬇ Download to save changes."}
        </div>
      </div>
    </div>
  );
}

// ─── Reader ───────────────────────────────────────────────────────────────────
function Reader({ db }) {
  const K = useK();
  const [posts, setPosts] = useState([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [post, setPost] = useState(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (!db) { setPosts([]); setSelectedId(null); setPost(null); return; }
    const r = execDb(db, `SELECT id, zdnet_id, post_date, post_title, post_author, reviewed FROM tac_posts_recovered ORDER BY post_date DESC, id DESC`);
    setPosts(r.rows || []);
    if (r.rows?.length && !selectedId) setSelectedId(r.rows[0].id);
  }, [db]);

  useEffect(() => {
    if (!db || !selectedId) { setPost(null); return; }
    const r = queryDb(db, `
      SELECT id, zdnet_id, post_date, post_title, post_author, post_slug,
             post_content, source, source_url, source_original_url,
             source_snapshot_ts, confidence, reviewed, reviewer_notes, created_at
      FROM tac_posts_recovered WHERE id=?`, [selectedId]);
    setPost(r.rows?.[0] || null);
  }, [db, selectedId]);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [selectedId]);

  if (!db) return (
    <div style={{ textAlign: "center", padding: "70px 0", color: K.muted }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>📖</div>
      <p style={{ fontFamily: "monospace", fontSize: 13 }}>Reader needs a loaded database.</p>
      <p style={{ fontFamily: "monospace", fontSize: 11, marginTop: 6, color: K.border }}>
        Switch to 🎯 Hunter — the cloud snapshot loads automatically there.
      </p>
    </div>
  );

  const filtered = search.trim()
    ? posts.filter(p =>
        (p.post_title || "").toLowerCase().includes(search.toLowerCase()) ||
        String(p.zdnet_id || "").includes(search) ||
        (p.post_date || "").includes(search))
    : posts;

  const badge = v => v === 1 ? { label: "✓ accepted", color: K.green }
    : v === -1 ? { label: "✗ rejected", color: K.red }
    : { label: "⏳ pending", color: K.gold };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 12, minHeight: "70vh" }}>
      {/* Sidebar */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ paddingBottom: 10 }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Search title, ID, date…"
            style={{ width:"100%", boxSizing:"border-box", padding:"7px 10px",
              background:K.surface, border:`1px solid ${K.b2}`, borderRadius:6,
              color:K.text, fontFamily:"monospace", fontSize:12, outline:"none" }} />
        </div>
        <div style={{ background:K.card, border:`1px solid ${K.border}`, borderRadius:10, overflowY:"auto", flex:1, maxHeight:"calc(100vh - 180px)" }}>
          <div style={{ padding:"8px 12px", borderBottom:`1px solid ${K.dim}`, fontSize:9, fontWeight:700, color:K.muted, textTransform:"uppercase", letterSpacing:2, fontFamily:"monospace" }}>
            📚 {filtered.length} posts
          </div>
          {filtered.length === 0 && (
            <div style={{ padding:"16px 12px", fontFamily:"monospace", fontSize:11, color:K.muted }}>
              {posts.length === 0 ? "No recovered posts yet." : "No matches."}
            </div>
          )}
          {filtered.map(p => {
            const b = badge(p.reviewed);
            const active = selectedId === p.id;
            return (
              <div key={p.id} onClick={() => setSelectedId(p.id)}
                style={{ padding:"10px 12px", cursor:"pointer",
                  background: active ? K.surface : "transparent",
                  borderLeft: active ? `3px solid ${K.gold}` : "3px solid transparent",
                  borderBottom:`1px solid ${K.dim}` }}>
                <div style={{ fontFamily:"monospace", fontSize:10, color:K.muted, marginBottom:3, display:"flex", justifyContent:"space-between" }}>
                  <span>📅 {(p.post_date || "").slice(0,10)}</span>
                  <span style={{ color:b.color, fontSize:9 }}>{b.label}</span>
                </div>
                <div style={{ fontFamily:"Georgia,serif", fontSize:13, color:active ? K.gold : K.text, lineHeight:1.35,
                  overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" }}>
                  {p.post_title || <em style={{ color:K.muted }}>Untitled</em>}
                </div>
                {p.zdnet_id && <div style={{ fontFamily:"monospace", fontSize:10, color:K.muted, marginTop:3 }}>🔢 #{p.zdnet_id}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Viewer */}
      <div ref={bodyRef} style={{ background:K.card, border:`1px solid ${K.border}`, borderRadius:10,
        overflowY:"auto", maxHeight:"calc(100vh - 130px)", padding:"24px 28px" }}>
        {!post ? (
          <div style={{ color:K.muted, fontFamily:"monospace", fontSize:12, paddingTop:40, textAlign:"center" }}>
            ← Select a post from the list.
          </div>
        ) : (
          <>
            <div style={{ marginBottom:20, borderBottom:`1px solid ${K.border}`, paddingBottom:16 }}>
              <h1 style={{ fontFamily:"Georgia,serif", fontSize:22, fontWeight:700, color:K.text, margin:"0 0 10px", lineHeight:1.3 }}>
                {post.post_title || <em style={{ color:K.muted }}>Untitled</em>}
              </h1>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap", fontFamily:"monospace", fontSize:11, color:K.muted }}>
                {post.post_date    && <span>📅 {post.post_date.slice(0,10)}</span>}
                {post.post_author  && <span>✍️ {post.post_author}</span>}
                {post.zdnet_id     && <span>🔢 #{post.zdnet_id}</span>}
                {post.confidence != null && <span>🎯 {(post.confidence*100).toFixed(0)}% confidence</span>}
                {(() => { const b = badge(post.reviewed); return <span style={{ color:b.color }}>{b.label}</span>; })()}
              </div>
              <div style={{ display:"flex", gap:10, marginTop:10, flexWrap:"wrap" }}>
                {post.source_url && (
                  <a href={post.source_url} target="_blank" rel="noreferrer"
                    style={{ fontFamily:"monospace", fontSize:11, color:K.blue, textDecoration:"none", border:`1px solid ${K.b2}`, borderRadius:4, padding:"2px 8px" }}>
                    ↗ Wayback archive
                  </a>
                )}
                {post.source_original_url && (
                  <a href={post.source_original_url} target="_blank" rel="noreferrer"
                    style={{ fontFamily:"monospace", fontSize:11, color:K.muted, textDecoration:"none", border:`1px solid ${K.b2}`, borderRadius:4, padding:"2px 8px" }}>
                    orig zdnet.com
                  </a>
                )}
              </div>
            </div>

            {post.post_content ? (
              <>
                <style>{`
                  .tac-body a { color: ${K.blue}; }
                  .tac-body img { max-width: 100%; height: auto; border-radius: 4px; }
                  .tac-body p { margin: 0 0 1em; }
                  .tac-body h1,.tac-body h2,.tac-body h3 { font-family: Georgia,serif; color: ${K.text}; margin: 1.2em 0 0.5em; }
                  .tac-body blockquote { border-left: 3px solid ${K.b2}; margin: 0 0 1em; padding-left: 14px; color: ${K.muted}; }
                  .tac-body pre,.tac-body code { background: ${K.dim}; border-radius: 4px; padding: 2px 6px; font-size: 13px; color: ${K.gold}; font-family: monospace; }
                `}</style>
                <div className="tac-body" dangerouslySetInnerHTML={{ __html: post.post_content }}
                  style={{ fontFamily:"Georgia,serif", fontSize:15, lineHeight:1.75, color:K.text }} />
              </>
            ) : (
              <div style={{ color:K.muted, fontFamily:"monospace", fontSize:12 }}>
                📭 No body content stored. This post was fetched with <code style={{ background:K.dim, padding:"1px 5px", borderRadius:3, color:K.text }}>--no-body</code>.
                <br/><br/>
                To fetch: <code style={{ background:K.dim, padding:"1px 5px", borderRadius:3, color:K.text }}>bin/wayback-recover.py fetch --id {post.zdnet_id || post.id}</code>
              </div>
            )}

            <div style={{ marginTop:28, paddingTop:14, borderTop:`1px solid ${K.border}`,
              fontFamily:"monospace", fontSize:10, color:K.muted, display:"flex", gap:20, flexWrap:"wrap" }}>
              <span>source: {post.source || "—"}</span>
              {post.source_snapshot_ts && <span>snapshot: {post.source_snapshot_ts}</span>}
              {post.post_slug          && <span>slug: {post.post_slug}</span>}
              {post.created_at         && <span>recovered: {post.created_at.slice(0,16)}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── SQL Explorer ─────────────────────────────────────────────────────────────
function Explorer({ db, tables, sql, setSql, result, onRun }) {
  const K = useK();
  const [hov, setHov] = useState(null);
  return (
    <div style={{ display:"grid", gridTemplateColumns:"200px 1fr", gap:12, minHeight:"60vh" }}>
      <div style={{ background:K.card, border:`1px solid ${K.border}`, borderRadius:10, padding:12, overflowY:"auto" }}>
        <p style={{ margin:"0 0 8px", fontSize:9, fontWeight:700, color:K.muted, textTransform:"uppercase", letterSpacing:2, fontFamily:"monospace" }}>
          🗂 Tables · {tables.length}
        </p>
        {tables.map(t => (
          <div key={t}
            onMouseEnter={() => setHov(t)} onMouseLeave={() => setHov(null)}
            onClick={() => setSql(`SELECT *\nFROM \`${t}\`\nLIMIT 50;`)}
            style={{ padding:"5px 8px", borderRadius:4, cursor:"pointer", marginBottom:1,
              background: hov === t ? K.surface : "transparent",
              color: hov === t ? K.gold : K.muted, fontFamily:"monospace", fontSize:11 }}>
            ⊞ {t}
          </div>
        ))}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ background:K.card, border:`1px solid ${K.border}`, borderRadius:10, padding:14 }}>
          <textarea value={sql} onChange={e => setSql(e.target.value)} spellCheck={false}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onRun(); } }}
            style={{ width:"100%", height:110, padding:12, resize:"vertical", background:K.surface,
              color:"#8dd4a8", border:`1px solid ${K.b2}`, borderRadius:6,
              fontFamily:"monospace", fontSize:13, lineHeight:1.6, outline:"none", boxSizing:"border-box" }} />
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
            <span style={{ fontSize:11, color:K.muted, fontFamily:"monospace" }}>⌘↵ to run</span>
            <button onClick={onRun} style={{ padding:"6px 20px", background:K.gold, color:K.ink, border:"none", borderRadius:6, cursor:"pointer", fontFamily:"Georgia,serif", fontWeight:700, fontSize:13 }}>
              ▶ Run
            </button>
          </div>
        </div>
        {result && (
          <div style={{ background:K.card, border:`1px solid ${result.err ? K.red : K.border}`, borderRadius:10, overflow:"hidden" }}>
            {result.err ? (
              <div style={{ padding:14, color:K.red, fontFamily:"monospace", fontSize:12 }}>⚠ {result.err}</div>
            ) : (
              <>
                <div style={{ padding:"6px 14px", background:K.surface, borderBottom:`1px solid ${K.border}`, fontSize:11, color:K.muted, fontFamily:"monospace" }}>
                  {result.rows.length.toLocaleString()} rows · {result.cols.length} cols
                </div>
                <div style={{ overflowX:"auto", maxHeight:400 }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontFamily:"monospace", fontSize:12 }}>
                    <thead>
                      <tr style={{ background:K.surface, position:"sticky", top:0 }}>
                        {result.cols.map(c => (
                          <th key={c} style={{ padding:"7px 12px", textAlign:"left", color:K.gold, fontWeight:600, borderBottom:`1px solid ${K.border}`, whiteSpace:"nowrap" }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 ? K.surface : "transparent" }}>
                          {result.cols.map(c => (
                            <td key={c} style={{ padding:"5px 12px", color:K.text, borderBottom:`1px solid ${K.border}`, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {row[c] == null ? <em style={{ color:K.muted }}>NULL</em> : String(row[c])}
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

// ─── Theme Picker ─────────────────────────────────────────────────────────────
function ThemePicker({ mode, setTheme }) {
  const K = useK();
  const opts = [
    { id: "system", icon: "🌓", title: "System" },
    { id: "dark",   icon: "🌑", title: "Dark" },
    { id: "light",  icon: "☀️", title: "Light" },
  ];
  return (
    <div style={{ display:"flex", gap:2, background:K.surface, border:`1px solid ${K.border}`, borderRadius:6, padding:"2px" }}>
      {opts.map(o => (
        <button key={o.id} onClick={() => setTheme(o.id)} title={o.title}
          style={{ cursor:"pointer", border:"none", borderRadius:4, padding:"3px 7px", fontSize:13,
            background: mode === o.id ? K.gold : "transparent",
            color: mode === o.id ? K.ink : K.muted }}>
          {o.icon}
        </button>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const theme = useTheme();
  const { K, mode, setTheme } = theme;

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

  const refreshTables = useCallback(() => {
    if (dbInst) setTables(getDbTables(dbInst));
  }, [dbInst]);

  const TABS = [
    { id: "hunter",   label: "🎯 Hunter" },
    { id: "reader",   label: "📖 Reader" },
    { id: "explorer", label: "🗄 SQL Explorer" },
  ];

  return (
    <ThemeCtx.Provider value={theme}>
      <div style={{ minHeight:"100vh", background:K.bg, color:K.text, transition:"background 0.15s, color 0.15s" }}>
        <div style={{ background:K.ink, borderBottom:`1px solid ${K.border}`, position:"sticky", top:0, zIndex:50 }}>
          <div style={{ maxWidth:1480, margin:"0 auto", padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", height:50 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontFamily:"Georgia,serif", fontWeight:700, fontSize:16, color:K.text }}>
                The&nbsp;Apple&nbsp;Core<span style={{ color:K.gold }}>.</span>
              </span>
              <span style={{ fontFamily:"monospace", fontSize:10, color:K.muted }}>
                tac-twin · zdnet.com/blog/apple recovery
              </span>
              {loading && <><Spinner offset={0} color={K.gold}/><span style={{ fontSize:10, color:K.gold, fontFamily:"monospace" }}>loading…</span></>}
            </div>
            <nav style={{ display:"flex", gap:2 }}>
              {TABS.map(({ id, label }) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  padding:"5px 14px", background: tab === id ? K.gold : "transparent",
                  color: tab === id ? K.ink : K.muted, border:"none", borderRadius:5, cursor:"pointer",
                  fontFamily:"monospace", fontSize:12, fontWeight: tab === id ? "bold" : "normal",
                }}>{label}</button>
              ))}
            </nav>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <ThemePicker mode={mode} setTheme={setTheme} />
              <label style={{ cursor:"pointer", padding:"4px 12px", border:`1px solid ${K.b2}`, borderRadius:5, fontSize:11, color:K.muted, fontFamily:"monospace" }}>
                📂 Load .db
                <input type="file" accept=".db,.sqlite,.sqlite3" style={{ display:"none" }}
                  onChange={e => loadFile(e.target.files[0])} />
              </label>
            </div>
          </div>
        </div>

        <div style={{ maxWidth:1480, margin:"0 auto", padding:"20px 20px 60px" }}>
          {tab === "hunter"   && <Hunter db={dbInst} onReload={loadFile} onDbChange={refreshTables} />}
          {tab === "reader"   && <Reader db={dbInst} />}
          {tab === "explorer" && (
            dbInst ? (
              <Explorer db={dbInst} tables={tables} sql={sql} setSql={setSql} result={qRes} onRun={runQuery} />
            ) : (
              <div style={{ textAlign:"center", padding:"70px 0", color:K.muted }}>
                <div style={{ fontSize:36, marginBottom:12 }}>🗄️</div>
                <p style={{ fontFamily:"monospace", fontSize:13 }}>SQL Explorer needs a loaded database.</p>
                <p style={{ fontFamily:"monospace", fontSize:11, marginTop:6, color:K.border }}>
                  Drop a .db file via 📂 above to enable live querying.
                </p>
              </div>
            )
          )}
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
