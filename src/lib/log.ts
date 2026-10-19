type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min: Level = (process.env.LOG_LEVEL as Level) ?? "info";

function emit(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < order[min]) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const sink = level === "error" ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

export const logger = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
