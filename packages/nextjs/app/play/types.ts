export type GameType = "coinflip" | "dice" | "roulette" | "range";

export type BetResult = {
  commit: bigint;
  gambler: string;
  dice: bigint;
  payout: bigint;
  modulo: bigint;
  token: string;
};
