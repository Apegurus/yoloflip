import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { config } from "./config";
import { storeReveal } from "./revealStore";

/**
 * Creates the Express router for the commit signing API.
 *
 * @param secretSignerWallet - The wallet whose address is set as secretSigner in the contract
 * @param provider - Ethers provider to get current block number
 */
export function createSignerRouter(
  secretSignerWallet: ethers.Wallet,
  provider: ethers.Provider,
): Router {
  const router = Router();

  /**
   * GET /api/commit
   *
   * Generates a new commit-reveal pair and returns the signed commit to the player.
   * The player uses this to call placeBet on the YoloFlip contract.
   *
   * Response:
   *   {
   *     commit: string,          // hex string: keccak256(reveal) as uint256
   *     commitLastBlock: string, // hex string: current block + offset
   *     v: number,               // signature recovery id (27 or 28)
   *     r: string,               // signature r (hex bytes32)
   *     s: string,               // signature s (hex bytes32)
   *   }
   */
  router.get("/commit", async (_req: Request, res: Response) => {
    try {
      // 1. Get current block number
      const currentBlock = await provider.getBlockNumber();
      const commitLastBlock = BigInt(currentBlock + config.commitBlockOffset);

      // 2. Generate random reveal (32 bytes -> uint256)
      const revealBytes = ethers.randomBytes(32);
      const reveal = BigInt(ethers.hexlify(revealBytes));

      // 3. Compute commit = keccak256(abi.encodePacked(reveal))
      //    reveal is uint256, so packed encoding = 32-byte big-endian
      const commit = BigInt(
        ethers.solidityPackedKeccak256(["uint256"], [reveal]),
      );
      const commitHex = "0x" + commit.toString(16).padStart(64, "0");

      // 4. Build the message hash that the contract verifies:
      //    keccak256(abi.encodePacked(uint40(commitLastBlock), commit, address(this)))
      const msgHash = ethers.solidityPackedKeccak256(
        ["uint40", "uint256", "address"],
        [commitLastBlock, commit, config.contractAddress],
      );

      // 5. Sign the RAW hash (no Ethereum personal_sign prefix).
      //    This matches the contract's ECDSA.recover which uses the raw hash.
      const sig = secretSignerWallet.signingKey.sign(ethers.getBytes(msgHash));

      // 6. Store the reveal in memory for settlement
      storeReveal(commitHex, reveal);

      // 7. Return the signed commit data
      res.json({
        commit: commitHex,
        commitLastBlock: "0x" + commitLastBlock.toString(16),
        v: sig.v,
        r: sig.r,
        s: sig.s,
      });
    } catch (error) {
      console.error("[Signer] Error generating commit:", error);
      res.status(500).json({ error: "Failed to generate commit" });
    }
  });

  return router;
}

// Signature verification note:
// 1. reveal: random uint256
// 2. commit = solidityPackedKeccak256(["uint256"], [reveal])
// 3. msgHash = solidityPackedKeccak256(["uint40", "uint256", "address"], [commitLastBlock, commit, contractAddress])
// 4. sig = secretSignerWallet.signingKey.sign(getBytes(msgHash))
// 5. Contract recovers: ECDSA.recover(msgHash, v, r, s) == secretSigner
