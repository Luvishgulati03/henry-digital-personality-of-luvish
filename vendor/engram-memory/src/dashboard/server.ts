/**
 * Dashboard server — a tiny zero-dependency HTTP server (node:http only) that
 * serves the neuron-graph viz and three JSON endpoints backed by a live Engram:
 *
 *   GET  /              -> the dashboard page (self-contained HTML)
 *   GET  /api/graph     -> graphExport() + an emotion->hue palette for tinting
 *   GET  /api/recall    -> recallTrace(q): which neurons fire + the spread trace
 *   POST /api/maintain  -> op=dream (promote+consolidate) | op=reindex (rebuild edges)
 *
 * Plug-and-play: `new Engram(...)` then `startDashboard(engram)` and open the URL.
 * No build step, no framework, no external assets — it runs anywhere Node does.
 */

import http from "node:http";
import type { Engram } from "../engram.js";
import { DASHBOARD_HTML } from "./page.js";
import { emotionPalette, emotionFamilyLegend } from "../enrich/emotions.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(s);
}

/**
 * Start the dashboard HTTP server against a live Engram. Returns the Node
 * server (call `.close()` to stop). Does not block — keep the process alive
 * however you like (the CLI just lets it run).
 */
export function startDashboard(engram: Engram, opts: DashboardOptions = {}): http.Server {
  const palette = emotionPalette();
  const families = emotionFamilyLegend();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && path === "/api/graph") {
        const g = engram.graphExport();
        sendJson(res, 200, { nodes: g.nodes, edges: g.edges, stats: g.stats, palette, families });
        return;
      }

      if (req.method === "GET" && path === "/api/recall") {
        const q = (url.searchParams.get("q") ?? "").trim();
        const k = Math.max(1, Math.min(30, Number(url.searchParams.get("k")) || 8));
        if (!q) return sendJson(res, 400, { error: "missing q" });
        const out = await engram.recallTrace(q, { k });
        sendJson(res, 200, {
          results: out.results.map((r) => ({ id: r.id, score: r.score, why: r.why })),
          trace: out.trace,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/maintain") {
        // CSRF hardening: the server binds to localhost, but any webpage can
        // still fire a cross-origin form POST at it. Only accept same-origin
        // (or origin-less, e.g. curl) requests.
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
          return sendJson(res, 403, { error: "cross-origin request rejected" });
        }
        const op = url.searchParams.get("op");
        if (op === "dream") {
          const r = engram.dream({ consolidate: { capacity: undefined } });
          const promoted = r.promotion?.promoted ?? 0;
          const archived = r.consolidation?.archived ?? 0;
          sendJson(res, 200, { message: "dreamed — promoted " + promoted + ", archived " + archived });
          return;
        }
        if (op === "reindex") {
          const r = engram.buildEdges();
          sendJson(res, 200, { message: "reindexed — " + r.total + " edges" });
          return;
        }
        return sendJson(res, 400, { error: "unknown op" });
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = opts.port ?? 7755;
  const host = opts.host ?? "127.0.0.1";
  server.listen(port, host);
  return server;
}
