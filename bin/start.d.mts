export declare const shellQuote: (value: string) => string;
export declare const DEFAULT_KOKORO_URL: string;
export declare function terminalCommand(node: string, entry: string): string;
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
  options?: { spawnProcess?: unknown; graceMs?: number; env?: NodeJS.ProcessEnv },
): Promise<void>;
export declare function startHenry(args: string[]): Promise<void>;
