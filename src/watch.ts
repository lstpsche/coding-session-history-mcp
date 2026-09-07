import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** One child writer at a time; retrieval runs in a separate process. */
export async function watch(
  source: string,
  db: string,
  interval: number,
  signal: AbortSignal,
  policyPath: string | null,
) {
  if (!Number.isInteger(interval) || interval < 100 || interval > 300_000)
    throw new Error("interval-ms must be between 100 and 300000");
  let child: ChildProcess | undefined;
  const stop = () => child?.kill("SIGTERM");
  signal.addEventListener("abort", stop);
  try {
    while (!signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("cli.js", import.meta.url)),
            "index",
            ...(policyPath === null ? ["--all"] : ["--policy", policyPath]),
            "--source",
            source,
            "--db",
            db,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.stderr?.pipe(process.stderr, { end: false });
        child.once("error", reject);
        child.once("exit", () => {
          child = undefined;
          resolve();
        });
      });
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, interval);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
