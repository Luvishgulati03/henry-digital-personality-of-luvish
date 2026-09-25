import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { PUBLIC_ORIGIN, cookieFrom, publicHarness, tunnel } from "./public-harness.ts";
import { TUNNEL_LOGIN_ROUTES } from "../src/dashboard/server.ts";
import { PUBLIC_TUNNEL_ROUTES, isPublicRequest, matchPublicRoute } from "../src/public/surface.ts";
import {
  MIN_OWNER_PASSWORD_LENGTH, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, endAllSessions, issueSession, ownerAccountExists, readSession, setOwnerPassword, verifyLogin,
} from "../src/dashboard/auth.ts";
import { remoteAdminEnabled } from "../src/dashboard/remote-admin.ts";

/**
 * THE TUNNEL SEES ONLY THE ALLOWLIST. Every route the dashboard server registers is read straight
 * out of src/dashboard/server.ts (string routes and regex routes alike) and requested through the
 * tunnel with every method; a future route therefore cannot leak by default. Unauthenticated, only
 * the public face's allowlist and the owner's login/logout may answer; everything else is a 302 to
 * /login (a page) or a 401 (an API). With a valid owner session, the owner gets the dashboard.
 */

const OWNER_PASSWORD = "correct horse battery staple";

function registeredRoutes(): string[] {
  const source = fs.readFileSync(new URL("../src/dashboard/server.ts", import.meta.url), "utf8");
  const paths = new Set<string>();
  for (const match of source.matchAll(/(?:route|url\.pathname) === "([^"]+)"/g)) paths.add(match[1]);
  for (const match of source.matchAll(/url\.pathname\.match\(\/\^(.+?)\$\/\)/g)) {
    let pattern = match[1].replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "sample-id");
    const alternatives = /\(([a-z|-]+)\)/.exec(pattern);
    if (alternatives) {
      for (const option of alternatives[1].split("|")) paths.add(pattern.replace(alternatives[0], option));
    } else {
      paths.add(pattern);
    }
    pattern = "";
  }
  for (const entry of PUBLIC_TUNNEL_ROUTES) paths.add(entry.split(" ")[1].replace("*", "bundle.min.js"));
  // Paths no route owns, and traversal attempts: all must stay closed.
  for (const extra of ["/api/unknown", "/index.html", "/public", "/public/", "/api/public", "/api/public/unknown", "/%2e%2e/api/status", "/public/../api/approvals", "/vendor/vad/../../package.json", "/favicon.ico"]) paths.add(extra);
  return [...paths];
}

async function raw(port: number, method: string, pathName: string, headers: Record<string, string>): Promise<{ status: number; location?: string; body: string }> {
  // Raw http (not fetch) so the path is sent exactly as written, traversal attempts included.
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: pathName, headers: { ...headers, ...(method !== "GET" ? { "content-type": "application/json", "content-length": "2" } : {}) } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 4096) response.destroy(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }));
      response.on("close", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }));
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => { request.destroy(new Error(`timeout ${method} ${pathName}`)); });
    if (method !== "GET") request.write("{}");
    request.end();
  });
}

function allowlisted(method: string, pathName: string): boolean {
  const route = pathName.split("?")[0].replace(/\/+$/, "") || "/";
  return Boolean(matchPublicRoute(method, route)) || TUNNEL_LOGIN_ROUTES.includes(`${method} ${route}`);
}

