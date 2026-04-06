export type GameType = "coinflip" | "dice";

export type BetResult = {
  commit: bigint;
  gambler: string;
  dice: bigint;
  payout: bigint;
  modulo: bigint;
};
