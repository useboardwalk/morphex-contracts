const {
  contractAt,
  sendTxn,
  updateTokensPerInterval,
} = require("../shared/helpers");
const { ethers } = require("hardhat");
const { BASE_DEPLOY_KEY, BASE_URL, SONIC_URL } = require("../../env.json");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Configuration
const network = "base"; // set to network you want to update on
const additionalRevenueSources = {
  freestyleUSDC: "0", // set this, 6 decimals
  basedMediaXETH: "0", // set this, 18 decimals
  // following chain configs are to track revenue bridged from other chains to base
  sonic: {
    stakingIncentivesETH: "0",
  },
};
const USER_ADDRESS = "0xB1dD2Fdb023cB54b7cc2a0f5D9e8d47a9F7723ce";

// Constants
const API_ENDPOINTS = {
  quote: "https://api.odos.xyz/sor/quote/v2",
  assemble: "https://api.odos.xyz/sor/assemble",
};
const FREESTYLE_ALLOCATIONS = {
  singleStaking: 60, // swap to weth
  bltMlt: 40, // swap to weth
};
const BASED_MEDIAX_ALLOCATIONS = {
  singleStaking: 60,
  bltMlt: 40,
};

// Helper Functions
function logSectionHeader(title) {
  console.log("\n" + "=".repeat(50));
  console.log(`${title}`);
  console.log("=".repeat(50));
}
function logBalance(label, amount, decimals = 18, symbol = "ETH") {
  console.log(
    `${label}: ${amount.toString()} (${ethers.utils.formatUnits(
      amount,
      decimals
    )} ${symbol})`
  );
}
async function logFinalSummary(
  freestyleResults,
  basedMediaXResults,
  classicRewardBalance
) {
  logSectionHeader("Final Distribution Summary");

  console.log("\n🏆 Classic Revenue:");
  logBalance(
    `Total Classic ${network === "sonic" ? "wS" : "ETH"}`,
    classicRewardBalance
  );

  console.log("\n🏆 Freestyle Revenue:");
  if (freestyleResults) {
    console.log("\nFreestyle Single-Staking:");
    logBalance(
      "Amount",
      freestyleResults.singleStaking,
      18,
      network === "sonic" ? "wS" : "ETH"
    );
    console.log("\nFreestyle BLT/SLT:");
    logBalance(
      "Amount",
      freestyleResults.bltMlt,
      18,
      network === "sonic" ? "wS" : "ETH"
    );
  } else {
    console.log("Nothing.");
  }

  console.log("\n🏆 Based MediaX Revenue:");
  if (basedMediaXResults) {
    console.log("\nBased MediaX Single-Staking:");
    logBalance("Amount", basedMediaXResults.singleStaking, 18, "ETH");
    console.log("\nBased MediaX BLT:");
    logBalance("Amount", basedMediaXResults.bltMlt, 18, "ETH");
  } else {
    console.log("Nothing.");
  }

  if (network === "base") {
    console.log("\n🏆 Revenue bridged from other chains:");
    console.log("Sonic:");
    logBalance(
      "Single-staking",
      ethers.BigNumber.from(
        additionalRevenueSources.sonic.stakingIncentivesETH
      ),
      18,
      "ETH"
    );
  }
}

async function createQuoteRequest(chainId, toTokenAddress, inputTokens) {
  return {
    chainId,
    inputTokens,
    outputTokens: [
      {
        tokenAddress: toTokenAddress,
        proportion: 1,
      },
    ],
    userAddr: USER_ADDRESS,
    slippageLimitPercent: 1,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };
}

async function requestQuote(tokens, toTokenAddress, chainId) {
  const requestBody = await createQuoteRequest(chainId, toTokenAddress, tokens);
  console.log(`Getting quote for ${toTokenAddress}...`);

  const response = await fetch(API_ENDPOINTS.quote, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      "Quote Error:",
      response.status,
      response.statusText,
      errorText
    );
    throw new Error("Quote request failed");
  }

  const quote = await response.json();
  console.log("Quote generated successfully");
  return quote;
}

async function assembleAndExecuteTransaction(quote, wallet, provider) {
  const assembleRequestBody = {
    userAddr: USER_ADDRESS,
    pathId: quote.pathId,
    simulate: true,
  };

  console.log("Assembling transaction...");
  const response = await fetch(API_ENDPOINTS.assemble, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assembleRequestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      "Assembly Error:",
      response.status,
      response.statusText,
      errorText
    );
    throw new Error("Transaction assembly failed");
  }

  const assembled = await response.json();
  console.log("Transaction assembled");

  const transaction = {
    ...assembled.transaction,
    gasLimit: assembled.transaction.gas,
    value: parseInt(assembled.transaction.value),
  };
  delete transaction.gas;

  const signedTx = await wallet.signTransaction(transaction);
  const txResponse = await provider.sendTransaction(signedTx);
  const receipt = await txResponse.wait();

  console.log("Transaction executed:", receipt.transactionHash);
  return receipt;
}

