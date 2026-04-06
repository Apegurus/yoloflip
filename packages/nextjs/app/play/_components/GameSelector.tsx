"use client";

type GameType = "coinflip" | "dice";

type GameSelectorProps = {
  selectedGame: GameType;
  onSelect: (game: GameType) => void;
};

export const GameSelector = ({ selectedGame, onSelect }: GameSelectorProps) => {
  return (
    <div className="flex gap-3 justify-center my-4">
      <button
        className={`btn btn-lg ${selectedGame === "coinflip" ? "btn-primary" : "btn-outline btn-primary"}`}
        onClick={() => onSelect("coinflip")}
      >
        🪙 Coinflip
      </button>
      <button
        className={`btn btn-lg ${selectedGame === "dice" ? "btn-secondary" : "btn-outline btn-secondary"}`}
        onClick={() => onSelect("dice")}
      >
        🎲 Dice
      </button>
    </div>
  );
};
