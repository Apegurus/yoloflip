"use client";

import { useEffect } from "react";
import { formatUnits, parseUnits } from "viem";
import { erc20Abi } from "viem";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { getParsedError, notification } from "~~/utils/scaffold-eth";

export type TokenSelection = {
  address: `0x${string}` | null; // null = ETH
  symbol: string;
  decimals: number;
};

// Configurable token list — extend as needed
const TOKEN_OPTIONS: TokenSelection[] = [{ address: null, symbol: "ETH", decimals: 18 }];

type TokenSelectorProps = {
  selected: TokenSelection;
  onSelect: (token: TokenSelection) => void;
  betAmount: string;
  customTokens?: TokenSelection[];
  onNeedsApprovalChange?: (needsApproval: boolean) => void;
};

export const TokenSelector = ({
  selected,
  onSelect,
  betAmount,
  customTokens = [],
  onNeedsApprovalChange,
}: TokenSelectorProps) => {
  const { address: userAddress } = useAccount();
  const { data: contractInfo } = useDeployedContractInfo({ contractName: "YoloFlip" });

  const allTokens = [...TOKEN_OPTIONS, ...customTokens];

  // ETH balance
  const { data: ethBalance } = useBalance({
    address: userAddress,
  });

  // ERC20 balance (only when a token is selected)
  const { data: tokenBalance } = useReadContract({
    address: selected.address ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!selected.address && !!userAddress },
  });

  // ERC20 allowance
  const { data: allowance } = useReadContract({
    address: selected.address ?? undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: userAddress && contractInfo ? [userAddress, contractInfo.address] : undefined,
    query: { enabled: !!selected.address && !!userAddress && !!contractInfo },
  });

  // ERC20 decimals
  const { data: tokenDecimals } = useReadContract({
    address: selected.address ?? undefined,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: !!selected.address },
  });

  const decimals = selected.address ? (tokenDecimals ?? 18) : 18;

  const { writeContractAsync: approveAsync, isPending: isApproving } = useWriteContract();

  let betAmountWei = 0n;
  try {
    betAmountWei = betAmount ? parseUnits(betAmount as `${number}`, decimals) : 0n;
  } catch {
    // Invalid input during typing (e.g. "0.", "1.2.3") — treat as zero
  }
  const needsApproval = selected.address && allowance !== undefined && allowance < betAmountWei;

  useEffect(() => {
    onNeedsApprovalChange?.(!!needsApproval);
  }, [needsApproval, onNeedsApprovalChange]);

  const handleApprove = async () => {
    if (!selected.address || !contractInfo) return;
    try {
      await approveAsync({
        address: selected.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [contractInfo.address, betAmountWei],
      });
    } catch (error) {
      console.error("Approve failed:", error);
      const parsed = getParsedError(error);
      notification.error(parsed);
    }
  };

  const balance = selected.address ? tokenBalance : ethBalance?.value;
  const formattedBalance = balance !== undefined ? formatUnits(balance, decimals) : "—";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-sm opacity-70">Token:</label>
        <select
          className="select select-bordered select-sm flex-1"
          value={selected.address ?? "ETH"}
          onChange={e => {
            const val = e.target.value;
            const token = allTokens.find(t => (t.address ?? "ETH") === val) ?? TOKEN_OPTIONS[0];
            onSelect(token);
          }}
        >
          {allTokens.map(t => (
            <option key={t.address ?? "ETH"} value={t.address ?? "ETH"}>
              {t.symbol}
            </option>
          ))}
        </select>
        <span className="text-xs opacity-50">
          Bal: {balance !== undefined ? Number(formattedBalance).toFixed(4) : "—"}
        </span>
      </div>

      {needsApproval && betAmountWei > 0n && (
        <button className="btn btn-warning btn-sm w-full" onClick={handleApprove} disabled={isApproving}>
          {isApproving && <span className="loading loading-spinner loading-xs" />}
          Approve {selected.symbol}
        </button>
      )}
    </div>
  );
};
