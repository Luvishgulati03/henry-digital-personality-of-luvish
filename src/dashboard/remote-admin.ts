import type http from "node:http";

/**
 * OWNER ACCESS THROUGH THE PUBLIC LINK.
 *
 * The public link's landing page offers the owner a password login (src/dashboard/auth.ts, the
 * `owner` account set by `henry admin password`). After it, the owner's session reaches the full
 * dashboard through the tunnel. This file holds the two policy pieces that sit around that login:
 *
 *   remoteAdminEnabled()  the kill switch. HENRY_REMOTE_ADMIN=off (or 0/false/no) refuses owner
 *                         login AND every owner session on tunnelled requests; loopback access on
 *                         the owner's Mac is unaffected.
 *   RemoteLoginAlerts     Telegram notices to the owner (never anyone else): every successful
 *                         remote owner login, and every burst of failed attempts, rate-limited so
 *                         an attack cannot flood the owner's phone but an intrusion is visible.
 */

export function remoteAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HENRY_REMOTE_ADMIN?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false" || value === "no");
}

/** Edge-reported client details, for the owner's notice only (never for any decision). */
export function edgeClientSummary(request: http.IncomingMessage): string {
  const ip = request.headers["cf-connecting-ip"];
  const country = request.headers["cf-ipcountry"];
  const cleanIp = typeof ip === "string" && /^[0-9A-Fa-f:.]{3,45}$/.test(ip.trim()) ? ip.trim() : undefined;
  const cleanCountry = typeof country === "string" && /^[A-Z0-9]{2}$/.test(country.trim()) ? country.trim() : undefined;
  if (!cleanIp && !cleanCountry) return "client address not reported";
  return `Cloudflare reports ${[cleanIp ? `IP ${cleanIp}` : "", cleanCountry ? `country ${cleanCountry}` : ""].filter(Boolean).join(", ")}`;
}

const SUCCESS_NOTICE_GAP_MS = 5 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_BURST = 3;
const FAILURE_NOTICE_GAP_MS = 30 * 60 * 1000;

export class RemoteLoginAlerts {
  private lastSuccessNotice = -Infinity;
  private lastFailureNotice = -Infinity;
  private failures: number[] = [];

  constructor(private readonly send: ((text: string) => Promise<boolean>) | undefined, private readonly now: () => number = Date.now) {}

  /** A successful owner login through the public link. At most one notice per 5 minutes. */
  success(request: http.IncomingMessage): boolean {
    const at = this.now();
    this.failures = [];
    if (!this.send || at - this.lastSuccessNotice < SUCCESS_NOTICE_GAP_MS) return false;
    this.lastSuccessNotice = at;
    void this.send([
      `Henry: owner sign-in through the public link at ${new Date(at).toISOString()} (${edgeClientSummary(request)}).`,
      "If this was not you: run `henry admin logout-all`, then `henry admin password`, or set HENRY_REMOTE_ADMIN=off.",
    ].join("\n")).catch(() => false);
    return true;
  }

  /**
   * A failed attempt through the public link. The third failure inside 10 minutes (and every lock)
   * sends one notice; then at most one per 30 minutes.
   */
  failure(request: http.IncomingMessage, locked: boolean): boolean {
    const at = this.now();
    this.failures = this.failures.filter((time) => at - time < FAILURE_WINDOW_MS);
    this.failures.push(at);
    if (!this.send) return false;
    if (!locked && this.failures.length < FAILURE_BURST) return false;
    if (at - this.lastFailureNotice < FAILURE_NOTICE_GAP_MS) return false;
    this.lastFailureNotice = at;
    void this.send([
      `Henry: ${this.failures.length} failed owner sign-in ${this.failures.length === 1 ? "attempt" : "attempts"} through the public link in the last 10 minutes${locked ? "; owner login is now locked for a while" : ""} (${edgeClientSummary(request)}).`,
      "Nothing was unlocked. To shut remote owner access off entirely, set HENRY_REMOTE_ADMIN=off and restart Henry.",
    ].join("\n")).catch(() => false);
    return true;
  }
}
