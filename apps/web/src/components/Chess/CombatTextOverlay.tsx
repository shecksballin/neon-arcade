import React, { useEffect, useState, useRef } from 'react';
import { 
  NumberCircleOne, 
  NumberCircleThree, 
  NumberCircleFive, 
  NumberCircleNine, 
  Sparkle, 
  X, 
  CheckFat,
  Shield,
  ArrowFatUp
} from '@phosphor-icons/react';
import { animate } from 'animejs';

export interface CombatEvent {
  id: string;
  type: 'capture' | 'check' | 'castle' | 'promotion';
  piece?: string; // 'p', 'n', 'b', 'r', 'q'
  isUser: boolean; // Did the user do the action (winning)? Or opponent?
  x: number;
  y: number;
}

interface Props {
  lastMove: any;
  orientation: 'white' | 'black';
  squareSize: number;
  pieces: any[];
  historyLength?: number;
}

export function CombatTextOverlay({ lastMove, orientation, squareSize, pieces, historyLength }: Props) {
  const [events, setEvents] = useState<CombatEvent[]>([]);
  const lastHandledHistoryLength = useRef(-1);

  useEffect(() => {
    if (!lastMove || historyLength === undefined) return;
    if (historyLength <= lastHandledHistoryLength.current) return;
    
    lastHandledHistoryLength.current = historyLength;

    const isCheck = lastMove.san.includes('+') || lastMove.san.includes('#');
    const isCapture = !!lastMove.captured;
    const isCastle = lastMove.san.startsWith('O-O'); // Covers both O-O and O-O-O
    const isPromotion = lastMove.flags.includes('p') || !!lastMove.promotion;

    if (!isCheck && !isCapture && !isCastle && !isPromotion) {
      setEvents([]);
      return;
    }

    // Determine user color vs attacker color. 
    // In local pass & play, orientation is always white and "user" is the one making the active move? 
    // Usually orientation indicates user color.
    const isUserColor = (lastMove.color === 'w' && orientation === 'white') || 
                        (lastMove.color === 'b' && orientation === 'black');
                        
    // determine coordinate
    const toFiles = 'abcdefgh';
    const toRank = parseInt(lastMove.to[1], 10);
    const toFileObj = toFiles.indexOf(lastMove.to[0]);
    
    let targetRank = toRank;
    if (isCapture && lastMove.flags.includes('e')) {
       targetRank = lastMove.color === 'w' ? toRank - 1 : toRank + 1;
    }

    let col = toFileObj;
    let row = 8 - targetRank;
    if (orientation === 'black') {
      col = 7 - col;
      row = 7 - row;
    }
    
    // Exact center of the target square
    const x = (col * squareSize) + (squareSize / 2);
    const y = (row * squareSize) + (squareSize / 2);

    const newEvents: CombatEvent[] = [];
    const idBase = Date.now() + Math.random().toString();

    if (isCapture) {
      newEvents.push({
        id: idBase + '-cap',
        type: 'capture',
        piece: lastMove.captured,
        isUser: isUserColor,
        x,
        y
      });
    }

    if (isCastle) {
      const movedColor = lastMove.color === 'w' ? 'white' : 'black';
      const king = pieces.find(p => p.type === 'king' && p.color === movedColor && !p.isCaptured);
      
      let castleX = x;
      let castleY = y;
      
      if (king) {
        let kingRow = Math.floor(king.currentSquare / 8);
        let kingCol = king.currentSquare % 8;
        if (orientation === 'black') {
          kingRow = 7 - kingRow;
          kingCol = 7 - kingCol;
        }
        
        if (lastMove.san.startsWith('O-O-O')) {
            // Top left of king's square
            castleX = (kingCol * squareSize);
            castleY = (kingRow * squareSize);
        } else {
            // Top right of king's square
            castleX = (kingCol * squareSize) + squareSize;
            castleY = (kingRow * squareSize);
        }
      }
      
      newEvents.push({
        id: idBase + '-castle',
        type: 'castle',
        isUser: isUserColor,
        x: castleX,
        y: castleY
      });
    }

    if (isCheck) {
      const checkedColor = lastMove.color === 'w' ? 'black' : 'white';
      const king = pieces.find(p => p.type === 'king' && p.color === checkedColor && !p.isCaptured);
      
      let checkX = x;
      let checkY = y - (isCapture ? 30 : 0);
      
      if (king) {
        let kingRow = Math.floor(king.currentSquare / 8);
        let kingCol = king.currentSquare % 8;
        if (orientation === 'black') {
          kingRow = 7 - kingRow;
          kingCol = 7 - kingCol;
        }
        
        // Top right of the king's square
        checkX = (kingCol * squareSize) + squareSize;
        checkY = (kingRow * squareSize);
      }
      
      newEvents.push({
        id: idBase + '-check',
        type: 'check',
        isUser: isUserColor,
        x: checkX,
        y: checkY
      });
    }

    if (isPromotion) {
      newEvents.push({
        id: idBase + '-promo',
        type: 'promotion',
        isUser: isUserColor,
        x,
        y
      });
    }

    setEvents(newEvents);

  }, [lastMove, orientation, squareSize, pieces, historyLength]);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', width: '100%', height: '100%', zIndex: 100 }}>
      {events.map(ev => (
         <CombatAnimation key={ev.id} event={ev} onComplete={() => {
            setEvents(prev => prev.filter(e => e.id !== ev.id));
         }} />
      ))}
    </div>
  );
}

function CombatAnimation({ event, onComplete }: { event: CombatEvent, onComplete: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const color = event.isUser ? '#00ffe1' : '#ff1100';
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const anim = animate(el, {
      translateY: [-24, -84],
      translateX: ['-50%', '-50%'],
      opacity: [0, 1, 1, 0],
      scale: [0.5, 1.2, 1, 1],
      duration: 3500,
      ease: 'outQuart',
      onComplete: () => {
         if (onCompleteRef.current) onCompleteRef.current();
      }
    });

    return () => {
      anim.pause();
    };
  }, []); // Only run once on mount

  return (
    <div 
      ref={containerRef}
      style={{ 
        position: 'absolute', 
        left: event.x,
        top: event.y,
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
        justifyContent: 'center',
        filter: `drop-shadow(0 0 12px ${color})`,
        willChange: 'transform, opacity',
        transform: 'translate(-50%, -50%)' // Ensure initial centering
      }}
    >
      {event.type === 'capture' && (
        <>
          {event.piece === 'p' && <NumberCircleOne size={24} color={color} weight="bold" />}
          {(event.piece === 'n' || event.piece === 'b') && <NumberCircleThree size={24} color={color} weight="bold" />}
          {event.piece === 'r' && <NumberCircleFive size={24} color={color} weight="bold" />}
          {event.piece === 'q' && <NumberCircleNine size={24} color={color} weight="bold" />}
          
          {event.isUser ? (
             <Sparkle size={24} color={color} weight="bold" />
          ) : (
             <X size={24} color={color} weight="bold" />
          )}
        </>
      )}
      {event.type === 'check' && (
        <CheckFat size={24} color={color} weight="bold" />
      )}
      {event.type === 'castle' && (
        <Shield size={24} color={color} weight="bold" />
      )}
      {event.type === 'promotion' && (
        <ArrowFatUp size={24} color={color} weight="bold" />
      )}
    </div>
  );
}
