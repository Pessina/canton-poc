import { describe, it, expect } from "vitest";
import {
  computeRequestId,
  computeResponseHash,
  hashEvmParams,
  EVM_PARAMS_TYPE_HASH,
  REQUEST_TYPE_HASH,
  RESPONSE_TYPE_HASH,
  type EvmTransactionParams,
} from "../mpc/crypto.js";

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
// Unit tests: domain tags
// ---------------------------------------------------------------------------
describe("domain tags", () => {
  it("are 32-byte hex strings (64 chars)", () => {
    expect(EVM_PARAMS_TYPE_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(REQUEST_TYPE_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(RESPONSE_TYPE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are all distinct", () => {
    expect(EVM_PARAMS_TYPE_HASH).not.toBe(REQUEST_TYPE_HASH);
    expect(EVM_PARAMS_TYPE_HASH).not.toBe(RESPONSE_TYPE_HASH);
    expect(REQUEST_TYPE_HASH).not.toBe(RESPONSE_TYPE_HASH);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: hashEvmParams
// ---------------------------------------------------------------------------
describe("hashEvmParams", () => {
  it("produces 32-byte hex (64 chars)", () => {
    const hash = hashEvmParams(sampleEvmParams);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashEvmParams(sampleEvmParams);
    const b = hashEvmParams(sampleEvmParams);
    expect(a).toBe(b);
  });

  it("changes when params change", () => {
    const original = hashEvmParams(sampleEvmParams);
    const modified = hashEvmParams({
      ...sampleEvmParams,
      nonce: "0000000000000000000000000000000000000000000000000000000000000002",
    });
    expect(original).not.toBe(modified);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("is deterministic", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "");
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "");
    expect(a).toBe(b);
  });

  it("produces 32-byte hash", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes with different authCidText", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "auth1");
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "auth2");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: computeResponseHash
// ---------------------------------------------------------------------------
describe("computeResponseHash", () => {
  it("produces 32-byte hash", () => {
    const requestId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const hash = computeResponseHash(requestId, "01");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const requestId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const a = computeResponseHash(requestId, "01");
    const b = computeResponseHash(requestId, "01");
    expect(a).toBe(b);
  });

  it("changes with different output", () => {
    const requestId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const a = computeResponseHash(requestId, "01");
    const b = computeResponseHash(requestId, "00");
    expect(a).not.toBe(b);
  });
});
