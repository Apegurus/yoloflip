"use client";

import { formatEther } from "viem";

type BetResult = {
  commit: bigint;
  gambler: string;
  dice: bigint;
  payout: bigint;
  modulo: bigint;
};

type GameResultProps = {
  lastResult: BetResult | null;
};

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

const getDiceEmoji = (dice: bigint): string => {
  const idx = Number(dice);
  return DICE_FACES[idx] ?? `${idx}`;
};

export const GameResult = ({ lastResult }: GameResultProps) => {
  if (!lastResult) {
    return (
      <div className="card bg-base-200 shadow-sm w-full max-w-md">
        <div className="card-body text-center opacity-50">
          <p>No result yet — place your first bet!</p>
        </div>
      </div>
    );
  }

  const { dice, payout, modulo } = lastResult;
  const won = payout > 0n;
  const isCoinflip = modulo === 2n;

  return (
    <div
      className={`card shadow-xl w-full max-w-md ${won ? "bg-success text-success-content" : "bg-error text-error-content"}`}
    >
      <div className="card-body text-center">
        <h2 className="card-title justify-center text-2xl">{won ? "🎉 You Won!" : "😢 You Lost"}</h2>
        <div className="text-6xl my-2">{isCoinflip ? (dice === 0n ? "🪙 Heads" : "🪙 Tails") : getDiceEmoji(dice)}</div>
        <p className="text-lg">
          {isCoinflip ? `Rolled: ${dice === 0n ? "Heads" : "Tails"}` : `Rolled: ${Number(dice) + 1}`}
        </p>
        {won && <p className="font-bold text-xl">Payout: {formatEther(payout)} ETH</p>}
      </div>
    </div>
  );
};
