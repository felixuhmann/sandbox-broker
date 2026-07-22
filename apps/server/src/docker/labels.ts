import { createHash } from "node:crypto";

import {
  NetworkMode,
  SandboxLimits,
  type CreateSandboxRequest,
} from "@sandbox-broker/contracts";

import type { BrokerConfig } from "../config.js";

const PREFIX = "sandbox-broker";

/**
 * Label keys the broker stamps onto every resource it creates. Broker state is
 * reconstructible from these after a restart, so they must stay stable — and
 * must never carry a secret, since anyone with Docker read access sees them.
 */
export const LABEL = {
  managedBy: `${PREFIX}.managed-by`,
  namespace: `${PREFIX}.namespace`,
  role: `${PREFIX}.role`,
  sandboxId: `${PREFIX}.sandbox-id`,
  ownerRefHash: `${PREFIX}.owner-ref-hash`,
  idempotencyKeyHash: `${PREFIX}.idempotency-key-hash`,
  networkMode: `${PREFIX}.network-mode`,
  limits: `${PREFIX}.limits`,
  policyVersion: `${PREFIX}.policy-version`,
  brokerVersion: `${PREFIX}.broker-version`,
  createdAt: `${PREFIX}.created-at`,
} as const;

export const MANAGED_BY = "sandbox-broker";

/** Bumped whenever the enforced hardening/network policy changes shape. */
export const POLICY_VERSION = "1";

export type SandboxRole = "sandbox" | "firewall-helper";

export function hashRef(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type SandboxLabelInput = {
  id: string;
  createdAt: string;
  config: BrokerConfig;
  request: CreateSandboxRequest;
};

export function buildSandboxLabels(input: SandboxLabelInput): Record<string, string> {
  const { id, createdAt, config, request } = input;
  return {
    [LABEL.managedBy]: MANAGED_BY,
    [LABEL.namespace]: config.ownerNamespace,
    [LABEL.role]: "sandbox",
    [LABEL.sandboxId]: id,
    // Caller references are hashed: labels are world-readable to anyone with
    // Docker access, and ownerRef can identify a user or conversation.
    [LABEL.ownerRefHash]: hashRef(request.ownerRef),
    [LABEL.idempotencyKeyHash]: hashRef(request.idempotencyKey),
    [LABEL.networkMode]: request.networkMode,
    [LABEL.limits]: JSON.stringify(request.limits),
    [LABEL.policyVersion]: POLICY_VERSION,
    [LABEL.brokerVersion]: config.brokerVersion,
    [LABEL.createdAt]: createdAt,
  };
}

export function buildHelperLabels(
  config: BrokerConfig,
  sandboxId: string,
): Record<string, string> {
  return {
    [LABEL.managedBy]: MANAGED_BY,
    [LABEL.namespace]: config.ownerNamespace,
    [LABEL.role]: "firewall-helper",
    [LABEL.sandboxId]: sandboxId,
    [LABEL.policyVersion]: POLICY_VERSION,
    [LABEL.brokerVersion]: config.brokerVersion,
  };
}

export type ParsedSandboxLabels = {
  id: string;
  namespace: string;
  ownerRefHash: string;
  idempotencyKeyHash: string;
  networkMode: NetworkMode;
  limits: SandboxLimits;
  policyVersion: string;
  brokerVersion: string;
  createdAt: string;
};

type LabelMap = Record<string, string | undefined>;

/**
 * True only for resources created by *this* broker namespace. Everything else
 * on the host — including another broker's containers — is off limits.
 */
export function isBrokerOwned(labels: LabelMap | undefined, namespace: string): boolean {
  if (!labels) return false;
  return labels[LABEL.managedBy] === MANAGED_BY && labels[LABEL.namespace] === namespace;
}

export function labelRole(labels: LabelMap | undefined): SandboxRole | null {
  const role = labels?.[LABEL.role];
  return role === "sandbox" || role === "firewall-helper" ? role : null;
}

/** Returns `null` when the labels do not describe a well-formed sandbox. */
export function parseSandboxLabels(labels: LabelMap | undefined): ParsedSandboxLabels | null {
  if (!labels) return null;
  const id = labels[LABEL.sandboxId];
  const networkMode = NetworkMode.safeParse(labels[LABEL.networkMode]);
  if (!id || !networkMode.success) return null;

  let limits: SandboxLimits;
  try {
    limits = SandboxLimits.parse(JSON.parse(labels[LABEL.limits] ?? ""));
  } catch {
    return null;
  }

  return {
    id,
    namespace: labels[LABEL.namespace] ?? "",
    ownerRefHash: labels[LABEL.ownerRefHash] ?? "",
    idempotencyKeyHash: labels[LABEL.idempotencyKeyHash] ?? "",
    networkMode: networkMode.data,
    limits,
    policyVersion: labels[LABEL.policyVersion] ?? "",
    brokerVersion: labels[LABEL.brokerVersion] ?? "",
    createdAt: labels[LABEL.createdAt] ?? "",
  };
}

/** Docker `filters` value selecting exactly this broker's resources. */
export function ownershipFilters(namespace: string, role?: SandboxRole): { label: string[] } {
  const label = [`${LABEL.managedBy}=${MANAGED_BY}`, `${LABEL.namespace}=${namespace}`];
  if (role) label.push(`${LABEL.role}=${role}`);
  return { label };
}