async function getBaseValues() {
  const chainId = 8453;
  const provider = new ethers.providers.JsonRpcProvider(BASE_URL);
  const rewardToken = await contractAt(
    "Token",
    "0x4200000000000000000000000000000000000006"
  );
  const govToken = await contractAt(
    "Token",
    "0x548f93779fBC992010C07467cBaf329DD5F059B7"
  );
  const usdcToken = await contractAt(
    "Token",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  );

  const swapTokenArr = [
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
    "0xA88594D404727625A9437C3f886C7643872296AE", // WELL
  ];
  const rewardTrackerArr = [
    {
      name: "feeGmxDistributor",
      address: "0x0259083181Ae54730f4FBB1C174a53E21BCE5266",
      allocation: 20,
    },
    {
      name: "feeGlpDistributor",
      address: "0x06c35893Ba9bc454e12c36F4117BC99f75e34346",
      allocation: 80,
    },
  ];

  return {
    chainId,
    provider,
    rewardToken,
    rewardTrackerArr,
    swapTokenArr,
    govToken,
    usdcToken,
  };
}

async function getSonicValues() {
  const chainId = 146;
  const provider = new ethers.providers.JsonRpcProvider(SONIC_URL);
  const rewardToken = await contractAt(
    "Token",
    "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38"
  );
  const govToken = await contractAt(
    "Token",
    "0xC28f1D82874ccFebFE6afDAB3c685D5E709067E5"
  );
  const usdcToken = await contractAt(
    "Token",
    "0x29219dd400f2Bf60E5a23d13Be72B486D4038894"
  );

  const swapTokenArr = [
    "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", // wETH
    "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", // USDC.e
  ];
  const rewardTrackerArr = [
    {
      name: "bridgedStakingIncentives", // bridge to base
      address: "",
      allocation: 20,
    },
    {
      name: "feeGlpDistributor",
      address: "0x86c48E2FFEaCee704B7B7840127BF2f325F075cf",
      allocation: 80,
    },
  ];

  return {
    chainId,
    provider,
    rewardToken,
    rewardTrackerArr,
    swapTokenArr,
    govToken,
    usdcToken,
  };
}

function getValues() {
  if (network === "base") {
    return getBaseValues();
  }
  if (network === "sonic") {
    return getSonicValues();
  }

  throw new Error("Invalid network");
}

// Revenue Processing Functions
async function processClassicRevenue(
  tokens,
  rewardToken,
  wallet,
  provider,
  chainId,
  basedMediaXETH,
  bridgedRevenue
) {
  logSectionHeader("Processing Classic Revenue");
  if (tokens.length === 0) {
    console.log("No classic revenue tokens to process");
    const balanceRaw = await rewardToken.balanceOf(USER_ADDRESS);
    const balance = balanceRaw
      .sub(basedMediaXETH)
      .sub(bridgedRevenue.stakingIncentivesETH);
    logBalance("Classic Revenue Final Balance", balance);
    return balance;
  }

  if (tokens.length > 6) {
    const mid = Math.ceil(tokens.length / 2);
    const firstHalf = tokens.slice(0, mid);
    const secondHalf = tokens.slice(mid);

    const firstQuote = await requestQuote(
      firstHalf,
      rewardToken.address,
      chainId
    );
    await assembleAndExecuteTransaction(firstQuote, wallet, provider);

    const secondQuote = await requestQuote(
      secondHalf,
      rewardToken.address,
      chainId
    );
    await assembleAndExecuteTransaction(secondQuote, wallet, provider);
  } else {
    const quote = await requestQuote(tokens, rewardToken.address, chainId);
    await assembleAndExecuteTransaction(quote, wallet, provider);
  }

  const finalBalanceWithBasedMediaX = await rewardToken.balanceOf(USER_ADDRESS);
  const finalBalance = finalBalanceWithBasedMediaX
    .sub(basedMediaXETH)
    .sub(bridgedRevenue.stakingIncentivesETH);
  logBalance("Classic Revenue Final Balance", finalBalance);
  return finalBalance;
}

