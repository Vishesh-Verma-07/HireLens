import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./log.js";

/**
 * Loads `<root>/.env` when Node supports `process.loadEnvFile`.
 *
 * Both the CLI (`npm run match`) and the email bot need the same Google API
 * keys, so the loading lives in one place.
 */
export function loadEnv(root: string): void {
  const path = resolve(root, ".env");
  try {
    if (existsSync(path) && typeof process.loadEnvFile === "function") {
      process.loadEnvFile(path);
    }
  } catch (err) {
    logger.warn(`could not load .env — ${(err as Error).message}`);
  }
}
