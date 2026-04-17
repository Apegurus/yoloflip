"use client";

import { useMemo } from "react";
import { getNumberColor } from "./rouletteBets";
import { erc20Abi, formatEther, formatUnits, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { useScaffoldEventHistory } from "~~/hooks/scaffold-eth";

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function formatOutcome(dice: bigint, modulo: bigint | undefined): string {
  const mod = Number(modulo ?? 2n);
  if (mod === 2) return dice === 0n ? "Heads" : "Tails";
  if (mod === 6) return `${DICE_FACES[Number(dice)] ?? "?"} ${Number(dice) + 1}`;
  if (mod === 37) {
    const num = Number(dice);
    const color = getNumberColor(num);
    const dot = color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";
    return `${dot} ${num}`;
  }
  return `${Number(dice)} / ${mod}`;
}

export const BetHistory = () => {
  const { data: events, isLoading } = useScaffoldEventHistory({
    contractName: "YoloFlip",
    eventName: "BetSettled",
    watch: true,
  });

  const recentBets = useMemo(() => (events ?? []).slice(0, 10), [events]);

  // Collect unique non-ETH token addresses for on-chain metadata lookup
  const uniqueTokens = useMemo(() => {
    const tokens = new Set<`0x${string}`>();
    recentBets.forEach(e => {
      const t = e.args.token;
      if (t && t !== zeroAddress) tokens.add(t as `0x${string}`);
    });
    return Array.from(tokens);
  }, [recentBets]);

  // Batch-read decimals + symbol for each non-ETH token
  const { data: tokenInfoResults } = useReadContracts({
    contracts: uniqueTokens.flatMap(addr => [
      { address: addr, abi: erc20Abi, functionName: "decimals" as const },
      { address: addr, abi: erc20Abi, functionName: "symbol" as const },
    ]),
  });

  // Build token → { decimals, symbol } lookup
  const tokenInfoMap = useMemo(() => {
    const map: Record<string, { decimals: number; symbol: string }> = {};
    uniqueTokens.forEach((addr, i) => {
      const dec = tokenInfoResults?.[i * 2]?.result;
      const sym = tokenInfoResults?.[i * 2 + 1]?.result;
      map[addr.toLowerCase()] = {
        decimals: typeof dec === "number" ? dec : 18,
        symbol: typeof sym === "string" ? sym : "tokens",
      };
    });
    return map;
  }, [uniqueTokens, tokenInfoResults]);

  const formatPayout = (payout: bigint, token: string | undefined) => {
    const isETH = !token || token === zeroAddress;
    if (isETH) return `${formatEther(payout)} ETH`;
    const info = tokenInfoMap[token.toLowerCase()];
    return info ? `${formatUnits(payout, info.decimals)} ${info.symbol}` : `${formatEther(payout)} tokens`;
  };

  if (isLoading) {
    return (
      <div className="w-full max-w-2xl">
        <h3 className="text-lg font-bold mb-2">Recent Bets</h3>
        <div className="skeleton h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl">
      <h3 className="text-lg font-bold mb-2">Recent Bets</h3>
      {recentBets.length === 0 ? (
        <div className="text-center opacity-50 py-4">No bets yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Result</th>
                <th>Outcome</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {recentBets.map(event => {
                const payout = event.args.payout ?? 0n;
                const dice = event.args.dice ?? 0n;
                const token = event.args.token;
                const won = payout > 0n;
                return (
                  <tr key={event.args.commit?.toString()}>
                    <td>
                      <span className={`badge ${won ? "badge-success" : "badge-error"}`}>{won ? "WIN" : "LOSS"}</span>
                    </td>
                    <td>{formatOutcome(dice, event.args.modulo)}</td>
                    <td>{won ? formatPayout(payout, token) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
