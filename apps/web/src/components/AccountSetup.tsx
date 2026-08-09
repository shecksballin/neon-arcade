import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { User, ShieldCheck, Copy, Check, ArrowRight, Loader2, Smartphone, RefreshCw } from 'lucide-react';
import { useWallets } from '@privy-io/react-auth/solana';
import { AVATAR_LIST } from '../lib/avatars';
import { profileApi, NETWORK_ERROR_MESSAGE } from '../lib/api';
import { useBackendAuth, AUTH_TOKEN_KEY } from '../hooks/useBackendAuth';
import { USERNAME_REGEX, USERNAME_RULES, PIN_REGEX, TOTP_CODE_REGEX } from '@neon/types';

/**
 * ACCOUNT SETUP — shown the INSTANT Privy sign-on completes.
 *
 * Because it opens before the embedded wallet exists or the backend JWT
 * is minted, the panel owns that whole "connect" phase itself:
 *   connect: wait for the wallet → run (or join — useBackendAuth shares
 *     one in-flight promise) the signature exchange → check the account
 *     registry. Accounts that are already complete self-dismiss here.
 * Then:
 *   Step 1 "identity": pick an avatar, claim a unique username, choose
 *     a 4-digit PIN. POSTs to /api/profile/register (the server hashes
 *     the PIN and mints the TOTP secret — nothing sensitive here).
 *   Step 2 "authenticator": scan the server-rendered QR with an
 *     authenticator app and prove one 6-digit code to finish.
 */

interface AccountSetupProps {
  onComplete: (profile: { name: string; avatarUrl: string }) => void;
}

type Step = 'connect' | 'identity' | 'authenticator';

const AVATARS = AVATAR_LIST;

