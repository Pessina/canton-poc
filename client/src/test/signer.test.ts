import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utils } from "signet.js";
import { keccak256, toBytes, type Hex } from "viem";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "../mpc-service/signer.js";

const { deriveChildPublicKey } = utils.cryptography;

const MPC_ROOT_PRIVATE_KEY =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const MPC_ROOT_PUBLIC_KEY =
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

const PREDECESSOR_ID = "Issuer::1220abcdef";
const PATH = "m/44/60/0/0";
const CAIP2_ID = "eip155:11155111";

describe("deriveChildPrivateKey", () => {
  it("produces valid 32-byte hex", () => {
    const childKey = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH, CAIP2_ID);
    expect(childKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH, CAIP2_ID);
    const b = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH, CAIP2_ID);
    expect(a).toBe(b);
  });

  it("matches deriveChildPublicKey", () => {
    // signet.js v0.3.1-beta.4 only supports "eip155:1" — use it for interop test
    const signetCaip2 = "eip155:1";
    const childPrivKey = deriveChildPrivateKey(
      MPC_ROOT_PRIVATE_KEY,
      PREDECESSOR_ID,
      PATH,
      signetCaip2,
    );

    const privKeyBytes = toBytes(childPrivKey);
    const childPubFromPriv = Buffer.from(
      secp256k1.getPublicKey(privKeyBytes, false),
    ).toString("hex");

    const childPubFromSignet = deriveChildPublicKey(
      MPC_ROOT_PUBLIC_KEY as `04${string}`,
      PREDECESSOR_ID,
      PATH,
      signetCaip2,
      1,
    );

    expect(childPubFromPriv).toBe(childPubFromSignet);
  });
});

describe("signEvmTxHash", () => {
  const sampleTxHash = keccak256("0xdeadbeef");

  it("produces { r, s, v }", () => {
    const childKey = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH, CAIP2_ID);
    const sig = signEvmTxHash(childKey, sampleTxHash);

    expect(sig.r).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.s).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.v === 0 || sig.v === 1).toBe(true);
  });

  it("recovery bit is correct", () => {
    const childKey = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH, CAIP2_ID);
    const sig = signEvmTxHash(childKey, sampleTxHash);

    const msgHash = toBytes(sampleTxHash);
    const rBigInt = BigInt("0x" + sig.r);
    const sBigInt = BigInt("0x" + sig.s);
    const signature = new secp256k1.Signature(rBigInt, sBigInt, sig.v);
    const recoveredPoint = signature.recoverPublicKey(msgHash);
    const recoveredHex = Buffer.from(recoveredPoint.toBytes(false)).toString("hex");

    const childPubKey = Buffer.from(
      secp256k1.getPublicKey(toBytes(childKey), false),
    ).toString("hex");

    expect(recoveredHex).toBe(childPubKey);
  });
});

describe("signMpcResponse", () => {
  it("produces DER-encoded hex", () => {
    const requestId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const mpcOutput = "01";
    const der = signMpcResponse(MPC_ROOT_PRIVATE_KEY, requestId, mpcOutput);

    expect(der.startsWith("30")).toBe(true);
    expect(der.length).toBeGreaterThan(0);
    expect(der).toMatch(/^[0-9a-f]+$/);
  });
});
