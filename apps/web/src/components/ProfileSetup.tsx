import React, { useState } from 'react';
import { motion } from 'motion/react';
import { User, Camera, Check, ArrowRight } from 'lucide-react';
import { AVATAR_LIST } from '../lib/avatars';

interface ProfileSetupProps {
  // `guest: true` means the user skipped avatar/username selection —
  // App.tsx uses it to skip the wallet login popup (practice only).
  onComplete: (profile: { name: string; avatarUrl: string }, opts?: { guest?: boolean }) => void;
}

const AVATARS = AVATAR_LIST;

export const ProfileSetup: React.FC<ProfileSetupProps> = ({ onComplete }) => {
  const [name, setName] = useState('');
  const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0]);
  const [error, setError] = useState<string | null>(null);

  // Profile is client-side for now (localStorage via App.tsx). It syncs
  // to the backend `users` table once accounts land — wallet sign-in
  // happens right after this screen, so the identity to attach it to
  // doesn't exist yet.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter a username');
      return;
    }
    if (name.length > 20) {
      setError('Username must be under 20 characters');
      return;
    }

    setError(null);
    onComplete({ name: name.trim(), avatarUrl: selectedAvatar });
  };

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-[#111] rounded-3xl p-8 border border-white/5 shadow-2xl"
      >
        <div className="text-center mb-10">
          <div className="inline-flex p-3 bg-[#00FFD1]/10 rounded-2xl mb-4">
            <User className="w-8 h-8 text-[#00FFD1]" />
          </div>
          <h1 className="text-3xl font-black text-white italic uppercase tracking-tighter">
            Initialize Profile
          </h1>
          <p className="text-white/40 text-sm mt-2 font-mono uppercase tracking-widest">
            Identity verification required
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 mb-6 text-center">
              Choose your avatar
            </label>
            <div className="grid grid-cols-4 gap-4 mb-6">
              {AVATARS.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => {
                    setSelectedAvatar(url);
                  }}
                  className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all duration-300 ${
                    selectedAvatar === url ? 'border-[#00FFD1] scale-105 shadow-[0_0_15px_rgba(0,255,209,0.3)]' : 'border-transparent opacity-50 hover:opacity-80'
                  }`}
                >
                  <img src={url} alt="Avatar" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
              Username
            </label>
            <div className="relative group">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ENTER NAME..."
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 px-6 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 focus:bg-white/[0.07] transition-all font-bold tracking-tight text-lg"
              />
            </div>
            {error && (
              <motion.p 
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-red-400 text-xs font-mono mt-2 px-2 italic"
              >
                * {error}
              </motion.p>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className={`w-full group relative overflow-hidden bg-[#00FFD1] hover:bg-[#00E5BC] text-black font-black py-5 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 uppercase italic tracking-tighter text-lg`}
            >
              <span className="relative z-10">Ready to Play</span>
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                const guestName = `Guest_${Math.floor(Math.random() * 10000)}`;
                const guestAvatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                onComplete({ name: guestName, avatarUrl: guestAvatar }, { guest: true });
              }}
              className="w-full text-white/40 hover:text-white/80 font-mono text-xs uppercase tracking-widest py-3 transition-colors"
            >
              Play as Guest
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
};
