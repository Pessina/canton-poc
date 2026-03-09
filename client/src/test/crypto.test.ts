import { describe, it, expect } from "vitest";
import { hashTypedData } from "viem";
import {
  computeRequestId,
  computeResponseHash,
  eip712Types,
  eip712Domain,
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
// Cross-language vectors (must match Daml Test.daml)
// ---------------------------------------------------------------------------
const VECTORS = {
  requestIdKv1: "0x767d52078eb4f558d2ad22df5c3daf3045fbaf96c4a18400357adbfdd25a8972",
  requestIdKv256: "0x82becb6d088e399f2d92095d993890eaa548a9ce6338bd102eaf599b6aaed489",
  requestIdKv0: "0x43d221a4edee57c6a6f0c4606fd14b7fb73300be41e6a1ea09db42f6772699f3",
  requestIdEmptyArgs: "0x0892f934734c6280aa92fdf8d8ff9bf7edb918f748c1833cc6fc15e96c0da1ab",
  responseHash01: "0x5773f12bd1f9c7a760461812f7a3fc96a2f5a0f041258dfa8feb43f7f8b3ebe2",
  responseHashEmpty: "0xaf2ff87730133736cd5ad11131445277ced38a0762eaa9e62320a1ffc49de8da",
};

const KNOWN_REQUEST_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("matches cross-language vector (keyVersion=1)", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, 1, PATH, "ECDSA", "ethereum", "");
    expect(hash).toBe(VECTORS.requestIdKv1);
  });

  it("matches cross-language vector (keyVersion=256)", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, 256, PATH, "ECDSA", "ethereum", "");
    expect(hash).toBe(VECTORS.requestIdKv256);
  });

  it("matches cross-language vector (keyVersion=0)", () => {
    const hash = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, 0, PATH, "ECDSA", "ethereum", "");
    expect(hash).toBe(VECTORS.requestIdKv0);
  });

  it("matches cross-language vector (empty args)", () => {
    const emptyArgsParams = { ...sampleEvmParams, args: [] as string[] };
    const hash = computeRequestId(SENDER, emptyArgsParams, CAIP2_ID, 1, PATH, "ECDSA", "ethereum", "");
    expect(hash).toBe(VECTORS.requestIdEmptyArgs);
  });

  it("is deterministic", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "");
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "");
    expect(a).toBe(b);
  });

  it("changes with different authCidText", () => {
    const a = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "auth1");
    const b = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, KEY_VERSION, PATH, "ECDSA", "ethereum", "auth2");
    expect(a).not.toBe(b);
  });

  it("matches viem hashTypedData directly", () => {
    const manual = computeRequestId(SENDER, sampleEvmParams, CAIP2_ID, 1, PATH, "ECDSA", "ethereum", "");
    const viem = hashTypedData({
      domain: eip712Domain,
      types: eip712Types,
      primaryType: "CantonMpcDepositRequest",
      message: {
        sender: SENDER,
        evmParams: {
          to: `0x${sampleEvmParams.to}`,
          functionSignature: sampleEvmParams.functionSignature,
          args: sampleEvmParams.args.map((a): `0x${string}` => `0x${a}`),
          value: BigInt(`0x${sampleEvmParams.value}`),
          nonce: BigInt(`0x${sampleEvmParams.nonce}`),
          gasLimit: BigInt(`0x${sampleEvmParams.gasLimit}`),
          maxFeePerGas: BigInt(`0x${sampleEvmParams.maxFeePerGas}`),
          maxPriorityFee: BigInt(`0x${sampleEvmParams.maxPriorityFee}`),
          chainId: BigInt(`0x${sampleEvmParams.chainId}`),
        },
        caip2Id: CAIP2_ID,
        keyVersion: 1,
        path: PATH,
        algo: "ECDSA",
        dest: "ethereum",
        authCidText: "",
      },
    });
    expect(manual).toBe(viem);
  });
});

// ---------------------------------------------------------------------------
// computeResponseHash
// ---------------------------------------------------------------------------
describe("computeResponseHash", () => {
  it("matches cross-language vector (mpcOutput=01)", () => {
    expect(computeResponseHash(KNOWN_REQUEST_ID, "01")).toBe(VECTORS.responseHash01);
  });

  it("matches cross-language vector (empty mpcOutput)", () => {
    expect(computeResponseHash(KNOWN_REQUEST_ID, "")).toBe(VECTORS.responseHashEmpty);
  });

  it("is deterministic", () => {
    const a = computeResponseHash(KNOWN_REQUEST_ID, "01");
    const b = computeResponseHash(KNOWN_REQUEST_ID, "01");
    expect(a).toBe(b);
  });

  it("changes with different output", () => {
    const a = computeResponseHash(KNOWN_REQUEST_ID, "01");
    const b = computeResponseHash(KNOWN_REQUEST_ID, "00");
    expect(a).not.toBe(b);
  });
});
