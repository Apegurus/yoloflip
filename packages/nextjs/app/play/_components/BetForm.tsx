"use client";

import { useState } from "react";
import type { GameType } from "../types";
import { EtherInput } from "@scaffold-ui/components";
import { parseEther } from "viem";

type BetFormProps = {
  gameType: GameType;
  onSubmit: (betMask: bigint, modulo: bigint, betAmount: bigint) => void;
  isPending: boolean;
};

// Coinflip: modulo=2, heads=betMask 1 (face 0), tails=betMask 2 (face 1)
// Dice: modulo=6, face N (1-6 displayed) = bit (N-1) = 2^(N-1)
const DICE_FACES = [1, 2, 3, 4, 5, 6];

export const BetForm = ({ gameType, onSubmit, isPending }: BetFormProps) => {
  const [betAmountEth, setBetAmountEth] = useState("");
  const [coinflipChoice, setCoinflipChoice] = useState<"heads" | "tails">("heads");
  const [selectedDiceFaces, setSelectedDiceFaces] = useState<Set<number>>(new Set([1]));

  const toggleDiceFace = (face: number) => {
    setSelectedDiceFaces(prev => {
      const next = new Set(prev);
      if (next.has(face)) {
        if (next.size > 1) next.delete(face); // must select at least 1
      } else {
        next.add(face);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!betAmountEth) return;
    const betAmount = parseEther(betAmountEth as `${number}`);

    if (gameType === "coinflip") {
      const betMask = coinflipChoice === "heads" ? 1n : 2n;
      onSubmit(betMask, 2n, betAmount);
    } else {
      // Dice: betMask = OR of 2^(face-1) for each selected face
      let betMask = 0n;
      selectedDiceFaces.forEach(face => {
        betMask |= 1n << BigInt(face - 1);
      });
      onSubmit(betMask, 6n, betAmount);
    }
  };

  return (
    <div className="card bg-base-100 shadow-xl w-full max-w-md">
      <div className="card-body">
        <h2 className="card-title">Place Your Bet</h2>

        {gameType === "coinflip" && (
          <div className="flex gap-3 justify-center my-3">
            <button
              className={`btn btn-lg ${coinflipChoice === "heads" ? "btn-primary" : "btn-outline"}`}
              onClick={() => setCoinflipChoice("heads")}
            >
              Heads
            </button>
            <button
              className={`btn btn-lg ${coinflipChoice === "tails" ? "btn-primary" : "btn-outline"}`}
              onClick={() => setCoinflipChoice("tails")}
            >
              Tails
            </button>
          </div>
        )}

        {gameType === "dice" && (
          <div className="my-3">
            <p className="text-sm opacity-70 mb-2">Select winning faces:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {DICE_FACES.map(face => (
                <button
                  key={face}
                  className={`btn btn-square btn-lg ${selectedDiceFaces.has(face) ? "btn-secondary" : "btn-outline"}`}
                  onClick={() => toggleDiceFace(face)}
                >
                  {face}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="my-3">
          <EtherInput placeholder="Enter bet amount" onValueChange={({ valueInEth }) => setBetAmountEth(valueInEth)} />
        </div>

        <button className="btn btn-primary w-full" onClick={handleSubmit} disabled={isPending || !betAmountEth}>
          {isPending && <span className="loading loading-spinner loading-sm" />}
          {isPending ? "Placing Bet..." : "Place Bet 🎰"}
        </button>
      </div>
    </div>
  );
};