test("route walk: an unauthenticated tunnel request reaches ONLY the landing, login, public allowlist, and health", async () => {
  const h = await publicHarness();
  try {
    const port = Number(new URL(h.base).port);
    const paths = registeredRoutes();
    assert.ok(paths.length > 60, `expected the whole dashboard route table, found ${paths.length}`);
    for (const must of ["/api/approvals", "/api/memory/recall", "/api/chat/send", "/api/settings/provider", "/api/events", "/memory", "/admin/knowledge", "/api/approvals/sample-id/execute", "/api/attachments/sample-id", "/talk", "/chat", "/"]) {
      assert.ok(paths.includes(must), `route extraction missed ${must}`);
    }
    const leaks: string[] = [];
    for (const pathName of paths) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        for (const accept of ["text/html", "application/json"]) {
          const result = await raw(port, method, pathName, { ...tunnel(), accept, origin: PUBLIC_ORIGIN });
          if (allowlisted(method, new URL(pathName, "http://x").pathname)) {
            assert.ok(result.status < 500, `${method} ${pathName} errored through the tunnel (${result.status})`);
            continue;
          }
          const closed = result.status === 401 || (result.status === 302 && result.location === "/login") || result.status === 404;
          if (!closed) leaks.push(`${method} ${pathName} [${accept}] -> ${result.status}`);
          if (method === "GET" && accept === "text/html" && result.status === 302) assert.equal(result.location, "/login");
        }
      }
    }
    assert.deepEqual(leaks, [], "only the allowlist may answer an unauthenticated tunnel request");
    assert.equal(h.runs.length, 0, "the walk never started a model turn");
  } finally { await h.close(); }
});

test("the local-admin bypass and the dashboard token never apply to a tunnelled request", async () => {
  const h = await publicHarness();
  try {
    h.runtime.config.dashboardToken = "local-dashboard-token-123";
    // Locally (loopback, no proxy headers) the owner's dashboard works exactly as before.
    assert.equal((await fetch(`${h.base}/api/approvals`)).status, 200);
    assert.match(await (await fetch(`${h.base}/`, { headers: { accept: "text/html" } })).text(), /<html/i);
    // Through the tunnel the socket peer is still 127.0.0.1, but that grants nothing.
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: tunnel() })).status, 401);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), authorization: "Bearer local-dashboard-token-123", "x-henry-token": "local-dashboard-token-123" } })).status, 401);
    // A visitor cookie grants nothing admin.
    const page = await fetch(`${h.base}/public/chat`, { headers: tunnel() });
    const visitor = cookieFrom(page);
    assert.match(visitor, /^henry_visitor=/);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: visitor } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: visitor.replace("henry_visitor", "henry_sess") } })).status, 401);
    // Unauthenticated "/" through the tunnel is the landing page, not the dashboard.
    const landing = await (await fetch(`${h.base}/`, { headers: { ...tunnel(), accept: "text/html" } })).text();
    assert.match(landing, /I'm here to learn more/);
    assert.match(landing, /href="\/login"/);
  } finally { await h.close(); }
});

test("isPublicRequest: fail-closed classification", () => {
  const request = (headers: Record<string, string>, remoteAddress = "127.0.0.1"): http.IncomingMessage => ({ headers, socket: { remoteAddress } as net.Socket } as unknown as http.IncomingMessage);
  const local = { allowRemoteDashboard: false };
  assert.equal(isPublicRequest(request({ host: "127.0.0.1:7337" }), local), false);
  assert.equal(isPublicRequest(request({ host: "localhost:7337" }), local), false);
  assert.equal(isPublicRequest(request({ host: "[::1]:7337" }, "::1"), local), false);
  for (const header of ["cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"]) {
    assert.equal(isPublicRequest(request({ host: "127.0.0.1:7337", [header]: "x" }), local), true, header);
  }
  assert.equal(isPublicRequest(request({ host: "henry.example.com" }), local), true, "a non-loopback Host (e.g. DNS rebinding) is public");
  assert.equal(isPublicRequest(request({}), local), true, "no Host header is public");
  assert.equal(isPublicRequest(request({ host: "127.0.0.1:7337" }, "192.168.1.20"), local), true, "a non-loopback peer is public");
  assert.equal(isPublicRequest(request({ host: "192.168.1.5:7337" }, "192.168.1.20"), { allowRemoteDashboard: true }), false, "explicit token remote dashboard keeps its own path");
  assert.equal(isPublicRequest(request({ host: "192.168.1.5:7337", "cf-ray": "x" }, "192.168.1.20"), { allowRemoteDashboard: true }), true);
});

async function tunnelLogin(base: string, password: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...tunnel(extra["cf-connecting-ip"] ? { "cf-connecting-ip": extra["cf-connecting-ip"] } : {}), origin: PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams({ username: "owner", password }).toString(),
  });
}

