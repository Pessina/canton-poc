import {
  getActiveContracts,
  exerciseChoice,
  type CreatedEvent,
} from "../infra/canton-client.js";

export async function handleEvmTxOutcomeSignature(params: {
  orchCid: string;
  userId: string;
  actAs: string[];
  issuerParty: string;
  event: CreatedEvent;
}): Promise<void> {
  const { orchCid, userId, actAs, issuerParty, event } = params;
  const args = event.createArgument as Record<string, unknown>;
  const requestId = args.requestId as string;
  const outcomeCid = event.contractId;

  console.log(
    `[Relayer] EvmTxOutcomeSignature created for requestId=${requestId}`,
  );

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

  const pendingCid = matching.contractId;
  const pendingArgs = matching.createArgument as Record<string, unknown>;
  const evmParams = pendingArgs.evmParams as Record<string, unknown>;
  const evmParamsArgs = evmParams.args as string[];
  const amount = BigInt("0x" + evmParamsArgs[1]!).toString();

  await exerciseChoice(
    userId,
    actAs,
    "Erc20Vault:VaultOrchestrator",
    orchCid,
    "ClaimEvmDeposit",
    { pendingCid, outcomeCid, amount },
  );

  console.log(
    `[Relayer] ClaimEvmDeposit exercised for requestId=${requestId}, amount=${amount}`,
  );
}
