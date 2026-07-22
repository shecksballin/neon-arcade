import React, { useState } from 'react';
import { 
  Menu as MenuIcon, 
  X as XIcon, 
  Users, 
  Trophy, 
  TrendingUp, 
  Settings, 
  Award, 
  MessageSquare, 
  History,
  Wallet
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useNeonBucks } from '../NeonBucksStore';

export function SidebarMenu({ 
  gameTitle = "Neon Arcade",
  isOpen: controlledIsOpen,
  onClose: controlledOnClose,
  showDefaultTrigger = false
}: { 
  gameTitle?: string;
  isOpen?: boolean;
  onClose?: () => void;
  showDefaultTrigger?: boolean;
}) {
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : localIsOpen;
  const { balance } = useNeonBucks();
  
  const setIsOpen = (open: boolean) => {
    if (controlledIsOpen !== undefined) {
      if (!open && controlledOnClose) {
        controlledOnClose();
      }
    } else {
      setLocalIsOpen(open);
    }
  };

  return (
    <>
      {showDefaultTrigger && (
        <button 
          onClick={() => setIsOpen(true)}
          className="fixed top-6 left-6 z-[60] p-2.5 border border-[#00FFD1]/40 rounded-full backdrop-blur-md hover:bg-[#00ffd1]/20 hover:shadow-[0_0_25px_rgba(0,255,209,0.35)] hover:scale-105 active:scale-95 transition-all flex items-center justify-center cursor-pointer group select-none shadow-lg"
        >
          <MenuIcon size={24} className="text-[#00FFD1] group-hover:rotate-12 transition-transform duration-300" />
        </button>
      )}

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 left-0 bottom-0 w-80 bg-[#081616] border-r border-[#00ffd1]/20 z-[200] flex flex-col font-mono shadow-[0_0_50px_rgba(0,255,209,0.1)]"
            >
              <div className="flex items-center justify-between p-6 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent">
                <h2 className="text-xl font-black text-[#00ffd1] uppercase tracking-[0.2em]">{gameTitle} Menu</h2>
                <button 
                  onClick={() => setIsOpen(false)}
                  className="text-white/50 hover:text-[#00FFD1] transition-colors cursor-pointer"
                >
                  <XIcon size={24} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                
                {/* Practice Wallet Section */}
                <div className="p-4 border border-[#00ffd1]/20 rounded-xl bg-gradient-to-br from-[#00ffd1]/10 to-transparent relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-3 opacity-20 group-hover:opacity-40 transition-opacity">
                    <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="w-12 h-12 object-contain" />
                  </div>
                  <div className="flex items-center gap-3 mb-2 relative z-10">
                    <div className="w-8 h-8 rounded-lg bg-[#00ffd1]/10 flex items-center justify-center border border-[#00ffd1]/30">
                      <Wallet size={18} className="text-[#00ffd1]" />
                    </div>
                    <div>
                      <div className="text-[10px] text-[#00ffd1]/60 uppercase tracking-widest">Practice Wallet</div>
                      <div className="text-2xl text-white font-black tracking-tighter flex items-center gap-1.5 mt-0.5">
                        <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-5 w-auto drop-shadow-[0_0_8px_rgba(0,255,209,0.5)]" />
                        <span>{balance.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 text-[9px] text-white/40 uppercase tracking-wider leading-relaxed border-t border-[#00ffd1]/10 pt-2 flex justify-between items-center">
                    <span>Practice Balance</span>
                    <span className="text-[#00ffd1]/80 font-bold animate-pulse">Sync Active</span>
                  </div>
                </div>

                {/* Rank Section */}
                <div className="p-4 border border-[#00ffd1]/20 rounded-xl bg-black/40">
                  <div className="flex items-center gap-3 mb-2">
                    <Award size={28} className="text-[#00ffd1] shrink-0" />
                    <div>
                      <div className="text-[10px] text-[#00ffd1]/60 uppercase tracking-widest">Current Rank</div>
                      <div className="text-xl text-white font-bold tracking-wider">DIAMOND I</div>
                    </div>
                  </div>
                  <div className="w-full bg-black/60 h-2 rounded-full mt-3 overflow-hidden">
                    <div className="bg-[#00ffd1] h-full w-[75%] shadow-[0_0_10px_#00ffd1]"></div>
                  </div>
                </div>

                {/* Navigation Items */}
                <div className="space-y-2">
                  <NavItem icon={<Users size={20} />} label="Friends" count={5} />
                  <NavItem icon={<MessageSquare size={20} />} label="Messages" count={2} />
                  <NavItem icon={<History size={20} />} label={`${gameTitle} History`} />
                  <NavItem icon={<Trophy size={20} />} label="Leaderboard" />
                  <NavItem icon={<TrendingUp size={20} />} label="Stats" />
                  <NavItem icon={<Settings size={20} />} label="Settings" />
                </div>

                {/* Placeholder Friends List */}
                <div className="pt-4 border-t border-[#00ffd1]/20">
                  <div className="text-[10px] text-white/40 uppercase tracking-[0.2em] mb-4 pl-2">Online Friends</div>
                  <div className="space-y-3">
                    <FriendItem name="CyberNinja" status="In Game" />
                    <FriendItem name="GlitchMatrix" status="Online" />
                    <FriendItem name="NeonRider" status="Away" />
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function NavItem({ icon, label, count }: { icon: React.ReactNode, label: string, count?: number }) {
  return (
    <button className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
      <div className="flex items-center gap-3">
        {icon}
        <span className="uppercase tracking-wider text-sm">{label}</span>
      </div>
      {count !== undefined && (
        <span className="bg-[#00ffd1]/20 text-[#00ffd1] text-[10px] px-2 py-1 rounded-md font-bold">
          {count}
        </span>
      )}
    </button>
  );
}

function FriendItem({ name, status }: { name: string, status: string }) {
  const isOnline = status === 'Online';
  const isInGame = status === 'In Game';

  return (
    <div className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group">
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00ffd1]/40 to-blue-500/40 border border-[#00ffd1]/20" />
          <div className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-[#081616] ${isOnline ? 'bg-green-500' : isInGame ? 'bg-purple-500' : 'bg-yellow-500'}`} />
        </div>
        <div className="text-left">
          <div className="text-sm text-white/90 group-hover:text-white transition-colors tracking-wide">{name}</div>
          <div className={`text-[10px] ${isInGame ? 'text-purple-400' : isOnline ? 'text-green-400' : 'text-yellow-400'}`}>{status}</div>
        </div>
      </div>
    </div>
  );
}
