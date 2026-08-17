/**
 * WalletPanel
 * ===========
 * Opened by the "Wallet" button in the top nav once a user is logged in.
 * Lets them access their embedded Privy wallet and see its funds:
 *   - the wallet address (copy + view on explorer)
 *   - the live SOL balance (devnet), with a refresh
 *   - export the embedded wallet's private key (Privy's own secure modal)
 *   - disconnect
 *
 * Read-only + Privy-native: this panel never moves money itself. Balance
 * is read from the RPC; export is handled inside Privy's iframe. All real
 * wager money movement lives on the server.
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  Wallet,
  Copy,
  Check,
  LogOut,
  X,
  RefreshCcw,
  ExternalLink,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../auth';
import { useWalletAddress, isEmbeddedWallet, pickPrimaryWallet } from '../hooks/useWalletAddress';
import { useSolBalance } from '../hooks/useSolBalance';
import { explorerAddressUrl, SOLANA_CLUSTER } from '../lib/solana';
import { useCurrency } from '../CurrencyStore';

interface WalletPanelProps {
  profile: { name: string; avatarUrl: string } | null;
  onClose: () => void;
  onDisconnect: () => void;
}

const GUEST_AVATAR = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const WalletPanel: React.FC<WalletPanelProps> = ({ profile, onClose, onDisconnect }) => {
  const { address } = useWalletAddress();
  const { wallets, exportWallet } = useAuth();
  const { balance, loading, error, refresh } = useSolBalance(address);
  const { currency, fromSol, formatSolAs, isNative } = useCurrency();

  const [copied, setCopied] = useState(false);

  // Same rule as the sidebar's wallet card: the balance is READ in SOL and
  // only DISPLAYED in the player's currency, and no rate means no guess —
  // it stays in SOL. Probing with 1 SOL (rather than the balance, which may
  // still be null) keeps the unit label steady while the RPC call is out.
  const canConvert = !isNative && fromSol(1) !== null;
  const amountText = error
    ? '—'
    : balance === null
      ? '…'
      : canConvert
        ? formatSolAs(balance, { bare: true })
        : balance.toLocaleString(undefined, { maximumFractionDigits: 4 });

  // Export is only meaningful for the Privy embedded wallet — you can't
  // export the private key of an external wallet (Phantom etc.).
  const primary = pickPrimaryWallet(wallets);
  const isEmbedded = primary ? isEmbeddedWallet(primary) : false;

  const handleCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op, the address is still visible to read */
    }
  };

  const handleExport = async () => {
    // exportWallet is null until the lazy auth chunk lands. Unreachable in
    // practice — this panel only opens for an authenticated user, which
    // implies a loaded SDK — but the type is honestly nullable, so honour it.
    if (!address || !exportWallet) return;
    try {
      await exportWallet({ address });
    } catch (e) {
      console.error('Export wallet failed:', e);
    }
  };

  const hasAvatar = profile?.avatarUrl && profile.avatarUrl !== GUEST_AVATAR;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
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
        className="relative w-full max-w-md bg-[#081616] border border-[#00FFD1]/30 rounded-[28px] overflow-hidden shadow-[0_0_60px_rgba(0,255,209,0.15)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#00FFD1]/10 flex items-center justify-center">
              <Wallet className="w-5 h-5 text-[#00FFD1]" />
            </div>
            <div>
              <h2 className="text-lg font-black italic uppercase text-white tracking-tighter leading-none">
                Wallet
              </h2>
              <span className="text-[9px] font-mono uppercase tracking-[2px] text-[#00FFD1]/50">
                {isEmbedded ? 'Embedded · ' : 'External · '}{SOLANA_CLUSTER}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors" title="Close">
            <X className="w-5 h-5 text-white/40" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Identity */}
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-white/5 overflow-hidden border border-[#00FFD1]/40 flex items-center justify-center shrink-0">
              {hasAvatar ? (
                <img src={profile!.avatarUrl} alt={profile!.name} className="w-full h-full object-cover" />
              ) : (
                <Wallet className="w-5 h-5 text-[#00FFD1]" />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-black italic uppercase text-white tracking-tighter truncate">
                {profile?.name ?? 'Player'}
              </p>
              <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest">Signed in</p>
            </div>
          </div>

          {/* Balance card */}
          <div className="rounded-2xl border border-[#00FFD1]/20 bg-[#00FFD1]/[0.04] p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono uppercase tracking-[2px] text-[#00FFD1]/60">Balance</span>
              <button
                onClick={refresh}
                disabled={loading}
                className="p-1.5 rounded-full hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Refresh balance"
              >
                <RefreshCcw className={`w-3.5 h-3.5 text-[#00FFD1] ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black tracking-tighter text-white tabular-nums">
                {amountText}
              </span>
              <span className="text-sm font-bold text-[#00FFD1] uppercase">
                {canConvert ? currency.code : 'SOL'}
              </span>
            </div>
            {/* What you actually hold, kept on screen under the conversion. */}
            {canConvert && !error && balance !== null && (
              <p className="mt-1 font-mono text-[11px] tracking-wider text-white/40 tabular-nums">
                ◎{balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL
              </p>
            )}
            {error && <p className="text-red-400/80 text-[10px] font-mono mt-2 italic">* {error} — try refresh</p>}
          </div>

          {/* Address */}
          <div className="space-y-2">
            <span className="text-[10px] font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-1">Address</span>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                <p className="font-mono text-xs text-white/80 truncate">{address ?? 'No wallet'}</p>
              </div>
              <button
                onClick={handleCopy}
                disabled={!address}
                className="p-3 rounded-xl border border-white/10 hover:border-[#00FFD1]/40 hover:bg-[#00FFD1]/5 transition-all disabled:opacity-40"
                title="Copy address"
              >
                {copied ? <Check className="w-4 h-4 text-[#00FFD1]" /> : <Copy className="w-4 h-4 text-white/60" />}
              </button>
              <a
                href={address ? explorerAddressUrl(address) : undefined}
                target="_blank"
                rel="noreferrer"
                className={`p-3 rounded-xl border border-white/10 transition-all ${
                  address ? 'hover:border-[#00FFD1]/40 hover:bg-[#00FFD1]/5' : 'opacity-40 pointer-events-none'
                }`}
                title="View on explorer"
              >
                <ExternalLink className="w-4 h-4 text-white/60" />
              </a>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-1">
            {isEmbedded && (
              <button
                onClick={handleExport}
                className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/[0.08] border border-white/10 hover:border-[#00FFD1]/40 text-white/90 font-bold py-3.5 rounded-xl transition-all uppercase text-xs tracking-widest"
              >
                <KeyRound className="w-4 h-4 text-[#00FFD1]" />
                Export Private Key
              </button>
            )}
            <button
              onClick={onDisconnect}
              className="w-full flex items-center justify-center gap-2 text-red-500/70 hover:text-red-400 hover:bg-red-500/5 border border-transparent hover:border-red-500/20 font-bold py-3.5 rounded-xl transition-all uppercase text-xs tracking-widest"
            >
              <LogOut className="w-4 h-4" />
              Disconnect
            </button>
          </div>

          {/* Reassurance footer */}
          <div className="flex items-center justify-center gap-1.5 text-[9px] font-mono uppercase tracking-widest text-white/25 border-t border-white/5 pt-4">
            <ShieldCheck className="w-3 h-3" />
            Keys secured by Privy
          </div>
        </div>
      </motion.div>
    </div>
  );
};
