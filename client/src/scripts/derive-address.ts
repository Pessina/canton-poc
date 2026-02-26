import { deriveDepositAddress } from "../mpc/address-derivation.js";

const rootPubKey =
  process.env.MPC_ROOT_PUBLIC_KEY ??
  "04bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020decddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4";
const predecessorId = process.argv[2] ?? "Issuer::1220abcdef";
const path = process.argv[3] ?? "m/44/60/0/0";
const caip2Id = process.argv[4] ?? "eip155:11155111";
const keyVersion = Number(process.argv[5] ?? "1");

const address = deriveDepositAddress(rootPubKey, predecessorId, path, caip2Id, keyVersion);
console.log(`Deposit address: ${address}`);
console.log(`  rootPubKey:    ${rootPubKey.slice(0, 20)}...`);
console.log(`  predecessorId: ${predecessorId}`);
console.log(`  path:          ${path}`);
console.log(`  caip2Id:       ${caip2Id}`);
console.log(`  keyVersion:    ${keyVersion}`);
