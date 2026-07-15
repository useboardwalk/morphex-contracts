const { deployContract, contractAt, sendTxn } = require("../shared/helpers")

// Deploys the BWS single-staking stack on Arbitrum (adapted from deploySingleStaking.js):
// bnBWS + the three trackers/distributors, private modes, RewardRouterV5 and its grants.

async function main() {
  const stakingTokenAddress = "0x170F6e39ea851108f0713090467871F28A62A5D4"; // BWS
  const rewardTokenAddress = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // Arbitrum WETH

  if (!stakingTokenAddress) {
    throw new Error("set stakingTokenAddress to the deployed BWS token first");
  }

  const bonusToken = await deployContract("MintableBaseToken", ["Bonus BWS", "bnBWS", 0]);
  // const bonusToken = await contractAt("MintableBaseToken", "");

  const stakedBwsTracker = await deployContract("RewardTracker", ["Staked BWS", "sBWS"])
  // const stakedBwsTracker = await contractAt("RewardTracker", "");
  const stakedBwsDistributor = await deployContract("RewardDistributorV2", [stakingTokenAddress, stakedBwsTracker.address])
  await sendTxn(stakedBwsTracker.initialize([stakingTokenAddress], stakedBwsDistributor.address), "stakedBwsTracker.initialize")
  await sendTxn(stakedBwsDistributor.updateLastDistributionTime(), "stakedBwsDistributor.updateLastDistributionTime")

  const bonusBwsTracker = await deployContract("RewardTracker", ["Staked + Bonus BWS", "sbBWS"])
  // const bonusBwsTracker = await contractAt("RewardTracker", "");
  const bonusBwsDistributor = await deployContract("BonusDistributor", [bonusToken.address, bonusBwsTracker.address])
  await sendTxn(bonusBwsTracker.initialize([stakedBwsTracker.address], bonusBwsDistributor.address), "bonusBwsTracker.initialize")
  await sendTxn(bonusBwsDistributor.updateLastDistributionTime(), "bonusBwsDistributor.updateLastDistributionTime")

  const feeBwsTracker = await deployContract("RewardTracker", ["Staked + Bonus + Fee BWS", "sbfBWS"])
  // const feeBwsTracker = await contractAt("RewardTracker", "");
  const feeBwsDistributor = await deployContract("RewardDistributorV2", [rewardTokenAddress, feeBwsTracker.address])
  await sendTxn(feeBwsTracker.initialize([bonusBwsTracker.address, bonusToken.address], feeBwsDistributor.address), "feeBwsTracker.initialize")
  await sendTxn(feeBwsDistributor.updateLastDistributionTime(), "feeBwsDistributor.updateLastDistributionTime")

  await sendTxn(stakedBwsTracker.setInPrivateTransferMode(true), "stakedBwsTracker.setInPrivateTransferMode")
  await sendTxn(stakedBwsTracker.setInPrivateStakingMode(true), "stakedBwsTracker.setInPrivateStakingMode")
  await sendTxn(bonusBwsTracker.setInPrivateTransferMode(true), "bonusBwsTracker.setInPrivateTransferMode")
  await sendTxn(bonusBwsTracker.setInPrivateStakingMode(true), "bonusBwsTracker.setInPrivateStakingMode")
  await sendTxn(bonusBwsTracker.setInPrivateClaimingMode(true), "bonusBwsTracker.setInPrivateClaimingMode")
  await sendTxn(feeBwsTracker.setInPrivateTransferMode(true), "feeBwsTracker.setInPrivateTransferMode")
  await sendTxn(feeBwsTracker.setInPrivateStakingMode(true), "feeBwsTracker.setInPrivateStakingMode")

  await sendTxn(bonusToken.setInPrivateTransferMode(true), "bonusToken.setInPrivateTransferMode")

  // Deployed but NOT initialized - initialize takes the GovernanceVoter from script/bws/02.
  const rewardRouter = await deployContract("RewardRouterV5", [])
  // const rewardRouter = await contractAt("RewardRouterV5", "");

  // allow rewardRouter to stake in stakedBwsTracker
  await sendTxn(stakedBwsTracker.setHandler(rewardRouter.address, true), "stakedBwsTracker.setHandler(rewardRouter)")

  // allow bonusBwsTracker to stake stakedBwsTracker
  await sendTxn(stakedBwsTracker.setHandler(bonusBwsTracker.address, true), "stakedBwsTracker.setHandler(bonusBwsTracker)")

  // allow rewardRouter to stake in bonusBwsTracker
  await sendTxn(bonusBwsTracker.setHandler(rewardRouter.address, true), "bonusBwsTracker.setHandler(rewardRouter)")

  // allow feeBwsTracker to stake bonusBwsTracker
  await sendTxn(bonusBwsTracker.setHandler(feeBwsTracker.address, true), "bonusBwsTracker.setHandler(feeBwsTracker)")

  // multiplier points at 100% APR
  await sendTxn(bonusBwsDistributor.setBonusMultiplier(10000), "bonusBwsDistributor.setBonusMultiplier")

  // allow rewardRouter to stake in feeBwsTracker
  await sendTxn(feeBwsTracker.setHandler(rewardRouter.address, true), "feeBwsTracker.setHandler(rewardRouter)")

  // allow feeBwsTracker to stake bonusToken
  await sendTxn(bonusToken.setHandler(feeBwsTracker.address, true), "bonusToken.setHandler(feeBwsTracker)")

  // allow rewardRouter to mint/burn bonusToken
  await sendTxn(bonusToken.setMinter(rewardRouter.address, true), "bonusToken.setMinter(rewardRouter)")

  console.log("\nBWS staking stack deployed. Env for the boardwalk-contracts scripts:")
  console.log(`  STAKED_BWS_TRACKER=${stakedBwsTracker.address}`)
  console.log(`  BONUS_BWS_TRACKER=${bonusBwsTracker.address}`)
  console.log(`  FEE_BWS_TRACKER=${feeBwsTracker.address}`)
  console.log(`  BN_BWS=${bonusToken.address}`)
  console.log(`  (reward router: ${rewardRouter.address})`)
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
