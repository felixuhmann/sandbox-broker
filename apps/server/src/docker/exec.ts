import { randomUUID } from "node:crypto";

import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_CANCELLED_EXIT_CODE,
  EXEC_TIMEOUT_EXIT_CODE,
  WORKSPACE_ROOT,
  type ExecEvent,
  type ExecRequest,
} from "@sandbox-broker/contracts";
import type { Container } from "dockerode";

import type { BrokerConfig } from "../config.js";
import { BrokerError } from "../errors.js";
import type { Logger } from "../log.js";

export type FrameStream = "stdout" | "stderr";
export type Frame = { stream: FrameStream; data: Buffer };


/**
 * Incremental parser for Docker's multiplexed attach stream.
 *
 * Chunk boundaries are arbitrary: a header can be split across TCP reads and a
 * payload can span many. Buffering until a whole frame is available is what
 * keeps binary output intact.
 */
export function createFrameParser(): (chunk: Buffer) => Frame[] {
  let buffered: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): Frame[] => {
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
    const frames: Frame[] = [];
    while (buffered.length >= 8) {
      const size = buffered.readUInt32BE(4);
      if (buffered.length < 8 + size) break;
      const streamType = buffered.readUInt8(0);
      const data = buffered.subarray(8, 8 + size);
      if (size > 0) {
        frames.push({ stream: streamType === 2 ? "stderr" : "stdout", data: Buffer.from(data) });
      }
      buffered = Buffer.from(buffered.subarray(8 + size));
    }
    return frames;
  };
}

/** Directory on the sandbox's noexec tmpfs where the wrapper records its PID. */
export const EXEC_RUNTIME_DIR = "/run/sandbox-broker";

/**
 * Fixed wrapper script. The caller's command is passed as a positional
 * argument, never interpolated, so no quoting in the command can change what
 * the wrapper itself does.
 */
const WRAPPER_SCRIPT = [
  `mkdir -p ${EXEC_RUNTIME_DIR} 2>/dev/null || true`,
  // Recording the PID lets the broker find and kill a leaked process tree
  // before it falls back to restarting the whole sandbox.
  `printf '%s' "$$" > "${EXEC_RUNTIME_DIR}/$1.pid" 2>/dev/null || true`,
  'cd "$2" || exit 1',
  'exec /bin/bash -lc "$3"',
].join("\n");

export function buildExecCommand(input: {
  executionId: string;
  cwd: string;
  command: string;
}): string[] {
  return [
    "/bin/bash",
    "-c",
    WRAPPER_SCRIPT,
    "sandbox-broker-exec",
    input.executionId,
    input.cwd,
    input.command,
  ];
}

export function resolveExecTimeout(requested: number | undefined, config: BrokerConfig): number {
  const fallback = config.defaultExecTimeoutMs || DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(requested ?? fallback, config.maxExecTimeoutMs);
}

export function terminalExitCode(input: {
  timedOut: boolean;
  cancelled: boolean;
  raw: number | null;
}): number {
  if (input.timedOut) return EXEC_TIMEOUT_EXIT_CODE;
  if (input.cancelled) return EXEC_CANCELLED_EXIT_CODE;
  const raw = input.raw;
  if (raw === null || !Number.isInteger(raw) || raw < 0 || raw > 255) return 255;
  return raw;
}

/**
 * Enforces one execution per sandbox in v1. A second concurrent request is a
 * client bug, so it fails fast instead of queueing.
 */
export class ExecutionRegistry {
  private readonly running = new Map<string, string>();

  acquire(sandboxId: string, executionId: string): () => void {
    const existing = this.running.get(sandboxId);
    if (existing) {
      throw new BrokerError(
        "conflict",
        "An execution is already running in this sandbox.",
        { runningExecutionId: existing },
      );
    }
    this.running.set(sandboxId, executionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.running.get(sandboxId) === executionId) this.running.delete(sandboxId);
    };
  }

  current(sandboxId: string): string | null {
    return this.running.get(sandboxId) ?? null;
  }

  releaseAll(): void {
    this.running.clear();
  }
}

export type ExecDeps = {
  config: BrokerConfig;
  logger: Logger;
  registry: ExecutionRegistry;
  /**
   * Restarts the sandbox and re-applies its network policy. Called after a
   * timeout or cancellation so no reparented process can survive into the next
   * command; `/workspace` is untouched.
   */
  recoverSandbox: (sandboxId: string, reason: "timeout" | "cancelled") => Promise<void>;
};

