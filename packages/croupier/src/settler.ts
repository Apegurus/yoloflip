import { ethers } from "ethers";
import { YOLOFLIP_ABI } from "./abi";
import { config } from "./config";
import { getReveal, deleteReveal, getAllReveals, countReveals } from "./revealStore";

const RETRY_INTERVAL_MS = 30_000;
const inFlight = new Set<string>();

// L3: simple sequential nonce queue to prevent nonce conflicts
let txQueue: Promise<void> = Promise.resolve();
function enqueueSettlement(fn: () => Promise<void>): Promise<void> {
  txQueue = txQueue.then(fn, fn);
  return txQueue;
}

export async function startSettler(
  provider: ethers.Provider,
  wallet: ethers.Wallet,
): Promise<void> {
  const contract = new ethers.Contract(config.contractAddress, YOLOFLIP_ABI, wallet);

  console.log(`[Settler] Watching for BetPlaced events on ${config.contractAddress}`);
  console.log(`[Settler] ${countReveals()} pending reveals recovered from database`);

  contract.on(
    "BetPlaced",
    async (commit: bigint, gambler: string, amount: bigint, _betMask: bigint, _modulo: bigint, token: string, _isOver: boolean) => {
      const commitKey = "0x" + commit.toString(16).padStart(64, "0");
      const isToken = token !== ethers.ZeroAddress;

      console.log(
        `[Settler] BetPlaced: commit=${commitKey}, gambler=${gambler}, amount=${isToken ? amount.toString() : ethers.formatEther(amount) + " ETH"}${isToken ? `, token=${token}` : ""}`,
      );

      const reveal = getReveal(commitKey);
      if (reveal === undefined) {
        console.warn(`[Settler] No reveal found for commit ${commitKey} — bet placed before croupier started?`);
        return;
      }

      if (inFlight.has(commitKey)) {
        console.log(`[Settler] Bet ${commitKey} already in-flight, skipping`);
        return;
      }

      // L5: configurable block wait
      await sleep(config.blockWaitMs);

      inFlight.add(commitKey);
      try {
        await enqueueSettlement(() => settleBetOnChain(contract, provider, commit, reveal));
        deleteReveal(commitKey);
      } catch (error) {
        console.error(`[Settler] Failed to settle bet ${commitKey}:`, error);
        // Will be retried by the sweep
      } finally {
        inFlight.delete(commitKey);
      }
    },
  );

  // Periodic retry sweep for unsettled reveals
  setInterval(() => {
    retrySweep(contract, provider).catch(err => {
      console.error(`[Settler] Retry sweep error:`, err);
    });
  }, RETRY_INTERVAL_MS);

  provider.on("error", (error: unknown) => {
    console.error(`[Settler] Provider error:`, error);
  });
}

async function retrySweep(contract: ethers.Contract, provider: ethers.Provider): Promise<void> {
  const reveals = getAllReveals();
  if (reveals.length === 0) return;

  console.log(`[Settler] Retry sweep: ${reveals.length} pending reveals`);

  for (const { commit, reveal } of reveals) {
    if (inFlight.has(commit)) continue;

    const commitUint = BigInt(commit);
    inFlight.add(commit);
    try {
      const bet = await contract.bets(commitUint);
      if (bet.amount === 0n) {
        // Bet was already settled or never placed — clean up
        deleteReveal(commit);
        continue;
      }

      const placeBlockNumber = Number(bet.placeBlockNumber);
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock > placeBlockNumber + 256) {
        // Bet expired — player can refund, clean up reveal
        console.log(`[Settler] Reveal ${commit} expired, removing`);
        deleteReveal(commit);
        continue;
      }

      await enqueueSettlement(() => settleBetOnChain(contract, provider, commitUint, reveal));
      deleteReveal(commit);
    } catch (error) {
      console.error(`[Settler] Retry failed for ${commit}:`, error);
    } finally {
      inFlight.delete(commit);
    }
  }
}

async function settleBetOnChain(
  contract: ethers.Contract,
  provider: ethers.Provider,
  commit: bigint,
  reveal: bigint,
): Promise<void> {
  const bet = await contract.bets(commit);
  if (bet.amount === 0n) {
    console.log(`[Settler] Bet already settled or doesn't exist`);
    return;
  }

  const placeBlockNumber = Number(bet.placeBlockNumber);
  const currentBlock = await provider.getBlockNumber();

  if (currentBlock > placeBlockNumber + 256) {
    console.warn(
      `[Settler] Bet expired at block ${placeBlockNumber + 256}, current: ${currentBlock}`,
    );
    return;
  }

  const block = await provider.getBlock(placeBlockNumber);
  if (!block || !block.hash) {
    console.error(`[Settler] Could not get block ${placeBlockNumber}`);
    return;
  }

  const tx = await contract.settleBet(reveal, block.hash);
  const receipt = await tx.wait();
  if (receipt) {
    console.log(`[Settler] Settled bet in tx ${receipt.hash}`);
  } else {
    console.warn(`[Settler] Settlement tx sent but receipt not confirmed`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
