import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  User,
  Check,
  X,
  LogOut,
  Shield,
  Coins,
  Bell,
  MessageSquare,
  Swords,
  Users,
  Globe,
} from 'lucide-react';
import { AVATAR_LIST } from '../lib/avatars';
import RegionSelect from './common/RegionSelect';
import { getRegion, setRegion } from '../lib/region';
import { profileApi } from '../lib/api';
import { CurrencySelector } from './CurrencySelector';
import { useCurrency } from '../CurrencyStore';
import { useNotifications } from '../notifications/NotificationsStore';
import type { NotificationPrefs } from '../notifications/types';

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
  const [activeTab, setActiveTab] = useState<'profile' | 'currency' | 'notifications' | 'region'>('profile');
  const [regionValue, setRegionValue] = useState<string>(() => getRegion());
  const { currency } = useCurrency();
  const { prefs, setPref } = useNotifications();

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
        className="relative w-full max-w-2xl bg-[#0a0a0a] border border-white/10 rounded-3xl md:rounded-[32px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.5)] flex flex-col md:flex-row h-auto max-h-[85dvh] md:h-[600px]"
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

          <button
            onClick={() => setActiveTab('currency')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              activeTab === 'currency' ? 'bg-[#00FFD1] text-black font-black italic' : 'text-white/40 hover:text-white/80 transition-colors'
            }`}
          >
            <Coins className="w-4 h-4" />
            <span className="uppercase text-xs tracking-widest flex-1 text-left">Currency</span>
            <span className={`text-[10px] font-mono tracking-widest ${
              activeTab === 'currency' ? 'text-black/60' : 'text-white/25'
            }`}>
              {currency.code}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('notifications')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              activeTab === 'notifications' ? 'bg-[#00FFD1] text-black font-black italic' : 'text-white/40 hover:text-white/80 transition-colors'
            }`}
          >
            <Bell className="w-4 h-4" />
            <span className="uppercase text-xs tracking-widest flex-1 text-left">Alerts</span>
            <span className={`text-[10px] font-mono tracking-widest ${
              activeTab === 'notifications' ? 'text-black/60' : 'text-white/25'
            }`}>
              {prefs.popups ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('region')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
              activeTab === 'region' ? 'bg-[#00FFD1] text-black font-black italic' : 'text-white/40 hover:text-white/80 transition-colors'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span className="uppercase text-xs tracking-widest flex-1 text-left">Region</span>
            <span className={`text-[10px] font-mono tracking-widest ${
              activeTab === 'region' ? 'text-black/60' : 'text-white/25'
            }`}>
              {regionValue.toUpperCase()}
            </span>
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
              <h2 className="text-2xl font-black italic uppercase text-white tracking-widest">
                {activeTab === 'currency'
                  ? 'Display Currency'
                  : activeTab === 'notifications'
                    ? 'Notifications'
                    : activeTab === 'region'
                      ? 'Game Region'
                      : 'Profile Settings'}
              </h2>
              <div className="flex items-center gap-4 mt-1">
                <p className="text-white/40 text-[10px] font-mono">
                  {activeTab === 'currency'
                    ? `SHOWING AMOUNTS IN: ${currency.code}`
                    : activeTab === 'notifications'
                      ? `IN-APP POP-UPS: ${prefs.popups ? 'ENABLED' : 'DISABLED'}`
                      : activeTab === 'region'
                        ? `CONNECTED TO: ${regionValue.toUpperCase()}`
                        : `USER_ID: ${currentProfile.name.toUpperCase()}`}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
              <X className="w-5 h-5 text-white/40" />
            </button>
          </div>

          {activeTab === 'currency' && <CurrencySelector />}

          {activeTab === 'notifications' && (
            <NotificationSettings prefs={prefs} setPref={setPref} />
          )}

          {activeTab === 'region' && (
            <RegionSettings
              value={regionValue}
              onChange={(r) => setRegionValue(r)}
            />
          )}

          <div className={`space-y-8 ${activeTab === 'profile' ? '' : 'hidden'}`}>
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

// ---------------------------------------------------------------------------
// REGION TAB
// ---------------------------------------------------------------------------
/**
 * Which regional game server this player lives on. A region is a separate
 * PLAYER POOL (matches, queues and invites all live on that region's
 * machine), so the copy leads with the social rule. Selection is applied
 * instantly: localStorage first (routing + the socket reconnect read it),
 * then persisted on the account so it follows the player across devices.
 */
function RegionSettings({
  value,
  onChange,
}: {
  value: string;
  onChange: (region: string) => void;
}) {
  return (
    <div className="space-y-5">
      <RegionSelect
        value={value}
        onChange={(r) => {
          onChange(r);
          setRegion(r);
          void profileApi.setRegion(r).catch(() => {});
        }}
      />
      <div className="rounded-xl border border-[#FF6B9A]/20 bg-[#FF6B9A]/5 px-4 py-3">
        <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#FF6B9A]/80">
          Changing region reconnects you to a different server — leave any
          live match first, or it counts as a forfeit.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS TAB
// ---------------------------------------------------------------------------
/**
 * IN-APP POP-UPS ONLY. Every switch here is about the pop-up in the corner of
 * the screen — nothing silences the nav-bar bell, which is the record of what
 * happened. Turning pop-ups off means a wager invite arrives quietly and waits
 * for you in the bell (and on your friend's row in the menu), not that it
 * never arrived.
 *
 * Choices are stored per BROWSER (localStorage), not on the account: they are
 * about this screen, and a phone and a desktop can reasonably disagree.
 */
function NotificationSettings({
  prefs,
  setPref,
}: {
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <ToggleRow
        icon={<Bell className="w-4 h-4" />}
        title="In-app pop-ups"
        description="Show a card in the corner when something arrives. Off means notifications only appear in the nav-bar bell."
        checked={prefs.popups}
        onChange={(value) => setPref('popups', value)}
      />

      <div className="space-y-3">
        <label className="text-[10px] font-mono uppercase tracking-[3px] text-[#00FFD1]/60 px-1 block">
          Pop up for
        </label>
        {/* Dimmed rather than unmounted when the master is off: the player can
            still see what they had chosen, and turning pop-ups back on
            restores exactly that. */}
        <div className={`space-y-3 transition-opacity ${prefs.popups ? '' : 'opacity-40 pointer-events-none'}`}>
          <ToggleRow
            icon={<Swords className="w-4 h-4" />}
            title="Wager invites"
            description="A friend challenged you to a private wager."
            checked={prefs.invites}
            onChange={(value) => setPref('invites', value)}
            compact
          />
          <ToggleRow
            icon={<MessageSquare className="w-4 h-4" />}
            title="Messages"
            description="A direct message from a friend."
            checked={prefs.messages}
            onChange={(value) => setPref('messages', value)}
            compact
          />
          <ToggleRow
            icon={<Users className="w-4 h-4" />}
            title="Friend requests"
            description="Someone added you, or accepted your request."
            checked={prefs.friends}
            onChange={(value) => setPref('friends', value)}
            compact
          />
        </div>
      </div>

      <p className="text-[9px] font-mono uppercase tracking-widest text-white/25 px-1 leading-relaxed">
        Pop-ups never interrupt a match — anything that arrives while you are
        playing is held back and shown once the game ends.
      </p>
    </div>
  );
}

/** One labelled switch. The whole row is the control (label + input). */
function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
  compact = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-4 rounded-2xl border transition-all cursor-pointer ${
        compact ? 'p-3' : 'p-4'
      } ${
        checked
          ? 'border-[#00FFD1]/30 bg-[#00FFD1]/5'
          : 'border-white/10 bg-white/[0.02]'
      }`}
    >
      <span
        className={`shrink-0 flex items-center justify-center rounded-xl ${
          compact ? 'w-9 h-9' : 'w-10 h-10'
        } ${checked ? 'bg-[#00FFD1]/15 text-[#00FFD1]' : 'bg-white/5 text-white/30'}`}
      >
        {icon}
      </span>

      <span className="flex-1 min-w-0">
        <span className="block text-xs font-black uppercase tracking-widest text-white/90">
          {title}
        </span>
        <span className="block text-[9px] font-mono uppercase tracking-wider text-white/35 mt-1 leading-relaxed">
          {description}
        </span>
      </span>

      {/* A real checkbox, visually hidden: keyboard, screen readers and form
          semantics all keep working, and the neon track below is pure CSS. */}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <span
        aria-hidden="true"
        className={`shrink-0 relative w-11 h-6 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#00FFD1]/60 ${
          checked ? 'bg-[#00FFD1]' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full transition-all ${
            checked ? 'left-6 bg-[#00382c]' : 'left-1 bg-white/60'
          }`}
        />
      </span>
    </label>
  );
}
