import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAddress, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { findCreated } from "../infra/canton-helpers.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import { computeRequestId } from "../mpc/crypto.js";
import { reconstructSignedTx, submitRawTransaction } from "../evm/tx-builder.js";
import { deriveChildPrivateKey } from "../mpc-service/signer.js";
import {
  tryLoadEnv,
  setupVault,
  executeDepositFlow,
  pollForContract,
  VAULT_ORCHESTRATOR,
  ECDSA_SIGNATURE,
  OUTCOME_SIGNATURE,
  ERC20_HOLDING,
  SEPOLIA_CHAIN_ID,
  GAS_LIMIT,
  KEY_VERSION,
  ALGO,
  DEST,
  type VaultSetup,
  type PendingEvmTx,
  type EcdsaSignature,
  type EvmTxOutcomeSignature,
  type Erc20Holding,
} from "./helpers/e2e-setup.js";
import {
  DEPOSIT_AMOUNT,
  fetchNonce,
  fetchGasParams,
  checkErc20Balance,
  toCantonHex,
  fundFromFaucet,
} from "./helpers/sepolia-helpers.js";

const env = tryLoadEnv();
const describeIf = env ? describe : describe.skip;

describeIf("sepolia e2e withdrawal lifecycle", () => {
  let setup: VaultSetup;
  let holdingCid: string;

  beforeAll(async () => {
    setup = await setupVault(env!, "sepolia-withdrawal-e2e", "Wdl");

    // Fund vault address with ERC20 (needed for the withdrawal tx)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      setup.vaultAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    const deposit = await executeDepositFlow(env!, setup, "[wdl-e2e]");
    holdingCid = deposit.holdingCid;
  }, 600_000);

  afterAll(() => {
    setup.mpcServer.shutdown();
  });

  it("completes full withdrawal flow through Sepolia", async () => {
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);

    // Recipient is the faucet address (send tokens back)
    const recipientAddress = privateKeyToAddress(env!.FAUCET_PRIVATE_KEY).slice(2).toLowerCase();
    const recipientPadded = recipientAddress.padStart(64, "0");

    // Fetch vault nonce and gas
    const vaultNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, setup.vaultAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);

    const evmParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(vaultNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    // Check recipient balance before withdrawal
    const balanceBefore = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance before: ${balanceBefore}`);

    // ── Request withdrawal ──
    console.log("[wdl-e2e] User → Canton: RequestEvmWithdrawal");
    const wdlResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_ORCHESTRATOR,
      setup.orchCid,
      "RequestEvmWithdrawal",
      {
        requester: setup.requester,
        evmParams,
        recipientAddress: recipientPadded,
        balanceCidText: holdingCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        balanceCid: holdingCid,
      },
      undefined,
      [setup.orchDisclosure],
    );

    const pendingWdl = findCreated(wdlResult.transaction.events, "PendingEvmTx");
    const pendingWdlCid = pendingWdl.contractId;
    const { requestId, path: pendingPath } = pendingWdl.createArgument as PendingEvmTx;
    expect(pendingPath).toBe("root");

    const caip2Id = chainIdHexToCaip2(evmParams.chainId);
    const tsRequestId = computeRequestId(
      setup.requester,
      evmParams,
      caip2Id,
      KEY_VERSION,
      "root",
      ALGO,
      DEST,
      holdingCid,
    );
    expect(tsRequestId.slice(2)).toBe(requestId);
    console.log(`[wdl-e2e] PendingEvmTx created (requestId=${requestId})`);

    // ── MPC signs withdrawal tx on Canton ──
    const ecdsaSig = await pollForContract(
      [setup.issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature (withdrawal)",
    );
    const ecdsaCid = ecdsaSig.contractId;
    const ecdsaArgs = ecdsaSig.createArgument as EcdsaSignature;
    console.log("[wdl-e2e] EcdsaSignature observed");

    // ── User submits signed withdrawal tx to Sepolia ──
    const signedTx = reconstructSignedTx(evmParams, {
      r: `0x${ecdsaArgs.r}`,
      s: `0x${ecdsaArgs.s}`,
      v: Number(ecdsaArgs.v),
    });
    const txHash = await submitRawTransaction(env!.SEPOLIA_RPC_URL, signedTx);
    console.log(`[wdl-e2e] User submitted signed withdrawal tx: ${txHash}`);

    // ── MPC verifies Sepolia receipt and posts outcome signature ──
    const outcome = await pollForContract(
      [setup.issuer],
      OUTCOME_SIGNATURE,
      (args) => args.requestId === requestId,
      "EvmTxOutcomeSignature (withdrawal)",
    );
    const outcomeCid = outcome.contractId;
    const outcomeArgs = outcome.createArgument as EvmTxOutcomeSignature;
    expect(outcomeArgs.mpcOutput).toBe("01");
    console.log("[wdl-e2e] EvmTxOutcomeSignature observed");

    // ── User completes withdrawal on Canton ──
    await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_ORCHESTRATOR,
      setup.orchCid,
      "CompleteEvmWithdrawal",
      {
        requester: setup.requester,
        pendingCid: pendingWdlCid,
        outcomeCid,
        ecdsaCid,
      },
      undefined,
      [setup.orchDisclosure],
    );

    // CompleteEvmWithdrawal succeeded (no throw).
    // On success (mpcOutput=="01"): returns None — no refund Erc20Holding created.
    const holdings = await setup.canton.getActiveContracts(
      [setup.issuer, setup.requester],
      ERC20_HOLDING,
    );
    const refund = holdings.find(
      (c) => (c.createArgument as Erc20Holding).owner === setup.requester,
    );
    expect(refund).toBeUndefined();

    // Verify recipient balance increased on Sepolia
    const balanceAfter = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance after: ${balanceAfter}`);
    expect(balanceAfter).toBe(balanceBefore + DEPOSIT_AMOUNT);

    console.log("[wdl-e2e] All withdrawal assertions passed");
  }, 300_000);

  it("refunds Erc20Holding when withdrawal tx is replaced", async () => {
    // Run a fresh deposit to get a new holding
    const deposit = await executeDepositFlow(env!, setup, "[wdl-nonce]");
    const errorHoldingCid = deposit.holdingCid;

    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
    const recipientAddress = privateKeyToAddress(env!.FAUCET_PRIVATE_KEY).slice(2).toLowerCase();
    const recipientPadded = recipientAddress.padStart(64, "0");

    // Ensure vault has ETH for the replacement tx (may have been spent on prior withdrawal gas)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      setup.vaultAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    const vaultNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, setup.vaultAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);

    const evmParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(vaultNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    const balanceBefore = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );

    // ── Request withdrawal ──
    console.log("[wdl-nonce] User → Canton: RequestEvmWithdrawal");
    const wdlResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_ORCHESTRATOR,
      setup.orchCid,
      "RequestEvmWithdrawal",
      {
        requester: setup.requester,
        evmParams,
        recipientAddress: recipientPadded,
        balanceCidText: errorHoldingCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        balanceCid: errorHoldingCid,
      },
      undefined,
      [setup.orchDisclosure],
    );

    const pendingWdl = findCreated(wdlResult.transaction.events, "PendingEvmTx");
    const pendingWdlCid = pendingWdl.contractId;
    const { requestId } = pendingWdl.createArgument as PendingEvmTx;
    console.log(`[wdl-nonce] PendingEvmTx created (requestId=${requestId})`);

    // ── Wait for MPC to sign ──
    const ecdsaSig = await pollForContract(
      [setup.issuer],
      ECDSA_SIGNATURE,
      (args) => args.requestId === requestId,
      "EcdsaSignature (nonce-replace)",
    );
    const ecdsaCid = ecdsaSig.contractId;
    console.log("[wdl-nonce] EcdsaSignature observed");

    // ── Submit replacement tx from vault (consumes the nonce, not the withdrawal) ──
    const vaultChildKey = deriveChildPrivateKey(
      env!.MPC_ROOT_PRIVATE_KEY,
      `${env!.VAULT_ID}${setup.issuer}`,
      "root",
    );
    const vaultAccount = privateKeyToAccount(vaultChildKey);
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(env!.SEPOLIA_RPC_URL),
    });
    const walletClient = createWalletClient({
      account: vaultAccount,
      chain: sepolia,
      transport: http(env!.SEPOLIA_RPC_URL),
    });

    console.log("[wdl-nonce] Submitting replacement tx (0 ETH self-transfer)");
    const replacementHash = await walletClient.sendTransaction({
      to: vaultAccount.address,
      value: 0n,
      nonce: vaultNonce,
    });
    await publicClient.waitForTransactionReceipt({ hash: replacementHash });
    console.log(`[wdl-nonce] Replacement tx mined: ${replacementHash}`);

    // ── MPC detects nonce consumed without receipt → mpcOutput="00" ──
    const outcome = await pollForContract(
      [setup.issuer],
      OUTCOME_SIGNATURE,
      (args) => args.requestId === requestId,
      "EvmTxOutcomeSignature (nonce-replace)",
    );
    const outcomeCid = outcome.contractId;
    const outcomeArgs = outcome.createArgument as EvmTxOutcomeSignature;
    expect(outcomeArgs.mpcOutput).toBe("00");
    console.log("[wdl-nonce] EvmTxOutcomeSignature observed (mpcOutput=00)");

    // ── Complete withdrawal → refund ──
    const completeResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_ORCHESTRATOR,
      setup.orchCid,
      "CompleteEvmWithdrawal",
      {
        requester: setup.requester,
        pendingCid: pendingWdlCid,
        outcomeCid,
        ecdsaCid,
      },
      undefined,
      [setup.orchDisclosure],
    );

    // Refund Erc20Holding should be created (mpcOutput != "01")
    const refundHolding = findCreated(completeResult.transaction.events, "Erc20Holding");
    const refundArgs = refundHolding.createArgument as Erc20Holding;
    expect(refundArgs.owner).toBe(setup.requester);
    expect(refundArgs.issuer).toBe(setup.issuer);
    expect(refundArgs.amount).toBe(amountPadded);

    // Recipient balance unchanged (withdrawal never executed)
    const balanceAfter = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    expect(balanceAfter).toBe(balanceBefore);

    console.log("[wdl-nonce] All nonce-replacement assertions passed");
  }, 300_000);
});
