import { describe, expect, it } from "vitest";

import { BrokerStreamError } from "./errors.js";
import { parseExecStream, type ParseExecStreamOptions } from "./stream.js";

const EXECUTION_ID = "11111111-2222-3333-4444-555555555555";

function stdout(seq: number, text: string, executionId = EXECUTION_ID) {
  return {
    type: "stdout",
    executionId,
    seq,
    dataBase64: Buffer.from(text, "utf8").toString("base64"),
  };
}

function result(seq: number, executionId = EXECUTION_ID) {
  return {
    type: "result",
    executionId,
    seq,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 12,
  };
}

function ndjson(frames: unknown[], options: { trailingNewline?: boolean } = {}): string {
  const body = frames.map((frame) => JSON.stringify(frame)).join("\n");
  return options.trailingNewline === false ? body : `${body}\n`;
}

/** Emits `text` in fixed-size byte slices to simulate arbitrary TCP boundaries. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function collect(
  source: ReadableStream<Uint8Array>,
  options?: ParseExecStreamOptions,
) {
  const events = [];
  for await (const event of parseExecStream(source, options)) {
    events.push(event);
  }
  return events;
}

async function expectStreamError(
  source: ReadableStream<Uint8Array>,
  reason: BrokerStreamError["reason"],
  options?: ParseExecStreamOptions,
): Promise<BrokerStreamError> {
  try {
    await collect(source, options);
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerStreamError);
    expect((error as BrokerStreamError).reason).toBe(reason);
    return error as BrokerStreamError;
  }
  throw new Error(`expected a ${reason} stream error`);
}

describe("parseExecStream framing", () => {
  it("reassembles frames split across arbitrary chunk boundaries", async () => {
    const text = ndjson([stdout(1, "hello "), stdout(2, "world"), result(3)]);

    for (const size of [1, 3, 17, 4096]) {
      const events = await collect(chunked(text, size));
      expect(events.map((event) => event.type)).toEqual(["stdout", "stdout", "result"]);
      expect(events[0]).toMatchObject({ seq: 1, executionId: EXECUTION_ID });
    }
  });

  it("keeps multi-byte UTF-8 intact when a code point spans two chunks", async () => {
    const payload = "héllo → 🌍";
    const events = await collect(chunked(ndjson([stdout(1, payload), result(2)]), 2));

    const frame = events[0];
    if (frame?.type !== "stdout") throw new Error("expected a stdout frame");
    expect(Buffer.from(frame.dataBase64, "base64").toString("utf8")).toBe(payload);
  });

  it("accepts a final frame that is not newline-terminated", async () => {
    const text = ndjson([stdout(1, "x"), result(2)], { trailingNewline: false });
    const events = await collect(chunked(text, 5));
    expect(events).toHaveLength(2);
  });

  it("tolerates blank lines and CRLF separators", async () => {
    const text = `${JSON.stringify(stdout(1, "x"))}\r\n\r\n${JSON.stringify(result(2))}\r\n`;
    const events = await collect(chunked(text, 7));
    expect(events.map((event) => event.type)).toEqual(["stdout", "result"]);
  });
});

describe("parseExecStream validation", () => {
  it("rejects malformed JSON instead of skipping the line", async () => {
    const text = `${JSON.stringify(stdout(1, "x"))}\n{"type":"stdout"\n`;
    const error = await expectStreamError(chunked(text, 9), "malformed_json");
    expect(error.message).toContain("not valid JSON");
  });

  it("rejects frames that do not match the contract", async () => {
    const text = ndjson([
      stdout(1, "x"),
      { type: "stdout", executionId: EXECUTION_ID, seq: 2, data: "not-base64-field" },
    ]);
    await expectStreamError(chunked(text, 13), "invalid_frame");
  });

  it("rejects unknown frame types", async () => {
    const text = ndjson([{ type: "progress", executionId: EXECUTION_ID, seq: 1 }]);
    await expectStreamError(chunked(text, 8), "invalid_frame");
  });

  it("requires the first sequence number to be 1", async () => {
    await expectStreamError(chunked(ndjson([stdout(2, "x"), result(3)]), 16), "sequence");
  });

  it("rejects a gap in the sequence", async () => {
    await expectStreamError(chunked(ndjson([stdout(1, "x"), result(3)]), 16), "sequence");
  });

  it("rejects out-of-order frames", async () => {
    const text = ndjson([stdout(1, "a"), stdout(3, "c"), stdout(2, "b"), result(4)]);
    await expectStreamError(chunked(text, 16), "sequence");
  });

  it("rejects frames belonging to a different execution", async () => {
    const text = ndjson([stdout(1, "a"), stdout(2, "b", "99999999-9999-4999-8999-999999999999")]);
    await expectStreamError(chunked(text, 16), "execution_id");
  });
});

describe("parseExecStream terminal frames", () => {
  it("rejects a stream that ends without a terminal frame", async () => {
    await expectStreamError(chunked(ndjson([stdout(1, "x")]), 16), "missing_terminal");
  });

  it("rejects an empty stream", async () => {
    await expectStreamError(chunked("", 16), "missing_terminal");
  });

  it("rejects any frame after the terminal result", async () => {
    const text = ndjson([stdout(1, "x"), result(2), stdout(3, "late")]);
    await expectStreamError(chunked(text, 16), "after_terminal");
  });

  it("rejects a second terminal frame", async () => {
    const text = ndjson([result(1), result(2)]);
    await expectStreamError(chunked(text, 16), "after_terminal");
  });

  it("treats an error frame as terminal and yields it", async () => {
    const text = ndjson([
      stdout(1, "x"),
      { type: "error", executionId: "unknown", seq: 1, code: "internal", message: "boom" },
    ]);

    const events = await collect(chunked(text, 11));

    // The server emits its synthetic failure frame after the status line is
    // already sent, with its own executionId/seq. It must not be rejected.
    expect(events.at(-1)).toMatchObject({ type: "error", code: "internal" });
  });
});

describe("parseExecStream limits and cancellation", () => {
  it("fails instead of buffering an unbounded line", async () => {
    const huge = `{"type":"stdout","dataBase64":"${"A".repeat(5_000)}"`;
    await expectStreamError(chunked(huge, 512), "line_too_long", { maxLineBytes: 1_024 });
  });

  it("throws an AbortError and cancels the source when the signal fires", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(`${JSON.stringify(stdout(1, "x"))}\n`));
      },
      pull() {
        // Never resolves on its own: only the abort can end this stream.
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    const iterator = parseExecStream(source, { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("throws immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = chunked(ndjson([result(1)]), 16);

    await expect(collect(source, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
