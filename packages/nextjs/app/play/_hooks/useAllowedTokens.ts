"use client";

import { useMemo } from "react";
import type { TokenSelection } from "../_components/TokenSelector";
import { erc20Abi } from "viem";
import { useReadContracts } from "wagmi";
import { useScaffoldEventHistory } from "~~/hooks/scaffold-eth";

export function useAllowedTokens() {
  const { data: events, isLoading: eventsLoading } = useScaffoldEventHistory({
    contractName: "YoloFlip",
    eventName: "TokenAllowed",
    watch: true,
  });

  const allowedAddresses = useMemo(() => {
    const allowed = new Map<string, boolean>();
    const chronological = [...(events ?? [])].reverse();
    for (const event of chronological) {
      const { token, allowed: isAllowed } = event.args;
      if (token) allowed.set((token as string).toLowerCase(), !!isAllowed);
    }
    const result: `0x${string}`[] = [];
    allowed.forEach((isAllowed, addr) => {
      if (isAllowed) result.push(addr as `0x${string}`);
    });
    return result;
  }, [events]);

  const { data: tokenInfoResults, isLoading: infoLoading } = useReadContracts({
    contracts: allowedAddresses.flatMap(addr => [
      { address: addr, abi: erc20Abi, functionName: "decimals" as const },
      { address: addr, abi: erc20Abi, functionName: "symbol" as const },
    ]),
  });

  const tokens: TokenSelection[] = useMemo(() => {
    return allowedAddresses.map((addr, i) => {
      const dec = tokenInfoResults?.[i * 2]?.result;
      const sym = tokenInfoResults?.[i * 2 + 1]?.result;
      return {
        address: addr,
        symbol: typeof sym === "string" ? sym : `${addr.slice(0, 6)}...`,
        decimals: typeof dec === "number" ? dec : 18,
      };
    });
  }, [allowedAddresses, tokenInfoResults]);

  return { tokens, isLoading: eventsLoading || infoLoading };
}
