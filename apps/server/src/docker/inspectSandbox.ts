import { WORKSPACE_ROOT, type Sandbox, type SandboxState } from "@sandbox-broker/contracts";
import type Docker from "dockerode";

import { parseSandboxLabels } from "./labels.js";

export type ContainerInspect = Docker.ContainerInspectInfo;

export type SandboxView = {
  sandbox: Sandbox;
  containerId: string;
  containerName: string;
  running: boolean;
};

export type MapOptions = {
  /**
   * Whether the network policy has been applied and verified for the *current*
   * network namespace. A running container without a verified policy is
   * reported as `starting`, and the service refuses exec until it flips.
   */
  policyReady: boolean;
  ownerRef: string;
  message?: string;
};

/**
 * Translates Docker's container status into the broker's normalized state. Any
 * status the broker does not model maps to `error` rather than being guessed
 * into something reassuring.
 */
export function normalizeState(status: string, policyReady: boolean): SandboxState {
  switch (status) {
    case "running":
      return policyReady ? "started" : "starting";
    case "created":
    case "exited":
      return "stopped";
    case "restarting":
    case "paused":
      return "starting";
    case "removing":
      return "deleted";
    case "dead":
      return "error";
    default:
      return "error";
  }
}

/**
 * Builds the API representation of a sandbox. Container ids, host paths and
 * image references are deliberately not part of the response.
 */
export function toSandbox(inspect: ContainerInspect, options: MapOptions): SandboxView | null {
  const labels = parseSandboxLabels(inspect.Config?.Labels ?? {});
  if (!labels) return null;

  const state = normalizeState(inspect.State?.Status ?? "unknown", options.policyReady);
  const sandbox: Sandbox = {
    id: labels.id,
    ownerRef: options.ownerRef,
    networkMode: labels.networkMode,
    limits: labels.limits,
    state,
    createdAt: labels.createdAt || new Date(inspect.Created).toISOString(),
    updatedAt: new Date().toISOString(),
    workspacePath: WORKSPACE_ROOT,
    ...(options.message ? { message: options.message } : {}),
  };

  return {
    sandbox,
    containerId: inspect.Id,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    running: inspect.State?.Running === true,
  };
}
