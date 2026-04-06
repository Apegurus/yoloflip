"use client";

import type { GameType } from "../types";

type GameSelectorProps = {
  selectedGame: GameType;
  onSelect: (game: GameType) => void;
};

const GAMES: { type: GameType; label: string; color: string }[] = [
  { type: "coinflip", label: "🪙 Coinflip", color: "btn-primary" },
  { type: "dice", label: "🎲 Dice", color: "btn-secondary" },
  { type: "roulette", label: "🎰 Roulette", color: "btn-accent" },
  { type: "range", label: "📊 Range", color: "btn-info" },
];

export const GameSelector = ({ selectedGame, onSelect }: GameSelectorProps) => {
  return (
    <div className="flex flex-wrap gap-3 justify-center my-4">
      {GAMES.map(({ type, label, color }) => (
        <button
          key={type}
          className={`btn btn-lg ${selectedGame === type ? color : `btn-outline ${color}`}`}
          onClick={() => onSelect(type)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};
