import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";
import fetch from "node-fetch";
import { Pool } from "pg";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const app = express();
app.use(helmet());
app.use(cors()); 
app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));


app.use(
  "/vendor",
  express.static(path.join(__dirname, "..", "node_modules", "chart.js", "dist"))
);
app.use("/static", express.static(path.join(__dirname, "..", "public")));

// ====== ENV ======
const {
  DATABASE_URL,
  PGSSL = "true",
  PORT = 8080,
  API_KEY = "supersecreto", 
  ADMIN_KEY = "",           
  CAMERA_SNAPSHOT_URL = "", 
  SNAP_BASIC_USER = "",    
  SNAP_BASIC_PASS = "",     
  METRICS_WINDOW_MIN = "1000",
  DEFAULT_SOURCE_ID = "",   
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL === "true" ? { rejectUnauthorized: false } : false,
});


const Payload = z.object({
  source_id: z.string().min(1),
  timestamp: z.string().datetime(), 
  count: z.number().int().nonnegative(),
  unique: z.number().int().nonnegative().optional().default(0),
  max: z.number().int().nonnegative().nullable().optional(),
  min: z.number().int().nonnegative().nullable().optional(),
  avg_window: z.number().nullable().optional(),
  fps: z.number().nullable().optional(),
});


function toEpochSec(isoTs) {
  return Math.floor(new Date(isoTs).getTime() / 1000);
}
function secondsToHMS(s) {
  s = Math.max(0, Math.floor(s));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

async function getCamId(client, sourceCode) {
  const cam = await client.query(
    "SELECT id FROM camaras WHERE codigo = $1 LIMIT 1",
    [sourceCode]
  );
  if (cam.rowCount === 0) return null;
  return cam.rows[0].id;
}

async function getCapacidadLugarByCam(client, camaraId) {
  const { rows } = await client.query(
    `
    SELECT 
      l.capacidad_maxima,
      COALESCE(NULLIF(l.nombre, ''), c.codigo) AS lugar_nombre
    FROM camaras c
    LEFT JOIN lugares l ON l.id = c.lugar_id
    WHERE c.id = $1
    LIMIT 1
    `,
    [camaraId]
  );
  return{
    capacidad_maxima: rows?.[0]?.capacidad_maxima ?? null,
    lugar_nombre: rows?.[0]?.lugar_nombre ?? null,
  };


}
async function getLugarInfoByCam(client, camaraId) {
  const { rows } = await client.query(
    `
    SELECT 
      l.capacidad_maxima,
      COALESCE(NULLIF(l.nombre, ''), c.codigo) AS lugar_nombre
    FROM camaras c
    LEFT JOIN lugares l ON l.id = c.lugar_id
    WHERE c.id = $1
    LIMIT 1
    `,
    [camaraId]
  );
  return {
    capacidad_maxima: rows?.[0]?.capacidad_maxima ?? null,
    lugar_nombre: rows?.[0]?.lugar_nombre ?? null,
  };
}


// ====== Rutas ======
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Ingesta de métricas desde el worker
 * Header requerido: Authorization: Bearer ${API_KEY}
 */
app.post("/api/metrics", async (req, res) => {
  try {
    if ((req.headers.authorization || "") !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const b = Payload.parse(req.body);
    toEpochSec(b.timestamp); // útil si quieres depurar

    const client = await pool.connect();
    try {
      const camara_id = await getCamId(client, b.source_id);
      if (!camara_id) {
        return res
          .status(404)
          .json({ error: "camera_not_found", source_id: b.source_id });
      }


      const q = `
        INSERT INTO metricas
          (camara_id, ts, count, unique_count, max_count, min_count, roll_avg, fps)
        VALUES
          ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (camara_id, ts_sec)
        DO UPDATE SET
          count        = EXCLUDED.count,
          unique_count = EXCLUDED.unique_count,
          max_count    = GREATEST(COALESCE(metricas.max_count, 0), COALESCE(EXCLUDED.max_count, 0)),
          min_count    = LEAST(COALESCE(metricas.min_count, EXCLUDED.min_count), EXCLUDED.min_count),
          roll_avg     = EXCLUDED.roll_avg,
          fps          = EXCLUDED.fps
        RETURNING id
      `;

      const params = [
        camara_id,            // $1
        b.timestamp,          // $2 (ISO con 'Z')
        b.count,              // $3
        b.unique ?? 0,        // $4
        b.max ?? null,        // $5
        b.min ?? null,        // $6
        b.avg_window ?? null, // $7
        b.fps ?? null,        // $8
      ];

      const { rows } = await client.query(q, params);
      res.json({ ok: true, id: rows[0].id });
    } finally {
      client.release();
    }
  } catch (e) {
    if (e instanceof z.ZodError)
      return res.status(400).json({ error: "bad_payload", issues: e.issues });
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * Dashboard HTML (self-hosted JS)
 */
app.get("/", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(DASH_HTML);
});

app.get("/metrics", async (req, res) => {
  const source_id = (req.query.source_id || DEFAULT_SOURCE_ID || "").toString();
  const minutes = Math.max(
    1,
    Math.min(60 * 6, Number(req.query.minutes || METRICS_WINDOW_MIN))
  ); // 1..360 min

  try {
    const client = await pool.connect();
    try {
      let camara_id = null;
      if (source_id) {
        camara_id = await getCamId(client, source_id);
        if (!camara_id) {
          return res.json({ now: {}, history: [] });
        }
      } else {
        const r = await client.query("SELECT id, codigo FROM camaras LIMIT 1");
        if (r.rowCount) {
          camara_id = r.rows[0].id;
        } else {
          return res.json({ now: {}, history: [] });
        }
      }

      const q = `
        SELECT ts, count, unique_count, max_count, min_count, roll_avg, fps
        FROM metricas
        WHERE camara_id = $1
          AND ts >= NOW() - ($2::text || ' minutes')::interval
        ORDER BY ts ASC
      `;
      const { rows } = await client.query(q, [camara_id, String(minutes)]);

      if (!rows.length) return res.json({ now: {}, history: [] });

      // Serie
      const history = rows.map((r) => ({
        t: r.ts.toISOString().replace(/\.\d+Z$/, "Z"),
        count: Number(r.count || 0),
      }));

      // KPIs básicos
      const counts = rows.map((r) => Number(r.count || 0));
      const cNow = counts[counts.length - 1];
      const cMax = Math.max(...counts);
      const cMin = Math.min(...counts);
      const prom = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);

      // trend 30s: últimos 5s vs previos 30s
      const nowEpoch = Date.now();
      const withTs = rows.map((r) => ({
        epoch: new Date(r.ts).getTime(),
        count: Number(r.count || 0),
      }));
      const recent = withTs.filter((p) => nowEpoch - p.epoch <= 5000);
      const prev30 = withTs.filter(
        (p) => nowEpoch - p.epoch > 5000 && nowEpoch - p.epoch <= 35000
      );
      const avgRecent =
        recent.length > 0
          ? recent.reduce((a, b) => a + b.count, 0) / recent.length
          : cNow;
      const avgPrev30 =
        prev30.length > 0
          ? prev30.reduce((a, b) => a + b.count, 0) / prev30.length
          : cNow;
      const trend30s = Number((avgRecent - avgPrev30).toFixed(2));

      
      const maxIdx = counts.indexOf(cMax);
      const max_time = history[maxIdx]?.t || "—";


      const uptimeSec = Math.max(
        0,
        Math.floor((nowEpoch - withTs[0].epoch) / 1000)
      );

  
      const last = rows[rows.length - 1];

     
      const { capacidad_maxima, lugar_nombre } = await getLugarInfoByCam(client, camara_id);
      let capacidad_pct = null;
      let semaforo = null;
      let disponibles = null;
      if (Number.isFinite(cNow) && capacidad_maxima && capacidad_maxima > 0) {
        capacidad_pct = Math.min(100, Math.round((cNow / capacidad_maxima) * 100));
        disponibles = Math.max(0, capacidad_maxima - cNow);

    
        if (capacidad_pct <= 30) semaforo = "verde";
        else if (capacidad_pct < 70) semaforo = "amarillo";
        else semaforo = "rojo";
      }

      const now = {
        timestamp: history[history.length - 1].t,
        count: cNow,
        max: cMax,
        min: cMin,
        prom: Number(prom.toFixed(2)),
        trend30s,
        max_time,
        uptime: secondsToHMS(uptimeSec),
        unicos: Number(last.unique_count || 0),
        fps: Number(last.fps || 0),
        roll_avg: Number(last.roll_avg || 0),

        // NUEVO
        capacidad_maxima: capacidad_maxima ?? null,
        capacidad_pct,
        disponibles,
        semaforo,
        lugar_nombre, 
      };

      res.json({ now, history });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * Snapshot proxy (opcional)
 */
app.get("/snapshot.jpg", async (_req, res) => {
  try {
    if (!CAMERA_SNAPSHOT_URL) return res.status(404).end();

    const headers = {};
    if (SNAP_BASIC_USER && SNAP_BASIC_PASS) {
      const token = Buffer.from(`${SNAP_BASIC_USER}:${SNAP_BASIC_PASS}`).toString("base64");
      headers["Authorization"] = `Basic ${token}`;
    }
    const r = await fetch(CAMERA_SNAPSHOT_URL, { headers });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "image/jpeg").send(buf);
  } catch {
    res.status(502).end();
  }
});


app.post("/reset", async (req, res) => {
  try {
    if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const source_id = String(req.body?.source_id || "");
    const minutes = Math.max(
      1,
      Math.min(60 * 6, Number(req.body?.minutes || 10))
    );

    const client = await pool.connect();
    try {
      const camara_id = await getCamId(client, source_id);
      if (!camara_id) return res.json({ ok: true, deleted: 0 });

      const del = await client.query(
        `DELETE FROM metricas
         WHERE camara_id = $1
           AND ts >= NOW() - ($2::text || ' minutes')::interval`,
        [camara_id, String(minutes)]
      );
      res.json({ ok: true, deleted: del.rowCount });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`API + Dashboard up on :${PORT}`);
});

// ====== HTML del dashboard (self-hosted scripts) ======
const DASH_HTML = `<!DOCTYPE html>
<html lang="es"
      data-source="${(DEFAULT_SOURCE_ID || "").replace(/"/g,'&quot;')}"
      data-minutes="${Number(METRICS_WINDOW_MIN)}"
      data-has-reset="${ADMIN_KEY ? "1" : "0"}">
<head>
<meta charset="utf-8"><title>Dashboard Migratio out </title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#0b0f14; --card:#121821; --muted:#8aa0b2; --fg:#e9f0f6; --border:#1e2733; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Helvetica Neue',Arial,'Noto Sans'; background:#0b0f14; color:var(--fg); }
  header { padding:20px 22px; background:linear-gradient(90deg,#0b6b68,#1a8d75); box-shadow:0 2px 0 #0e3e3c; }
  header h1 { margin:0; font-size:20px; letter-spacing:.3px }
  .container { padding:18px 22px; }
  .grid { display:grid; grid-template-columns:repeat(6,minmax(160px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:12px; }
  .kpi h2 { margin:0 0 6px; font-size:12px; color:var(--muted); font-weight:600 }
  .kpi .val { font-size:28px; font-weight:800 }
  .chip { display:inline-flex; gap:6px; padding:2px 8px; border-radius:9999px; font-size:12px; border:1px solid var(--border); color:var(--muted) }
  .chip.up { color:#97e0bb } .chip.down { color:#ffb3b3 }
  /* Semáforo estilos */
  .sf-verde    { background:#0f5132; color:#d1e7dd; border-color:#0f5132; }
  .sf-amarillo { background:#664d03; color:#fff3cd; border-color:#664d03; }
  .sf-rojo     { background:#842029; color:#f8d7da; border-color:#842029; }

  .row { display:grid; grid-template-columns:1.5fr .9fr; gap:12px; margin-top:12px }
  #chart { background:#0b0f14; border-radius:10px; border:1px solid var(--border); }
  .snapshot { width:100%; border-radius:10px; border:1px solid var(--border); background:#0b0f14; height:360px; object-fit:contain }
  .actions { display:flex; gap:10px; margin-top:8px }
  button { background:#173045; color:#d7e6f2; border:1px solid var(--border); padding:8px 12px; border-radius:10px; cursor:pointer; }
</style>
</head><body>
  <header><h1>Dashboard Migratio Out (en vivo)</h1></header>
  <div class="container">
    <div class="grid">
      <div class="card kpi"><h2>Lugar</h2><div class="val" id="lugar_nombre">—</div></div>
      <div class="card kpi"><h2>Activos</h2><div class="val" id="activos">0</div></div>
      <div class="card kpi"><h2>Peak(Max)</h2><div class="val"><span id="max">0</span></div><div class="meta" id="max_time">—</div></div>

      <div class="card kpi"><h2>FPS</h2><div class="val" id="fps">0</div></div>
  
    
      <div class="card kpi">
        <h2>Total</h2>
        <div class="val" id="oc_pct">—</div>
        <div class="meta">
          <span id="oc_sem" class="chip">—</span>
          <span id="capmax" class="chip">cap: —</span>
          <span id="disp"   class="chip">disp: —</span>
        </div>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <h3 class="panel-title">Serie temporal (últimos minutos) <span class="chip" id="ts">—</span> <span class="chip" id="trend"></span></h3>
        <canvas id="chart" width="1000" height="360" style="display:block"></canvas>
        <div class="actions"><button id="resetBtn">Reset métricas</button></div>
      </div>

    </div>
  </div>

  <!-- Self-hosted scripts (mismo origen) -->
  <script src="/vendor/chart.umd.min.js" defer></script>
  <script src="/static/dashboard.js" defer></script>
</body></html>`;