test("owner through the tunnel: not set up until `henry admin password`; then a Secure SameSite=Strict session gets the full dashboard", async () => {
  const h = await publicHarness();
  try {
    assert.equal(ownerAccountExists(), false);
    const config = await (await fetch(`${h.base}/api/public/config`, { headers: tunnel() })).json();
    assert.equal(config.ownerAccess, "not-set-up");
    const setup = await fetch(`${h.base}/login`, { redirect: "manual", headers: { ...tunnel(), accept: "text/html" } });
    assert.equal(setup.headers.get("location"), "/login?error=setup");
    assert.equal((await tunnelLogin(h.base, OWNER_PASSWORD)).headers.get("location"), "/login?error=setup");

    assert.throws(() => setOwnerPassword("short"), new RegExp(`at least ${MIN_OWNER_PASSWORD_LENGTH}`));
    setOwnerPassword(OWNER_PASSWORD);
    assert.equal(ownerAccountExists(), true);
    assert.equal((await (await fetch(`${h.base}/api/public/config`, { headers: tunnel() })).json()).ownerAccess, "ready");

    // A cross-site or origin-less login POST is refused before the password is even checked.
    for (const origin of ["https://evil.example.com", "https://henry.example.com.evil.test"]) {
      assert.equal((await tunnelLogin(h.base, OWNER_PASSWORD, { origin })).status, 403);
    }
    const noOrigin = await fetch(`${h.base}/login`, { method: "POST", redirect: "manual", headers: { ...tunnel(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "owner", password: OWNER_PASSWORD }).toString() });
    assert.equal(noOrigin.status, 403);

    const login = await tunnelLogin(h.base, OWNER_PASSWORD);
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    const setCookie = login.headers.getSetCookie().find((value) => value.startsWith("henry_sess="))!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=604800/);
    const cookie = cookieFrom(login);
    assert.ok(h.sends.some((text) => /owner sign-in through the public link/.test(text) && /203\.0\.113\.7/.test(text)), "the owner is told about every remote sign-in");

    // The full dashboard, exactly as on loopback.
    const home = await fetch(`${h.base}/`, { headers: { ...tunnel(), cookie, accept: "text/html" } });
    assert.equal(home.status, 200);
    assert.doesNotMatch(await home.text(), /I'm here to learn more/);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie } })).status, 200);
    assert.equal((await fetch(`${h.base}/login`, { redirect: "manual", headers: { ...tunnel(), cookie } })).headers.get("location"), "/");
    const port = Number(new URL(h.base).port);
    // /logout would (correctly) end this very session; /api/events streams forever.
    const skipped = new Set(["/api/events", "/api/memory/recall", "/logout"]);
    for (const pathName of registeredRoutes()) {
      if (skipped.has(pathName) || !pathName.startsWith("/") || pathName.includes("..") || pathName.includes("%2e")) continue;
      const result = await raw(port, "GET", pathName, { ...tunnel(), cookie, accept: "application/json" });
      assert.notEqual(result.status, 401, `owner GET ${pathName} was refused`);
      assert.ok(!(result.status === 302 && result.location === "/login"), `owner GET ${pathName} bounced to login`);
    }

    // Exact-origin CSRF on every state change through the tunnel.
    const provider = (origin?: string): Promise<Response> => fetch(`${h.base}/api/settings/provider`, {
      method: "POST", headers: { ...tunnel(), cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ provider: "codex" }),
    });
    assert.equal((await provider("https://evil.example.com")).status, 403);
    assert.equal((await provider("http://127.0.0.1:7337")).status, 403, "a loopback origin is not trusted through the tunnel");
    assert.equal((await provider()).status, 403, "a state change without Origin is refused through the tunnel");
    assert.equal((await provider(PUBLIC_ORIGIN)).status, 200);

    // Kill switch: the same session is refused through the tunnel; loopback is unaffected.
    process.env.HENRY_REMOTE_ADMIN = "off";
    try {
      assert.equal(remoteAdminEnabled(), false);
      assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie } })).status, 401);
      assert.equal((await fetch(`${h.base}/login`, { redirect: "manual", headers: tunnel() })).headers.get("location"), "/login?error=off");
      assert.equal((await tunnelLogin(h.base, OWNER_PASSWORD)).headers.get("location"), "/login?error=off");
      assert.equal((await (await fetch(`${h.base}/api/public/config`, { headers: tunnel() })).json()).ownerAccess, "off");
      assert.equal((await fetch(`${h.base}/api/approvals`)).status, 200, "loopback is unchanged");
    } finally { delete process.env.HENRY_REMOTE_ADMIN; }

    // Logout ends the session (cookie cleared, Secure), and logout-all ends every other one.
    const logout = await fetch(`${h.base}/logout`, { redirect: "manual", headers: { ...tunnel(), cookie } });
    assert.equal(logout.headers.get("location"), "/");
    assert.match(logout.headers.getSetCookie().join(";"), /henry_sess=;.*Max-Age=0.*Secure/);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie } })).status, 401);
    const again = cookieFrom(await tunnelLogin(h.base, OWNER_PASSWORD));
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: again } })).status, 200);
    assert.ok(endAllSessions() >= 1);
    assert.equal((await fetch(`${h.base}/api/approvals`, { headers: { ...tunnel(), cookie: again } })).status, 401);
  } finally { await h.close(); }
});

