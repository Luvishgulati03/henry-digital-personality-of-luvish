#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();

if (process.argv[2] === "start") {
  const { startHenry } = await import("./start.mjs");
  await startHenry(process.argv.slice(3)).catch((error) => {
    console.error(`Henry startup failed: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  await import("../src/cli.ts");
}
