import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as spawnType } from "node:child_process";
import type { ActivityKind } from "../types.ts";

/**
 * Henry's public-link tunnel (ported from Kelly's src/remote/tunnel.ts, Cloudflare named tunnel
 * only). Henry never changes its bind address and never sets allowRemoteDashboard: the dashboard
 * stays on 127.0.0.1. This module only starts and supervises `cloudflared tunnel run`, which
 * forwards the owner's public hostname into the loopback dashboard. Everything that arrives that
 * way is gated in src/dashboard/server.ts: without an owner session only the public face's
 * allowlist (src/public/surface.ts) and the owner's login answer.
 *
 * Process spawning is fully injected (TunnelDeps) so tests never run a real binary, and
 * tests/isolate.mjs forces HENRY_TUNNEL=off and points HENRY_CLOUDFLARED_PATH at a missing file.
 */

export type TunnelMode = "off" | "cloudflare";

export interface TunnelStatus {
  mode: TunnelMode;
  active: boolean;
  url?: string;
  since?: string;
  restarts: number;
  lastError?: string;
  binary?: string;
  /** true for cloudflare mode: the link is reachable by anyone. */
  public?: boolean;
}

export interface TunnelConfig {
  mode: TunnelMode;
  port: number;
  cloudflaredPath: string;
  cloudflareTunnel?: string;
  /** HENRY_PUBLIC_HOST, e.g. "henry.your-domain.com". Reported as status().url once cloudflared
   *  confirms a registered connection, instead of scraping a hostname from its log. */
  publicHost?: string;
}

/** The one ActivityLog method the tunnel uses (kept structural so tests can pass a recorder). */
export interface TunnelActivity {
  record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface TunnelDeps {
  spawn?: typeof spawnType;
  which?: (binary: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Returns a reason the public surface cannot be exposed yet (e.g. no published knowledge pack),
   * or undefined when it is ready. The tunnel refuses to start while a reason is returned: Henry
   * never answers the public from nothing.
   */
  preflight?: () => string | undefined;
}

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const MAX_MESSAGE_LEN = 240;
const MAX_BUFFER_LEN = 4_000;

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LEN ? `${message.slice(0, MAX_MESSAGE_LEN)}...` : message;
}

/**
 * Maps common `cloudflared tunnel run` output to a plain-English sentence with the fix. Returns
 * undefined when nothing known matches, so the caller falls back to the generic exit message.
 */
export function classifyCloudflareFailure(output: string, hostOrTunnel?: string): string | undefined {
  const text = output.toLowerCase();
  if (!text.trim()) return undefined;
  const setupTarget = hostOrTunnel ?? "<hostname>";
  if (text.includes("cannot determine default origin certificate") || text.includes("cert.pem")) {
    return `Cloudflare tunnel is not set up on this Mac yet. Run \`henry tunnel setup ${setupTarget}\`, then try again.`;
  }
  if (text.includes("tunnel not found") || (text.includes("credentials file") && (text.includes("not found") || text.includes("missing") || text.includes("no such file")))) {
    return `Cloudflare tunnel is not set up on this Mac yet. Run \`henry tunnel setup ${setupTarget}\`, then try again.`;
  }
  if (text.includes("failed to dial") || text.includes("network is unreachable") || text.includes("no such host") || text.includes("connection refused")) {
    return "Could not reach Cloudflare. Check the internet connection on this Mac; Henry keeps retrying.";
  }
  return undefined;
}

/**
 * Emitted every time record() logs a remote.started/remote.failed/remote.stopped transition,
 * never on a no-op. src/remote/announce.ts awaits the first one after start().
 */
export interface TunnelStatusEvent {
  kind: ActivityKind;
  status: TunnelStatus;
}

export class TunnelManager extends EventEmitter {
  private _active = false;
  private stopped = true;
  private status_: TunnelStatus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private cfChild?: ChildProcess;
  private cfBuffer = "";
  private cfBackoff = BACKOFF_INITIAL_MS;
  private cfStopping = false;
  private cfClassifiedError?: string;

