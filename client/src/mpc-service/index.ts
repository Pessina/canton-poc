import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../config/env.js";
import { CantonClient } from "../infra/canton-client.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { MpcServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const USER_ID = "mpc-service";

async function main() {
  const config = loadEnv();
  const canton = new CantonClient(config.CANTON_JSON_API_URL);
  console.log("[MPC] Starting MPC service");

  await canton.uploadDar(DAR_PATH);
  console.log("[MPC] DAR uploaded");

  const issuer = await canton.allocateParty("Issuer");
  console.log(`[MPC] Issuer party: ${issuer}`);

  await canton.createUser(USER_ID, issuer);
  console.log("[MPC] User created");

  const contracts = await canton.getActiveContracts([issuer], VAULT_ORCHESTRATOR);
  if (contracts.length === 0) {
    throw new Error("[MPC] No VaultOrchestrator contract found");
  }
  const orchCid = contracts[0]!.contractId;
  console.log(`[MPC] VaultOrchestrator CID: ${orchCid}`);

  const server = new MpcServer({
    canton,
    orchCid,
    userId: USER_ID,
    parties: [issuer],
    rootPrivateKey: config.MPC_ROOT_PRIVATE_KEY,
    rpcUrl: config.SEPOLIA_RPC_URL,
  });

  await server.start();
  await server.waitUntilReady();

  const shutdown = () => {
    server.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[MPC] Fatal:", err);
  process.exit(1);
});
