import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { User, ShieldCheck, Copy, Check, ArrowRight, Loader2, Smartphone, RefreshCw, LogIn } from 'lucide-react';
import { useAuth } from '../auth';
import { AVATAR_LIST } from '../lib/avatars';
import { ApiError, profileApi, NETWORK_ERROR_MESSAGE } from '../lib/api';
import { useBackendAuth, abandonSignIn, AUTH_TOKEN_KEY } from '../hooks/useBackendAuth';
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
 *
 * MOST PEOPLE WHO LAND HERE ALREADY HAVE AN ACCOUNT.
 * -------------------------------------------------
 * That is why the connect phase says "signing you in" rather than
 * "create account": by the time it resolves, the common case is a
 * returning player, and it dismisses itself without them reading a word.
 * The server does the recognising — a sign-in presents the Privy identity
 * as well as the wallet signature, so a player whose Privy login handed
 * them a NEW wallet still resolves to the account they already own
 * instead of being walked into making a second one.
 *
 * The "sign-in" step is the backstop for what that cannot reach: a Privy
 * login with no verifiable link to the existing account. Rather than a
 * duplicate account, the player proves the account is theirs with the PIN
 * and authenticator code they set up here, and the server attaches this
 * login to it so the wallet path works unaided from then on. It is
 * reachable from the identity step, and opened automatically when the
 * server says the account already exists.
 */

interface AccountSetupProps {
  onComplete: (profile: { name: string; avatarUrl: string }) => void;
}

type Step = 'connect' | 'identity' | 'authenticator' | 'login';

/**
 * How long to wait for a wallet to appear after login before admitting
 * that one is not coming. Embedded wallets normally land within a couple
 * of seconds; 20 is generous enough that a slow connection never trips it
 * and short enough that a misconfigured app is caught rather than endured.
 */
const WALLET_WAIT_MS = 20_000;

const AVATARS = AVATAR_LIST;

