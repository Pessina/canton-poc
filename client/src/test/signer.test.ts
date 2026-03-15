import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utils } from "signet.js";
import { toBytes, type Hex } from "viem";
import { deriveChildPrivateKey } from "../mpc-service/signer.js";

const { deriveChildPublicKey } = utils.cryptography;

const MPC_ROOT_PRIVATE_KEY =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const MPC_ROOT_PUBLIC_KEY =
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";

const PREDECESSOR_ID = "Issuer::1220abcdef";
const PATH = "m/44/60/0/0";

describe("deriveChildPrivateKey", () => {
  it("matches deriveChildPublicKey", () => {
    const childPrivKey = deriveChildPrivateKey(MPC_ROOT_PRIVATE_KEY, PREDECESSOR_ID, PATH);

    const privKeyBytes = toBytes(childPrivKey);
    const childPubFromPriv = Buffer.from(secp256k1.getPublicKey(privKeyBytes, false)).toString(
      "hex",
    );

    const childPubFromSignet = deriveChildPublicKey(
      MPC_ROOT_PUBLIC_KEY as `04${string}`,
      PREDECESSOR_ID,
      PATH,
      "eip155:1",
      1,
    );

    expect(childPubFromPriv).toBe(childPubFromSignet);
  });
});
