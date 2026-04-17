import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { HDNodeWallet, Wallet } from "ethers";
import type { YoloFlip } from "../typechain-types";

function generateReveal(): bigint {
  return BigInt(ethers.hexlify(ethers.randomBytes(32)));
}

function revealToCommit(reveal: bigint): bigint {
  return BigInt(ethers.solidityPackedKeccak256(["uint256"], [reveal]));
}

async function signCommit(
  wallet: Wallet | HDNodeWallet,
  commitLastBlock: bigint,
  commit: bigint,
  contractAddress: string,
): Promise<{ v: number; r: string; s: string }> {
  const msgHash = ethers.solidityPackedKeccak256(
    ["uint40", "uint256", "address"],
    [commitLastBlock, commit, contractAddress],
  );
  const sig = wallet.signingKey.sign(ethers.getBytes(msgHash));
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe("YoloFlip Integration", function () {
  this.timeout(30000);

  let yoloFlip: YoloFlip;
  let admin: HardhatEthersSigner;
  let croupier: HardhatEthersSigner;
  let player: HardhatEthersSigner;
  let secretSignerWallet: Wallet | HDNodeWallet;

  before(async function () {
    [admin, croupier, player] = await ethers.getSigners();
    secretSignerWallet = ethers.Wallet.createRandom();

    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    yoloFlip = (await YoloFlipFactory.deploy(
      admin.address,
      croupier.address,
      secretSignerWallet.address,
      200n,
      ethers.parseEther("0.001"),
    )) as unknown as YoloFlip;
    await yoloFlip.waitForDeployment();

    await admin.sendTransaction({
      to: await yoloFlip.getAddress(),
      value: ethers.parseEther("10"),
    });
  });

  it("integration: full coinflip bet-settle cycle on local chain", async function () {
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const contractAddress = await yoloFlip.getAddress();
    const currentBlock = await ethers.provider.getBlockNumber();
    const commitLastBlock = BigInt(currentBlock + 100);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    const betAmount = ethers.parseEther("0.01");
    const betTx = await yoloFlip
      .connect(player)
      .placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, { value: betAmount });
    const betReceipt = await betTx.wait();
    expect(betReceipt).to.not.equal(null);

    const betPlacedFilter = yoloFlip.filters.BetPlaced(commit);
    const betPlacedEvents = await yoloFlip.queryFilter(betPlacedFilter, betReceipt!.blockNumber);
    expect(betPlacedEvents).to.have.length(1, "BetPlaced event should be emitted");
    expect(betPlacedEvents[0].args.gambler).to.equal(player.address);

    await mine(1);

    const block = await ethers.provider.getBlock(betReceipt!.blockNumber);
    const blockHash = block!.hash!;

    const settleTx = await yoloFlip.connect(croupier).settleBet(reveal, blockHash);
    const settleReceipt = await settleTx.wait();
    expect(settleReceipt).to.not.equal(null);

    const betSettledFilter = yoloFlip.filters.BetSettled(commit);
    const betSettledEvents = await yoloFlip.queryFilter(betSettledFilter, settleReceipt!.blockNumber);
    expect(betSettledEvents).to.have.length(1, "BetSettled event should be emitted");
    expect(betSettledEvents[0].args.gambler).to.equal(player.address);

    const lockedAfter = await yoloFlip.lockedInBets(ethers.ZeroAddress);
    expect(lockedAfter).to.equal(0n, "lockedInBets should be 0 after settlement");

    const bet = await yoloFlip.bets(commit);
    expect(bet.amount).to.equal(0n, "Bet should be cleared after settlement");

    console.log(
      `[Integration] Coinflip bet settled. Dice: ${betSettledEvents[0].args.dice}, Payout: ${ethers.formatEther(
        betSettledEvents[0].args.payout,
      )} ETH`,
    );
  });

  it("integration: full dice bet-settle cycle (3 faces selected)", async function () {
    const betMask = 21n;
    const modulo = 6n;

    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const contractAddress = await yoloFlip.getAddress();
    const currentBlock = await ethers.provider.getBlockNumber();
    const commitLastBlock = BigInt(currentBlock + 100);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    const betAmount = ethers.parseEther("0.01");
    const betTx = await yoloFlip
      .connect(player)
      .placeBet(betMask, modulo, false, commitLastBlock, commit, v, r, s, { value: betAmount });
    const betReceipt = await betTx.wait();

    await mine(1);
    const block = await ethers.provider.getBlock(betReceipt!.blockNumber);
    const blockHash = block!.hash!;

    const settleTx = await yoloFlip.connect(croupier).settleBet(reveal, blockHash);
    const settleReceipt = await settleTx.wait();

    const events = await yoloFlip.queryFilter(yoloFlip.filters.BetSettled(commit), settleReceipt!.blockNumber);
    expect(events).to.have.length(1);

    const dice = events[0].args.dice;
    const payout = events[0].args.payout;

    const entropy = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reveal, blockHash]);
    const expectedDice = BigInt(entropy) % modulo;
    expect(dice).to.equal(expectedDice, "Dice result should match entropy calculation");

    const wasWin = ((1n << expectedDice) & betMask) !== 0n;
    if (wasWin) {
      expect(payout).to.be.gt(0n, "Payout should be > 0 for a win");
    } else {
      expect(payout).to.equal(0n, "Payout should be 0 for a loss");
    }

    console.log(
      `[Integration] Dice bet settled. Dice: ${dice}, Win: ${wasWin}, Payout: ${ethers.formatEther(payout)} ETH`,
    );
  });

  it("integration: timeout refund after 256 blocks (player gets full bet amount)", async function () {
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const contractAddress = await yoloFlip.getAddress();
    const currentBlock = await ethers.provider.getBlockNumber();
    const commitLastBlock = BigInt(currentBlock + 100);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    const betAmount = ethers.parseEther("0.05");
    const betTx = await yoloFlip.connect(player).placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, {
      value: betAmount,
    });
    await betTx.wait();

    const lockedBefore = await yoloFlip.lockedInBets(ethers.ZeroAddress);
    expect(lockedBefore).to.be.gt(0n, "lockedInBets should be > 0 after placing bet");

    await mine(257);

    const playerBalanceBefore = await ethers.provider.getBalance(player.address);
    const refundTx = await yoloFlip.connect(player).refundBet(commit);
    const refundReceipt = await refundTx.wait();
    expect(refundReceipt).to.not.equal(null);

    const refundEvents = await yoloFlip.queryFilter(yoloFlip.filters.BetRefunded(commit), refundReceipt!.blockNumber);
    expect(refundEvents).to.have.length(1, "BetRefunded event should be emitted");
    expect(refundEvents[0].args.gambler).to.equal(player.address);
    expect(refundEvents[0].args.amount).to.equal(betAmount, "Refund amount should equal original bet");

    const playerBalanceAfter = await ethers.provider.getBalance(player.address);
    const gasPrice = refundReceipt!.gasPrice ?? 0n;
    const gasCost = refundReceipt!.gasUsed * gasPrice;
    const netReceived = playerBalanceAfter - playerBalanceBefore + gasCost;
    expect(netReceived).to.equal(betAmount, "Player should receive full bet amount back");

    const lockedAfter = await yoloFlip.lockedInBets(ethers.ZeroAddress);
    expect(lockedAfter).to.equal(0n, "lockedInBets should be 0 after refund");

    console.log(`[Integration] Timeout refund succeeded. Player received ${ethers.formatEther(betAmount)} ETH back.`);
  });
});
