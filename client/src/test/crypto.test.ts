import { describe, it, expect } from "vitest";
import { computeRequestId, packParams, type EvmTransactionParams } from "../mpc/crypto.js";

const sampleEvmParams: EvmTransactionParams = {
  to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  functionSignature: "transfer(address,uint256)",
  args: [
    "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  ],
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
  maxPriorityFee: "000000000000000000000000000000000000000000000000000000003b9aca00",
  chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
};

const SENDER = "Issuer::1220abcdef";
const CAIP2_ID = "eip155:11155111";
const KEY_VERSION = 1;
const PATH = "m/44/60/0/0";

// ---------------------------------------------------------------------------
// Unit tests: packParams
// ---------------------------------------------------------------------------
describe("packParams", () => {
  it("produces correct byte layout", () => {
    const packed = packParams(sampleEvmParams);

    expect(packed).toContain(sampleEvmParams.to);
    expect(packed).toContain(sampleEvmParams.args.join(""));
    expect(packed).toContain(sampleEvmParams.value);
    expect(packed).toContain(sampleEvmParams.nonce);
    expect(packed).toContain(sampleEvmParams.gasLimit);
    expect(packed).toContain(sampleEvmParams.maxFeePerGas);
    expect(packed).toContain(sampleEvmParams.maxPriorityFee);
    expect(packed).toContain(sampleEvmParams.chainId);

    const fnSigHex = Buffer.from(sampleEvmParams.functionSignature, "utf8").toString("hex");
    expect(packed.startsWith(sampleEvmParams.to + fnSigHex)).toBe(true);
    expect(packed.endsWith(sampleEvmParams.chainId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("is deterministic", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "", "");
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "", "");
    expect(a).toBe(b);
  });

  it("produces 32-byte hash", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "", "");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
