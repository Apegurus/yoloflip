export const YOLOFLIP_ABI = [
  // Events
  "event BetPlaced(uint256 indexed commit, address indexed gambler, uint256 amount, uint256 betMask, uint256 modulo)",
  "event BetSettled(uint256 indexed commit, address indexed gambler, uint256 dice, uint256 payout, uint256 modulo)",
  "event BetRefunded(uint256 indexed commit, address indexed gambler, uint256 amount)",

  // Functions
  "function settleBet(uint256 reveal, bytes32 blockHash) external",
  "function bets(uint256 commit) external view returns (uint128 amount, uint8 modulo, uint8 rollUnder, uint40 placeBlockNumber, uint40 mask, address gambler)",
  "function lockedInBets() external view returns (uint128)",
] as const;
