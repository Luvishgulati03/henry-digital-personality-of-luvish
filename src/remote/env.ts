import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { TunnelManager, tunnelModeFromEnv, type TunnelActivity } from "./tunnel.ts";
import { publicPackDir } from "../public/config.ts";
import { publishedPackProblem } from "../public/pack.ts";

/**
 * Builds Henry's TunnelManager from HENRY_* environment:
 *
 *   HENRY_TUNNEL=cloudflare      set by `henry start --public` only (off otherwise)
 *   HENRY_CLOUDFLARE_TUNNEL      the named tunnel (written by `henry tunnel setup`)
 *   HENRY_PUBLIC_HOST            the public hostname (written by `henry tunnel setup`)
 *   HENRY_CLOUDFLARED_PATH       optional binary override
 *   HENRY_TUNNEL_PORT            optional; defaults to the dashboard port
 *
 * The tunnel's preflight refuses to expose anything while the published public knowledge pack is
 * missing or empty.
 */

const CLOUDFLARED_FALLBACKS = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];

function executable(filePath: string): boolean {
  try { fs.accessSync(filePath, fs.constants.X_OK); return true; } catch { return false; }
}

/** HENRY_CLOUDFLARED_PATH, else `cloudflared` on PATH, else the Homebrew prefixes. Never installs anything. */
export function resolveCloudflaredPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HENRY_CLOUDFLARED_PATH?.trim();
  if (override) return override;
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (executable(path.join(dir, "cloudflared"))) return path.join(dir, "cloudflared");
  }
  return CLOUDFLARED_FALLBACKS.find(executable) ?? "cloudflared";
}

export function createTunnelFromEnv(options: { port: number; dataDir: string; activity: TunnelActivity }, env: NodeJS.ProcessEnv = process.env): TunnelManager {
  return new TunnelManager({
    mode: tunnelModeFromEnv(env.HENRY_TUNNEL),
    port: Number(env.HENRY_TUNNEL_PORT) || options.port,
    cloudflaredPath: resolveCloudflaredPath(env),
    cloudflareTunnel: env.HENRY_CLOUDFLARE_TUNNEL?.trim() || undefined,
    publicHost: env.HENRY_PUBLIC_HOST?.trim() || undefined,
  }, options.activity, {
    spawn,
    which: async (binary) => binary.includes(path.sep)
      ? executable(binary)
      : (env.PATH || "").split(path.delimiter).filter(Boolean).some((dir) => executable(path.join(dir, binary))),
    preflight: () => publishedPackProblem(publicPackDir(options.dataDir)),
  });
}
