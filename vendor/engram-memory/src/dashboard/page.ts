/**
 * The dashboard page — a single self-contained HTML document (inline CSS + a
 * vanilla-canvas force-directed graph, zero external libraries, works offline).
 * Served by `dashboard/server.ts`. The frontend talks to three JSON endpoints
 * (`/api/graph`, `/api/recall`, `/api/maintain`) on the same origin.
 *
 * It deliberately uses NO template literals so it nests cleanly inside this TS
 * template string. Don't add backticks or ${...} to the embedded script.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>engram · memory</title>
<style>
  :root {
    --bg: #07090f; --panel: rgba(18,22,33,0.82); --line: rgba(255,255,255,0.08);
    --text: #c9d4e6; --muted: #66748c; --accent: #5b8def;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; overflow: hidden; }
  #app { position: fixed; inset: 0; }
  canvas { display: block; width: 100%; height: 100%; }

  .topbar { position: absolute; top: 0; left: 0; right: 0; z-index: 5; padding: 14px 18px 10px;
    display: flex; flex-direction: column; gap: 10px;
    background: linear-gradient(180deg, rgba(7,9,15,0.92) 0%, rgba(7,9,15,0) 100%); pointer-events: none; }
  .topbar > * { pointer-events: auto; }
  .searchrow { display: flex; gap: 8px; align-items: center; }
  #q { flex: 1; background: var(--panel); border: 1px solid var(--line); color: var(--text);
    border-radius: 9px; padding: 11px 14px; font: inherit; outline: none; backdrop-filter: blur(8px); }
  #q:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(91,141,239,0.18); }
  button { background: var(--panel); border: 1px solid var(--line); color: var(--text);
    border-radius: 8px; padding: 10px 14px; font: inherit; cursor: pointer; backdrop-filter: blur(8px);
    transition: border-color .15s, background .15s, transform .05s; }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.primary { background: linear-gradient(180deg, #4f7fe6, #3f6fd6); border-color: #6c97ee; color: #fff; font-weight: 600; }
  .metarow { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .stats { color: var(--muted); letter-spacing: .3px; }
  .stats b { color: var(--text); font-weight: 600; }
  .right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; }
  .legend span { color: var(--muted); display: inline-flex; align-items: center; gap: 5px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; box-shadow: 0 0 6px currentColor; }
  .btns { display: flex; gap: 6px; }

  #panel { position: absolute; right: 16px; bottom: 16px; width: 340px; max-width: 42vw; z-index: 6;
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px;
    backdrop-filter: blur(10px); display: none; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  #panel h3 { margin: 0 0 6px; font-size: 12px; color: var(--accent); letter-spacing: .4px; text-transform: uppercase; }
  #panel .body { color: var(--text); font-size: 13px; max-height: 30vh; overflow: auto; }
  #panel .tags { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  #panel .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; }
  #panel .close { position: absolute; top: 10px; right: 12px; color: var(--muted); cursor: pointer; border: none; background: none; padding: 0; }

  .hint { position: absolute; left: 18px; bottom: 14px; color: var(--muted); z-index: 4; font-size: 11px; }
  #elegend { position: absolute; left: 16px; top: 92px; z-index: 5; width: 158px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    backdrop-filter: blur(10px); padding: 8px 10px; font-size: 11px; box-shadow: 0 8px 28px rgba(0,0,0,0.4); }
  #elegend .hd { color: var(--accent); letter-spacing: .4px; text-transform: uppercase; font-size: 10px;
    font-weight: 600; cursor: pointer; user-select: none; display: flex; justify-content: space-between; align-items: center; }
  #elegend .chev { transition: transform .15s; }
  #elegend.collapsed .chev { transform: rotate(-90deg); }
  #elegend.collapsed .items { display: none; }
  #elegend .items { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; max-height: 52vh; overflow: auto; }
  #elegend .items span { color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  #elegend .items .sep { margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--line); }
  #elegend .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #toast { position: absolute; left: 50%; top: 64px; transform: translateX(-50%); z-index: 8;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px;
    backdrop-filter: blur(8px); opacity: 0; transition: opacity .2s; pointer-events: none; }
</style>
</head>
<body>
<div id="app">
  <canvas id="c"></canvas>
  <div class="topbar">
    <div class="searchrow">
      <input id="q" placeholder="recall a memory — watch the neurons fire..." autocomplete="off" />
      <button id="recall" class="primary">recall ✨</button>
      <button id="reset">reset</button>
    </div>
    <div class="metarow">
      <div class="stats" id="stats">loading…</div>
      <div class="right">
        <div class="legend" id="legend"></div>
        <div class="btns">
          <button id="dream">🌙 dream</button>
          <button id="reindex">reindex</button>
          <button id="refresh">refresh</button>
        </div>
      </div>
    </div>
  </div>
  <div id="panel"><button class="close" id="panelClose">✕</button><h3 id="panelTitle">memory</h3><div class="body" id="panelBody"></div><div class="tags" id="panelTags"></div></div>
  <div id="elegend">
    <div class="hd" id="elegendToggle">emotions <span class="chev">▾</span></div>
    <div class="items" id="elegendItems"></div>
  </div>
  <div class="hint">scroll to zoom · drag to pan · click a neuron</div>
  <div id="toast"></div>
</div>
<script>
"use strict";
(function () {
  var EDGE_COLORS = {
    similar: "#5b8def", temporal_next: "#22b8cf", temporal: "#22b8cf",
    about: "#8b7bb5", lesson_from: "#84cc16", lesson: "#84cc16",
    caused: "#ef4444", supersedes: "#f59e0b"
  };
  var EDGE_LABELS = [
    ["similar", "#5b8def"], ["temporal", "#22b8cf"], ["about", "#8b7bb5"],
    ["lesson", "#84cc16"], ["caused", "#ef4444"], ["supersedes", "#f59e0b"], ["archived", "#3a4256"]
  ];

  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  var W = 0, H = 0;
  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);

  var nodes = [], edges = [], byId = {}, palette = {}, families = [];
  var view = { x: 0, y: 0, k: 1 };
  var alpha = 0, tick = 0, framed = false, userMoved = false;
  var hover = null, selected = null;

  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.style.opacity = "1";
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = "0"; }, 1800);
  }

  // Untagged / affect-neutral neurons sit quiet so felt ones pop.
  var UNTAGGED_COLOR = [90, 100, 120];   // muted slate-gray
  var DIM_BASE = [38, 44, 60];           // what a low-intensity emotion fades toward
  function hexToRgb(hex) {
    var h = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
  function nodeColor(n) {
    if (n.archived) return "rgba(120,130,150,0.35)";
    var info = n.emotion ? palette[n.emotion] : null;
    if (info && info.color) {
      // Vividness tracks emotional intensity: a faint feeling barely tints the
      // dim base, a strong one shows the family colour at full strength.
      var t = 0.45 + 0.55 * Math.min(1, (n.emotionIntensity || 0.4));
      return rgb(mix(DIM_BASE, hexToRgb(info.color), t));
    }
    return rgb(UNTAGGED_COLOR);
  }
  function nodeRadius(n) {
    return 2.2 + (n.importance || 0) * 3.6 + Math.min(2.4, (n.salience || 0) * 1.2) + (n.useCount ? Math.min(2, Math.log(1 + n.useCount)) : 0);
  }

  function buildGraph(data) {
    palette = data.palette || {};
    if (data.families && data.families.length) { families = data.families; buildEmotionLegend(); }
    byId = {};
    var spread = 50 * Math.sqrt(Math.max(1, data.nodes.length));
    nodes = data.nodes.map(function (n) {
      var o = {};
      for (var key in n) o[key] = n[key];
      o.x = (Math.random() - 0.5) * spread;
      o.y = (Math.random() - 0.5) * spread;
      o.vx = 0; o.vy = 0; o.deg = 0; o.fire = 0;
      byId[o.id] = o; return o;
    });
    edges = [];
    for (var i = 0; i < data.edges.length; i++) {
      var e = data.edges[i];
      var s = byId[e.src], t = byId[e.dst];
      if (!s || !t) continue;
      s.deg++; t.deg++;
      edges.push({ s: s, t: t, type: e.type, weight: e.weight || 0.5 });
    }
    view = { x: W / 2, y: H / 2, k: 0.35 };
    alpha = 1; tick = 0; framed = false; userMoved = false;
  }

  // Frame most of the graph in view, ignoring far outliers (uses mean ± k·std
  // so a few long spikes don't force the whole thing to zoom way out).
  function fitView() {
    var n = nodes.length; if (!n) return;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += nodes[i].x; my += nodes[i].y; }
    mx /= n; my /= n;
    var sx = 0, sy = 0;
    for (i = 0; i < n; i++) { var dx = nodes[i].x - mx, dy = nodes[i].y - my; sx += dx * dx; sy += dy * dy; }
    sx = Math.sqrt(sx / n); sy = Math.sqrt(sy / n);
    var halfW = Math.max(sx * 2.6, 60), halfH = Math.max(sy * 2.6, 60);
    var k = Math.min(W / (halfW * 2 * 1.12), H / (halfH * 2 * 1.12));
    k = Math.max(0.04, Math.min(2.2, k));
    view.k = k; view.x = W / 2 - mx * k; view.y = H / 2 - my * k;
  }

  function clampVel(nd, max) {
    var m = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy);
    if (m > max) { nd.vx = nd.vx / m * max; nd.vy = nd.vy / m * max; }
  }

  // ---- force simulation, tuned for large graphs ----
  //  - LOCAL pairwise repulsion (anti-overlap, short range, via a grid)
  //  - GLOBAL repulsion from per-cell centroids (Barnes-Hut-lite): spreads the
  //    core so it doesn't collapse into a hairball
  //  - degree-normalised springs: hubs pull each leaf gently, killing the long
  //    radial spikes a naive spring produces on high-degree nodes
  function step() {
    if (alpha < 0.004) { if (!framed && !userMoved) { fitView(); framed = true; } return; }
    tick++;
    var n = nodes.length, i;
    var cell = 140;
    var grid = {}, sumx = {}, sumy = {}, cnt = {};
    for (i = 0; i < n; i++) {
      var a = nodes[i];
      var gx = Math.round(a.x / cell), gy = Math.round(a.y / cell), key = gx + "," + gy;
      (grid[key] || (grid[key] = [])).push(a);
      sumx[key] = (sumx[key] || 0) + a.x; sumy[key] = (sumy[key] || 0) + a.y; cnt[key] = (cnt[key] || 0) + 1;
    }
    var keys = Object.keys(grid), cents = [];
    for (i = 0; i < keys.length; i++) { var ck = keys[i]; cents.push({ x: sumx[ck] / cnt[ck], y: sumy[ck] / cnt[ck], m: cnt[ck] }); }

    var LOCAL = 1100, GLOBAL = 34000, NEAR = cell * 1.5, NEAR2 = NEAR * NEAR;
    for (i = 0; i < n; i++) {
      var p = nodes[i];
      var pgx = Math.round(p.x / cell), pgy = Math.round(p.y / cell);
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
        var b = grid[(pgx + ox) + "," + (pgy + oy)]; if (!b) continue;
        for (var j = 0; j < b.length; j++) {
          var qn = b[j]; if (qn === p) continue;
          var dx = p.x - qn.x, dy = p.y - qn.y, d2 = dx * dx + dy * dy + 0.01;
          var f = LOCAL / d2 * alpha, d = Math.sqrt(d2);
          p.vx += dx / d * f; p.vy += dy / d * f;
        }
      }
      for (var c = 0; c < cents.length; c++) {
        var ce = cents[c];
        var ex = p.x - ce.x, ey = p.y - ce.y, e2 = ex * ex + ey * ey + 1;
        if (e2 < NEAR2) continue;
        var ef = GLOBAL * ce.m / e2 * alpha, ed2 = Math.sqrt(e2);
        p.vx += ex / ed2 * ef; p.vy += ey / ed2 * ef;
      }
    }

    var SPRING = 0.02, TARGET = 64;
    for (var e = 0; e < edges.length; e++) {
      var edg = edges[e], s = edg.s, t = edg.t;
      var dx2 = t.x - s.x, dy2 = t.y - s.y, dist = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.01;
      var norm = 1 / Math.sqrt(Math.min(s.deg, t.deg) || 1);
      var f2 = (dist - TARGET) * SPRING * (0.4 + edg.weight) * norm * alpha;
      var fx = dx2 / dist * f2, fy = dy2 / dist * f2;
      s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
    }

    var CENTER = 0.01, DAMP = 0.9;
    for (i = 0; i < n; i++) {
      var nd = nodes[i];
      nd.vx -= nd.x * CENTER * alpha; nd.vy -= nd.y * CENTER * alpha;
      nd.vx *= DAMP; nd.vy *= DAMP;
      clampVel(nd, 22);
      nd.x += nd.vx; nd.y += nd.vy;
    }
    alpha *= 0.991;
    // keep the graph framed while it settles, until the user takes control
    if (!userMoved && tick % 30 === 0) fitView();
  }

  function tx(x) { return x * view.k + view.x; }
  function ty(y) { return y * view.k + view.y; }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // edges
    ctx.lineWidth = 0.6;
    // Edges are faint by default (12k+ of them would otherwise be a hairball);
    // an edge lights up only when one of its endpoints is firing. Denser graphs
    // get fainter base edges so the structure stays readable.
    var edgeBase = Math.max(0.025, Math.min(0.1, 90 / (edges.length + 1)));
    ctx.lineWidth = 0.5;
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e], s = ed.s, t = ed.t;
      var lit = s.fire > 0.02 || t.fire > 0.02;
      var sx2 = tx(s.x), sy2 = ty(s.y), tx2 = tx(t.x), ty2 = ty(t.y);
      // cull edges fully off-screen
      if (!lit && ((sx2 < 0 && tx2 < 0) || (sx2 > W && tx2 > W) || (sy2 < 0 && ty2 < 0) || (sy2 > H && ty2 > H))) continue;
      ctx.strokeStyle = EDGE_COLORS[ed.type] || "#33415e";
      ctx.globalAlpha = lit ? 0.5 : edgeBase + ed.weight * edgeBase;
      ctx.beginPath();
      ctx.moveTo(sx2, sy2);
      ctx.lineTo(tx2, ty2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // nodes
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var r = nodeRadius(nd) * Math.max(0.6, Math.sqrt(view.k));
      var x = tx(nd.x), y = ty(nd.y);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      var c = nodeColor(nd);
      if (nd.fire > 0.02) {
        ctx.globalAlpha = Math.min(1, nd.fire);
        ctx.fillStyle = "#fff7e0";
        ctx.beginPath(); ctx.arc(x, y, r + 6 + nd.fire * 8, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 0.25 * nd.fire;
        ctx.fillStyle = "#ffd479";
        ctx.beginPath(); ctx.arc(x, y, r + 12 + nd.fire * 16, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
      ctx.fillStyle = c; ctx.fill();
      if (nd === hover || nd === selected) {
        ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      }
      if (nd.fire > 0.02) nd.fire *= 0.97;
    }
  }

  function frame() { step(); draw(); requestAnimationFrame(frame); }

  // ---- interaction ----
  var dragging = false, lastX = 0, lastY = 0, moved = false;
  canvas.addEventListener("mousedown", function (ev) { dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; });
  window.addEventListener("mouseup", function () { dragging = false; });
  window.addEventListener("mousemove", function (ev) {
    if (dragging) {
      var dx = ev.clientX - lastX, dy = ev.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; userMoved = true; }
      view.x += dx; view.y += dy; lastX = ev.clientX; lastY = ev.clientY;
    } else {
      hover = pick(ev.clientX, ev.clientY);
      canvas.style.cursor = hover ? "pointer" : "default";
    }
  });
  canvas.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    userMoved = true;
    var rect = canvas.getBoundingClientRect();
    var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    var f = Math.exp(-ev.deltaY * 0.0012);
    var nk = Math.max(0.12, Math.min(6, view.k * f));
    view.x = mx - (mx - view.x) * (nk / view.k);
    view.y = my - (my - view.y) * (nk / view.k);
    view.k = nk;
  }, { passive: false });
  canvas.addEventListener("click", function (ev) {
    if (moved) return;
    var n = pick(ev.clientX, ev.clientY);
    if (n) showPanel(n); else hidePanel();
  });
  function pick(cx, cy) {
    var rect = canvas.getBoundingClientRect();
    var x = cx - rect.left, y = cy - rect.top, best = null, bd = 14;
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var dx = tx(nd.x) - x, dy = ty(nd.y) - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) { bd = d; best = nd; }
    }
    return best;
  }

  function showPanel(n) {
    selected = n;
    document.getElementById("panel").style.display = "block";
    document.getElementById("panelTitle").textContent = (n.tier || "memory") + (n.archived ? " · archived" : "");
    document.getElementById("panelBody").textContent = n.label || "(no preview)";
    var tags = [];
    if (n.emotion) tags.push(n.emotion + (n.emotionIntensity ? " " + Math.round(n.emotionIntensity * 100) + "%" : ""));
    if (n.topic) tags.push(n.topic);
    tags.push("importance " + (n.importance || 0).toFixed(2));
    if (n.useCount) tags.push(n.useCount + "× recalled");
    var box = document.getElementById("panelTags"); box.innerHTML = "";
    for (var i = 0; i < tags.length; i++) {
      var s = document.createElement("span"); s.className = "tag"; s.textContent = tags[i]; box.appendChild(s);
    }
  }
  function hidePanel() { selected = null; document.getElementById("panel").style.display = "none"; }
  document.getElementById("panelClose").addEventListener("click", hidePanel);

  // ---- data + api ----
  function setStats(s, archived) {
    document.getElementById("stats").innerHTML =
      "<b>" + s.count + "</b> neurons · <b>" + s.edges + "</b> synapses · <b>" +
      s.entities + "</b> entities · <b>" + archived + "</b> archived";
  }
  function buildLegend() {
    var el = document.getElementById("legend"); el.innerHTML = "";
    for (var i = 0; i < EDGE_LABELS.length; i++) {
      var span = document.createElement("span");
      span.innerHTML = "<i class='dot' style='color:" + EDGE_LABELS[i][1] + ";background:" + EDGE_LABELS[i][1] + "'></i>" + EDGE_LABELS[i][0];
      el.appendChild(span);
    }
  }
  function buildEmotionLegend() {
    var el = document.getElementById("elegend"); if (!el) return;
    var html = "";
    for (var i = 0; i < families.length; i++) {
      var f = families[i];
      html += "<span title='" + f.valence + "'><i class='dot' style='color:" + f.color + ";background:" + f.color + "'></i>" + f.key + "</span>";
    }
    html += "<span class='sep'><i class='dot' style='color:rgb(90,100,120);background:rgb(90,100,120)'></i>untagged</span>";
    document.getElementById("elegendItems").innerHTML = html;
  }
  function load() {
    fetch("api/graph").then(function (r) { return r.json(); }).then(function (data) {
      buildGraph(data);
      var archived = 0; for (var i = 0; i < nodes.length; i++) if (nodes[i].archived) archived++;
      setStats(data.stats, archived);
    }).catch(function () { toast("failed to load graph"); });
  }

  function clearFire() { for (var i = 0; i < nodes.length; i++) nodes[i].fire = 0; }
  function doRecall() {
    var q = document.getElementById("q").value.trim();
    if (!q) return;
    clearFire();
    fetch("api/recall?q=" + encodeURIComponent(q) + "&k=8").then(function (r) { return r.json(); }).then(function (res) {
      var hit = 0;
      (res.results || []).forEach(function (m, idx) { var nd = byId[m.id]; if (nd) { nd.fire = 1; hit++; } });
      (res.trace && res.trace.activations || []).forEach(function (a) {
        var nd = byId[a.id]; if (nd && nd.fire < 0.6) nd.fire = Math.min(0.85, 0.3 + a.activation * 4);
      });
      (res.trace && res.trace.seeds || []).forEach(function (s) { var nd = byId[s.id]; if (nd && !nd.fire) nd.fire = 0.5; });
      alpha = Math.max(alpha, 0.15);
      toast(hit ? ("fired " + hit + " neuron" + (hit === 1 ? "" : "s")) : "no memory matched");
    }).catch(function () { toast("recall failed"); });
  }
  function maintain(kind) {
    toast(kind + "…");
    fetch("api/maintain?op=" + kind, { method: "POST" }).then(function (r) { return r.json(); }).then(function (res) {
      toast(res.message || (kind + " done")); load();
    }).catch(function () { toast(kind + " failed"); });
  }

  document.getElementById("recall").addEventListener("click", doRecall);
  document.getElementById("q").addEventListener("keydown", function (e) { if (e.key === "Enter") doRecall(); });
  document.getElementById("reset").addEventListener("click", function () {
    document.getElementById("q").value = ""; clearFire(); hidePanel();
    userMoved = false; fitView();
  });
  document.getElementById("dream").addEventListener("click", function () { maintain("dream"); });
  document.getElementById("reindex").addEventListener("click", function () { maintain("reindex"); });
  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("elegendToggle").addEventListener("click", function () {
    document.getElementById("elegend").classList.toggle("collapsed");
  });

  resize(); buildLegend(); load(); frame();
})();
</script>
</body>
</html>`;
