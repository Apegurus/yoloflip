import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { HDNodeWallet, Signer, TransactionReceipt, Wallet } from "ethers";
import type { YoloFlip, MockERC20 } from "../typechain-types";

const ETH_TOKEN = ethers.ZeroAddress;

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
  let mockToken: MockERC20;
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
    betOver?: boolean;
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
    const betOver = opts.betOver ?? false;

    const tx = await yoloFlip
      .connect(opts.player)
      .placeBet(opts.betMask, opts.modulo, betOver, commitLastBlock, commit, v, r, s, { value: betAmount });
    const receipt = await tx.wait();
    return { commit, reveal, tx, receipt: receipt! };
  }

  async function placeBetWithToken(opts: {
    player: HardhatEthersSigner;
    betMask: bigint;
    modulo: bigint;
    betOver?: boolean;
    betAmount?: bigint;
    token?: MockERC20;
    reveal?: bigint;
  }): Promise<{
    commit: bigint;
    reveal: bigint;
    tx: Awaited<ReturnType<YoloFlip["placeBetWithToken"]>>;
    receipt: TransactionReceipt;
  }> {
    const contractAddress = await yoloFlip.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = opts.reveal ?? generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);
    const betAmount = opts.betAmount ?? defaultBetAmount;
    const betOver = opts.betOver ?? false;
    const token = opts.token ?? mockToken;

    await token.connect(opts.player).approve(contractAddress, betAmount);

    const tx = await yoloFlip
      .connect(opts.player)
      .placeBetWithToken(
        opts.betMask,
        opts.modulo,
        betOver,
        await token.getAddress(),
        betAmount,
        commitLastBlock,
        commit,
        v,
        r,
        s,
      );
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
    betOver = false,
  ): Promise<{ commit: bigint; reveal: bigint; receipt: TransactionReceipt; dice: bigint; blockHash: string }> {
    for (let i = 0; i < 40; i++) {
      const reveal = generateReveal();
      const placed = await placeBet({ player, betMask, modulo, reveal, betOver });
      const placeBlock = await ethers.provider.getBlock(placed.receipt.blockNumber);
      const blockHash = placeBlock!.hash!;
      const entropy = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reveal, blockHash]);
      const dice = BigInt(entropy) % modulo;

      let win: boolean;
      if (modulo <= 40n) {
        win = ((1n << dice) & betMask) !== 0n;
      } else if (betOver) {
        // rollUnder = modulo - 1 - betMask (count of winning outcomes)
        win = dice >= modulo - (modulo - 1n - betMask);
      } else {
        win = dice < betMask;
      }

      if (win === desiredWin) {
        return { ...placed, dice, blockHash };
      }

      await mine(257);
      await yoloFlip.connect(player).refundBet(placed.commit);
    }

    throw new Error(`Could not find ${desiredWin ? "winning" : "losing"} reveal`);
  }

  async function findOutcomeTokenBet(
    desiredWin: boolean,
    betMask: bigint,
    modulo: bigint,
    betOver = false,
  ): Promise<{ commit: bigint; reveal: bigint; receipt: TransactionReceipt; dice: bigint; blockHash: string }> {
    for (let i = 0; i < 40; i++) {
      const reveal = generateReveal();
      const placed = await placeBetWithToken({ player, betMask, modulo, reveal, betOver });
      const placeBlock = await ethers.provider.getBlock(placed.receipt.blockNumber);
      const blockHash = placeBlock!.hash!;
      const entropy = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reveal, blockHash]);
      const dice = BigInt(entropy) % modulo;

      let win: boolean;
      if (modulo <= 40n) {
        win = ((1n << dice) & betMask) !== 0n;
      } else if (betOver) {
        win = dice >= modulo - (modulo - 1n - betMask);
      } else {
        win = dice < betMask;
      }

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

    // Deploy and set up mock ERC20
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = (await MockERC20Factory.deploy("TestToken", "TT")) as MockERC20;
    await mockToken.waitForDeployment();

    // Whitelist the token
    await yoloFlip.connect(admin).setAllowedToken(await mockToken.getAddress(), true);

    // Mint tokens to player and fund the house
    const tokenAmount = ethers.parseEther("1000");
    await mockToken.mint(player.address, tokenAmount);
    await mockToken.mint(await yoloFlip.getAddress(), ethers.parseEther("100")); // house bankroll
  });

  // ===================== ETH BETTING TESTS =====================

  it("should place a coinflip bet (mod 2, heads=betMask 1)", async function () {
    const beforeLocked = await yoloFlip.lockedInBets(ETH_TOKEN);
    const { commit, tx } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const afterLocked = await yoloFlip.lockedInBets(ETH_TOKEN);
    const bet = await yoloFlip.bets(commit);

    await expect(tx)
      .to.emit(yoloFlip, "BetPlaced")
      .withArgs(commit, player.address, defaultBetAmount, 1n, 2n, ETH_TOKEN, false);
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
    expect(bet.isOver).to.equal(false);
  });

  it("should revert on invalid modulo (0)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 0n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidModulo");
  });

  it("should revert on invalid modulo (1)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 1n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidModulo");
  });

  it("should revert on invalid modulo (> 100)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip.connect(player).placeBet(1n, 101n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
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
    await expect(tx)
      .to.emit(yoloFlip, "BetPlaced")
      .withArgs(commit, player.address, defaultBetAmount, 1n, 2n, ETH_TOKEN, false);
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

    await yoloFlip
      .connect(player)
      .placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount });
    await expect(
      yoloFlip.connect(player).placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
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
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout, 2n, ETH_TOKEN);

    expect(receipt).to.not.equal(null);
    expect(afterBalance - beforeBalance).to.equal(expectedPayout);
  });

  it("should settle a coinflip loss with zero payout", async function () {
    const losing = await findOutcomeBet(false, 1n, 2n);
    const beforeBalance = await ethers.provider.getBalance(player.address);
    const tx = await yoloFlip.connect(croupier).settleBet(losing.reveal, losing.blockHash);
    const afterBalance = await ethers.provider.getBalance(player.address);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(losing.commit, player.address, losing.dice, 0n, 2n, ETH_TOKEN);
    expect(afterBalance - beforeBalance).to.equal(0n);
  });

  it("should calculate correct dice win payout (mod 6, 3 faces)", async function () {
    const winning = await findOutcomeBet(true, 21n, 6n);
    const rollUnder = popCount(21n);
    const expectedPayout = (defaultBetAmount * (10000n - houseEdgeBP) * 6n) / rollUnder / 10000n;

    await expect(yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash))
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout, 6n, ETH_TOKEN);
  });

  it("should track lockedInBets correctly (increase on place, decrease on settle)", async function () {
    const before = await yoloFlip.lockedInBets(ETH_TOKEN);
    const { reveal, receipt } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const afterPlace = await yoloFlip.lockedInBets(ETH_TOKEN);
    const possibleWin = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);

    expect(afterPlace - before).to.equal(possibleWin);

    await settleBet(reveal, receipt.blockNumber);
    const afterSettle = await yoloFlip.lockedInBets(ETH_TOKEN);
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

    await expect(tx).to.emit(yoloFlip, "BetRefunded").withArgs(commit, player.address, defaultBetAmount, ETH_TOKEN);
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
      .withArgs(refundable.commit, badActor.address, defaultBetAmount, ETH_TOKEN);
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
    expect(await yoloFlip.pendingPayouts(rejectorAddress, ETH_TOKEN)).to.equal(expectedPending);

    await ethers.provider.send("hardhat_setCode", [rejectorAddress, "0x"]);
    const before = await ethers.provider.getBalance(rejectorAddress);
    const claimTx = await yoloFlip.connect(rejectorSigner).claimPendingPayout(ETH_TOKEN);
    const claimReceipt = await claimTx.wait();
    const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
    const after = await ethers.provider.getBalance(rejectorAddress);

    expect(after - before + gasCost).to.equal(expectedPending);
    expect(await yoloFlip.pendingPayouts(rejectorAddress, ETH_TOKEN)).to.equal(0n);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [rejectorAddress]);
  });

  it("should allow admin to withdraw available funds (balance - lockedInBets)", async function () {
    await placeBet({ player, betMask: 1n, modulo: 2n });

    const balance = await ethers.provider.getBalance(await yoloFlip.getAddress());
    const locked = await yoloFlip.lockedInBets(ETH_TOKEN);
    const available = balance - locked;

    await expect(
      yoloFlip.connect(admin).withdrawHouseFunds(admin.address, available + 1n, ETH_TOKEN),
    ).to.be.revertedWithCustomError(yoloFlip, "WithdrawTooLarge");

    const before = await ethers.provider.getBalance(admin.address);
    const tx = await yoloFlip.connect(admin).withdrawHouseFunds(admin.address, available, ETH_TOKEN);
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

  it("should revert claimPendingPayout when nothing is owed", async function () {
    await expect(yoloFlip.connect(player).claimPendingPayout(ETH_TOKEN)).to.be.revertedWithCustomError(
      yoloFlip,
      "NoPayoutPending",
    );
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

  it("should emit SecretSignerChanged when updating signer", async function () {
    const newSigner = ethers.Wallet.createRandom().address;
    await expect(yoloFlip.connect(admin).setSecretSigner(newSigner))
      .to.emit(yoloFlip, "SecretSignerChanged")
      .withArgs(newSigner);
    expect(await yoloFlip.secretSigner()).to.equal(newSigner);
  });

  it("should emit MinBetChanged when updating min bet", async function () {
    const newMinBet = ethers.parseEther("0.01");
    await expect(yoloFlip.connect(admin).setMinBet(newMinBet)).to.emit(yoloFlip, "MinBetChanged").withArgs(newMinBet);
    expect(await yoloFlip.minBetAmount()).to.equal(newMinBet);
  });

  it("should revert setMinBet with zero", async function () {
    await expect(yoloFlip.connect(admin).setMinBet(0n)).to.be.revertedWithCustomError(yoloFlip, "BetTooSmall");
  });

  it("should emit MaxProfitRatioChanged when updating max profit ratio", async function () {
    await expect(yoloFlip.connect(admin).setMaxProfitRatio(800n))
      .to.emit(yoloFlip, "MaxProfitRatioChanged")
      .withArgs(800n);
    expect(await yoloFlip.maxProfitRatio()).to.equal(800n);
  });

  it("should emit HouseFundsWithdrawn when withdrawing", async function () {
    const withdrawAmount = ethers.parseEther("1");
    await expect(yoloFlip.connect(admin).withdrawHouseFunds(admin.address, withdrawAmount, ETH_TOKEN))
      .to.emit(yoloFlip, "HouseFundsWithdrawn")
      .withArgs(admin.address, withdrawAmount, ETH_TOKEN);
  });

  it("should include modulo in BetSettled event", async function () {
    const winning = await findOutcomeBet(true, 1n, 2n);
    const tx = await yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash);
    const expectedPayout = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout, 2n, ETH_TOKEN);
  });

  // ===================== ROLL OVER TESTS =====================

  it("should place a roll-over bet (mod 100, over 50)", async function () {
    const { commit } = await placeBet({ player, betMask: 50n, modulo: 100n, betOver: true });
    const bet = await yoloFlip.bets(commit);

    // rollUnder stores winning outcome count: 100 - 1 - 50 = 49
    expect(bet.rollUnder).to.equal(49n);
    expect(bet.isOver).to.equal(true);
    expect(bet.modulo).to.equal(100n);
  });

  it("should settle a roll-over win correctly", async function () {
    // betMask=50, betOver=true → win if dice > 50 (dice ∈ {51..99}, 49 outcomes)
    const winning = await findOutcomeBet(true, 50n, 100n, true);
    const rollUnder = 49n; // 100 - 1 - 50
    const expectedPayout = await yoloFlip.getWinAmount(defaultBetAmount, 100n, rollUnder);

    const tx = await yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash);
    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout, 100n, ETH_TOKEN);

    // Verify the dice was actually > 50
    expect(winning.dice).to.be.gt(50n);
  });

  it("should settle a roll-over loss correctly", async function () {
    const losing = await findOutcomeBet(false, 50n, 100n, true);
    const tx = await yoloFlip.connect(croupier).settleBet(losing.reveal, losing.blockHash);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(losing.commit, player.address, losing.dice, 0n, 100n, ETH_TOKEN);

    // Verify the dice was <= 50
    expect(losing.dice).to.be.lte(50n);
  });

  it("should revert roll-over with betMask >= modulo - 1", async function () {
    // betMask=99 with betOver on mod 100 → over 99 = 0 winning outcomes
    await expect(placeBet({ player, betMask: 99n, modulo: 100n, betOver: true })).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidBetMask",
    );
  });

  it("should ignore betOver for bitmask modulo (mod <= 40)", async function () {
    // betOver is stored as false for modulo <= 40
    const { commit } = await placeBet({ player, betMask: 1n, modulo: 2n, betOver: true });
    const bet = await yoloFlip.bets(commit);
    expect(bet.isOver).to.equal(false);
  });

  // ===================== ERC20 TOKEN BETTING TESTS =====================

  it("should place an ERC20 token bet", async function () {
    const tokenAddr = await mockToken.getAddress();
    const { commit, tx } = await placeBetWithToken({ player, betMask: 1n, modulo: 2n });

    await expect(tx)
      .to.emit(yoloFlip, "BetPlaced")
      .withArgs(commit, player.address, defaultBetAmount, 1n, 2n, tokenAddr, false);

    const bet = await yoloFlip.bets(commit);
    expect(bet.token).to.equal(tokenAddr);
    expect(bet.amount).to.equal(defaultBetAmount);
    expect(bet.gambler).to.equal(player.address);
  });

  it("should track lockedInBets per token", async function () {
    const tokenAddr = await mockToken.getAddress();
    const beforeETH = await yoloFlip.lockedInBets(ETH_TOKEN);
    const beforeToken = await yoloFlip.lockedInBets(tokenAddr);

    await placeBet({ player, betMask: 1n, modulo: 2n });
    await placeBetWithToken({ player, betMask: 1n, modulo: 2n });

    const afterETH = await yoloFlip.lockedInBets(ETH_TOKEN);
    const afterToken = await yoloFlip.lockedInBets(tokenAddr);

    expect(afterETH).to.be.gt(beforeETH);
    expect(afterToken).to.be.gt(beforeToken);
  });

  it("should settle an ERC20 token win and transfer tokens", async function () {
    const tokenAddr = await mockToken.getAddress();
    const winning = await findOutcomeTokenBet(true, 1n, 2n);

    const beforeBalance = await mockToken.balanceOf(player.address);
    const tx = await yoloFlip.connect(croupier).settleBet(winning.reveal, winning.blockHash);
    const afterBalance = await mockToken.balanceOf(player.address);
    const expectedPayout = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(winning.commit, player.address, winning.dice, expectedPayout, 2n, tokenAddr);

    expect(afterBalance - beforeBalance).to.equal(expectedPayout);
  });

  it("should settle an ERC20 token loss with zero payout", async function () {
    const tokenAddr = await mockToken.getAddress();
    const losing = await findOutcomeTokenBet(false, 1n, 2n);

    const beforeBalance = await mockToken.balanceOf(player.address);
    const tx = await yoloFlip.connect(croupier).settleBet(losing.reveal, losing.blockHash);
    const afterBalance = await mockToken.balanceOf(player.address);

    await expect(tx)
      .to.emit(yoloFlip, "BetSettled")
      .withArgs(losing.commit, player.address, losing.dice, 0n, 2n, tokenAddr);

    expect(afterBalance - beforeBalance).to.equal(0n);
  });

  it("should refund an ERC20 token bet after expiration", async function () {
    const tokenAddr = await mockToken.getAddress();
    const { commit } = await placeBetWithToken({ player, betMask: 1n, modulo: 2n });
    await mine(257);

    const beforeBalance = await mockToken.balanceOf(player.address);
    const tx = await yoloFlip.connect(player).refundBet(commit);
    const afterBalance = await mockToken.balanceOf(player.address);

    await expect(tx).to.emit(yoloFlip, "BetRefunded").withArgs(commit, player.address, defaultBetAmount, tokenAddr);

    expect(afterBalance - beforeBalance).to.equal(defaultBetAmount);
  });

  it("should revert placeBetWithToken for non-whitelisted token", async function () {
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const badToken = (await MockERC20Factory.deploy("Bad", "BAD")) as MockERC20;
    await badToken.mint(player.address, ethers.parseEther("100"));

    const contractAddress = await yoloFlip.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    await badToken.connect(player).approve(contractAddress, defaultBetAmount);

    await expect(
      yoloFlip
        .connect(player)
        .placeBetWithToken(
          1n,
          2n,
          false,
          await badToken.getAddress(),
          defaultBetAmount,
          commitLastBlock,
          commit,
          v,
          r,
          s,
        ),
    ).to.be.revertedWithCustomError(yoloFlip, "TokenNotAllowed");
  });

  it("should revert placeBetWithToken with ETH address", async function () {
    const contractAddress = await yoloFlip.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    await expect(
      yoloFlip
        .connect(player)
        .placeBetWithToken(1n, 2n, false, ETH_TOKEN, defaultBetAmount, commitLastBlock, commit, v, r, s),
    ).to.be.revertedWithCustomError(yoloFlip, "InvalidTokenBet");
  });

  it("should withdraw ERC20 house funds", async function () {
    const tokenAddr = await mockToken.getAddress();
    const houseBankroll = await mockToken.balanceOf(await yoloFlip.getAddress());

    const beforeBalance = await mockToken.balanceOf(admin.address);
    await yoloFlip.connect(admin).withdrawHouseFunds(admin.address, houseBankroll, tokenAddr);
    const afterBalance = await mockToken.balanceOf(admin.address);

    expect(afterBalance - beforeBalance).to.equal(houseBankroll);
  });

  it("should emit TokenAllowed when whitelisting", async function () {
    const newToken = ethers.Wallet.createRandom().address;
    await expect(yoloFlip.connect(admin).setAllowedToken(newToken, true))
      .to.emit(yoloFlip, "TokenAllowed")
      .withArgs(newToken, true);
    expect(await yoloFlip.allowedTokens(newToken)).to.equal(true);

    await expect(yoloFlip.connect(admin).setAllowedToken(newToken, false))
      .to.emit(yoloFlip, "TokenAllowed")
      .withArgs(newToken, false);
    expect(await yoloFlip.allowedTokens(newToken)).to.equal(false);
  });

  it("should revert setAllowedToken for ETH address", async function () {
    await expect(yoloFlip.connect(admin).setAllowedToken(ETH_TOKEN, true)).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidTokenBet",
    );
  });

  it("should support ERC20 roll-over bet", async function () {
    const tokenAddr = await mockToken.getAddress();
    const { commit } = await placeBetWithToken({ player, betMask: 50n, modulo: 100n, betOver: true });
    const bet = await yoloFlip.bets(commit);

    expect(bet.isOver).to.equal(true);
    expect(bet.rollUnder).to.equal(49n);
    expect(bet.token).to.equal(tokenAddr);
  });

  it("should report maxWin per token", async function () {
    const tokenAddr = await mockToken.getAddress();
    const ethMaxWin = await yoloFlip.maxWin(ETH_TOKEN);
    const tokenMaxWin = await yoloFlip.maxWin(tokenAddr);

    expect(ethMaxWin).to.be.gt(0n);
    expect(tokenMaxWin).to.be.gt(0n);
  });

  // ===================== SECURITY FIX TESTS =====================

  it("H1: should revert constructor with zero admin address", async function () {
    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    await expect(
      YoloFlipFactory.deploy(
        ethers.ZeroAddress,
        croupier.address,
        secretSignerWallet.address,
        houseEdgeBP,
        minBetAmount,
      ),
    ).to.be.revertedWithCustomError(yoloFlip, "ZeroAddress");
  });

  it("H1: should revert constructor with zero croupier address", async function () {
    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    await expect(
      YoloFlipFactory.deploy(admin.address, ethers.ZeroAddress, secretSignerWallet.address, houseEdgeBP, minBetAmount),
    ).to.be.revertedWithCustomError(yoloFlip, "ZeroAddress");
  });

  it("H1: should revert constructor with zero secretSigner address", async function () {
    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    await expect(
      YoloFlipFactory.deploy(admin.address, croupier.address, ethers.ZeroAddress, houseEdgeBP, minBetAmount),
    ).to.be.revertedWithCustomError(yoloFlip, "ZeroAddress");
  });

  it("H1: should revert constructor with zero minBetAmount", async function () {
    const YoloFlipFactory = await ethers.getContractFactory("YoloFlip");
    await expect(
      YoloFlipFactory.deploy(admin.address, croupier.address, secretSignerWallet.address, houseEdgeBP, 0n),
    ).to.be.revertedWithCustomError(yoloFlip, "BetTooSmall");
  });

  it("C1: should revert when commitLastBlock exceeds uint40 max (truncation bypass)", async function () {
    const block = await ethers.provider.getBlock("latest");
    const validCommitLastBlock = BigInt(block!.number + 100);
    // Add 2^40 to bypass truncation — signature would still verify but expiry is extended
    const attackerCommitLastBlock = validCommitLastBlock + (1n << 40n);

    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const { v, r, s } = await signCommit(secretSignerWallet, validCommitLastBlock, commit, await yoloFlip.getAddress());

    await expect(
      yoloFlip
        .connect(player)
        .placeBet(1n, 2n, false, attackerCommitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "CommitExpired");
  });

  it("C3: should revert when bitmask has out-of-range bits (modulo=6, bit 10 set)", async function () {
    // Bit 10 is outside modulo 6 range (0-5). Would inflate popcount → wrong payout odds.
    const outOfRangeMask = (1n << 10n) | (1n << 0n); // bits 0 and 10
    await expect(placeBet({ player, betMask: outOfRangeMask, modulo: 6n })).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidBetMask",
    );
  });

  it("C2: should handle houseEdge change mid-flight without lockedInBets drift (settle)", async function () {
    const { reveal, receipt } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const lockedAfterPlace = await yoloFlip.lockedInBets(ETH_TOKEN);
    expect(lockedAfterPlace).to.be.gt(0n);

    // Change house edge while bet is in flight
    await yoloFlip.connect(admin).setHouseEdge(500n); // 5% instead of 2%

    // Settle the bet — lockedInBets should return to 0 regardless of edge change
    await settleBet(reveal, receipt.blockNumber);
    const lockedAfterSettle = await yoloFlip.lockedInBets(ETH_TOKEN);
    expect(lockedAfterSettle).to.equal(0n);
  });

  it("C2: should handle houseEdge change mid-flight without lockedInBets drift (refund)", async function () {
    const { commit } = await placeBet({ player, betMask: 1n, modulo: 2n });
    const lockedAfterPlace = await yoloFlip.lockedInBets(ETH_TOKEN);
    expect(lockedAfterPlace).to.be.gt(0n);

    // Change house edge while bet is in flight
    await yoloFlip.connect(admin).setHouseEdge(500n);

    // Expire and refund — lockedInBets should return to 0
    await mine(257);
    await yoloFlip.connect(player).refundBet(commit);
    const lockedAfterRefund = await yoloFlip.lockedInBets(ETH_TOKEN);
    expect(lockedAfterRefund).to.equal(0n);
  });

  // ===================== ADDITIONAL COVERAGE TESTS =====================

  it("L9: should place and settle a roulette bet (mod 37, red numbers bitmask)", async function () {
    // Red numbers in European roulette: 1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
    const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
    let redMask = 0n;
    for (const n of redNumbers) {
      redMask |= 1n << BigInt(n);
    }
    // 18 numbers selected out of 37
    const { commit } = await placeBet({ player, betMask: redMask, modulo: 37n });
    const bet = await yoloFlip.bets(commit);
    expect(bet.modulo).to.equal(37n);
    expect(bet.rollUnder).to.equal(18n); // popcount of 18 red numbers
  });

  it("L9: should reject bet exceeding maxProfit", async function () {
    // Set maxProfitRatio very low so a standard bet exceeds it
    await yoloFlip.connect(admin).setMaxProfitRatio(1n); // 0.01% of bankroll

    // A coinflip bet with modulo=2, rollUnder=1 has ~2x payout
    // With 10 ETH bankroll and 0.01% ratio, max profit = 0.001 ETH
    // A 0.01 ETH bet would profit ~0.0096 ETH, exceeding 0.001 ETH
    await expect(placeBet({ player, betMask: 1n, modulo: 2n })).to.be.revertedWithCustomError(
      yoloFlip,
      "ProfitExceedsMax",
    );

    // Restore
    await yoloFlip.connect(admin).setMaxProfitRatio(500n);
  });

  it("L9: should handle concurrent bets from the same player", async function () {
    const bet1 = await placeBet({ player, betMask: 1n, modulo: 2n });
    const bet2 = await placeBet({ player, betMask: 2n, modulo: 2n });

    const locked = await yoloFlip.lockedInBets(ETH_TOKEN);
    const possibleWin = await yoloFlip.getWinAmount(defaultBetAmount, 2n, 1n);
    expect(locked).to.equal(possibleWin * 2n);

    // Settle both
    await settleBet(bet1.reveal, bet1.receipt.blockNumber);
    await settleBet(bet2.reveal, bet2.receipt.blockNumber);
    expect(await yoloFlip.lockedInBets(ETH_TOKEN)).to.equal(0n);
  });

  it("L1: should use per-token minBet when set", async function () {
    const tokenAddr = await mockToken.getAddress();
    const highMinBet = ethers.parseEther("1"); // 1 token minimum

    await yoloFlip.connect(admin).setTokenMinBet(tokenAddr, highMinBet);

    // Default bet amount (0.01) should now be too small for this token
    await expect(
      placeBetWithToken({ player, betMask: 1n, modulo: 2n, betAmount: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "BetTooSmall");

    // But ETH bets still use the global minimum
    await expect(placeBet({ player, betMask: 1n, modulo: 2n })).to.not.be.reverted;

    // Reset
    await yoloFlip.connect(admin).setTokenMinBet(tokenAddr, 0n);
  });

  it("L1: should emit TokenMinBetChanged", async function () {
    const tokenAddr = await mockToken.getAddress();
    await expect(yoloFlip.connect(admin).setTokenMinBet(tokenAddr, 100n))
      .to.emit(yoloFlip, "TokenMinBetChanged")
      .withArgs(tokenAddr, 100n);
    // Reset
    await yoloFlip.connect(admin).setTokenMinBet(tokenAddr, 0n);
  });

  it("M3: bankroll should exclude pending payouts", async function () {
    // Get initial maxWin
    const initialMaxWin = await yoloFlip.maxWin(ETH_TOKEN);

    // Create a rejector that will cause pendingPayouts to accumulate
    const rejectorAddress = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [rejectorAddress, "0x60006000fd"]);
    await ethers.provider.send("hardhat_setBalance", [rejectorAddress, "0x3635C9ADC5DEA00000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [rejectorAddress]);
    const rejectorSigner = await ethers.getSigner(rejectorAddress);

    // Find a winning bet for the rejector
    let winningBet: { commit: bigint; reveal: bigint; blockHash: string } | null = null;
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
    }
    expect(winningBet).to.not.equal(null);

    // Settle — payout fails, goes to pendingPayouts
    await yoloFlip.connect(croupier).settleBet(winningBet!.reveal, winningBet!.blockHash);

    const pending = await yoloFlip.pendingPayouts(rejectorAddress, ETH_TOKEN);
    expect(pending).to.be.gt(0n);

    // maxWin should now be reduced by the pending amount
    const newMaxWin = await yoloFlip.maxWin(ETH_TOKEN);
    expect(newMaxWin).to.be.lt(initialMaxWin);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [rejectorAddress]);
  });

  it("should revert settleBet with wrong block hash (BlockHashMismatch)", async function () {
    const placed = await placeBet({ player, betMask: 1n, modulo: 2n });
    await mine(1);
    const wrongBlockHash = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
    await expect(yoloFlip.connect(croupier).settleBet(placed.reveal, wrongBlockHash)).to.be.revertedWithCustomError(
      yoloFlip,
      "BlockHashMismatch",
    );
  });

  it("should revert double-settle of the same bet (BetDoesNotExist)", async function () {
    const placed = await placeBet({ player, betMask: 1n, modulo: 2n });
    const { blockHash } = await settleBet(placed.reveal, placed.receipt.blockNumber);
    await expect(yoloFlip.connect(croupier).settleBet(placed.reveal, blockHash)).to.be.revertedWithCustomError(
      yoloFlip,
      "BetDoesNotExist",
    );
  });

  it("should revert settleBet after expiry (BetExpired)", async function () {
    const placed = await placeBet({ player, betMask: 1n, modulo: 2n });
    await mine(257);
    const placeBlock = await ethers.provider.getBlock(placed.receipt.blockNumber);
    await expect(yoloFlip.connect(croupier).settleBet(placed.reveal, placeBlock!.hash!)).to.be.revertedWithCustomError(
      yoloFlip,
      "BetExpired",
    );
  });

  it("should revert all admin functions when called by non-admin", async function () {
    const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

    await expect(yoloFlip.connect(player).setHouseEdge(100n))
      .to.be.revertedWithCustomError(yoloFlip, "AccessControlUnauthorizedAccount")
      .withArgs(player.address, DEFAULT_ADMIN_ROLE);

    await expect(yoloFlip.connect(player).setMinBet(1n)).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );

    await expect(yoloFlip.connect(player).setMaxProfitRatio(100n)).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );

    await expect(yoloFlip.connect(player).setSecretSigner(player.address)).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );

    await expect(
      yoloFlip.connect(player).withdrawHouseFunds(player.address, 1n, ETH_TOKEN),
    ).to.be.revertedWithCustomError(yoloFlip, "AccessControlUnauthorizedAccount");

    await expect(yoloFlip.connect(player).setAllowedToken(player.address, true)).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );

    await expect(yoloFlip.connect(player).setTokenMinBet(ETH_TOKEN, 1n)).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );

    await expect(yoloFlip.connect(player).pause()).to.be.revertedWithCustomError(
      yoloFlip,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("should verify ERC20 winning payout is sent (not pending)", async function () {
    const tokenAddr = await mockToken.getAddress();
    const result = await findOutcomeTokenBet(true, 1n, 2n);

    const playerBalBefore = await mockToken.balanceOf(player.address);
    await yoloFlip.connect(croupier).settleBet(result.reveal, result.blockHash);
    const playerBalAfter = await mockToken.balanceOf(player.address);

    expect(playerBalAfter).to.be.gt(playerBalBefore);
    expect(await yoloFlip.pendingPayouts(player.address, tokenAddr)).to.equal(0n);
  });

  it("should reject setMaxProfitRatio(1001) and accept 1000", async function () {
    await expect(yoloFlip.connect(admin).setMaxProfitRatio(1001n)).to.be.revertedWithCustomError(
      yoloFlip,
      "InvalidMaxProfitRatio",
    );
    await expect(yoloFlip.connect(admin).setMaxProfitRatio(1000n)).to.not.be.reverted;
    await yoloFlip.connect(admin).setMaxProfitRatio(500n);
  });

  it("should re-enable betting after unpause", async function () {
    await yoloFlip.connect(admin).pause();
    const reveal = generateReveal();
    const commit = revealToCommit(reveal);
    const block = await ethers.provider.getBlock("latest");
    const commitLastBlock = BigInt(block!.number + 100);
    const contractAddress = await yoloFlip.getAddress();
    const { v, r, s } = await signCommit(secretSignerWallet, commitLastBlock, commit, contractAddress);

    await expect(
      yoloFlip.connect(player).placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.be.revertedWithCustomError(yoloFlip, "EnforcedPause");

    await yoloFlip.connect(admin).unpause();

    await expect(
      yoloFlip.connect(player).placeBet(1n, 2n, false, commitLastBlock, commit, v, r, s, { value: defaultBetAmount }),
    ).to.not.be.reverted;
  });
});
