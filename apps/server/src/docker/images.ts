import type { BrokerConfig } from "../config.js";
import type { DockerClient } from "./client.js";

export type ImageStatus = {
  reference: string;
  present: boolean;
  /** Content-addressable digest, so a deployment can record what actually ran. */
  id?: string;
};

/**
 * The broker only ever uses these two images and never pulls anything a caller
 * named. Absence is a readiness failure, not something to paper over at
 * sandbox-creation time.
 */
export function requiredImages(config: BrokerConfig): string[] {
  return [config.sandboxImage, config.firewallImage];
}

export async function inspectImage(
  docker: DockerClient,
  reference: string,
): Promise<ImageStatus> {
  try {
    const info = await docker.getImage(reference).inspect();
    return { reference, present: true, id: info.Id };
  } catch {
    return { reference, present: false };
  }
}

export async function checkRequiredImages(
  docker: DockerClient,
  config: BrokerConfig,
): Promise<ImageStatus[]> {
  return Promise.all(requiredImages(config).map((reference) => inspectImage(docker, reference)));
}
