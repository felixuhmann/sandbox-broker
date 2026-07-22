import type { Container } from "dockerode";

import { createFrameParser } from "./exec.js";

export type CapturedExec = { stdout: string; stderr: string; exitCode: number };

/**
 * Runs a short broker-internal command and buffers its output.
 *
 * Only used for the broker's own housekeeping (measuring workspace usage,
 * creating a directory, renaming a temporary file). Caller commands go through
 * the streaming path in exec.ts.
 */
export async function execCapture(
  container: Container,
  cmd: string[],
  options: { user?: string } = {},
): Promise<CapturedExec> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: false,
    ...(options.user ? { User: options.user } : {}),
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  const parse = createFrameParser();
  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      for (const frame of parse(chunk)) {
        if (frame.stream === "stdout") stdout += frame.data.toString("utf8");
        else stderr += frame.data.toString("utf8");
      }
    });
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", reject);
  });

  const inspected = await exec.inspect().catch(() => null);
  return { stdout, stderr, exitCode: inspected?.ExitCode ?? -1 };
}
