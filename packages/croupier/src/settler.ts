import { ethers } from "ethers";
import { YOLOFLIP_ABI } from "./abi";
import { config } from "./config";

// In-memory commit→reveal store. Process restart loses pending bets.
// The settler must be started BEFORE players place bets for reveals to be tracked.
const revealStore = new Map<string, bigint>();

/**
 * Store a reveal for later settlement.
 * Called by the signer service when it generates a new commit.
 */
export function storeReveal(commit: string, reveal: bigint): void {
  revealStore.set(commit.toLowerCase(), reveal);
}

export async function startSettler(
  provider: ethers.Provider,
  wallet: ethers.Wallet,
): Promise<void> {
  const contract = new ethers.Contract(config.contractAddress, YOLOFLIP_ABI, wallet);

  console.log(`[Settler] Watching for BetPlaced events on ${config.contractAddress}`);

  contract.on(
    "BetPlaced",
    async (commit: bigint, gambler: string, amount: bigint, _betMask: bigint, _modulo: bigint) => {
      const commitKey = "0x" + commit.toString(16).padStart(64, "0");

      console.log(
        `[Settler] BetPlaced: commit=${commitKey}, gambler=${gambler}, amount=${ethers.formatEther(amount)} ETH`,
      );

      const reveal = revealStore.get(commitKey.toLowerCase());
      if (reveal === undefined) {
        console.warn(`[Settler] No reveal found for commit ${commitKey} — bet placed before croupier started?`);
        return;
      }

      // Wait 1 block to ensure blockhash is available
      await sleep(2000);

      try {
        await settleBetOnChain(contract, provider, commit, reveal);
        revealStore.delete(commitKey.toLowerCase());
      } catch (error) {
        console.error(`[Settler] Failed to settle bet ${commitKey}:`, error);
        // v1: no retry — expired bets can be refunded by the player
      }
    },
  );

  provider.on("error", (error: unknown) => {
    console.error(`[Settler] Provider error:`, error);
  });
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
