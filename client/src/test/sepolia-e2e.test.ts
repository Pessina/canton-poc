import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  tryLoadEnv,
  setupVault,
  executeDepositFlow,
  ERC20_HOLDING,
  type VaultSetup,
  type Erc20Holding,
} from "./helpers/e2e-setup.js";

const env = tryLoadEnv();
const describeIf = env ? describe : describe.skip;

describeIf("sepolia e2e deposit lifecycle", () => {
  let setup: VaultSetup;

  beforeAll(async () => {
    setup = await setupVault(env!, "sepolia-e2e", "");
  }, 60_000);

  afterAll(() => {
    setup.mpcServer.shutdown();
  });

  it("completes full deposit flow through Sepolia", async () => {
    const result = await executeDepositFlow(env!, setup);

    expect(result.mpcOutput).toBe("01");
    expect(result.holdingArgs.owner).toBe(setup.requester);
    expect(result.holdingArgs.issuer).toBe(setup.issuer);
    expect(result.holdingArgs.amount).toBe(result.amountPadded);

    const activeHoldings = await setup.canton.getActiveContracts(
      [setup.issuer, setup.requester],
      ERC20_HOLDING,
    );
    expect(
      activeHoldings.some((c) => (c.createArgument as Erc20Holding).owner === setup.requester),
    ).toBe(true);

    console.log("[e2e] All assertions passed");
  }, 300_000);
});