export type ExecInput = {
  sandboxId: string;
  container: Container;
  request: ExecRequest;
  signal: AbortSignal;
};

/**
 * Streams one command execution as contract {@link ExecEvent} frames.
 *
 * The stream always terminates with exactly one `result` or `error` frame, and
 * sequence numbers increase by one across both output streams so a client can
 * detect a dropped frame.
 */
export async function* runExec(deps: ExecDeps, input: ExecInput): AsyncGenerator<ExecEvent> {
  const { config, logger, registry } = deps;
  const { sandboxId, container, request, signal } = input;

  const executionId = randomUUID();
  const release = registry.acquire(sandboxId, executionId);
  const startedAt = Date.now();
  const timeoutMs = resolveExecTimeout(request.timeoutMs, config);

  let seq = 0;
  const nextSeq = () => (seq += 1);

  let timedOut = false;
  let cancelled = false;

  try {
    const exec = await container.exec({
      Cmd: buildExecCommand({
        executionId,
        cwd: request.cwd ?? WORKSPACE_ROOT,
        command: request.command,
      }),
      Env: Object.entries(request.env ?? {}).map(([key, value]) => `${key}=${value}`),
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      // Never elevate: the exec inherits the container's non-root user.
      Privileged: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const parse = createFrameParser();

    const queue: Frame[] = [];
    let notify: (() => void) | null = null;
    let ended = false;
    let streamError: Error | null = null;

    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };

    /**
     * Ends the consumer loop. Destroying a hijacked stream emits `close`
     * rather than `end`, so every terminal path has to funnel through here or
     * the generator would wait forever on a stream that is already gone.
     */
    const finish = () => {
      if (ended) return;
      ended = true;
      wake();
    };

    stream.on("data", (chunk: Buffer) => {
      queue.push(...parse(chunk));
      wake();
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (error: Error) => {
      streamError = error;
      finish();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      destroyStream(stream);
      finish();
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      destroyStream(stream);
      finish();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (!ended || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const frame = queue.shift()!;
        yield {
          type: frame.stream,
          executionId,
          seq: nextSeq(),
          dataBase64: frame.data.toString("base64"),
        };
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }

    if (streamError && !timedOut && !cancelled) {
      logger.warn("exec stream failed", { sandboxId, executionId, error: streamError });
    }

    let rawExitCode: number | null = null;
    if (!timedOut && !cancelled) {
      const inspected = await exec.inspect().catch(() => null);
      rawExitCode = inspected?.ExitCode ?? null;
    }

    if (timedOut || cancelled) {
      // Best effort first: signalling the recorded process group usually stops
      // the tree immediately and keeps the container stop from dragging.
      await killExecutionProcessGroup(container, executionId).catch(() => undefined);
      // But a command can double-fork away from that group, so restarting the
      // sandbox is what actually guarantees nothing survives into the next
      // execution. /workspace is a volume and is unaffected.
      await deps
        .recoverSandbox(sandboxId, timedOut ? "timeout" : "cancelled")
        .catch((error: unknown) => {
          logger.error("sandbox recovery failed", { sandboxId, executionId, error });
        });
    }

    yield {
      type: "result",
      executionId,
      seq: nextSeq(),
      exitCode: terminalExitCode({ timedOut, cancelled, raw: rawExitCode }),
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    release();
  }
}

/**
 * Signals the process group recorded by the wrapper. `executionId` is a
 * broker-generated UUID, so interpolating it into the script is safe.
 */
export async function killExecutionProcessGroup(
  container: Container,
  executionId: string,
): Promise<void> {
  const pidFile = `${EXEC_RUNTIME_DIR}/${executionId}.pid`;
  const script = [
    `pid=$(cat ${pidFile} 2>/dev/null || true)`,
    '[ -n "$pid" ] || exit 0',
    'kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    "sleep 0.2",
    'kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
    `rm -f ${pidFile} 2>/dev/null || true`,
  ].join("\n");

  const exec = await container.exec({
    Cmd: ["/bin/bash", "-c", script],
    AttachStdout: false,
    AttachStderr: false,
  });
  await exec.start({ hijack: false, stdin: false });
}

type Destroyable = { destroy?: (error?: Error) => void; end?: () => void };

function destroyStream(stream: NodeJS.ReadableStream): void {
  const candidate = stream as unknown as Destroyable;
  try {
    candidate.destroy?.();
  } catch {
    /* the stream may already be closed */
  }
}
