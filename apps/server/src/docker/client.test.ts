import { describe, expect, it } from "vitest";

import { bridgeInterfaceName, hasMandatoryConfinement } from "./client.js";

describe("bridgeInterfaceName", () => {
  it("fits the 15-character Linux interface limit", () => {
    for (const name of ["sandbox-broker-egress", "x", "a".repeat(200)]) {
      expect(bridgeInterfaceName(name).length).toBeLessThanOrEqual(15);
    }
  });

  it("uses only characters valid in an interface name", () => {
    expect(bridgeInterfaceName("sandbox-broker-egress")).toMatch(/^[a-z0-9-]+$/);
  });

  it("is stable for the same network name", () => {
    expect(bridgeInterfaceName("sandbox-broker-egress")).toBe(
      bridgeInterfaceName("sandbox-broker-egress"),
    );
  });

  it("distinguishes names that share a long common prefix", () => {
    // Docker refuses to create a second network with an existing bridge name,
    // and these all collapse to the same characters under naive truncation.
    const names = [
      "sandbox-broker-egress",
      "sandbox-broker-itest-egress",
      "sandbox-broker-smoke-egress",
      "sandbox-broker-egress-2",
    ];
    const bridges = names.map(bridgeInterfaceName);
    expect(new Set(bridges).size).toBe(names.length);
  });
});

describe("hasMandatoryConfinement", () => {
  it("requires seccomp plus a mandatory access control system", () => {
    expect(
      hasMandatoryConfinement({
        serverVersion: "29",
        securityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
      }),
    ).toBe(true);
    expect(
      hasMandatoryConfinement({
        serverVersion: "29",
        securityOptions: ["name=selinux", "name=seccomp,profile=builtin"],
      }),
    ).toBe(true);
  });

  it("is false when either protection is missing", () => {
    expect(
      hasMandatoryConfinement({ serverVersion: "29", securityOptions: ["name=apparmor"] }),
    ).toBe(false);
    expect(
      hasMandatoryConfinement({ serverVersion: "29", securityOptions: ["name=seccomp"] }),
    ).toBe(false);
    expect(hasMandatoryConfinement({ serverVersion: "29", securityOptions: [] })).toBe(false);
  });
});
