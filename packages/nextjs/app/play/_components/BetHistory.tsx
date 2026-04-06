"use client";

import { formatEther } from "viem";
import { useScaffoldEventHistory } from "~~/hooks/scaffold-eth";

export const BetHistory = () => {
  const { data: events, isLoading } = useScaffoldEventHistory({
    contractName: "YoloFlip",
    eventName: "BetSettled",
    watch: true,
  });

  if (isLoading) {
    return (
      <div className="w-full max-w-2xl">
        <h3 className="text-lg font-bold mb-2">Recent Bets</h3>
        <div className="skeleton h-20 w-full" />
      </div>
    );
  }

  const recentBets = (events ?? []).slice(0, 10).reverse();

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
                <th>Dice</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {recentBets.map(event => {
                const payout = event.args.payout ?? 0n;
                const dice = event.args.dice ?? 0n;
                const token = event.args.token;
                const isETH = !token || token === "0x0000000000000000000000000000000000000000";
                const won = payout > 0n;
                return (
                  <tr key={event.args.commit?.toString()}>
                    <td>
                      <span className={`badge ${won ? "badge-success" : "badge-error"}`}>{won ? "WIN" : "LOSS"}</span>
                    </td>
                    <td>{Number(dice)}</td>
                    <td>{won ? `${formatEther(payout)} ${isETH ? "ETH" : "tokens"}` : "—"}</td>
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
