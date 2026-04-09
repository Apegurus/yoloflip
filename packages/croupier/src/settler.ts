import { ethers } from "ethers";
import { YOLOFLIP_ABI } from "./abi";
import { config } from "./config";
import { getReveal, deleteReveal, getAllReveals, countReveals } from "./revealStore";

const RETRY_INTERVAL_MS = 30_000;
const MAX_SETTLEMENT_RETRIES = 5;
const BET_EXPIRATION_BLOCKS = 256;
const inFlight = new Set<string>();
const failureCounts = new Map<string, number>();

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

      await waitForBlock(provider, await provider.getBlockNumber(), config.blockWaitMs);

      inFlight.add(commitKey);
      try {
        await enqueueSettlement(() => settleBetOnChain(contract, provider, commit, reveal));
        deleteReveal(commitKey);
        failureCounts.delete(commitKey);
      } catch (error) {
        const count = (failureCounts.get(commitKey) ?? 0) + 1;
        failureCounts.set(commitKey, count);
        console.error(`[Settler] Failed to settle bet ${commitKey} (attempt ${count}/${MAX_SETTLEMENT_RETRIES}):`, error);
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

    const failures = failureCounts.get(commit) ?? 0;
    if (failures >= MAX_SETTLEMENT_RETRIES) {
      console.warn(`[Settler] Commit ${commit} exceeded ${MAX_SETTLEMENT_RETRIES} retries, giving up`);
      deleteReveal(commit);
      failureCounts.delete(commit);
      continue;
    }

    const commitUint = BigInt(commit);
    inFlight.add(commit);
    try {
      const bet = await contract.bets(commitUint);
      if (bet.amount === 0n) {
        deleteReveal(commit);
        failureCounts.delete(commit);
        continue;
      }

      const placeBlockNumber = Number(bet.placeBlockNumber);
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock > placeBlockNumber + BET_EXPIRATION_BLOCKS) {
        console.log(`[Settler] Reveal ${commit} expired, removing`);
        deleteReveal(commit);
        failureCounts.delete(commit);
        continue;
      }

      await enqueueSettlement(() => settleBetOnChain(contract, provider, commitUint, reveal));
      deleteReveal(commit);
      failureCounts.delete(commit);
    } catch (error) {
      const count = (failureCounts.get(commit) ?? 0) + 1;
      failureCounts.set(commit, count);
      console.error(`[Settler] Retry failed for ${commit} (attempt ${count}/${MAX_SETTLEMENT_RETRIES}):`, error);
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

  if (currentBlock > placeBlockNumber + BET_EXPIRATION_BLOCKS) {
    console.warn(
      `[Settler] Bet expired at block ${placeBlockNumber + BET_EXPIRATION_BLOCKS}, current: ${currentBlock}`,
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

async function waitForBlock(provider: ethers.Provider, minBlock: number, pollMs: number): Promise<void> {
  const maxAttempts = Math.ceil(60_000 / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    const current = await provider.getBlockNumber();
    if (current > minBlock) return;
    await sleep(pollMs);
  }
  console.warn(`[Settler] Timed out waiting for block > ${minBlock}`);
}