  constructor(
    private readonly config: TunnelConfig,
    private readonly activity: TunnelActivity,
    private readonly deps: TunnelDeps,
  ) {
    super();
    this.status_ = { mode: config.mode, active: false, restarts: 0 };
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  get active(): boolean {
    return this._active;
  }

  status(): TunnelStatus {
    return {
      mode: this.config.mode,
      active: this._active,
      url: this._active ? this.status_.url : undefined,
      since: this._active ? this.status_.since : undefined,
      restarts: this.status_.restarts,
      lastError: this._active ? undefined : this.status_.lastError,
      binary: this.status_.binary,
      public: this.config.mode === "cloudflare" ? true : undefined,
    };
  }

  async start(): Promise<TunnelStatus> {
    if (this.config.mode === "off") {
      this.stopped = true;
      this._active = false;
      return this.status();
    }
    this.stopped = false;
    this.status_.binary = path.basename(this.config.cloudflaredPath);
    if (!this.config.cloudflareTunnel) {
      return this.fail("HENRY_CLOUDFLARE_TUNNEL is not set. Run `henry tunnel setup <hostname>` first.");
    }
    const notReady = this.deps.preflight?.();
    if (notReady) return this.fail(notReady);
    if (!(await this.which(this.config.cloudflaredPath))) {
      return this.fail(`${this.status_.binary} was not found. Henry does not install binaries; run \`brew install cloudflared\`.`);
    }
    this.cfBackoff = BACKOFF_INITIAL_MS;
    this.status_.restarts = 0;
    this.spawnCloudflared();
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.config.mode !== "cloudflare") return;
    this.cfStopping = true;
    this._active = false;
    const child = this.cfChild;
    if (!child) {
      this.cfStopping = false;
      await this.record("remote.stopped", "Cloudflare tunnel stopped", { mode: "cloudflare", binary: this.status_.binary });
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("exit", () => resolve());
      }),
      this.sleep(STOP_GRACE_MS).then(() => {
        if (this.cfChild === child) child.kill("SIGKILL");
      }),
    ]);
    this.cfChild = undefined;
    await this.record("remote.stopped", "Cloudflare tunnel stopped", { mode: "cloudflare", binary: this.status_.binary });
  }

  private async which(binaryPath: string): Promise<boolean> {
    if (!this.deps.which) return false;
    try {
      return await this.deps.which(binaryPath);
    } catch {
      return false;
    }
  }

  private async record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<void> {
    // Emitted synchronously, before the (possibly slow) activity write, so a listener waiting on
    // the next transition never blocks on disk I/O.
    this.emit("status", { kind, status: this.status() } satisfies TunnelStatusEvent);
    try {
      await this.activity.record(kind, bounded(message), metadata);
    } catch {
      /* activity logging must never break the tunnel */
    }
  }

  private async fail(reason: string): Promise<TunnelStatus> {
    this._active = false;
    this.status_.lastError = reason;
    await this.record("remote.failed", reason, { mode: this.config.mode, binary: this.status_.binary });
    return this.status();
  }

  private spawnCloudflared(): void {
    if (!this.deps.spawn) {
      this.status_.lastError = "no process spawner configured";
      void this.record("remote.failed", this.status_.lastError, { mode: "cloudflare", binary: this.status_.binary });
      return;
    }
    this.cfBuffer = "";
    this.cfClassifiedError = undefined;
    let child: ChildProcess;
    try {
      // --no-autoupdate is a `tunnel` flag, so it sits before `run`. --url means cloudflared needs
      // no ~/.cloudflared/config.yml ingress; the named tunnel (created by `henry tunnel setup`)
      // already owns the DNS route to this hostname. Never a shell.
      child = this.deps.spawn(this.config.cloudflaredPath, [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--url",
        `http://127.0.0.1:${this.config.port}`,
        this.config.cloudflareTunnel ?? "",
      ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.status_.lastError = `could not start cloudflared: ${errMessage(error)}`;
      void this.record("remote.failed", this.status_.lastError, { mode: "cloudflare", binary: this.status_.binary });
      this.scheduleRestart();
      return;
    }
    this.cfChild = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onOutput(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => this.onOutput(String(chunk)));
    // 'error' and 'close' can both fire for one child; only the first one counts.
    let exited = false;
    const exit = (code: number | null): void => {
      if (exited) return;
      exited = true;
      this.onExit(code);
    };
    child.once("error", (error: Error) => {
      this.status_.lastError = `cloudflared error: ${errMessage(error)}`;
      exit(null);
    });
    child.once("close", (code: number | null) => exit(code));
  }

  private onOutput(chunk: string): void {
    this.cfBuffer = (this.cfBuffer + chunk).slice(-MAX_BUFFER_LEN);
    if (!this.cfClassifiedError) {
      const known = classifyCloudflareFailure(this.cfBuffer, this.config.publicHost ?? this.config.cloudflareTunnel);
      if (known) this.cfClassifiedError = known;
    }
    if (this._active || !this.cfBuffer.includes("Registered tunnel connection")) return;
    this._active = true;
    this.status_.since = new Date(this.now()).toISOString();
    this.status_.lastError = undefined;
    this.cfBackoff = BACKOFF_INITIAL_MS;
    this.cfClassifiedError = undefined;
    // The operator-declared hostname, so the trusted-origin check and the announcement agree on the
    // exact domain. Without it no URL is reported (Henry never scrapes one from the log line).
    this.status_.url = this.config.publicHost ? `https://${this.config.publicHost}` : undefined;
    void this.record(
      "remote.started",
      this.status_.url ? "Cloudflare tunnel connected" : "Cloudflare tunnel connected (set HENRY_PUBLIC_HOST to report its hostname)",
      { mode: "cloudflare", binary: this.status_.binary },
    );
  }

  private onExit(code: number | null): void {
    this.cfChild = undefined;
    this._active = false;
    if (this.cfStopping) {
      this.cfStopping = false;
      return;
    }
    const classified = this.cfClassifiedError;
    this.status_.lastError = classified ?? `cloudflared exited (code ${String(code)}); reconnecting`;
    void this.record("remote.failed", classified ?? `cloudflared exited unexpectedly (code ${String(code)})`, {
      mode: "cloudflare", binary: this.status_.binary, restarts: this.status_.restarts,
    });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const wait = this.cfBackoff;
    this.cfBackoff = Math.min(this.cfBackoff * 2, BACKOFF_MAX_MS);
    this.status_.restarts += 1;
    void this.sleep(wait).then(() => {
      if (this.stopped) return;
      this.spawnCloudflared();
    });
  }
}

export function tunnelModeFromEnv(value: string | undefined): TunnelMode {
  return value === "cloudflare" ? "cloudflare" : "off";
}
