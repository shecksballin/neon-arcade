import React from 'react';

/**
 * Shared neon "pill" difficulty selector used across games (Chess, Volley,
 * Connect). Game-agnostic: pass the tiers, the current value, and an
 * onChange. Pills wrap, so it fits both a wide lobby and a ~300px sidebar.
 */
export interface DifficultyTier {
  id: string;
  label: string;
  /** The value handed back via onChange when this tier is picked. */
  value: number;
}

interface DifficultySelectorProps {
  tiers: DifficultyTier[];
  /** Currently selected tier value. */
  value: number;
  onChange: (value: number) => void;
  title?: string;
  /** Optional line under the pills (e.g. "Engine skill 9/20"). */
  caption?: string;
  /** Tighter spacing/sizing for a narrow sidebar. */
  compact?: boolean;
  /** Greys out and blocks changes (e.g. while it's the AI's turn). */
  disabled?: boolean;
}

export function DifficultySelector({
  tiers,
  value,
  onChange,
  title = 'Difficulty',
  caption,
  compact = false,
  disabled = false,
}: DifficultySelectorProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 6 : 10,
        alignItems: 'center',
        width: '100%',
      }}
    >
      {title && (
        <span
          style={{
            fontSize: compact ? 10 : 11,
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'rgba(0,255,209,0.7)',
            fontFamily: 'var(--font-body)',
          }}
        >
          {title}
        </span>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: compact ? 6 : 8,
        }}
      >
        {tiers.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onChange(t.value)}
              style={{
                padding: compact ? '5px 11px' : '7px 15px',
                borderRadius: 999,
                border: `1px solid ${active ? '#00FFD1' : 'rgba(0,255,209,0.25)'}`,
                background: active ? 'rgba(0,255,209,0.14)' : 'transparent',
                color: active ? '#00FFD1' : 'rgba(255,255,255,0.6)',
                boxShadow: active ? '0 0 12px rgba(0,255,209,0.35)' : 'none',
                fontFamily: 'var(--font-body)',
                fontSize: compact ? 11 : 13,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled && !active ? 0.4 : 1,
                transition: 'all 0.15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {caption && (
        <span
          style={{
            fontSize: compact ? 9 : 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.35)',
            fontFamily: 'var(--font-body)',
          }}
        >
          {caption}
        </span>
      )}
    </div>
  );
}

export default DifficultySelector;
