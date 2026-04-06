"use client";

import { useState } from "react";
import { BetForm } from "./_components/BetForm";
import { BetHistory } from "./_components/BetHistory";
import { GameResult } from "./_components/GameResult";
import { GameSelector } from "./_components/GameSelector";
import type { NextPage } from "next";
import { useAccount } from "wagmi";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

type GameType = "coinflip" | "dice";

type BetResult = {
  commit: bigint;
  gambler: string;
  dice: bigint;
  payout: bigint;
  modulo: bigint;
};

type CroupierCommitResponse = {
  commit: string;
  commitLastBlock: string;
  v: number;
  r: string;
  s: string;
};

const CROUPIER_URL = process.env.NEXT_PUBLIC_CROUPIER_URL ?? "http://localhost:3001";

const Play: NextPage = () => {
  const { isConnected } = useAccount();
  const [selectedGame, setSelectedGame] = useState<GameType>("coinflip");
  const [lastResult, setLastResult] = useState<BetResult | null>(null);

  const { writeContractAsync, isPending } = useScaffoldWriteContract({
    contractName: "YoloFlip",
  });

  const handlePlaceBet = async (betMask: bigint, modulo: bigint, betAmount: bigint) => {
    if (!isConnected) {
      notification.error("Please connect your wallet first");
      return;
    }

    try {
      const res = await fetch(`${CROUPIER_URL}/api/commit`);
      if (!res.ok) throw new Error("Failed to get commit from croupier");
      const { commit, commitLastBlock, v, r, s } = (await res.json()) as CroupierCommitResponse;

      await writeContractAsync({
        functionName: "placeBet",
        args: [betMask, modulo, BigInt(commitLastBlock), BigInt(commit), v, r as `0x${string}`, s as `0x${string}`],
        value: betAmount,
      });

      notification.success("Bet placed! Waiting for result...");
      setLastResult(null);
    } catch (error) {
      console.error("Failed to place bet:", error);
      notification.error("Failed to place bet. Is the croupier running?");
    }
  };

  return (
    <div className="flex items-center flex-col grow pt-10">
      <div className="px-5 w-full max-w-4xl">
        <h1 className="text-center mb-8">
          <span className="block text-4xl font-bold">🎰 YoloFlip</span>
          <span className="block text-lg opacity-70 mt-2">Provably fair commit-reveal gambling</span>
        </h1>

        {!isConnected ? (
          <div className="alert alert-warning max-w-md mx-auto">
            <span>Please connect your wallet to play.</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6">
            <GameSelector selectedGame={selectedGame} onSelect={setSelectedGame} />

            <BetForm gameType={selectedGame} onSubmit={handlePlaceBet} isPending={isPending} />

            <GameResult lastResult={lastResult} />

            <div className="divider w-full max-w-2xl">Recent Results</div>

            <BetHistory />
          </div>
        )}
      </div>
    </div>
  );
};

export default Play;