test("owner login throttle: keyed on the username, never on a forwarded address; bursts alert the owner", async () => {
  const h = await publicHarness();
  try {
    setOwnerPassword(OWNER_PASSWORD);
    for (let attempt = 0; attempt < 5; attempt++) {
      // Rotating CF-Connecting-IP / X-Forwarded-For per attempt must not reset anything.
      const ip = `198.51.100.${attempt + 1}`;
      const response = await tunnelLogin(h.base, "wrong password here", { "cf-connecting-ip": ip, "x-forwarded-for": ip });
      assert.equal(response.headers.get("location"), "/login?error=1");
    }
    const locked = await tunnelLogin(h.base, OWNER_PASSWORD, { "cf-connecting-ip": "192.0.2.99", "x-forwarded-for": "192.0.2.99" });
    assert.equal(locked.headers.get("location"), "/login?error=locked", "even the right password waits out the lock");
    assert.equal(locked.headers.getSetCookie().some((value) => value.startsWith("henry_sess=")), false);
    const alerts = h.sends.filter((text) => /failed owner sign-in/.test(text));
    assert.equal(alerts.length, 1, "one notice per burst, not one per attempt");
    assert.match(alerts[0], /Nothing was unlocked/);
  } finally { await h.close(); }
});

test("sessions: 12 hour idle expiry, 7 day absolute limit, password change signs everyone out", () => {
  setOwnerPassword(OWNER_PASSWORD);
  const owner = verifyLogin("owner", OWNER_PASSWORD)!;
  assert.ok(owner);
  const start = Date.UTC(2026, 0, 1);
  const cookieFor = (issued: string): string => issued.split(";")[0];
  const idle = cookieFor(issueSession(owner, { now: start }).cookie);
  assert.ok(readSession(idle, start + SESSION_IDLE_MS - 60_000));
  assert.equal(readSession(idle, start + SESSION_IDLE_MS - 60_000 + SESSION_IDLE_MS + 1), undefined, "idle past 12 hours");

  const busy = cookieFor(issueSession(owner, { now: start }).cookie);
  let at = start;
  while (at + SESSION_IDLE_MS / 2 < start + SESSION_ABSOLUTE_MS) {
    at += SESSION_IDLE_MS / 2;
    assert.ok(readSession(busy, at), "an active session stays alive inside the absolute limit");
  }
  assert.equal(readSession(busy, start + SESSION_ABSOLUTE_MS + 1), undefined, "never past 7 days, however active");

  const live = cookieFor(issueSession(owner).cookie);
  assert.ok(readSession(live));
  setOwnerPassword(`${OWNER_PASSWORD} v2`);
  assert.equal(readSession(live), undefined, "changing the password ends every session");
  assert.equal(verifyLogin("owner", OWNER_PASSWORD), undefined);
  assert.ok(verifyLogin("owner", `${OWNER_PASSWORD} v2`));
});
