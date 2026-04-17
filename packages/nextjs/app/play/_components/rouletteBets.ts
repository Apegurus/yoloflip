// European roulette: 37 numbers (0-36), modulo = 37
// Each bet type maps to a bitmask where bit N = number N is a winner
export const ROULETTE_MODULO = 37n;

// Number → color mapping: 0 = green, true = red, false = black
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function numbersToBitmask(numbers: number[]): bigint {
  let mask = 0n;
  for (const n of numbers) {
    mask |= 1n << BigInt(n);
  }
  return mask;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// ==================== Outside bets ====================

export const RED_MASK = numbersToBitmask([...RED_NUMBERS]);
export const BLACK_MASK = numbersToBitmask(range(1, 36).filter(n => !RED_NUMBERS.has(n)));

export const ODD_MASK = numbersToBitmask(range(1, 36).filter(n => n % 2 !== 0));
export const EVEN_MASK = numbersToBitmask(range(1, 36).filter(n => n % 2 === 0));

export const LOW_MASK = numbersToBitmask(range(1, 18)); // 1-18
export const HIGH_MASK = numbersToBitmask(range(19, 36)); // 19-36

export const DOZEN_1_MASK = numbersToBitmask(range(1, 12));
export const DOZEN_2_MASK = numbersToBitmask(range(13, 24));
export const DOZEN_3_MASK = numbersToBitmask(range(25, 36));

export const COLUMN_1_MASK = numbersToBitmask([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
export const COLUMN_2_MASK = numbersToBitmask([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]);
export const COLUMN_3_MASK = numbersToBitmask([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);

// ==================== Structured bet types ====================

export type RouletteBetCategory = "color" | "parity" | "half" | "dozen" | "column" | "straight";

export type RouletteBetType = {
  label: string;
  mask: bigint;
  category: RouletteBetCategory;
  payout: string; // Display only (e.g., "1:1", "2:1", "35:1")
};

export const OUTSIDE_BETS: RouletteBetType[] = [
  { label: "Red", mask: RED_MASK, category: "color", payout: "1:1" },
  { label: "Black", mask: BLACK_MASK, category: "color", payout: "1:1" },
  { label: "Odd", mask: ODD_MASK, category: "parity", payout: "1:1" },
  { label: "Even", mask: EVEN_MASK, category: "parity", payout: "1:1" },
  { label: "1-18", mask: LOW_MASK, category: "half", payout: "1:1" },
  { label: "19-36", mask: HIGH_MASK, category: "half", payout: "1:1" },
  { label: "1st 12", mask: DOZEN_1_MASK, category: "dozen", payout: "2:1" },
  { label: "2nd 12", mask: DOZEN_2_MASK, category: "dozen", payout: "2:1" },
  { label: "3rd 12", mask: DOZEN_3_MASK, category: "dozen", payout: "2:1" },
  { label: "Col 1", mask: COLUMN_1_MASK, category: "column", payout: "2:1" },
  { label: "Col 2", mask: COLUMN_2_MASK, category: "column", payout: "2:1" },
  { label: "Col 3", mask: COLUMN_3_MASK, category: "column", payout: "2:1" },
];

// Straight-up bets (single number 0-36)
export const STRAIGHT_BETS: RouletteBetType[] = range(0, 36).map(n => ({
  label: String(n),
  mask: 1n << BigInt(n),
  category: "straight" as const,
  payout: "35:1",
}));

// Color for each number (for display)
export function getNumberColor(n: number): "green" | "red" | "black" {
  if (n === 0) return "green";
  return RED_NUMBERS.has(n) ? "red" : "black";
}

// All numbers in table layout order (3 columns × 12 rows, plus 0)
export const ROULETTE_TABLE_ROWS: number[][] = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];
