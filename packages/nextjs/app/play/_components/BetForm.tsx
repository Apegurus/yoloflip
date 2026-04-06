"use client";

import { useState } from "react";
import type { GameType } from "../types";
import { TokenSelector } from "./TokenSelector";
import type { TokenSelection } from "./TokenSelector";
import { OUTSIDE_BETS, ROULETTE_MODULO, ROULETTE_TABLE_ROWS, STRAIGHT_BETS, getNumberColor } from "./rouletteBets";
import type { RouletteBetType } from "./rouletteBets";
import { EtherInput } from "@scaffold-ui/components";
import { parseEther } from "viem";

type BetFormProps = {
  gameType: GameType;
  onSubmit: (betMask: bigint, modulo: bigint, betAmount: bigint, betOver: boolean, token: TokenSelection) => void;
  isPending: boolean;
  customTokens?: TokenSelection[];
};

const DICE_FACES = [1, 2, 3, 4, 5, 6];

export const BetForm = ({ gameType, onSubmit, isPending, customTokens }: BetFormProps) => {
  const [betAmountEth, setBetAmountEth] = useState("");
  const [selectedToken, setSelectedToken] = useState<TokenSelection>({ address: null, symbol: "ETH" });

  // Coinflip state
  const [coinflipChoice, setCoinflipChoice] = useState<"heads" | "tails">("heads");

  // Dice state
  const [selectedDiceFaces, setSelectedDiceFaces] = useState<Set<number>>(new Set([1]));

  // Roulette state
  const [rouletteBet, setRouletteBet] = useState<RouletteBetType | null>(OUTSIDE_BETS[0]);

  // Range state
  const [rangeTarget, setRangeTarget] = useState(50);
  const [rangeDirection, setRangeDirection] = useState<"under" | "over">("under");

  const toggleDiceFace = (face: number) => {
    setSelectedDiceFaces(prev => {
      const next = new Set(prev);
      if (next.has(face)) {
        if (next.size > 1) next.delete(face);
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
      onSubmit(betMask, 2n, betAmount, false, selectedToken);
    } else if (gameType === "dice") {
      let betMask = 0n;
      selectedDiceFaces.forEach(face => {
        betMask |= 1n << BigInt(face - 1);
      });
      onSubmit(betMask, 6n, betAmount, false, selectedToken);
    } else if (gameType === "roulette") {
      if (!rouletteBet) return;
      onSubmit(rouletteBet.mask, ROULETTE_MODULO, betAmount, false, selectedToken);
    } else if (gameType === "range") {
      const betOver = rangeDirection === "over";
      onSubmit(BigInt(rangeTarget), 100n, betAmount, betOver, selectedToken);
    }
  };

  const rangeWinChance = rangeDirection === "under" ? rangeTarget : 100 - 1 - rangeTarget;

  return (
    <div className="card bg-base-100 shadow-xl w-full max-w-lg">
      <div className="card-body">
        <h2 className="card-title">Place Your Bet</h2>

        {/* ===== COINFLIP ===== */}
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

        {/* ===== DICE ===== */}
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

        {/* ===== ROULETTE ===== */}
        {gameType === "roulette" && (
          <div className="my-3 space-y-4">
            {/* Outside bets */}
            <div>
              <p className="text-sm opacity-70 mb-2">Outside bets:</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {OUTSIDE_BETS.map(bet => (
                  <button
                    key={bet.label}
                    className={`btn btn-sm ${
                      rouletteBet?.label === bet.label
                        ? bet.label === "Red"
                          ? "bg-red-600 text-white border-red-600"
                          : bet.label === "Black"
                            ? "bg-gray-800 text-white border-gray-800"
                            : "btn-accent"
                        : "btn-outline"
                    }`}
                    onClick={() => setRouletteBet(bet)}
                  >
                    {bet.label}
                    <span className="badge badge-xs ml-1">{bet.payout}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Straight-up number grid */}
            <div>
              <p className="text-sm opacity-70 mb-2">Straight up (35:1):</p>
              {/* Zero */}
              <div className="flex justify-center mb-1">
                <button
                  className={`btn btn-sm min-w-[2.5rem] ${
                    rouletteBet?.label === "0" ? "bg-green-600 text-white border-green-600" : "btn-outline"
                  }`}
                  onClick={() => setRouletteBet(STRAIGHT_BETS[0])}
                >
                  0
                </button>
              </div>
              {/* 3 rows × 12 columns */}
              <div className="flex flex-col gap-0.5">
                {ROULETTE_TABLE_ROWS.map((row, rowIdx) => (
                  <div key={rowIdx} className="flex gap-0.5 justify-center">
                    {row.map(num => {
                      const color = getNumberColor(num);
                      const isSelected = rouletteBet?.label === String(num);
                      const colorClass =
                        color === "red"
                          ? isSelected
                            ? "bg-red-600 text-white border-red-600"
                            : "btn-outline border-red-400 text-red-400"
                          : isSelected
                            ? "bg-gray-800 text-white border-gray-800"
                            : "btn-outline border-gray-500";
                      return (
                        <button
                          key={num}
                          className={`btn btn-xs min-w-[2rem] px-1 ${colorClass}`}
                          onClick={() => setRouletteBet(STRAIGHT_BETS[num])}
                        >
                          {num}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {rouletteBet && (
              <div className="text-center text-sm opacity-70">
                Selected: <span className="font-bold">{rouletteBet.label}</span> ({rouletteBet.payout})
              </div>
            )}
          </div>
        )}

        {/* ===== RANGE ===== */}
        {gameType === "range" && (
          <div className="my-3 space-y-4">
            <div className="flex gap-2 justify-center">
              <button
                className={`btn ${rangeDirection === "under" ? "btn-info" : "btn-outline btn-info"}`}
                onClick={() => setRangeDirection("under")}
              >
                Roll Under
              </button>
              <button
                className={`btn ${rangeDirection === "over" ? "btn-info" : "btn-outline btn-info"}`}
                onClick={() => setRangeDirection("over")}
              >
                Roll Over
              </button>
            </div>

            <div className="text-center">
              <p className="text-sm opacity-70 mb-1">
                Target: <span className="font-bold text-lg">{rangeTarget}</span>
              </p>
              <input
                type="range"
                min={rangeDirection === "under" ? 1 : 0}
                max={rangeDirection === "under" ? 99 : 98}
                value={rangeTarget}
                onChange={e => setRangeTarget(Number(e.target.value))}
                className="range range-info w-full"
              />
              <div className="flex justify-between text-xs opacity-50 px-1">
                <span>0</span>
                <span>50</span>
                <span>99</span>
              </div>
            </div>

            <div className="text-center text-sm">
              <span className="opacity-70">Win if roll </span>
              <span className="font-bold">
                {rangeDirection === "under" ? "<" : ">"} {rangeTarget}
              </span>
              <span className="opacity-70"> — {rangeWinChance}% chance</span>
            </div>
          </div>
        )}

        {/* ===== TOKEN SELECTOR ===== */}
        <div className="my-3">
          <TokenSelector
            selected={selectedToken}
            onSelect={setSelectedToken}
            betAmount={betAmountEth}
            customTokens={customTokens}
          />
        </div>

        {/* ===== BET AMOUNT & SUBMIT ===== */}
        <div className="my-3">
          <EtherInput placeholder="Enter bet amount" onValueChange={({ valueInEth }) => setBetAmountEth(valueInEth)} />
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={handleSubmit}
          disabled={isPending || !betAmountEth || (gameType === "roulette" && !rouletteBet)}
        >
          {isPending && <span className="loading loading-spinner loading-sm" />}
          {isPending ? "Placing Bet..." : "Place Bet 🎰"}
        </button>
      </div>
    </div>
  );
};