export const AccountSetup: React.FC<AccountSetupProps> = ({ onComplete }) => {
  const [step, setStep] = useState<Step>('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // connect-phase state
  const { wallets } = useWallets();
  const { signIn } = useBackendAuth();
  const [connectLabel, setConnectLabel] = useState('Preparing your wallet…');
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectStarted = useRef(false);

  // step 1 state
  const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0]);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');

  // step 2 state (from the register response)
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [registeredName, setRegisteredName] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  // The connect phase: make sure a session JWT exists (signature
  // exchange with the wallet — a small Privy prompt for embedded
  // wallets, the wallet's own popup for Phantom etc.), then look the
  // account up. A wallet that already finished setup skips straight
  // through; one that abandoned mid-enrollment restarts at identity —
  // re-registering is allowed until TOTP is proven.
  const runConnect = useCallback(async () => {
    setConnectError(null);

    const attemptConnect = async () => {
      const freshSignIn = async () => {
        setConnectLabel('Confirm the signature request from your wallet…');
        await signIn();
        setConnectLabel('Checking account…');
      };

      const hadToken = !!localStorage.getItem(AUTH_TOKEN_KEY);
      if (!hadToken) await freshSignIn();
      setConnectLabel('Checking account…');

      let me;
      try {
        me = await profileApi.me();
      } catch (err) {
        // A stored token can be stale (expired, or the server's signing
        // secret rotated). Without this, retries would skip the
        // signature step and 401 forever — drop the dead token and
        // sign once more instead.
        const message = err instanceof Error ? err.message : '';
        if (hadToken && /token/i.test(message)) {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          await freshSignIn();
          me = await profileApi.me();
        } else {
          throw err;
        }
      }

      if (me.username && me.totpEnabled) {
        onComplete({ name: me.username, avatarUrl: AVATARS[0] });
      } else {
        setStep('identity');
      }
    };

    // Transient blips (server restarting, wifi hiccup) get two quiet
    // retries before the user sees anything. Signature dismissals and
    // real API errors surface immediately — retrying those would just
    // re-pop prompts at someone who said no.
    for (let attempt = 0; ; attempt++) {
      try {
        await attemptConnect();
        return;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Sign-in failed — try again';
        if (message === NETWORK_ERROR_MESSAGE && attempt < 2) {
          setConnectLabel('Reconnecting…');
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        setConnectError(message);
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn, onComplete]);

  // Kick off as soon as a wallet exists (embedded wallets are created
  // moments after login, so the list can be empty for the first beats).
  // With a stored JWT there is nothing to sign — start immediately.
  useEffect(() => {
    if (connectStarted.current) return;
    if (!localStorage.getItem(AUTH_TOKEN_KEY) && wallets.length === 0) return;
    connectStarted.current = true;
    runConnect();
  }, [wallets, runConnect]);

  const digitsOnly = (value: string, length: number) =>
    value.replace(/\D/g, '').slice(0, length);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!USERNAME_REGEX.test(username)) {
      setError(`Invalid username — ${USERNAME_RULES.toLowerCase()}`);
      return;
    }
    if (!PIN_REGEX.test(pin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    if (pin !== pinConfirm) {
      setError('PINs do not match');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await profileApi.register(username, pin);
      setQrDataUrl(res.qrDataUrl);
      setSecret(res.secret);
      setRegisteredName(res.username);
      setCode('');
      setStep('authenticator');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed — try again');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!TOTP_CODE_REGEX.test(code)) {
      setError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await profileApi.verifyTotp(code);
      onComplete({ name: registeredName, avatarUrl: selectedAvatar });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed — try again');
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the secret is still visible to retype */
    }
  };

  return (
    // pt/pb clear the fixed top nav (top-6 + its height) and the fixed
    // footer, so the card sits exactly in the space between them; if the
    // window is shorter than the content, the card scrolls internally
    // (max-h-full + overflow) instead of sliding under either bar.
    <div className="h-full bg-[#050505] flex items-center justify-center px-6 pt-28 pb-20">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full max-h-full overflow-y-auto bg-[#111] rounded-3xl p-6 sm:p-7 border border-white/5 shadow-2xl"
      >
        {step === 'connect' && (
          <>
            <div className="text-center mb-2">
              <div className="inline-flex p-3 bg-[#00FFD1]/10 rounded-2xl mb-4">
                <User className="w-8 h-8 text-[#00FFD1]" />
              </div>
              <h1 className="text-3xl font-black text-white italic uppercase tracking-tighter">
                Create Account
              </h1>
            </div>

            {!connectError ? (
              <div className="flex flex-col items-center gap-4 py-10">
                <Loader2 className="w-8 h-8 text-[#00FFD1] animate-spin" />
                <p className="text-white/40 text-xs font-mono uppercase tracking-widest text-center px-4 leading-relaxed">
                  {connectLabel}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-5 py-8">
                <p className="text-red-400 text-xs font-mono italic text-center px-4">
                  * {connectError}
                </p>
                {/* Signature hint only when signing is what failed — a
                    connection problem or unconfigured server is not the
                    user's to fix */}
                {connectError !== NETWORK_ERROR_MESSAGE && !/configured/i.test(connectError) && (
                  <p className="text-white/40 text-[10px] font-mono uppercase tracking-widest text-center px-4 leading-relaxed">
                    A wallet signature is required to secure your account
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => runConnect()}
                  className="flex items-center gap-2 bg-[#00FFD1] hover:bg-[#00E5BC] text-black font-black py-3.5 px-8 rounded-2xl transition-all uppercase italic tracking-tighter"
                >
                  <RefreshCw className="w-4 h-4" />
                  Try again
                </button>
              </div>
            )}
          </>
        )}

        {step === 'identity' && (
          <>
            <div className="text-center mb-5">
              <div className="inline-flex p-2.5 bg-[#00FFD1]/10 rounded-2xl mb-3">
                <User className="w-7 h-7 text-[#00FFD1]" />
              </div>
              <h1 className="text-2xl font-black text-white italic uppercase tracking-tighter">
                Create Account
              </h1>
              <p className="text-white/40 text-xs mt-1.5 font-mono uppercase tracking-widest">
                Step 1 of 2 · Identity
              </p>
            </div>

            <form onSubmit={handleRegister} className="space-y-5">
              <div>
                <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 mb-3 text-center">
                  Choose your avatar
                </label>
                {/* one tidy row — AVATAR_LIST ships 7 */}
                <div className="grid grid-cols-7 gap-2">
                  {AVATARS.map((url) => (
                    <button
                      key={url}
                      type="button"
                      onClick={() => setSelectedAvatar(url)}
                      className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all duration-300 ${
                        selectedAvatar === url
                          ? 'border-[#00FFD1] scale-105 shadow-[0_0_15px_rgba(0,255,209,0.3)]'
                          : 'border-transparent opacity-50 hover:opacity-80'
                      }`}
                    >
                      <img src={url} alt="Avatar" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ENTER NAME..."
                  maxLength={20}
                  autoComplete="off"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 px-6 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 focus:bg-white/[0.07] transition-all font-bold tracking-tight text-lg"
                />
                <p className="text-[10px] font-mono text-white/25 px-2 uppercase tracking-wider">
                  {USERNAME_RULES} · unique across the arcade
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                    4-digit PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(digitsOnly(e.target.value, 4))}
                    placeholder="••••"
                    autoComplete="new-password"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 px-6 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 transition-all font-bold text-center text-xl tracking-[0.5em]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                    Confirm PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(digitsOnly(e.target.value, 4))}
                    placeholder="••••"
                    autoComplete="new-password"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 px-6 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 transition-all font-bold text-center text-xl tracking-[0.5em]"
                  />
                </div>
              </div>

              {error && (
                <motion.p
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="text-red-400 text-xs font-mono px-2 italic"
                >
                  * {error}
                </motion.p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full group relative overflow-hidden bg-[#00FFD1] hover:bg-[#00E5BC] disabled:opacity-50 text-black font-black py-4 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 uppercase italic tracking-tighter text-lg"
              >
                {busy ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <span className="relative z-10">Continue</span>
                    <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </button>
            </form>
          </>
        )}

        {step === 'authenticator' && (
          <>
            <div className="text-center mb-4">
              <div className="inline-flex p-2.5 bg-[#00FFD1]/10 rounded-2xl mb-3">
                <ShieldCheck className="w-7 h-7 text-[#00FFD1]" />
              </div>
              <h1 className="text-2xl font-black text-white italic uppercase tracking-tighter">
                Secure Account
              </h1>
              <p className="text-white/40 text-xs mt-1.5 font-mono uppercase tracking-widest">
                Step 2 of 2 · Authenticator
              </p>
            </div>

            {/* An app is required — say so explicitly, with options */}
            <div className="flex gap-3 p-3 rounded-2xl bg-[#00FFD1]/5 border border-[#00FFD1]/20 mb-4">
              <Smartphone className="w-5 h-5 text-[#00FFD1] shrink-0 mt-0.5" />
              <p className="text-[10px] leading-relaxed text-white/60 font-mono uppercase tracking-wide">
                An authenticator app is required — install{' '}
                <span className="text-[#00FFD1]">Google Authenticator</span> on your phone, or an
                alternative like <span className="text-white/80">Authy</span>,{' '}
                <span className="text-white/80">Microsoft Authenticator</span> or{' '}
                <span className="text-white/80">1Password</span>, then scan this code.
              </p>
            </div>

            <div className="flex justify-center mb-4">
              <div className="p-2.5 bg-white rounded-2xl shadow-[0_0_40px_rgba(0,255,209,0.15)]">
                {/* Server-rendered QR of the otpauth:// URI */}
                <img src={qrDataUrl} alt="Scan with your authenticator app" className="w-44 h-44" />
              </div>
            </div>

            <button
              type="button"
              onClick={copySecret}
              title="Copy the setup key for manual entry"
              className="w-full flex items-center justify-center gap-2 mb-4 py-2 rounded-xl border border-white/10 text-white/40 hover:text-white/80 hover:border-white/25 transition-all font-mono text-[10px] uppercase tracking-widest"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-[#00FFD1]" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : `Can't scan? Copy key: ${secret.slice(0, 8)}…`}
            </button>

            <form onSubmit={handleVerify} className="space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2 text-center">
                  Enter the 6-digit code from the app
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(digitsOnly(e.target.value, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 px-6 text-white placeholder-white/15 focus:outline-none focus:border-[#00FFD1]/50 transition-all font-bold text-center text-2xl tracking-[0.4em]"
                />
              </div>

              {error && (
                <motion.p
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="text-red-400 text-xs font-mono px-2 italic text-center"
                >
                  * {error}
                </motion.p>
              )}

              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="w-full bg-[#00FFD1] hover:bg-[#00E5BC] disabled:opacity-40 text-black font-black py-4 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 uppercase italic tracking-tighter text-lg"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Activate Account'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep('identity');
                }}
                className="w-full text-white/40 hover:text-white/80 font-mono text-xs uppercase tracking-widest py-1.5 transition-colors"
              >
                Back to identity
              </button>
            </form>
          </>
        )}
      </motion.div>
    </div>
  );
};
