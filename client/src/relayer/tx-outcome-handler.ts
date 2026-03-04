import { getActiveContracts, exerciseChoice, type CreatedEvent } from "../infra/canton-client.js";
import {
  EcdsaSignature,
  PendingEvmDeposit,
  VaultOrchestrator,
} from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";

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

  console.log(`[Relayer] EvmTxOutcomeSignature created for requestId=${requestId}`);

  const [pendingContracts, ecdsaContracts] = await Promise.all([
    getActiveContracts([issuerParty], PendingEvmDeposit.templateId),
    getActiveContracts([issuerParty], EcdsaSignature.templateId),
  ]);

  const matchingPending = pendingContracts.find((c) => {
    const cArgs = c.createArgument as Record<string, unknown>;
    return cArgs.requestId === requestId;
  });
  if (!matchingPending) {
    console.log(`[Relayer] No PendingEvmDeposit found for requestId=${requestId}, skipping`);
    return;
  }

  const matchingEcdsa = ecdsaContracts.find((c) => {
    const cArgs = c.createArgument as Record<string, unknown>;
    return cArgs.requestId === requestId;
  });
  if (!matchingEcdsa) {
    console.log(`[Relayer] No EcdsaSignature found for requestId=${requestId}, skipping`);
    return;
  }

  const pendingCid = matchingPending.contractId;
  const ecdsaCid = matchingEcdsa.contractId;

  await exerciseChoice(userId, actAs, VaultOrchestrator.templateId, orchCid, "ClaimEvmDeposit", {
    pendingCid,
    outcomeCid,
    ecdsaCid,
  });

  console.log(`[Relayer] ClaimEvmDeposit exercised for requestId=${requestId}`);
}
