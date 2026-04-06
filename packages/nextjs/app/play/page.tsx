"use client";

import { useState } from "react";
import { BetForm } from "./_components/BetForm";
import { BetHistory } from "./_components/BetHistory";
import { GameResult } from "./_components/GameResult";
import { GameSelector } from "./_components/GameSelector";
import type { TokenSelection } from "./_components/TokenSelector";
import type { BetResult, GameType } from "./types";
import type { NextPage } from "next";
import { useAccount } from "wagmi";
import { useScaffoldWatchContractEvent, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

type CroupierCommitResponse = {
  commit: string;
  commitLastBlock: string;
  v: number;
  r: string;
  s: string;
};

const CROUPIER_URL = process.env.NEXT_PUBLIC_CROUPIER_URL ?? "http://localhost:3001";

const Play: NextPage = () => {
  const { address, isConnected } = useAccount();
  const [selectedGame, setSelectedGame] = useState<GameType>("coinflip");
  const [lastResult, setLastResult] = useState<BetResult | null>(null);

  const { writeContractAsync, isPending } = useScaffoldWriteContract({
    contractName: "YoloFlip",
  });

  useScaffoldWatchContractEvent({
    contractName: "YoloFlip",
    eventName: "BetSettled",
    onLogs: logs => {
      for (const log of logs) {
        const { commit, gambler, dice, payout, modulo, token } = log.args;
        if (commit === undefined || gambler === undefined || dice === undefined || payout === undefined) continue;
        if (gambler.toLowerCase() !== address?.toLowerCase()) continue;

        setLastResult({
          commit,
          gambler,
          dice,
          payout,
          modulo: modulo ?? 2n,
          token: token ?? "0x0000000000000000000000000000000000000000",
        });
        notification.info(payout > 0n ? "You won!" : "Better luck next time!");
      }
    },
  });

  const handlePlaceBet = async (
    betMask: bigint,
    modulo: bigint,
    betAmount: bigint,
    betOver: boolean,
    token: TokenSelection,
  ) => {
    if (!isConnected) {
      notification.error("Please connect your wallet first");
      return;
    }

    try {
      const res = await fetch(`${CROUPIER_URL}/api/commit`);
      if (!res.ok) throw new Error("Failed to get commit from croupier");
      const { commit, commitLastBlock, v, r, s } = (await res.json()) as CroupierCommitResponse;

      if (token.address) {
        // ERC20 token bet
        await writeContractAsync({
          functionName: "placeBetWithToken",
          args: [
            betMask,
            modulo,
            betOver,
            token.address,
            betAmount,
            BigInt(commitLastBlock),
            BigInt(commit),
            v,
            r as `0x${string}`,
            s as `0x${string}`,
          ],
        });
      } else {
        // Native ETH bet
        await writeContractAsync({
          functionName: "placeBet",
          args: [
            betMask,
            modulo,
            betOver,
            BigInt(commitLastBlock),
            BigInt(commit),
            v,
            r as `0x${string}`,
            s as `0x${string}`,
          ],
          value: betAmount,
        });
      }

      notification.success("Bet placed! Waiting for result...");
    } catch (error) {
      console.error("Failed to place bet:", error);
      notification.error("Failed to place bet. Is the croupier running?");
    }
  };

  return (
    <div className="flex items-center flex-col grow pt-10">
      <div className="px-5 w-full max-w-4xl">
        <h1 className="text-center mb-8">
          <span className="block text-4xl font-bold">YoloFlip</span>
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
