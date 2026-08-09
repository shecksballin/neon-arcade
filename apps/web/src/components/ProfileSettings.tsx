import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User, Camera, Check, X, LogOut, Shield, ChevronRight } from 'lucide-react';
import { AVATAR_LIST } from '../lib/avatars';

interface ProfileSettingsProps {
  currentProfile: { name: string; avatarUrl: string };
  onUpdate: (profile: { name: string; avatarUrl: string }) => void;
  onClose: () => void;
}

const AVATARS = AVATAR_LIST;

export const ProfileSettings: React.FC<ProfileSettingsProps> = ({ currentProfile, onUpdate, onClose }) => {
  const [name, setName] = useState(currentProfile.name);
  const [selectedAvatar, setSelectedAvatar] = useState(currentProfile.avatarUrl);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'stats'>('profile');

  // Profile is client-side for now (localStorage via App.tsx). Syncs to
  // the backend `users` table once accounts land.
  const handleUpdate = () => {
    if (!name.trim()) return setError('Username is required');
    if (name.length > 20) return setError('Username must be under 20 characters');
    setError(null);
    onUpdate({ name: name.trim(), avatarUrl: selectedAvatar });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/80 backdrop-blur-md"
        onClick={onClose}
      />
      
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        className="relative w-full max-w-2xl bg-[#0a0a0a] border border-white/10 rounded-[32px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.5)] flex flex-col md:flex-row h-[600px]"
      >
        {/* Sidebar */}
        <div className="w-full md:w-64 bg-[#111] border-r border-white/5 p-6 space-y-2">
          <div className="flex items-center gap-3 mb-8 px-2">
            <div className="w-10 h-10 rounded-xl bg-[#00FFD1]/10 flex items-center justify-center">
              <Shield className="w-5 h-5 text-[#00FFD1]" />
            </div>
            <span className="font-black italic uppercase text-white">System Config</span>
          </div>

          <button 
            onClick={() => setActiveTab('profile')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              activeTab === 'profile' ? 'bg-[#00FFD1] text-black font-black italic' : 'text-white/40 hover:text-white/80 transition-colors'
            }`}
          >
            <User className="w-4 h-4" />
            <span className="uppercase text-xs tracking-widest">Identity</span>
          </button>
          
          <div className="pt-4 mt-4 border-t border-white/5">
             <button 
                onClick={() => {
                  localStorage.removeItem('neon_arcade_profile');
                  window.location.reload();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-500/60 hover:text-red-500 hover:bg-red-500/5 transition-all"
             >
                <LogOut className="w-4 h-4" />
                <span className="uppercase text-xs tracking-widest">Logout</span>
             </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 p-8 overflow-y-auto custom-scrollbar">
          <div className="flex justify-between items-start mb-8">
            <div>
              <h2 className="text-2xl font-black italic uppercase text-white tracking-widest">Profile Settings</h2>
              <div className="flex items-center gap-4 mt-1">
                <p className="text-white/40 text-[10px] font-mono">USER_ID: {currentProfile.name.toUpperCase()}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
              <X className="w-5 h-5 text-white/40" />
            </button>
          </div>

          <div className="space-y-8">
            {/* Avatar Section */}
            <div className="space-y-4">
              <label className="text-[10px] font-mono uppercase tracking-[3px] text-[#00FFD1]/60 px-1">Visual Representation</label>
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
                {AVATARS.map((url) => (
                  <button
                    key={url}
                    onClick={() => {
                      setSelectedAvatar(url);
                    }}
                    className={`relative aspect-square rounded-2xl overflow-hidden border-2 transition-all ${
                      selectedAvatar === url ? 'border-[#00FFD1] scale-105 shadow-[0_0_20px_rgba(0,255,209,0.2)]' : 'border-transparent opacity-40 hover:opacity-80'
                    }`}
                  >
                    <img src={url} alt="Avatar" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </div>

            {/* Name Section — read-only: usernames are unique and live in
                the account registry, so they can't be edited locally. */}
            <div className="space-y-4">
              <label className="text-[10px] font-mono uppercase tracking-[3px] text-[#00FFD1]/60 px-1">Callsign</label>
              <div className="relative">
                <input
                  type="text"
                  value={name}
                  disabled
                  title="Usernames are managed by your account and can't be changed here"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 px-6 text-white/60 text-xl font-black italic focus:outline-none transition-all cursor-not-allowed"
                />
              </div>
              <p className="text-[9px] font-mono uppercase tracking-widest text-white/25 px-1">
                Registered account username — locked
              </p>
            </div>

            {error && <p className="text-red-400 text-xs font-mono italic text-center">* {error}</p>}

            <div className="pt-4">
              <button
                onClick={handleUpdate}
                className="w-full bg-[#00FFD1] hover:bg-[#00E5BC] text-black font-black py-5 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 uppercase italic tracking-tighter text-lg"
              >
                Apply Changes
                <Check className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
