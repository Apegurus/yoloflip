"use client";

import type { BetResult } from "../types";
import { getNumberColor } from "./rouletteBets";
import { formatEther } from "viem";

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
  const isDice = modulo === 6n;
  const isRoulette = modulo === 37n;

  const renderResult = () => {
    if (isCoinflip) {
      return (
        <>
          <div className="text-6xl my-2">{dice === 0n ? "🪙 Heads" : "🪙 Tails"}</div>
          <p className="text-lg">Rolled: {dice === 0n ? "Heads" : "Tails"}</p>
        </>
      );
    }
    if (isDice) {
      return (
        <>
          <div className="text-6xl my-2">{getDiceEmoji(dice)}</div>
          <p className="text-lg">Rolled: {Number(dice) + 1}</p>
        </>
      );
    }
    if (isRoulette) {
      const num = Number(dice);
      const color = getNumberColor(num);
      const colorEmoji = color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";
      return (
        <>
          <div className="text-6xl my-2">
            {colorEmoji} {num}
          </div>
          <p className="text-lg capitalize">
            Rolled: {num} ({color})
          </p>
        </>
      );
    }
    // Range (d100)
    return (
      <>
        <div className="text-6xl my-2">{Number(dice)}</div>
        <p className="text-lg">Rolled: {Number(dice)} / 100</p>
      </>
    );
  };

  return (
    <div
      className={`card shadow-xl w-full max-w-md ${won ? "bg-success text-success-content" : "bg-error text-error-content"}`}
    >
      <div className="card-body text-center">
        <h2 className="card-title justify-center text-2xl">{won ? "🎉 You Won!" : "😢 You Lost"}</h2>
        {renderResult()}
        {won && <p className="font-bold text-xl">Payout: {formatEther(payout)} ETH</p>}
      </div>
    </div>
  );
};
