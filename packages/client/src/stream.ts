import { ExecEvent } from "@sandbox-broker/contracts";

import { BrokerStreamError, type BrokerStreamErrorReason } from "./errors.js";

/** Anything the runtime can hand back as a response body. */
export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type ParseExecStreamOptions = {
  signal?: AbortSignal;
  /**
   * Ceiling on a single NDJSON line. A server that never emits a newline would
   * otherwise grow the buffer until the process dies.
   */
  maxLineBytes?: number;
  /** Reported on thrown errors; defaults to the contract operation. */
  operationId?: string;
};

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Chunk iterator that reacts to an abort while a read is still pending.
 *
 * `for await` over a ReadableStream only observes the signal between chunks,
 * which is useless for a command that has gone quiet: the read below is raced
 * against the abort and the source is cancelled explicitly.
 */
async function* readChunks(
  source: ByteSource,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  if (signal?.aborted) throw abortReason(signal);

  // A WHATWG stream is also async-iterable in Node, but iterating it only
  // observes the signal between chunks. The reader path is preferred whenever
  // one is available so a silent command can still be aborted.
  if ("getReader" in source && typeof source.getReader === "function") {
    const reader = source.getReader();
    let abortListener: (() => void) | null = null;
    let abortedWith: unknown = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => {
        abortedWith = abortReason(signal);
        reject(abortedWith);
        // Cancelling releases the socket instead of leaving it half-read. It
        // also resolves the pending read as `done`, which is why the abort
        // reason is recorded rather than inferred from how the loop ended.
        void reader.cancel(abortedWith).catch(() => undefined);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    // Nothing awaits this promise unless the signal fires.
    aborted.catch(() => undefined);

    try {
      for (;;) {
        const { done, value } = await (signal
          ? Promise.race([reader.read(), aborted])
          : reader.read());
        if (abortedWith) throw abortedWith;
        if (done) return;
        if (value) yield value;
      }
    } finally {
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      reader.releaseLock();
    }
    return;
  }

  for await (const chunk of source) {
    if (signal?.aborted) throw abortReason(signal);
    yield chunk;
  }
}

/**
 * Parses a broker exec response into validated {@link ExecEvent} frames.
 *
 * The stream is a protocol, not a best-effort log: sequence numbers must start
 * at 1 and increase by exactly one, every frame must belong to the same
 * execution, and the stream must end with exactly one terminal frame. Any
 * deviation throws a {@link BrokerStreamError} rather than yielding a partial
 * transcript that a caller would mistake for the whole output.
 *
 * The one deliberate exception is the terminal `error` frame: the server emits
 * it after the 200 status line is already committed, with its own executionId
 * and sequence, so only its terminal position is enforced.
 */
export async function* parseExecStream(
  source: ByteSource,
  options: ParseExecStreamOptions = {},
): AsyncGenerator<ExecEvent> {
  const operationId = options.operationId ?? "execCommand";
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const fail = (reason: BrokerStreamErrorReason, message: string, issues?: unknown): never => {
    throw new BrokerStreamError(operationId, reason, message, issues);
  };

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let executionId: string | null = null;
  let expectedSeq = 1;
  let terminated = false;

  function parseLine(line: string): ExecEvent | null {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim().length === 0) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return fail("malformed_json", "Exec stream contained a line that is not valid JSON.");
    }

    const parsed = ExecEvent.safeParse(raw);
    if (!parsed.success) {
      return fail(
        "invalid_frame",
        "Exec stream contained a frame that does not match the v1 contract.",
        parsed.error.issues,
      );
    }
    const event = parsed.data;

    if (terminated) {
      return fail(
        "after_terminal",
        `Exec stream continued with a ${event.type} frame after its terminal frame.`,
      );
    }

    if (event.type === "error") {
      terminated = true;
      return event;
    }

    if (executionId === null) executionId = event.executionId;
    else if (event.executionId !== executionId) {
      return fail(
        "execution_id",
        "Exec stream mixed frames from more than one execution.",
      );
    }

    if (event.seq !== expectedSeq) {
      return fail(
        "sequence",
        `Exec stream frame ${event.seq} arrived where ${expectedSeq} was expected; output was dropped or reordered.`,
      );
    }
    expectedSeq += 1;
    if (event.type === "result") terminated = true;
    return event;
  }

  for await (const chunk of readChunks(source, options.signal)) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = parseLine(line);
      if (event) yield event;
      newline = buffer.indexOf("\n");
    }

    if (buffer.length > maxLineBytes) {
      fail("line_too_long", `Exec stream line exceeded ${maxLineBytes} bytes without a newline.`);
    }
  }

  buffer += decoder.decode();
  // A well-behaved server terminates the last line, but a truncated final
  // newline must not silently drop the result frame.
  const trailing = parseLine(buffer);
  if (trailing) yield trailing;

  if (!terminated) {
    fail(
      "missing_terminal",
      "Exec stream ended without a terminal result or error frame; the execution outcome is unknown.",
    );
  }
}