async function processFreestyleRevenue(
  freestyleUSDC,
  allocations,
  rewardToken,
  wallet,
  provider,
  chainId,
  classicRewardBalance,
  bridgedRevenue
) {
  logSectionHeader("Processing Freestyle Revenue");
  if (freestyleUSDC.amount.isZero()) {
    console.log("No Freestyle revenue to process");
    return null;
  }

  console.log(
    `Total amount: ${freestyleUSDC.amount.toString()}, ${ethers.utils.formatUnits(
      freestyleUSDC.amount,
      6
    )} USDC`
  );

  const amounts = {
    singleStaking: freestyleUSDC.amount.mul(allocations.singleStaking).div(100),
    bltMlt: freestyleUSDC.amount.mul(allocations.bltMlt).div(100),
  };

  // Log allocations
  Object.entries(amounts).forEach(([key, value]) => {
    console.log(
      `${key}: ${value.toString()}, ${ethers.utils.formatUnits(value, 6)} USDC`
    );
  });

  const result = {
    singleStaking: ethers.BigNumber.from(0),
    bltMlt: ethers.BigNumber.from(0),
  };

  const balanceToDeduct = classicRewardBalance
    .add(additionalRevenueSources.basedMediaXETH)
    .add(bridgedRevenue.stakingIncentivesETH);

  // Process single staking
  const singleQuote = await requestQuote(
    [
      {
        tokenAddress: freestyleUSDC.tokenAddress,
        amount: amounts.singleStaking.toString(),
      },
    ],
    rewardToken.address,
    chainId
  );
  await assembleAndExecuteTransaction(singleQuote, wallet, provider);
  const singleStakingBalance = await rewardToken.balanceOf(USER_ADDRESS);
  result.singleStaking = singleStakingBalance.sub(balanceToDeduct);

  // Process BLT/MLT
  const bltMltQuote = await requestQuote(
    [
      {
        tokenAddress: freestyleUSDC.tokenAddress,
        amount: amounts.bltMlt.toString(),
      },
    ],
    rewardToken.address,
    chainId
  );
  await assembleAndExecuteTransaction(bltMltQuote, wallet, provider);
  const bltMltBalance = await rewardToken.balanceOf(USER_ADDRESS);
  result.bltMlt = bltMltBalance.sub(balanceToDeduct).sub(result.singleStaking);

  return result;
}

async function processBasedMediaXRevenue(basedMediaXETH, allocations) {
  logSectionHeader("Processing Based MediaX Revenue");
  if (basedMediaXETH.amount === "0") {
    console.log("No Based MediaX revenue to process");
    return null;
  }

  console.log(
    `Total amount: ${basedMediaXETH.amount}, ${ethers.utils.formatEther(
      basedMediaXETH.amount
    )} ETH`
  );

  const ethAmount = ethers.BigNumber.from(basedMediaXETH.amount);
  const amounts = {
    singleStaking: ethAmount.mul(allocations.singleStaking).div(100),
    bltMlt: ethAmount.mul(allocations.bltMlt).div(100),
  };

  // Log allocations
  Object.entries(amounts).forEach(([key, value]) => {
    console.log(
      `${key}: ${value.toString()}, ${ethers.utils.formatEther(value)} ETH`
    );
  });

  const result = {
    singleStaking: amounts.singleStaking,
    bltMlt: amounts.bltMlt,
  };

  return result;
}

async function distributeRewards(
  rewardTrackerArr,
  rewardToken,
  rewardTokenBalance,
  totalSingleStaking,
  totalBltMlt
) {
  console.log("\nDistributing rewards...");
  let totalBridgeAmount = ethers.BigNumber.from(0);
  for (const { name, address, allocation } of rewardTrackerArr) {
    const baseAllocation = rewardTokenBalance.mul(allocation).div(100);
    const additionalAmount =
      allocation === 20 ? totalSingleStaking : totalBltMlt;

    const totalAllocation = baseAllocation.add(additionalAmount);
    console.log(
      `\n${name} distribution:`,
      `\nBase allocation: ${ethers.utils.formatEther(baseAllocation)} ${
        network === "sonic" ? "wS" : "ETH"
      }`,
      `\nAdditional amount: ${ethers.utils.formatEther(additionalAmount)} ${
        network === "sonic" ? "wS" : "ETH"
      }`,
      `\nTotal: ${ethers.utils.formatEther(totalAllocation)} ${
        network === "sonic" ? "wS" : "ETH"
      }`
    );

    if (name === "feeGlpDistributor") {
      const rewardDistributor = await contractAt("RewardDistributor", address);
      const rewardsPerInterval = totalAllocation.div(7 * 24 * 60 * 60);
      console.log(
        "Rewards per interval:",
        `${ethers.utils.formatEther(rewardsPerInterval)} ${
          network === "base"
            ? ethers.utils.formatEther(totalAllocation.div(7 * 24 * 60 * 60))
            : ""
        }`
      );

      await updateTokensPerInterval(
        rewardDistributor,
        rewardsPerInterval,
        "rewardDistributor"
      );

      await sendTxn(
        rewardToken.transfer(rewardDistributor.address, totalAllocation, {
          gasLimit: 500000,
        }),
        `rewardToken.transfer ${name}`
      );
    } else {
      console.log(
        `\n${name} ${ethers.utils.formatEther(
          totalAllocation
        )} ${totalAllocation} ${
          network === "sonic" ? "wS" : "ETH"
        } to bridge to Base.`
      );
      totalBridgeAmount = totalBridgeAmount.add(totalAllocation);
    }
  }
  console.log(
    `\nTotal amount to bridge to Base: ${ethers.utils.formatEther(
      totalBridgeAmount
    )} ${totalBridgeAmount} ${network === "sonic" ? "wS" : "ETH"}`
  );
}

