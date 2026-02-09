const {
  deployContract,
  contractAt,
  sendTxn,
  readTmpAddresses,
  callWithRetries,
} = require("../shared/helpers");
const { bigNumberify, expandDecimals } = require("../../test/shared/utilities");
const { toChainlinkPrice } = require("../../test/shared/chainlink");

const chain = "base"; // set to chain you want to work with
const tokens = require("./tokens")[chain];

async function getBaseValues() {
  const vault = await contractAt(
    "Vault",
    "0xec8d8D4b215727f3476FF0ab41c406FA99b4272C"
  );
  const timelock = await contractAt("Timelock", await vault.gov());
  const reader = await contractAt(
    "Reader",
    "0x92C97631450E804848781C0764907Ec4FC6fFd29"
  );

  const { eth, cbbtc, usdcCircle } = tokens;
  const tokenArr = [eth, cbbtc, usdcCircle];

  const vaultTokenInfo = await reader.getVaultTokenInfoV2(
    vault.address,
    eth.address,
    1,
    tokenArr.map((t) => t.address)
  );

  return { vault, timelock, reader, tokenArr, vaultTokenInfo };
}

async function getModeValues() {
  const vault = await contractAt(
    "Vault",
    "0xff745bdB76AfCBa9d3ACdCd71664D4250Ef1ae49"
  );
  const timelock = await contractAt("Timelock", await vault.gov());
  const reader = await contractAt(
    "Reader",
    "0xA3Ea99f8aE06bA0d9A6Cf7618d06AEa4564340E9"
  );

  const { eth, weeth, wbtc, mode, usdc } = tokens;
  const tokenArr = [eth, weeth, wbtc, mode, usdc];

  const vaultTokenInfo = await reader.getVaultTokenInfoV2(
    vault.address,
    eth.address,
    1,
    tokenArr.map((t) => t.address)
  );

  return { vault, timelock, reader, tokenArr, vaultTokenInfo };
}

async function getSonicValues() {
  const vault = await contractAt(
    "Vault",
    "0x9cC4E8e60a2c9a67Ac7D20f54607f98EfBA38AcF"
  );
  const timelock = await contractAt("Timelock", await vault.gov());
  const reader = await contractAt(
    "Reader",
    "0x9C959a40f1d1f3bc5C7d02EC474d13eD25441A5e"
  );

  const { s, weth, usdc } = tokens;
  const tokenArr = [s, weth, usdc];

  const vaultTokenInfo = await reader.getVaultTokenInfoV2(
    vault.address,
    s.address,
    1,
    tokenArr.map((t) => t.address)
  );

  return { vault, timelock, reader, tokenArr, vaultTokenInfo };
}

async function getValues() {
  if (chain === "fantom") {
    return getFtmValues();
  }

  if (chain === "bsc") {
    return getBscValues();
  }

  if (chain === "base") {
    return getBaseValues();
  }

  if (chain === "mode") {
    return getModeValues();
  }

  if (chain === "sonic") {
    return getSonicValues();
  }
}

async function main() {
  const { vault, timelock, tokenArr, vaultTokenInfo } = await getValues();

  console.log("vault", vault.address);
  console.log("timelock", timelock.address);

  const vaultPropsLength = 14;

  const shouldSendTxn = true;

  let totalUsdgAmount = bigNumberify(0);

  for (const [i, tokenItem] of tokenArr.entries()) {
    // console.log('token', tokenItem)
    const token = {};
    token.poolAmount = vaultTokenInfo[i * vaultPropsLength];
    token.reservedAmount = vaultTokenInfo[i * vaultPropsLength + 1];
    token.availableAmount = token.poolAmount.sub(token.reservedAmount);
    token.usdgAmount = vaultTokenInfo[i * vaultPropsLength + 2];
    token.redemptionAmount = vaultTokenInfo[i * vaultPropsLength + 3];
    token.weight = vaultTokenInfo[i * vaultPropsLength + 4];
    token.bufferAmount = vaultTokenInfo[i * vaultPropsLength + 5];
    token.maxUsdgAmount = vaultTokenInfo[i * vaultPropsLength + 6];
    token.globalShortSize = vaultTokenInfo[i * vaultPropsLength + 7];
    token.maxGlobalShortSize = vaultTokenInfo[i * vaultPropsLength + 8];
    token.minPrice = vaultTokenInfo[i * vaultPropsLength + 9];
    token.maxPrice = vaultTokenInfo[i * vaultPropsLength + 10];
    token.guaranteedUsd = vaultTokenInfo[i * vaultPropsLength + 11];

    token.availableUsd = tokenItem.isStable
      ? token.poolAmount
          .mul(token.minPrice)
          .div(expandDecimals(1, tokenItem.decimals))
      : token.availableAmount
          .mul(token.minPrice)
          .div(expandDecimals(1, tokenItem.decimals));

    token.managedUsd = token.availableUsd.add(token.guaranteedUsd);
    token.managedAmount = token.managedUsd
      .mul(expandDecimals(1, tokenItem.decimals))
      .div(token.minPrice);

    let usdgAmount = token.managedUsd.div(expandDecimals(1, 30 - 18));
    totalUsdgAmount = totalUsdgAmount.add(usdgAmount);

    const adjustedMaxUsdgAmount = expandDecimals(tokenItem.maxUsdgAmount, 18);
    if (usdgAmount.gt(adjustedMaxUsdgAmount)) {
      console.warn(
        `usdgAmount for ${
          tokenItem.name
        } was adjusted from ${usdgAmount.toString()} to ${adjustedMaxUsdgAmount.toString()}`
      );
      usdgAmount = adjustedMaxUsdgAmount;
    }

    if (shouldSendTxn) {
      await sendTxn(
        timelock.setTokenConfig(
          vault.address,
          tokenItem.address, // _token
          tokenItem.tokenWeight, // _tokenWeight
          tokenItem.minProfitBps, // _minProfitBps
          expandDecimals(tokenItem.maxUsdgAmount, 18), // _maxUsdgAmount
          expandDecimals(tokenItem.bufferAmount, tokenItem.decimals), // _bufferAmount
          usdgAmount
        ),
        `vault.setTokenConfig(${tokenItem.name}) ${tokenItem.address}`
      );
    }
  }

  console.log("totalUsdgAmount", totalUsdgAmount.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
