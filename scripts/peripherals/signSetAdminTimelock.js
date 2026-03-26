/**
 * After TokenManager.signalSetAdmin: additional signers call signSetAdmin until
 * minAuthorizations is met, then any signer can call setAdmin.
 *
 * IMPORTANT: The wallet that called signalSetAdmin must NOT run this script.
 * In TokenManager.signalSetAdmin, the contract sets signedActions[msg.sender][action]
 * for the caller — that counts as their signature. Calling signSetAdmin again from
 * the same address reverts with "TokenManager: already signed".
 *
 * Use a different TokenManager signer key in hardhat.config for this script.
 *
 * signSetAdmin(timelock, newAdmin, nonce) — onlySigner; must match the queued action
 * (same target, admin, and nonce as in SignalSetAdmin).
 *
 * Defaults match scripts/peripherals/signalSetAdminTimelock.js (Fantom Morphex).
 *
 * Usage:
 *   NONCE=123 npx hardhat run scripts/peripherals/signSetAdminTimelock.js --network fantom
 *
 * If you omit NONCE, the script uses TokenManager.actionsNonce() on-chain. That only
 * matches the queued setAdmin if no other signal* calls ran after signalSetAdmin; if
 * in doubt, set NONCE from the SignalSetAdmin event (fourth topic / log data nonce).
 *
 * Dry run:
 *   DRY_RUN=1 NONCE=123 npx hardhat run ... --network fantom
 *
 * Overrides:
 *   TIMELOCK=0x... TOKEN_MANAGER=0x... NEW_ADMIN=0x... NONCE=... npx hardhat run ...
 *
 * The Hardhat account must be a TokenManager signer who has NOT already signed this action.
 */
const { contractAt, sendTxn } = require("../shared/helpers");

const network = process.env.HARDHAT_NETWORK || "fantom";

const CONFIG = {
  fantom: {
    timelock: "0x0b122516fCA73E468CF20FD42BA153BA023F91cA",
    tokenManager: "0xC28f1D82874ccFebFE6afDAB3c685D5E709067E5",
    newAdmin: "0xB1dD2Fdb023cB54b7cc2a0f5D9e8d47a9F7723ce",
  },
};

const shouldSendTxn = process.env.DRY_RUN !== "1";

async function main() {
  const cfg = CONFIG[network];
  if (!cfg) {
    throw new Error(
      `No CONFIG for network "${network}". Add an entry to CONFIG or use a supported --network.`
    );
  }

  const timelockAddr = process.env.TIMELOCK || cfg.timelock;
  const tokenManagerAddr = process.env.TOKEN_MANAGER || cfg.tokenManager;
  const newAdmin = process.env.NEW_ADMIN || cfg.newAdmin;

  const [wallet] = await ethers.getSigners();
  const tokenManager = await contractAt(
    "TokenManager",
    tokenManagerAddr,
    wallet
  );

  let nonce;
  if (process.env.NONCE !== undefined && process.env.NONCE !== "") {
    nonce = ethers.BigNumber.from(process.env.NONCE);
  } else {
    nonce = await tokenManager.actionsNonce();
    console.warn(
      "NONCE not set: using TokenManager.actionsNonce(). If another action was signaled after signalSetAdmin, set NONCE explicitly from the SignalSetAdmin receipt."
    );
  }

  console.log("HARDHAT_NETWORK:", network);
  console.log("from:", wallet.address);
  console.log("tokenManager:", tokenManagerAddr);
  console.log("timelock (target):", timelockAddr);
  console.log("newAdmin:", newAdmin);
  console.log("nonce:", nonce.toString());

  const action = ethers.utils.solidityKeccak256(
    ["string", "address", "address", "uint256"],
    ["setAdmin", timelockAddr, newAdmin, nonce]
  );

  const alreadySigned = await tokenManager.signedActions(wallet.address, action);
  if (alreadySigned) {
    console.log(
      "\nThis address already signed this action (including if it called signalSetAdmin)."
    );
    console.log(
      "Use another TokenManager signer account — do not send signSetAdmin from the same wallet that signalled.\n"
    );
    return;
  }

  const isSigner = await tokenManager.isSigner(wallet.address);
  if (!isSigner) {
    console.warn(
      "This account is not a TokenManager signer — signSetAdmin will revert (onlySigner)."
    );
  }

  if (!shouldSendTxn) {
    console.log("DRY_RUN=1: not sending.");
    return;
  }

  await sendTxn(
    tokenManager.signSetAdmin(timelockAddr, newAdmin, nonce),
    `TokenManager.signSetAdmin(timelock=${timelockAddr}, newAdmin=${newAdmin}, nonce=${nonce})`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