export const AccountSetup: React.FC<AccountSetupProps> = ({ onComplete }) => {
  const [step, setStep] = useState<Step>('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // connect-phase state
  const { wallets } = useAuth();
  const { signIn, loginWithCredentials } = useBackendAuth();
  const [connectLabel, setConnectLabel] = useState('Preparing your wallet…');
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectStarted = useRef(false);

  // sign-in step state (existing account, PIN + authenticator)
  const [loginName, setLoginName] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginCode, setLoginCode] = useState('');

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
        // Two labels, because these are two different waits and only the
        // second one is the player's to act on. Announcing "confirm the
        // request in your wallet" up front meant a stalled nonce round
        // trip looked exactly like a wallet prompt nobody was clicking —
        // people sat waiting for a popup that had not been asked for yet.
        setConnectLabel('Preparing your sign-in request…');
        await signIn({
          onAwaitingSignature: () =>
            setConnectLabel('Confirm the signature request from your wallet…'),
        });
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

  /**
   * THE WAIT ABOVE USED TO HAVE NO END.
   *
   * Waiting for a wallet is right — embedded ones appear a beat after
   * login. Waiting FOREVER is not, and that is what happened to anyone
   * whose Privy login produced no wallet at all: the effect returned on
   * every render, `runConnect` never ran, `signIn()` was never called, and
   * so the wallet's signature prompt could never open. The panel just span
   * on "Preparing your wallet…" with no error and nothing to click. A
   * silent hang is the worst possible failure here, because the player
   * cannot tell it apart from slowness.
   *
   * The usual cause is configuration rather than the browser: a Privy app
   * with embedded-wallet creation switched off hands email/Google users no
   * wallet, and existing players never notice because they already have
   * one. Hence the console line — it names the thing to go and check,
   * which the player-facing message deliberately does not.
   */
  useEffect(() => {
    if (connectStarted.current) return;
    // Not waiting on a wallet: a stored token means no signature is needed.
    if (localStorage.getItem(AUTH_TOKEN_KEY)) return;
    // Already arrived — the effect above is taking it from here.
    if (wallets.length > 0) return;

    const timer = window.setTimeout(() => {
      if (connectStarted.current) return;
      console.error(
        `[auth] No Solana wallet appeared for this Privy login after ${
          WALLET_WAIT_MS / 1000
        }s, so there is nothing to sign in with. If this happens for every ` +
          'NEW player but not for existing ones, check the Privy dashboard: ' +
          'embedded-wallet creation for Solana must be enabled (create-on-login), ' +
          'or external Solana wallet login must be available. The client asks ' +
          'for embedded wallets in auth/privyRuntime.tsx, but the dashboard ' +
          'setting is what the SDK actually follows.'
      );
      setConnectError(
        'No wallet is attached to this login yet, and your account needs one to sign in.'
      );
    }, WALLET_WAIT_MS);

    return () => window.clearTimeout(timer);
    // Re-armed whenever the wallet list changes, and cancelled the moment
    // one shows up.
  }, [wallets]);

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
      // The server recognised this person as somebody who already has an
      // account. Creating a second one is exactly what must not happen —
      // send them to the sign-in step instead, with the name filled in.
      if (err instanceof ApiError && err.code === 'account_exists') {
        setError(null);
        setLoginName(username);
        setLoginPin('');
        setLoginCode('');
        setStep('login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Registration failed — try again');
    } finally {
      setBusy(false);
    }
  };

  // Sign in to an account that already exists, using the PIN and the
  // authenticator app that scanned the QR during setup. On success the
  // server also links this Privy login to the account, so the ordinary
  // wallet sign-in finds it on its own next time.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!USERNAME_REGEX.test(loginName)) {
      setError('Enter the username on your account');
      return;
    }
    if (!PIN_REGEX.test(loginPin)) {
      setError('PIN must be exactly 4 digits');
      return;
    }
    if (!TOTP_CODE_REGEX.test(loginCode)) {
      setError('Enter the 6-digit code from your authenticator app');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const account = await loginWithCredentials(loginName, loginPin, loginCode);
      onComplete({
        name: account.username ?? loginName,
        avatarUrl: selectedAvatar,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed — try again');
      // The code is single-use and 30 seconds old at best; make them read a
      // fresh one rather than resubmitting a burnt one.
      setLoginCode('');
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
              {/* Not "Create Account": at this point we do not yet know
                  whether this person has one, and the common case is that
                  they do — the panel dismisses itself for them a moment
                  later. Promising account creation to a returning player
                  is what made the app feel like it kept forgetting them. */}
              <h1 className="text-3xl font-black text-white italic uppercase tracking-tighter">
                Signing You In
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
                {/* Hint only when there is something the player can do — a
                    connection problem or unconfigured server is not theirs
                    to fix. "No wallet" and "signature refused" are
                    different problems, so they get different advice:
                    telling someone a signature is required when no wallet
                    exists to sign with just sends them round the loop
                    again. */}
                {connectError !== NETWORK_ERROR_MESSAGE && !/configured/i.test(connectError) && (
                  <p className="text-white/40 text-[10px] font-mono uppercase tracking-widest text-center px-4 leading-relaxed">
                    {/wallet is attached|no wallet/i.test(connectError)
                      ? 'Connect a Solana wallet to this login, then try again'
                      : 'A wallet signature is required to secure your account'}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // Drop any sign-in still pending from the last go.
                    // Without this the retry joined the SAME promise —
                    // so a stuck attempt made this button do nothing at
                    // all, forever, and only a reload got out of it.
                    abandonSignIn();
                    runConnect();
                  }}
                  className="flex items-center gap-2 bg-[#00FFD1] hover:bg-[#00E5BC] text-black font-black py-3.5 px-8 rounded-2xl transition-all uppercase italic tracking-tighter"
                >
                  <RefreshCw className="w-4 h-4" />
                  Try again
                </button>
                {/* A refused or broken signature must not lock an existing
                    player out of their own account: the PIN + authenticator
                    login needs no wallet at all. Hidden when the server is
                    simply unreachable, since that path would fail too. */}
                {connectError !== NETWORK_ERROR_MESSAGE && !/configured/i.test(connectError) && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStep('login');
                    }}
                    className="text-white/40 hover:text-[#00FFD1] font-mono text-[10px] uppercase tracking-widest transition-colors"
                  >
                    Already have an account? Sign in
                  </button>
                )}
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
                <div className="grid grid-cols-4 xs:grid-cols-5 sm:grid-cols-7 gap-2">
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

              {/* The way out for anyone who already has an account and
                  arrived here anyway — a Privy login the server could not
                  tie back to them. Making a second account would cost them
                  their username, rank and friends; this reunites them. */}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep('login');
                }}
                className="w-full text-white/40 hover:text-[#00FFD1] font-mono text-[10px] uppercase tracking-widest py-1 transition-colors"
              >
                Already have an account? Sign in
              </button>
            </form>
          </>
        )}

        {step === 'login' && (
          <>
            <div className="text-center mb-4">
              <div className="inline-flex p-2.5 bg-[#00FFD1]/10 rounded-2xl mb-3">
                <LogIn className="w-7 h-7 text-[#00FFD1]" />
              </div>
              <h1 className="text-2xl font-black text-white italic uppercase tracking-tighter">
                Sign In
              </h1>
              <p className="text-white/40 text-xs mt-1.5 font-mono uppercase tracking-widest">
                Your PIN · Your authenticator
              </p>
            </div>

            <div className="flex gap-3 p-3 rounded-2xl bg-[#00FFD1]/5 border border-[#00FFD1]/20 mb-4">
              <Smartphone className="w-5 h-5 text-[#00FFD1] shrink-0 mt-0.5" />
              <p className="text-[10px] leading-relaxed text-white/60 font-mono uppercase tracking-wide">
                Open the authenticator app you scanned the QR code with and enter its current
                6-digit code. This wallet is linked to your account afterwards, so next time you
                just walk straight in.
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                  Username
                </label>
                <input
                  type="text"
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="YOUR NAME..."
                  maxLength={20}
                  autoComplete="username"
                  className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 px-6 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 focus:bg-white/[0.07] transition-all font-bold tracking-tight text-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                    4-digit PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={loginPin}
                    onChange={(e) => setLoginPin(digitsOnly(e.target.value, 4))}
                    placeholder="••••"
                    autoComplete="current-password"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 px-4 text-white placeholder-white/20 focus:outline-none focus:border-[#00FFD1]/50 transition-all font-bold text-center text-xl tracking-[0.4em]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono uppercase tracking-[2px] text-[#00FFD1]/60 px-2">
                    6-digit code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={loginCode}
                    onChange={(e) => setLoginCode(digitsOnly(e.target.value, 6))}
                    placeholder="000000"
                    autoComplete="one-time-code"
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-2.5 px-4 text-white placeholder-white/15 focus:outline-none focus:border-[#00FFD1]/50 transition-all font-bold text-center text-xl tracking-[0.2em]"
                  />
                </div>
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
                disabled={busy || loginCode.length !== 6 || loginPin.length !== 4}
                className="w-full bg-[#00FFD1] hover:bg-[#00E5BC] disabled:opacity-40 text-black font-black py-4 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 uppercase italic tracking-tighter text-lg"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign In'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep('identity');
                }}
                className="w-full text-white/40 hover:text-white/80 font-mono text-xs uppercase tracking-widest py-1.5 transition-colors"
              >
                No account yet? Create one
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
