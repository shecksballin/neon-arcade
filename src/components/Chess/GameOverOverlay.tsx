import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Shield } from 'lucide-react';

export function GameOverOverlay({ gameResult, onRematch, playerColor, rematchText = "Rematch" }: any) {
  const isGameOver = ['checkmate', 'stalemate', 'draw'].includes(gameResult.status);
  
  if (!isGameOver) return null;

  const isCheckmate = gameResult.status === 'checkmate';
  const isStalemate = gameResult.status === 'stalemate' || gameResult.status === 'draw';
  
  let headerTitle = "Game Over";
  let subTitle = gameResult.message || "Match Ended";

  if (isCheckmate) {
     if (playerColor) {
        if (gameResult.winner === playerColor) {
           headerTitle = "Winner";
           subTitle = "Victory Achieved";
        } else if (gameResult.winner && gameResult.winner !== playerColor) {
           headerTitle = "Game Over";
           subTitle = "You Were Defeated";
        }
     } else {
        headerTitle = "Checkmate";
        subTitle = `${gameResult.winner.charAt(0).toUpperCase() + gameResult.winner.slice(1)} Wins`;
     }
  } else if (isStalemate) {
     headerTitle = "Stalemate";
     subTitle = gameResult.message || "Draw";
  }

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, backdropFilter: 'blur(0px)' }}
        animate={{ opacity: 1, scale: 1, backdropFilter: 'blur(12px)' }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#041010]/90"
        style={{ borderRadius: 8 }}
      >
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="flex flex-col items-center"
        >
          {isStalemate ? (
             <Shield className="w-20 h-20 text-[#00FFD1] mb-6 animate-pulse" />
          ) : (
             <Trophy className="w-20 h-20 text-[#00FFD1] mb-6 animate-pulse" />
          )}
          <h2 className="text-5xl md:text-6xl font-black text-white italic uppercase tracking-tighter mb-2 text-center">
             {headerTitle}
          </h2>
          <p className="text-xl md:text-2xl text-[#00FFD1] font-mono tracking-[0.2em] mb-4 uppercase text-center w-full px-4 break-words">
             {subTitle}
          </p>
        </motion.div>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="flex gap-4 mt-8"
        >
           <button 
              onClick={onRematch}
              className="px-12 py-4 font-black uppercase tracking-widest rounded-xl shadow-[0_0_30px_rgba(0,255,209,0.4)] hover:scale-105 transition-all flex flex-col items-center bg-[#00FFD1] text-[#081616]"
           >
              <span>{rematchText}</span>
           </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
