const { deployContract, contractAt, sendTxn } = require("../shared/helpers")

// A layer of the legacy hardhat/ethers stack surfaces contract-creation txs with `to: ""`, which
// ethers v5's formatter rejects mid-poll and kills the run (the node itself returns `to: null` -
// verified against the raw JSON-RPC response). Normalize before formatting; the txs themselves
// land fine, this only fixes the client-side confirmation polling.
const { Formatter } = require("@ethersproject/providers")
const _origTransactionResponse = Formatter.prototype.transactionResponse
Formatter.prototype.transactionResponse = function (transaction) {
  if (transaction && transaction.to === "") transaction.to = null
  if (transaction && transaction.creates === "") transaction.creates = null
  return _origTransactionResponse.call(this, transaction)
}
const _origReceipt = Formatter.prototype.receipt
Formatter.prototype.receipt = function (value) {
  if (value && value.to === "") value.to = null
  return _origReceipt.call(this, value)
}

// Deploys the BWLK single-staking stack on Ethereum mainnet (adapted from deployBwsStaking.js):
// bnBWLK + the three trackers/distributors, private modes, RewardRouterV5 and its grants.
//
// Run AFTER the BWLK token deploy (boardwalk-contracts script/bwlk/01) and BEFORE the governance
// deploy (script/bwlk/02, which takes the tracker addresses as env).
//
// The router is deployed but NOT initialized here: RewardRouterV5.initialize takes the
// GovernanceVoter (staking reverts while the voter is finalizing an epoch), which only exists
// after script/bwlk/02. Initialize is one-shot and onlyGov - run it from the deployer before
// handing gov to the staking multisig. This script prints the exact follow-ups.
//
// Run: HARDHAT_NETWORK=mainnet npx hardhat run scripts/staking/deployBwlkStaking.js  (Node 20 via nvm)

