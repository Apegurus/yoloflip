import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { HDNodeWallet, Signer, TransactionReceipt, Wallet } from "ethers";
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

describe("YoloFlip", function () {
  let yoloFlip: YoloFlip;
  let admin: HardhatEthersSigner;
  let croupier: HardhatEthersSigner;
  let player: HardhatEthersSigner;
  let badActor: HardhatEthersSigner;
  let etherlessPlayer: HardhatEthersSigner;
  let secretSignerWallet: Wallet | HDNodeWallet;

  const houseEdgeBP = 200n;
  const minBetAmount = ethers.parseEther("0.001");
  const defaultBetAmount = ethers.parseEther("0.01");

  async function placeBet(opts: {
    player: Signer;
    betMask: bigint;
    modulo: bigint;
    betAmount?: bigint;
    commitLastBlock?: bigint;
    reveal?: bigint;
    signerWallet?: Wallet | HDNodeWallet;
    commitOverride?: bigint;
  }): Promise<{
    commit: bigint;
    reveal: bigint;
    tx: Awaited<ReturnType<YoloFlip["placeBet"]>>;
    receipt: TransactionReceipt;
  }> {
    const contractAddress = await yoloFlip.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = opts.commitLastBlock ?? BigInt(block!.number + 100);
    const reveal = opts.reveal ?? generateReveal();
    const commit = opts.commitOverride ?? revealToCommit(reveal);
    const signerWallet = opts.signerWallet ?? secretSignerWallet;
    const { v, r, s } = await signCommit(signerWallet, commitLastBlock, commit, contractAddress);
    const betAmount = opts.betAmount ?? defaultBetAmount;

    const tx = await yoloFlip
      .connect(opts.player)
      .placeBet(opts.betMask, opts.modulo, commitLastBlock, commit, v, r, s, { value: betAmount });
    const receipt = await tx.wait();
    return { commit, reveal, tx, receipt: receipt! };
  }

  async function settleBet(reveal: bigint, placeBlockNumber: number) {
    await mine(1);
    const block = await ethers.provider.getBlock(placeBlockNumber);
    const blockHash = block!.hash!;
    const tx = await yoloFlip.connect(croupier).settleBet(reveal, blockHash);
    const receipt = await tx.wait();
    return { tx, receipt: receipt!, blockHash };
  }

  function popCount(mask: bigint): bigint {
    let n = mask;
    let count = 0n;
    while (n > 0n) {
      count += n & 1n;
      n >>= 1n;
    }
    return count;
  }

  async function findOutcomeBet(
    desiredWin: boolean,
    betMask: bigint,
    modulo: bigint,
  ): Promise<{ commit: bigint; reveal: bigint; receipt: TransactionReceipt; dice: bigint; blockHash: string }> {
    for (let i = 0; i < 40; i++) {
      const reveal = generateReveal();
      const placed = await placeBet({ player, betMask, modulo, reveal });
      const placeBlock = await ethers.provider.getBlock(placed.receipt.blockNumber);
      const blockHash = placeBlock!.hash!;
      const entropy = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reveal, blockHash]);
      const dice = BigInt(entropy) % modulo;
      const win = modulo <= 40n ? ((1n << dice) & betMask) !== 0n : dice < betMask;
      if (win === desiredWin) {
        return { ...placed, dice, blockHash };
      }

      await mine(257);
      await yoloFlip.connect(player).refundBet(placed.commit);
    }

    throw new Error(`Could not find ${desiredWin ? "winning" : "losing"} reveal`);
  }

  beforeEach(async function () {
    [admin, croupier, player, badActor, etherlessPlayer] = await ethers.getSigners();
    secretSignerWallet = ethers.Wallet.createRandom();

    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    yoloFlip = (await YoloFlipFactory.connect(admin).deploy(
      admin.address,
      croupier.address,
      secretSignerWallet.address,
      houseEdgeBP,
      minBetAmount,
    )) as YoloFlip;
    await yoloFlip.waitForDeployment();

    await admin.sendTransaction({ to: await yoloFlip.getAddress(), value: ethers.parseEther("10") });
    await ethers.provider.send("hardhat_setBalance", [etherlessPlayer.address, "0x0"]);
  });

  it("should place a coinflip bet (mod 2, heads=betMask 1)", async function () {
    const beforeLocked = await yoloFlip.lockedInBets();
    const { commit, tx } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const afterLocked = await yoloFlip.lockedInBets();
    const bet = await yoloFlip.bets(commit);

    await expect(tx).to.emit(yoloFlip, "BetPlaced").withArgs(commit, player.address, defaultBetAmount, 1n, 2n);
    expect(afterLocked).to.be.gt(beforeLocked);
    expect(bet.gambler).to.equal(player.address);
    expect(bet.modulo).to.equal(2n);
  });

  it("should place a dice bet (mod 6, faces 1,3,5 = betMask 0b010101)", async function () {
    const { commit } = await placeBet({ player, betMask: 21n, modulo: 6n });
    const bet = await yoloFlip.bets(commit);

    expect(bet.mask).to.equal(21n);
    expect(bet.rollUnder).to.equal(3n);
    expect(bet.modulo).to.equal(6n);
  });

  it("should place a range bet (mod 100, under 50)", async function () {
    const { commit } = await placeBet({ player, betMask: 50n, modulo: 100n });
    const bet = await yoloFlip.bets(commit);

    expect(bet.rollUnder).to.equal(50n);
    expect(bet.mask).to.equal(0n);
    expect(bet.modulo).to.equal(100n);
  });

  it("should revert on invalid modulo (0)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 0n, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidModulo");
  });

  it("should revert on invalid modulo (1)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 1n, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidModulo");
  });

  it("should revert on invalid modulo (> 100)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 101n, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidModulo");
  });

  it("should revert on invalid bitmask (0 for mod <= 40)", async function () {
    await expect(placeBet({ player, betMask: 0n, modulo: 2n })).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidBetMask",
    );
  });

  it("should revert on all-faces bitmask (guaranteed win, rollUnder >= modulo)", async function () {
    await expect(placeBet({ player, betMask: 3n, modulo: 2n })).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidBetMask",
    );
  });

  it("should revert on bet below minBet", async function () {
    await expect(placeBet({ player, betMask: 1n, modulo: 2n, betAmount: 100n })).to.be.revertedWithCustomError(
      yoloFlip,
      "BetTooSmall",
    );
  });

  it("should accept a valid ECDSA signature", async function () {
    const { commit, tx } = await placeBet({ player, betMask: 1n, modulo: 2n });
    await expect(tx).to.emit(yoloFlip, "BetPlaced").withArgs(commit, player.address, defaultBetAmount, 1n, 2n);
  });

  it("should revert on invalid signature (wrong signer)", async function () {
    await expect(
      placeBet({ player, betMask: 1n, modulo: 2n, signerWallet: ethers.Wallet.createRandom() }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidSignature");
  });

  it("should revert on expired commit (past commitLastBlock)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const expiredCommitLastBlock = BigInt(block!.number - 1);
    await expect(
      placeBet({ player, betMask: 1n, modulo: 2n, commitLastBlock: expiredCommitLastBlock }),
    ).to.be.revertedWithCustomError(yoloFlip, "CommitExpired");
  });

  it("should revert on replay of same commit", async function () {
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await yoloFlip.connect(player).placeBet(1n, 2n, commitLastBlock, commit, v, r, s, { value: defaultBetAmount });
    await expect(
      yoloFlip.connect(player).placeBet(1n, 2n, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "BetAlreadyExists");
  });

  it("should settle a coinflip win and send payout", async function () {
    const winning = await findOutcomeBet(true, 1n, 2n);
    const beforeBalance = await ethers.provider.getBalance(player.address);
    const tx = await yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash);
    const receipt = await tx.wait();
    const afterBalance = await ethers.provider.getBalance(player.address);
    const expectedPayout = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout);

    expect(receipt).to.not.equal(null);
    expect(afterBalance - beforeBalance).to.equal(expectedPayout);
  });

  it("should settle a coinflip loss with zero payout", async function () {
    const losing = await findOutcomeBet(false, 1n, 2n);
    const beforeBalance = await ethers.provider.getBalance(player.address);
    const tx = await yoloFlip.connect(croupier).settleBet(losing.reveal, losing.blockHash);
    const afterBalance = await ethers.provider.getBalance(player.address);

    await expect(tx).to.emit(yoloFlip, "BetSettled").withArgs(losing.commit, player.address, losing.dice, 0n);
    expect(afterBalance - beforeBalance).to.equal(0n);
  });

  it("should calculate correct dice win payout (mod 6, 3 faces)", async function () {
    const winning = await findOutcomeBet(true, 21n, 6n);
    const rollUnder = popCount(21n);
    const expectedPayout = (defaultBetAmount * (10000n - houseEdgeBP) * 6n) / rollUnder / 10000n;

    await expect(yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash))
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout);
  });

  it("should track lockedInBets correctly (increase on place, decrease on settle)", async function () {
    const before = await yoloFlip.lockedInBets();
    const { reveal, receipt } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const afterPlace = await yoloFlip.lockedInBets();
    const possibleWin = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);

    expect(afterPlace - before).to.equal(possibleWin);

    await settleBet(reveal, receipt.blockNumber);
    const afterSettle = await yoloFlip.lockedInBets();
    expect(afterSettle).to.equal(before);
  });

  it("should allow refund after BET_EXPIRATION_BLOCKS", async function () {
    const { commit } = await placeBet({ player, betMask: 1n, modulo: 2n });
    await mine(257);

    const beforeBalance = await ethers.provider.getBalance(player.address);
    const tx = await yoloFlip.connect(player).refundBet(commit);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const afterBalance = await ethers.provider.getBalance(player.address);

    await expect(tx).to.emit(yoloFlip, "BetRefunded").withArgs(commit, player.address, defaultBetAmount);
    expect(afterBalance - beforeBalance + gasCost).to.equal(defaultBetAmount);
  });

  it("should revert refund before expiration", async function () {
    const { commit } = await placeBet({ player, betMask: 1n, modulo: 2n });
    await mine(1);

    await expect(yoloFlip.connect(player).refundBet(commit)).to.be.revertedWithCustomError(yoloFlip, "BetNotExpired");
  });

  it("should block placeBet when paused, allow settleBet/refundBet", async function () {
    const settleCandidate = await placeBet({ player, betMask: 1n, modulo: 2n });
    const refundable = await placeBet({ player: badActor, betMask: 1n, modulo: 2n });
    await yoloFlip.connect(admin).pause();

    await expect(placeBet({ player, betMask: 1n, modulo: 2n })).to.be.revertedWithCustomError(
      yoloFlip,
      "EnforcedPause",
    );

    await expect(settleBet(settleCandidate.reveal, settleCandidate.receipt.blockNumber)).to.not.be.reverted;

    await mine(257);
    await expect(yoloFlip.connect(badActor).refundBet(refundable.commit))
      .to.emit(yoloFlip, "BetRefunded")
      .withArgs(refundable.commit, badActor.address, defaultBetAmount);
  });

  it("should credit pendingPayouts if payout fails", async function () {
    const rejectorAddress = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [rejectorAddress, "0x60006000fd"]);
    await ethers.provider.send("hardhat_setBalance", [rejectorAddress, "0x3635C9ADC5DEA00000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [rejectorAddress]);
    const rejectorSigner = await ethers.getSigner(rejectorAddress);

    let winningBet: { commit: bigint; reveal: bigint; blockHash: string } | null = null;
    let refundedLosingBets = 0n;
    for (let i = 0; i < 40; i++) {
      const reveal = generateReveal();
      const placed = await placeBet({ player: rejectorSigner, betMask: 1n, modulo: 2n, reveal });
      const placeBlock = await ethers.provider.getBlock(placed.receipt.blockNumber);
      const blockHash = placeBlock!.hash!;
      const entropy = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reveal, blockHash]);
      const dice = BigInt(entropy) % 2n;
      if (dice === 0n) {
        winningBet = { commit: placed.commit, reveal, blockHash };
        break;
      }
      await mine(257);
      await yoloFlip.connect(rejectorSigner).refundBet(placed.commit);
      refundedLosingBets += 1n;
    }

    expect(winningBet).to.not.equal(null);
    await yoloFlip.connect(croupier).settleBet(winningBet!.reveal, winningBet!.blockHash);

    const expectedWinPayout = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);
    const expectedPending = expectedWinPayout + refundedLosingBets * defaultBetAmount;
    expect(await yoloFlip.pendingPayouts(rejectorAddress)).to.equal(expectedPending);

    await ethers.provider.send("hardhat_setCode", [rejectorAddress, "0x"]);
    const before = await ethers.provider.getBalance(rejectorAddress);
    const claimTx = await yoloFlip.connect(rejectorSigner).claimPendingPayout();
    const claimReceipt = await claimTx.wait();
    const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
    const after = await ethers.provider.getBalance(rejectorAddress);

    expect(after - before + gasCost).to.equal(expectedPending);
    expect(await yoloFlip.pendingPayouts(rejectorAddress)).to.equal(0n);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [rejectorAddress]);
  });

  it("should allow admin to withdraw available funds (balance - lockedInBets)", async function () {
    await placeBet({ player, betMask: 1n, modulo: 2n });

    const balance = await ethers.provider.getBalance(await yoloFlip.getAddress());
    const locked = await yoloFlip.lockedInBets();
    const available = balance - locked;

    await expect(
      yoloFlip.connect(admin).withdrawHouseFunds(admin.address, available + 1n),
    ).to.be.revertedWithCustomError(yoloFlip, "WithdrawTooLarge");

    const before = await ethers.provider.getBalance(admin.address);
    const tx = await yoloFlip.connect(admin).withdrawHouseFunds(admin.address, available);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const after = await ethers.provider.getBalance(admin.address);

    expect(after - before + gasCost).to.equal(available);
  });

  it("should reject house edge above 500 BPS", async function () {
    await expect(yoloFlip.connect(admin).setHouseEdge(501n)).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidHouseEdge",
    );

    await expect(yoloFlip.connect(admin).setHouseEdge(500n)).to.emit(yoloFlip, "HouseEdgeChanged").withArgs(500n);

    expect(await yoloFlip.houseEdgeBP()).to.equal(500n);
  });

  it("should reject non-croupier calling settleBet", async function () {
    const { reveal, receipt } = await placeBet({ player, betMask: 1n, modulo: 2n });
    await mine(1);
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const croupierRole = await yoloFlip.CROUPIER_ROLE();

    await expect(yoloFlip.connect(player).settleBet(reveal, block!.hash!))
      .to.be.revertedWithCustomError(yoloFlip, "AccessControlUnauthorizedAccount")
      .withArgs(player.address, croupierRole);
  });
});
