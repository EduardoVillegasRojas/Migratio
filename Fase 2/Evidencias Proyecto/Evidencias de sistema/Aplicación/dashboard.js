(() => {

    const ROOT = document.documentElement;
    const DEFAULT_SOURCE_ID = ROOT.dataset.source || "";
    const METRICS_WINDOW_MIN = Number(ROOT.dataset.minutes || "10");
    const HAS_RESET = ROOT.dataset.hasReset === "1";
  
    
    Chart.defaults.responsive = false;
    Chart.defaults.devicePixelRatio = 1;
  
    const Y_MAX = 10; // ajusta si quieres
    const WINDOW_POINTS = 600;
  
    const el = (id) => document.getElementById(id);
  
    const ctx = document.getElementById("chart").getContext("2d");
    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{ label: "Personas activas", data: [], fill: false, tension: 0.25 }],
      },
      options: {
        responsive: false,
        devicePixelRatio: 1,
        animation: false,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: "Tiempo" } },
          y: {
            min: 0,
            max: Y_MAX,
            beginAtZero: true,
            ticks: { stepSize: 1 },
            title: { display: true, text: "Personas" },
          },
        },
        plugins: { legend: { display: false } },
      },
    });
  
    async function tick() {
      try {
        const qs = new URLSearchParams({
          source_id: DEFAULT_SOURCE_ID,
          minutes: String(METRICS_WINDOW_MIN),
        });
        const res = await fetch("/metrics?" + qs.toString(), { cache: "no-store" });
        const data = await res.json();
        const now = data.now || {};
        const history = data.history || [];
  
        el("activos").textContent = now.count ?? 0;
        el("max").textContent = now.max ?? 0;
        el("max_time").textContent = now.max_time ?? "—";
        // el("prom").textContent = (now.prom ?? 0).toFixed(2);
        // el("unicos").textContent = now.unicos ?? 0;
        el("fps").textContent = (now.fps ?? 0).toFixed(1);
        // el("uptime").textContent = now.uptime ?? "00:00:00";
        el("ts").textContent = now.timestamp ?? "—";
  
        const trend = now.trend30s ?? 0;
        const tChip = el("trend");
        if (trend > 0) {
          tChip.textContent = "↑ +" + trend.toFixed(2) + " vs 30s prev";
          tChip.className = "chip up";
        } else if (trend < 0) {
          tChip.textContent = "↓ " + trend.toFixed(2) + " vs 30s prev";
          tChip.className = "chip down";
        } else {
          tChip.textContent = "— trend 30s";
          tChip.className = "chip";
        }
  
        // Serie al gráfico
        const view = history.slice(-WINDOW_POINTS);
        chart.data.labels.length = 0;
        chart.data.datasets[0].data.length = 0;
        for (let i = 0; i < view.length; i++) {
          chart.data.labels.push(view[i].t.slice(11, 19)); // HH:MM:SS
          chart.data.datasets[0].data.push(view[i].count);
        }
        chart.update("none");
  
        // Snapshot (opcional)
        const url = "https://shipped-flow-candle-density.trycloudflare.com/snapshot.jpg" + Date.now();
        fetch(url, { cache: "no-store" })
          .then((r) => {
            if (r.ok) el("snap").src = url;
          })
          .catch(() => {});
  
        // === NUEVO: Ocupación + Semáforo ===
        const capMax = now.capacidad_maxima ?? null;
        const pct = now.capacidad_pct;
        const sem = now.semaforo;
        const disp = now.disponibles;
        
  
        el("oc_pct").textContent = (pct ?? "—") + (pct != null ? "%" : "");
        el("capmax").textContent = "cap: " + (capMax ?? "—");
        el("disp").textContent = "disp: " + (disp ?? "—");
        el("lugar_nombre").textContent = now.lugar_nombre ?? "—";
        
  
        const semEl = el("oc_sem");
        // limpia clases previas
        semEl.className = "chip";
        if (sem) {
          const map = { verde: "sf-verde", amarillo: "sf-amarillo", rojo: "sf-rojo" };
          semEl.className = "chip " + (map[sem] || "");
          const emoji = sem === "verde" ? "🟢" : sem === "amarillo" ? "🟡" : "🔴";
          semEl.textContent = `${emoji} ${sem}`;
        } else {
          semEl.textContent = "—";
        }
      } catch (e) {
        console.error(e);
      } finally {
        setTimeout(tick, 1000);
      }
    }
    tick();
  
    // Botón reset: NO exponemos ADMIN_KEY en HTML; se solicita al usar
    const resetBtn = document.getElementById("resetBtn");
    if (!HAS_RESET) resetBtn.style.display = "none";
    resetBtn.onclick = async () => {
      const key = prompt("Admin key:");
      if (!key) return;
      const body = { source_id: DEFAULT_SOURCE_ID, minutes: METRICS_WINDOW_MIN };
      try {
        await fetch("/reset", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": key,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.error(e);
      }
    };
  })();
  