async function main() {
  const stakingTokenAddress = "0xF9a352b7C7B62a852e5C8A64A455246Dd9596461"; // BWLK (from boardwalk-contracts script/bwlk/01)
  const rewardTokenAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Ethereum mainnet WETH

  if (!stakingTokenAddress) {
    throw new Error("set stakingTokenAddress to the deployed BWLK token first");
  }

  // Already deployed (tx 0xe44681d7... landed despite the RPC parse crash) - resume from here.
  // const bonusToken = await deployContract("MintableBaseToken", ["Bonus BWLK", "bnBWLK", 0]);
  const bonusToken = await contractAt("MintableBaseToken", "0x5821282f792e61843a0096f8eeef32939bd6e46d");

  // Already deployed (tx 0x85b15f86..., not yet initialized) - resume from the distributor.
  // const stakedBwlkTracker = await deployContract("RewardTracker", ["Staked BWLK", "sBWLK"])
  const stakedBwlkTracker = await contractAt("RewardTracker", "0x3961F92c26724C9d61CED679540F35794d90c576");
  const stakedBwlkDistributor = await deployContract("RewardDistributorV2", [stakingTokenAddress, stakedBwlkTracker.address])
  await sendTxn(stakedBwlkTracker.initialize([stakingTokenAddress], stakedBwlkDistributor.address), "stakedBwlkTracker.initialize")
  await sendTxn(stakedBwlkDistributor.updateLastDistributionTime(), "stakedBwlkDistributor.updateLastDistributionTime")

  const bonusBwlkTracker = await deployContract("RewardTracker", ["Staked + Bonus BWLK", "sbBWLK"])
  // const bonusBwlkTracker = await contractAt("RewardTracker", "");
  const bonusBwlkDistributor = await deployContract("BonusDistributor", [bonusToken.address, bonusBwlkTracker.address])
  await sendTxn(bonusBwlkTracker.initialize([stakedBwlkTracker.address], bonusBwlkDistributor.address), "bonusBwlkTracker.initialize")
  await sendTxn(bonusBwlkDistributor.updateLastDistributionTime(), "bonusBwlkDistributor.updateLastDistributionTime")

  const feeBwlkTracker = await deployContract("RewardTracker", ["Staked + Bonus + Fee BWLK", "sbfBWLK"])
  // const feeBwlkTracker = await contractAt("RewardTracker", "");
  const feeBwlkDistributor = await deployContract("RewardDistributorV2", [rewardTokenAddress, feeBwlkTracker.address])
  await sendTxn(feeBwlkTracker.initialize([bonusBwlkTracker.address, bonusToken.address], feeBwlkDistributor.address), "feeBwlkTracker.initialize")
  await sendTxn(feeBwlkDistributor.updateLastDistributionTime(), "feeBwlkDistributor.updateLastDistributionTime")

  await sendTxn(stakedBwlkTracker.setInPrivateTransferMode(true), "stakedBwlkTracker.setInPrivateTransferMode")
  await sendTxn(stakedBwlkTracker.setInPrivateStakingMode(true), "stakedBwlkTracker.setInPrivateStakingMode")
  await sendTxn(bonusBwlkTracker.setInPrivateTransferMode(true), "bonusBwlkTracker.setInPrivateTransferMode")
  await sendTxn(bonusBwlkTracker.setInPrivateStakingMode(true), "bonusBwlkTracker.setInPrivateStakingMode")
  await sendTxn(bonusBwlkTracker.setInPrivateClaimingMode(true), "bonusBwlkTracker.setInPrivateClaimingMode")
  await sendTxn(feeBwlkTracker.setInPrivateTransferMode(true), "feeBwlkTracker.setInPrivateTransferMode")
  await sendTxn(feeBwlkTracker.setInPrivateStakingMode(true), "feeBwlkTracker.setInPrivateStakingMode")

  // Live Base bnBMX runs in private transfer mode; the fee tracker moves it via the handler
  // bypass. The migrator flow and the boardwalk go-live gate both assume this wiring.
  await sendTxn(bonusToken.setInPrivateTransferMode(true), "bonusToken.setInPrivateTransferMode")

  // Deployed but NOT initialized - initialize takes the GovernanceVoter from script/bwlk/02.
  const rewardRouter = await deployContract("RewardRouterV5", [])
  // const rewardRouter = await contractAt("RewardRouterV5", "");

  // allow rewardRouter to stake in stakedBwlkTracker
  await sendTxn(stakedBwlkTracker.setHandler(rewardRouter.address, true), "stakedBwlkTracker.setHandler(rewardRouter)")

  // allow bonusBwlkTracker to stake stakedBwlkTracker
  await sendTxn(stakedBwlkTracker.setHandler(bonusBwlkTracker.address, true), "stakedBwlkTracker.setHandler(bonusBwlkTracker)")

  // allow rewardRouter to stake in bonusBwlkTracker
  await sendTxn(bonusBwlkTracker.setHandler(rewardRouter.address, true), "bonusBwlkTracker.setHandler(rewardRouter)")

  // allow feeBwlkTracker to stake bonusBwlkTracker
  await sendTxn(bonusBwlkTracker.setHandler(feeBwlkTracker.address, true), "bonusBwlkTracker.setHandler(feeBwlkTracker)")

  // multiplier points at 100% APR
  await sendTxn(bonusBwlkDistributor.setBonusMultiplier(10000), "bonusBwlkDistributor.setBonusMultiplier")

  // allow rewardRouter to stake in feeBwlkTracker
  await sendTxn(feeBwlkTracker.setHandler(rewardRouter.address, true), "feeBwlkTracker.setHandler(rewardRouter)")

  // allow feeBwlkTracker to stake bonusToken
  await sendTxn(bonusToken.setHandler(feeBwlkTracker.address, true), "bonusToken.setHandler(feeBwlkTracker)")

  // allow rewardRouter to mint/burn bonusToken
  await sendTxn(bonusToken.setMinter(rewardRouter.address, true), "bonusToken.setMinter(rewardRouter)")

  console.log("\nBWLK staking stack deployed. Env for the boardwalk-contracts scripts (02/03/04):")
  console.log(`  STAKED_BWLK_TRACKER=${stakedBwlkTracker.address}`)
  console.log(`  BONUS_BWLK_TRACKER=${bonusBwlkTracker.address}`)
  console.log(`  FEE_BWLK_TRACKER=${feeBwlkTracker.address}`)
  console.log(`  BN_BWLK=${bonusToken.address}`)
  console.log(`  (reward router: ${rewardRouter.address})`)
  console.log("\nFollow-ups, in order:")
  console.log("1. Deploy governance (boardwalk-contracts script/bwlk/02) with the env above.")
  console.log("2. From the deployer (gov), one-shot initialize the router with the voter:")
  console.log(`   rewardRouter.initialize(`)
  console.log(`     ${rewardTokenAddress}, // weth`)
  console.log(`     ${stakingTokenAddress}, // bwlk (as the bws param)`)
  console.log(`     ${bonusToken.address}, // bnBwlk`)
  console.log(`     ${stakedBwlkTracker.address}, // stakedBwlkTracker`)
  console.log(`     ${bonusBwlkTracker.address}, // bonusBwlkTracker`)
  console.log(`     ${feeBwlkTracker.address}, // feeBwlkTracker`)
  console.log(`     <GOVERNANCE_VOTER from step 1>)`)
  console.log("3. setGov(STAKING_GOV multisig) on: the 3 trackers, bonusToken, the 3 distributors,")
  console.log("   and the router. The go-live gate (script/bwlk/04) asserts tracker/bnBWLK gov.")
  console.log("4. The migrator grants (handler on the 3 trackers + minter on bnBWLK) come later,")
  console.log("   from STAKING_GOV, exactly as printed by script/bwlk/03 once the migrator clears review.")
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
