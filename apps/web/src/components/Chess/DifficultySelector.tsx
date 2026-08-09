import React from 'react';
import { DifficultySelector as BaseDifficultySelector } from '../common/DifficultySelector';
import { CHESS_DIFFICULTIES } from './difficulty';

/**
 * Chess-configured wrapper around the shared DifficultySelector: supplies
 * the Stockfish skill-level tiers and an "Engine skill n/20" caption.
 * Keeps the same API its call sites (ComputerGame, GameLobby) already use.
 */
interface ChessDifficultySelectorProps {
  /** Currently selected Stockfish skill level (0–20). */
  value: number;
  onChange: (skillLevel: number) => void;
  title?: string;
  compact?: boolean;
  disabled?: boolean;
}

const CHESS_TIERS = CHESS_DIFFICULTIES.map((d) => ({
  id: d.id,
  label: d.label,
  value: d.skillLevel,
}));

export function DifficultySelector({
  value,
  onChange,
  title = 'Difficulty',
  compact = false,
  disabled = false,
}: ChessDifficultySelectorProps) {
  return (
    <BaseDifficultySelector
      tiers={CHESS_TIERS}
      value={value}
      onChange={onChange}
      title={title}
      caption={`Engine skill ${value}/20`}
      compact={compact}
      disabled={disabled}
    />
  );
}

export default DifficultySelector;
