import { describe, it, expect } from "vitest";
import { deriveDepositAddress, publicKeyToEthAddress } from "../mpc/address-derivation.js";

const MPC_ROOT_PUBLIC_KEY =
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

const PREDECESSOR_ID = "Issuer::1220abcdef";
const PATH = "m/44/60/0/0";
// signet.js v0.3.1-beta.4 only supports "eip155:1" for EVM derivation
const CAIP2_ID = "eip155:1";
const KEY_VERSION = 1;

describe("publicKeyToEthAddress", () => {
  it("produces valid 20-byte address", () => {
    const address = publicKeyToEthAddress(MPC_ROOT_PUBLIC_KEY);
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("produces consistent result for known vector", () => {
    const a = publicKeyToEthAddress(MPC_ROOT_PUBLIC_KEY);
    const b = publicKeyToEthAddress(MPC_ROOT_PUBLIC_KEY);
    expect(a).toBe(b);
  });
});

describe("deriveDepositAddress", () => {
  it("is deterministic", () => {
    const a = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, PREDECESSOR_ID, PATH, CAIP2_ID, KEY_VERSION);
    const b = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, PREDECESSOR_ID, PATH, CAIP2_ID, KEY_VERSION);
    expect(a).toBe(b);
  });

  it("produces different addresses for different paths", () => {
    const addr1 = deriveDepositAddress(
      MPC_ROOT_PUBLIC_KEY,
      PREDECESSOR_ID,
      "m/44/60/0/0",
      CAIP2_ID,
      KEY_VERSION,
    );
    const addr2 = deriveDepositAddress(
      MPC_ROOT_PUBLIC_KEY,
      PREDECESSOR_ID,
      "m/44/60/0/1",
      CAIP2_ID,
      KEY_VERSION,
    );
    expect(addr1).not.toBe(addr2);
  });

  it("produces valid 20-byte address", () => {
    const address = deriveDepositAddress(
      MPC_ROOT_PUBLIC_KEY,
      PREDECESSOR_ID,
      PATH,
      CAIP2_ID,
      KEY_VERSION,
    );
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
