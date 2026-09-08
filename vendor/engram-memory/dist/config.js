import { existsSync, readFileSync } from "node:fs";
const DEFAULT_PATH = "engram.config.json";
/**
 * Load config from an explicit path, or `engram.config.json` in the CWD if
 * present. Returns `{}` when there is no config (never throws on absence).
 */
export function loadConfig(path) {
    const file = path ?? (existsSync(DEFAULT_PATH) ? DEFAULT_PATH : null);
    if (!file)
        return {};
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch (e) {
        throw new Error(`Failed to read config ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
//# sourceMappingURL=config.js.map