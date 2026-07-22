import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { normalizeWorkspacePath, WORKSPACE_ROOT } from "@sandbox-broker/contracts";
import type { Container } from "dockerode";
import { extract, pack } from "tar-stream";

import { BrokerError } from "../errors.js";
import { SANDBOX_GID, SANDBOX_UID } from "./createSandbox.js";
import { execCapture } from "./execCapture.js";
import { assertWorkspaceQuota } from "./workspaceQuota.js";

export type WorkspaceTarget = { path: string; dir: string; base: string };

/**
 * Validates and splits an API path.
 *
 * This is the single choke point for path handling: nothing reaches Docker
 * unless it normalizes to a location strictly beneath {@link WORKSPACE_ROOT}.
 * The service repeats the contract's check rather than trusting it, so a future
 * caller of this module cannot bypass it.
 */
export function resolveWorkspaceTarget(input: string): WorkspaceTarget {
  const normalized = normalizeWorkspacePath(input);
  if (normalized === null) {
    throw new BrokerError(
      "invalid_request",
      `Path must be an absolute path beneath ${WORKSPACE_ROOT}.`,
    );
  }
  const lastSlash = normalized.lastIndexOf("/");
  return {
    path: normalized,
    dir: lastSlash === 0 ? "/" : normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  };
}

/** Temporary name in the *same* directory, so the final rename is atomic. */
export function tempSiblingName(_base: string): string {
  return `.sandbox-broker-tmp-${randomUUID()}`;
}

/**
 * Streams a workspace file out of the container.
 *
 * `getArchive` returns a tar stream; the single entry is unwrapped so the API
 * can hand back raw bytes.
 */
export async function readWorkspaceFile(
  container: Container,
  requestedPath: string,
): Promise<Readable> {
  const target = resolveWorkspaceTarget(requestedPath);

  let archive: NodeJS.ReadableStream;
  try {
    archive = await container.getArchive({ path: target.path });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) {
      throw new BrokerError("not_found", "No such file in the workspace.");
    }
    throw error;
  }

  const output = new PassThrough();
  const extractor = extract();
  let delivered = false;

  extractor.on("entry", (header, entryStream, next) => {
    if (delivered || header.type !== "file") {
      entryStream.resume();
      entryStream.on("end", next);
      return;
    }
    delivered = true;
    entryStream.pipe(output, { end: false });
    entryStream.on("end", () => {
      output.end();
      next();
    });
  });
  extractor.on("finish", () => {
    if (!delivered) {
      output.destroy(new BrokerError("not_found", "Path is not a regular file."));
    }
  });
  extractor.on("error", (error: Error) => output.destroy(error));

  archive.pipe(extractor);
  return output;
}

/**
 * Writes a workspace file atomically.
 *
 * The bytes land in a temporary sibling first and are then renamed into place,
 * so a reader never observes a half-written file. Nothing about the operation
 * touches a host path: the payload travels through the Docker archive API.
 */
export async function writeWorkspaceFile(
  container: Container,
  requestedPath: string,
  body: Readable,
  options: { limits: { workspaceMiB: number }; maxBytes: number },
): Promise<void> {
  const target = resolveWorkspaceTarget(requestedPath);
  const contents = await readAll(body, options.maxBytes);

  await assertWorkspaceQuota(container, options.limits, contents.length);

  const created = await execCapture(container, ["/bin/sh", "-c", `mkdir -p "${shellQuote(target.dir)}"`]);
  if (created.exitCode !== 0) {
    throw new BrokerError("sandbox_error", `Could not create ${target.dir}.`);
  }

  const tempName = tempSiblingName(target.base);
  const archive = pack();
  archive.entry(
    {
      name: tempName,
      size: contents.length,
      mode: 0o600,
      uid: SANDBOX_UID,
      gid: SANDBOX_GID,
      type: "file",
    },
    contents,
  );
  archive.finalize();

  await container.putArchive(archive, { path: target.dir });

  const renamed = await execCapture(container, [
    "/bin/sh",
    "-c",
    `mv -f "${shellQuote(`${target.dir}/${tempName}`)}" "${shellQuote(target.path)}"`,
  ]);
  if (renamed.exitCode !== 0) {
    await execCapture(container, [
      "/bin/sh",
      "-c",
      `rm -f "${shellQuote(`${target.dir}/${tempName}`)}"`,
    ]).catch(() => undefined);
    throw new BrokerError("sandbox_error", `Could not write ${target.path}.`);
  }
}

export async function deleteWorkspacePath(
  container: Container,
  requestedPath: string,
  recursive: boolean,
): Promise<void> {
  const target = resolveWorkspaceTarget(requestedPath);
  const flag = recursive ? "-rf" : "-f";
  const result = await execCapture(container, [
    "/bin/sh",
    "-c",
    `[ -e "${shellQuote(target.path)}" ] || exit 44; rm ${flag} "${shellQuote(target.path)}"`,
  ]);
  if (result.exitCode === 44) {
    throw new BrokerError("not_found", "No such path in the workspace.");
  }
  if (result.exitCode !== 0) {
    throw new BrokerError(
      "sandbox_error",
      recursive ? `Could not delete ${target.path}.` : `${target.path} is not empty or not a file.`,
    );
  }
}

/**
 * Escapes for a double-quoted shell context. Paths are already validated to be
 * beneath /workspace, so this only has to survive exotic-but-legal filenames.
 */
function shellQuote(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

async function readAll(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) {
      sink.destroy(
        new BrokerError("invalid_request", `Upload exceeds the ${maxBytes} byte limit.`),
      );
      return;
    }
    chunks.push(chunk);
  });

  await pipeline(body, sink);
  return Buffer.concat(chunks);
}
