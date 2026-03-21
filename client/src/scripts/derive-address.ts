import { deriveDepositAddress, KEY_VERSION } from "../mpc/address-derivation.js";

const rootPubKey =
  process.env.MPC_ROOT_PUBLIC_KEY ??
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const predecessorId = process.argv[2];
if (!predecessorId) {
  console.error("Usage: derive-address <vaultId+issuer> [path] [keyVersion]");
  process.exit(1);
}
const path = process.argv[3] ?? "m/44/60/0/0";
const keyVersion = Number(process.argv[4] ?? KEY_VERSION);

const address = deriveDepositAddress(rootPubKey, predecessorId, path, keyVersion);
console.log(`Deposit address: ${address}`);
console.log(`  rootPubKey:    ${rootPubKey.slice(0, 20)}...`);
console.log(`  predecessorId: ${predecessorId}`);
console.log(`  path:          ${path}`);
console.log(`  keyVersion:    ${keyVersion}`);
