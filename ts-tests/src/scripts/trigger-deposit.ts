/**
 * Trigger a deposit request against a running VaultOrchestrator.
 *
 * Usage:
 *   npm run deposit -- <operator> <depositor> <orchestratorCid> <userId>
 *
 * Example:
 *   npm run deposit -- Operator::1220abc... Depositor::1220def... 00xyz... mpc-observer
 */

import { exerciseChoice } from "../infra/canton-client.js";
import { VaultOrchestrator } from "../../generated/model/canton-mpc-poc-0.2.0/lib/Erc20Vault/module.js";

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

const damlEvmParams = {
  erc20Address: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  recipient: "d8da6bf26964af9d7eed9e03e53415d37aa96045",
  amount:
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  nonce:
    "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit:
    "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas:
    "0000000000000000000000000000000000000000000000000000000ba43b7400",
  maxPriorityFee:
    "0000000000000000000000000000000000000000000000000000000077359400",
  chainId:
    "0000000000000000000000000000000000000000000000000000000000000001",
  value:
    "0000000000000000000000000000000000000000000000000000000000000000",
  operation: "Erc20Transfer",
};

async function main() {
  const [operator, depositor, orchCid, userId] = process.argv.slice(2);

  if (!operator || !depositor || !orchCid || !userId) {
    console.error(
      "Usage: npm run deposit -- <operator> <depositor> <orchestratorCid> <userId>",
    );
    process.exit(1);
  }

  console.log("Submitting RequestDeposit...");

  const result = await exerciseChoice(
    userId,
    [operator, depositor],
    VAULT_ORCHESTRATOR,
    orchCid,
    "RequestDeposit",
    {
      requester: depositor,
      erc20Address: damlEvmParams.erc20Address,
      amount: "100000000",
      evmParams: damlEvmParams,
    },
  );

  console.log(
    "RequestDeposit submitted. Transaction:",
    result.transaction.updateId,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
