import React, { useRef, useEffect } from 'react';
import { animate, utils } from 'animejs';
import './chess.css';

interface ChessPieceProps {
  id: string;
  icon: string;
  color: string;
  currentX: number;
  currentY: number;
  isCaptured: boolean;
  isStriking?: boolean;
  isTarget?: boolean;
  selected?: boolean;
  onClick?: () => void;
  size?: number;
  opacity?: number;
}

const ChessPiece = ({
  id,
  icon,
  color = 'white',
  currentX,
  currentY,
  isCaptured,
  isStriking = false,
  isTarget = false,
  selected = false,
  onClick,
  size = 42,
  opacity = 1,
}: ChessPieceProps) => {
  const pieceRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const glowClass = color === 'white' ? 'neon-glow-white' : 'neon-glow-black';

  useEffect(() => {
    if (pieceRef.current && isFirstRender.current) {
      utils.set(pieceRef.current, { translateX: currentX, translateY: currentY });
      isFirstRender.current = false;
    }
  }, [currentX, currentY]);

  useEffect(() => {
    if (pieceRef.current && !isCaptured) {
      // Ensure resets happen when game restarts or undos
      utils.set(pieceRef.current, { opacity, scale: 1, rotate: '0turn' });
    }
  }, [isCaptured, opacity]);

  useEffect(() => {
    // Only handle standard movement (non-captures) here.
    // Captures are handled externally via playCaptureSequence.
    if (!isFirstRender.current && pieceRef.current && !isCaptured && !isStriking) {
      animate(pieceRef.current, {
        translateX: currentX,
        translateY: currentY,
        opacity: opacity,
        duration: 200,
        ease: 'outExpo'
      });
    }
  }, [currentX, currentY, isCaptured, isStriking, opacity]);

  return (
    <div
      id={id}
      ref={pieceRef}
      className={`chess-piece ${selected ? 'selected' : ''}`}
      onClick={onClick}
      role="button"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: isCaptured ? 5 : 10,
        pointerEvents: isCaptured ? 'none' : 'auto',
        opacity: opacity,
        display: (isCaptured && !isTarget) ? 'none' : 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: 'var(--square-size)',
        height: 'var(--square-size)',
        willChange: 'transform',
      }}
    >
      <div className={`chess-piece-wrapper ${selected ? ' selected' : ''}`}>
        <span
          className={`material-symbols-outlined ${glowClass}`}
          style={{
            fontSize: `${size}px`,
            fontVariationSettings: "'FILL' 1",
          }}
        >
          {icon}
        </span>
      </div>
    </div>
  );
};

export default ChessPiece;
