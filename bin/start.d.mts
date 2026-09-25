export declare const shellQuote: (value: string) => string;
export declare const DEFAULT_KOKORO_URL: string;
export declare function terminalCommand(node: string, entry: string, publicMode?: boolean): string;
export declare function resolveTunnelMode(args: string[]): "off" | "cloudflare";
export declare function resolvePublicOrigin(env?: NodeJS.ProcessEnv): string | undefined;
export declare function publicPreflight(
  env: NodeJS.ProcessEnv,
  packDir: string,
  readdir?: (dir: string) => Promise<string[]>,
  readFile?: (file: string, encoding: "utf8") => Promise<string>,
): Promise<string | undefined>;
export declare function maybeKeepAwake(
  tunnelMode: "off" | "cloudflare",
  remoteActive: boolean,
  pid: number,
  options?: { platform?: NodeJS.Platform; spawnProcess?: unknown },
): unknown;
export declare function waitForTunnelActive(
  dashboard: string,
  options?: { timeoutMs?: number; fetcher?: typeof fetch; intervalMs?: number },
): Promise<boolean>;
export declare function assertFree(port: number): Promise<void>;
export declare function waitReady(url: string | URL, options?: {
  token?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  alive?: () => boolean;
}): Promise<void>;
export declare function supervise(
  commands: Array<{ file: string; args: string[] }>,
  ready: (alive: () => boolean) => Promise<void>,
  options?: { spawnProcess?: unknown; graceMs?: number; env?: NodeJS.ProcessEnv; pipeOutput?: boolean },
): Promise<void>;
export declare function teeServiceOutput(
  dataDir: string,
  options?: {
    streams?: { stdout: { write: (...args: any[]) => boolean }; stderr: { write: (...args: any[]) => boolean } };
    createLog?: () => { append(text: string): void };
    now?: () => Date;
  },
): Promise<() => void>;
export declare function startHenry(args: string[]): Promise<void>;
