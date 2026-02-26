import {
  reconstructSignedTx,
  submitRawTransaction,
  type CantonEvmParams,
} from "../evm/tx-builder.js";
import { getActiveContracts, type CreatedEvent } from "../infra/canton-client.js";

export async function handleEcdsaSignature(params: {
  issuerParty: string;
  rpcUrl: string;
  event: CreatedEvent;
}): Promise<void> {
  const { issuerParty, rpcUrl, event } = params;
  const args = event.createArgument as Record<string, unknown>;
  const requestId = args.requestId as string;
  const r = args.r as string;
  const s = args.s as string;
  const v = Number(args.v);

  console.log(`[Relayer] EcdsaSignature created for requestId=${requestId}`);

  const contracts = await getActiveContracts(
    [issuerParty],
    "Erc20Vault:PendingEvmDeposit",
  );
  const matching = contracts.find((c) => {
    const cArgs = c.createArgument as Record<string, unknown>;
    return cArgs.requestId === requestId;
  });
  if (!matching) {
    console.log(
      `[Relayer] No PendingEvmDeposit found for requestId=${requestId}, skipping`,
    );
    return;
  }

  const pendingArgs = matching.createArgument as Record<string, unknown>;
  const evmParams = pendingArgs.evmParams as CantonEvmParams;

  const signedTx = reconstructSignedTx(evmParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });

  const txHash = await submitRawTransaction(rpcUrl, signedTx);
  console.log(`[Relayer] Submitted EVM tx: ${txHash}`);
}