async function main() {
  const {
    chainId,
    provider,
    rewardToken,
    rewardTrackerArr,
    swapTokenArr,
    usdcToken,
  } = await getValues();
  const wallet = new ethers.Wallet(BASE_DEPLOY_KEY, provider);

  logSectionHeader("Beginning Revenue Processing");
  // Calculate initial balances for classic revenue and bridged revenue
  const classicTokenBalances = [];
  const bridgedRevenue = {
    stakingIncentivesETH: ethers.BigNumber.from(
      additionalRevenueSources.sonic.stakingIncentivesETH
    ),
  };

  for (const tokenAddress of swapTokenArr) {
    const token = await contractAt("Token", tokenAddress);
    const balance = await token.balanceOf(USER_ADDRESS);
    const decimals = await token.decimals();
    const symbol = await token.symbol();

    if (balance.gt(0)) {
      // Handle USDC separately to account for Freestyle revenue
      if (tokenAddress.toLowerCase() === usdcToken.address.toLowerCase()) {
        const classicAmount = balance.sub(
          additionalRevenueSources.freestyleUSDC
        );

        if (classicAmount.gt(0)) {
          classicTokenBalances.push({
            tokenAddress,
            amount: classicAmount.toString(),
          });
          logBalance(`Classic ${symbol}`, classicAmount, decimals, symbol);
        }
      }
      // Handle all other tokens normally
      else {
        classicTokenBalances.push({
          tokenAddress,
          amount: balance.toString(),
        });
        logBalance(`Classic ${symbol}`, balance, decimals, symbol);
      }
    }
  }

  // Process classic revenue first
  const classicRewardBalance = await processClassicRevenue(
    classicTokenBalances,
    rewardToken,
    wallet,
    provider,
    chainId,
    additionalRevenueSources.basedMediaXETH,
    bridgedRevenue
  );

  // Process Freestyle revenue (USDC)
  const freestyleResults = await processFreestyleRevenue(
    {
      tokenAddress: usdcToken.address,
      amount: ethers.BigNumber.from(additionalRevenueSources.freestyleUSDC),
    },
    FREESTYLE_ALLOCATIONS,
    rewardToken,
    wallet,
    provider,
    chainId,
    classicRewardBalance,
    bridgedRevenue
  );

  // Process Based MediaX revenue (wETH)
  const basedMediaXResults = await processBasedMediaXRevenue(
    {
      tokenAddress: rewardToken.address,
      amount: additionalRevenueSources.basedMediaXETH,
    },
    BASED_MEDIAX_ALLOCATIONS
  );

  // Calculate total allocations from additional revenue sources only
  const totalBltMlt = ethers.BigNumber.from(0)
    .add(freestyleResults?.bltMlt || 0)
    .add(basedMediaXResults?.bltMlt || 0);

  let totalSingleStaking = ethers.BigNumber.from(0)
    .add(freestyleResults?.singleStaking || 0)
    .add(basedMediaXResults?.singleStaking || 0);

  // If it's Base, add potential ETH bridged from other chains
  if (network === "base") {
    totalSingleStaking = totalSingleStaking.add(
      ethers.BigNumber.from(additionalRevenueSources.sonic.stakingIncentivesETH)
    );
  }
  logFinalSummary(freestyleResults, basedMediaXResults, classicRewardBalance);

  // Distribute rewards using only classic revenue balance
  await distributeRewards(
    rewardTrackerArr,
    rewardToken,
    classicRewardBalance,
    totalSingleStaking,
    totalBltMlt
  );

  console.log("\nReward distribution completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
