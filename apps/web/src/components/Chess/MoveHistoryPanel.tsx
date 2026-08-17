import React, { useRef, useEffect } from 'react';
import { Undo2, Plus } from 'lucide-react';

export function MoveHistoryPanel({ 
  history, 
  onUndo,  
  onNewGame
}: {
  history: any[],
  onUndo?: () => void,
  onNewGame?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const pairs = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push({ number: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] });
  }

  return (
    <div className="flex flex-col w-full h-full bg-[#041010] overflow-hidden rounded shadow-lg board-neon-border" style={{ fontFamily: 'var(--font-sans)' }}>
      {/* Moves List */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto w-full custom-scrollbar block"
      >
        {pairs.length === 0 && (
           <div className="p-4 text-[#00ffd1]/60 text-xs font-semibold text-center italic mt-4">
             No moves yet
           </div>
        )}
        {pairs.map(({ number, white, black }, index) => (
          <div key={number} className={`flex text-sm font-semibold tracking-wide ${index % 2 === 0 ? 'bg-transparent' : 'bg-[#00ffd1]/5'}`}>
             <div className="w-[15%] min-w-[36px] text-[#00ffd1]/60 border-r border-[#00ffd1]/20 flex items-center justify-center py-1 text-xs">
               {number}.
             </div>
             <div className="w-[42.5%] px-3 py-1 flex items-center text-[#e0e0e0] hover:bg-[#00ffd1]/20 cursor-pointer transition-colors border-r border-[#00ffd1]/20">
               {white?.san}
             </div>
             <div className="w-[42.5%] px-3 py-1 flex items-center text-[#e0e0e0] hover:bg-[#00ffd1]/20 cursor-pointer transition-colors">
               {black?.san ?? ''}
             </div>
          </div>
        ))}
      </div>

      {/* Control Buttons */}
      <div className="bg-[#00ffd1]/10 flex items-center justify-between p-2 border-t border-[#00ffd1]/30">
         <div className="flex gap-1 ml-2">
           {onNewGame && (
             <button 
               onClick={onNewGame}
               title="New Game"
               className="text-[#00ffd1]/80 hover:text-[#00ffd1] p-1.5 rounded hover:bg-[#00ffd1]/20 transition-colors flex items-center gap-1"
             >
               <Plus size={16} />
             </button>
           )}
           {onUndo && (
             <button 
               onClick={onUndo}
               title="Reverse Move"
               className="text-[#00ffd1]/80 hover:text-[#00ffd1] p-1.5 rounded hover:bg-[#00ffd1]/20 transition-colors"
             >
               <Undo2 size={16} />
             </button>
           )}
         </div>
      </div>
    </div>
  );
}
