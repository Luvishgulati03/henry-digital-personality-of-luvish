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
export interface DashboardOptions {
    port?: number;
    host?: string;
}
/**
 * Start the dashboard HTTP server against a live Engram. Returns the Node
 * server (call `.close()` to stop). Does not block — keep the process alive
 * however you like (the CLI just lets it run).
 */
export declare function startDashboard(engram: Engram, opts?: DashboardOptions): http.Server;
//# sourceMappingURL=server.d.ts.map