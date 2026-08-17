/**
 * SIDEBAR MENU — the real panel host (was 100% mock until this pass)
 * ==================================================================
 * The left drawer is now backed by live data end to end:
 *
 *   HEADER         the Neon Arcade logo + "MENU" (the game's own title now
 *                  lives on the History nav row, where it is actually useful)
 *   BALANCE        ONE card with a PRACTICE / WALLET toggle — Neon Bucks on
 *                  one side, the live Privy Solana wallet on the other
 *   RANK           Ranked 2.0: `getRankInfo(rp)` from GET /api/profile/me →
 *                  "SILVER III · 2,240 RP" with a bar across the DIVISION
 *   BADGES         pending friend requests + unread messages, from the same
 *                  endpoints the panels read (shared react-query keys, so a
 *                  request accepted inside a panel updates the badge too)
 *   PANELS         every nav item opens a panel: Friends and Messages live
 *                  in components/social/, Stats/Leaderboard/History are
 *                  owned by another module and resolved lazily (see below)
 *   ONLINE FRIENDS driven by the `social:friendsOnline` socket event, with
 *                  an invite button that appears on hover on the RIGHT — and,
 *                  when that friend has already invited YOU, a JOIN button
 *                  beside it (see the notification store note below)
 *
 * ‼️ SECURITY: everything on this screen is addressed by USERNAME. The only
 * wallet involved is my own (inside GET /api/profile/me), and it is never
 * rendered or passed to a panel.
 *
 * PROP CONTRACT FOR THE PRIVATE-WAGER MODULE
 * ------------------------------------------
 *   <SidebarMenu onInviteFriend={(username) => …} />
 * is called when the user clicks the invite (⚔) button on an online friend's
 * row. It receives the friend's USERNAME and is expected to open the
 * game/mode picker → `private:create` → `private:invite`.
 *
 * If the prop is NOT supplied — which is the normal setup — the row instead
 * dispatches the `neon-arcade:private-wager-invite` window event with
 * `{ detail: { username } }`. That is the exact bridge `PrivateWagerHost`
 * (components/social/PrivateWagerInvite.tsx) already listens on, so mounting
 * that host once at app level is all the wiring private wager needs from
 * here. Passing the prop suppresses the event.
 *
 * THE OTHER DIRECTION — JOINING
 * -----------------------------
 * An ONLINE FRIENDS row also answers "has this person invited ME?", by asking
 * the app-wide notification store (`inviteFrom`). When the answer is yes the
 * row says so and reveals a JOIN button next to the invite one; JOIN calls
 * `acceptInvite`, which is the same single accept path the nav-bar bell and
 * the in-app pop-ups use. This drawer owns NO socket listener of its own for
 * that — see src/notifications/.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react'
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
  Wallet,
  Swords,
  LogIn,
  Check,
  Copy,
  RefreshCcw,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getRankInfo } from '@neon/types'
import { useNeonBucks } from '../NeonBucksStore'
import { useCurrency } from '../CurrencyStore'
import { useWalletAddress } from '../hooks/useWalletAddress'
import { useSolBalance } from '../hooks/useSolBalance'
import { SOLANA_CLUSTER } from '../lib/solana'
import { profileApi, rankRpOf, socialApi } from '../lib/api'
import { SafeErrorBoundary } from './SafeErrorBoundary'
import FriendsPanel from './social/FriendsPanel'
import MessagesPanel from './social/MessagesPanel'
import { RankMeter, RowButton, UserRow } from './social/UserRow'
import {
  SOCIAL_KEYS,
  requestPrivateInvite,
  type InviteFriendHandler,
  type SocialPanelProps,
} from './social/socialContract'
import {
  SOCIAL_EVENTS,
  hasAuthToken,
  useOnlineFriends,
  useSocialEvent,
} from './social/usePresence'
// Incoming private-wager invites. The store is the ONE place they live (the
// nav-bar bell and the pop-ups read the same list), so an ONLINE FRIENDS row
// can ask "has this person invited me?" without owning a socket listener.
import { useNotifications } from '../notifications/NotificationsStore'

// ─────────────────────────────────────────────────
// PANELS OWNED BY OTHER MODULES
// ─────────────────────────────────────────────────
/**
 * Stats, Leaderboard and History are built in a different workstream. They
 * are resolved through `import.meta.glob` rather than a static import so
 * this file compiles and runs whether or not they exist yet — a missing
 * panel degrades to a one-line "not available" note instead of breaking the
 * whole drawer. Each is a default export taking {@link SocialPanelProps}.
 */
const PANEL_MODULES = import.meta.glob('./social/*Panel.tsx') as Record<
  string,
  () => Promise<{ default: ComponentType<SocialPanelProps> }>
>

function optionalPanel(
  fileName: string
): LazyExoticComponent<ComponentType<SocialPanelProps>> | null {
  const loader = PANEL_MODULES[`./social/${fileName}.tsx`]
  return loader ? lazy(loader) : null
}

// Module scope on purpose: lazy() must not be re-created on every render.
const StatsPanel = optionalPanel('StatsPanel')
const LeaderboardPanel = optionalPanel('LeaderboardPanel')
const HistoryPanel = optionalPanel('HistoryPanel')

/** Which panel the drawer is showing (null = the menu itself). */
type PanelId = 'friends' | 'messages' | 'history' | 'leaderboard' | 'stats'

/**
 * "Open the drawer already on this panel." Set by a notification row in the
 * nav bar (or a pop-up) just before it opens the drawer, so clicking a message
 * lands you in that conversation instead of on the menu.
 *
 * The host must keep the object STABLE while the drawer is open and clear it
 * on close — this component applies it on the closed→open edge and whenever a
 * NEW object arrives, so clearing it mid-flight would bounce you back to the
 * menu.
 */
export interface SidebarOpenTarget {
  panel: 'friends' | 'messages'
  /** Messages only: the conversation to open. */
  username?: string
}

export interface SidebarMenuProps {
  gameTitle?: string
  isOpen?: boolean
  onClose?: () => void
  showDefaultTrigger?: boolean
  /**
   * PRIVATE WAGER HOOK (see the header note). Receives a USERNAME.
   * When omitted, the invite button dispatches `neon:private-invite`.
   */
  onInviteFriend?: InviteFriendHandler
  /**
   * Settings nav item. Optional so the drawer keeps working exactly as it
   * does today wherever it is not supplied (the item is simply inert).
   */
  onOpenSettings?: () => void
  /** See {@link SidebarOpenTarget}. Null/absent = open on the menu. */
  openTo?: SidebarOpenTarget | null
}

export function SidebarMenu({
  gameTitle = 'Neon Arcade',
  isOpen: controlledIsOpen,
  onClose: controlledOnClose,
  showDefaultTrigger = false,
  onInviteFriend,
  onOpenSettings,
  openTo = null,
}: SidebarMenuProps) {
  const [localIsOpen, setLocalIsOpen] = useState(false)
  const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : localIsOpen
  const queryClient = useQueryClient()

  /** Which panel is showing, and (for Messages) which conversation. */
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [messageWith, setMessageWith] = useState<string | null>(null)

  /**
   * PRACTICE ⇄ WALLET for the balance card. Plain component state and
   * nothing else — the contract explicitly asks for NO persistence, so a
   * fresh mount always starts on PRACTICE (the balance that actually moves
   * while you play). Nothing here is written to localStorage.
   */
  const [balanceTab, setBalanceTab] = useState<BalanceTab>('practice')

  /**
   * Signed in = a backend JWT exists. Re-checked whenever the drawer opens
   * so signing in mid-session lights everything up without a reload.
   */
  const [signedIn, setSignedIn] = useState(hasAuthToken)

  const setIsOpen = (open: boolean) => {
    if (controlledIsOpen !== undefined) {
      if (!open && controlledOnClose) controlledOnClose()
    } else {
      setLocalIsOpen(open)
    }
  }

  /**
   * The target this drawer has already honoured. Compared by REFERENCE: the
   * host hands us a fresh object per request, so `!==` is exactly "a new
   * request", and a re-render with the same object is not.
   */
  const appliedTargetRef = useRef<SidebarOpenTarget | null>(null)
  // Read during render so the "just opened" effect can consult the target
  // without listing it as a dependency (which would make that effect re-run
  // whenever the host cleared it, resetting the panel out from under us).
  const openToRef = useRef(openTo)
  openToRef.current = openTo

  // Opening: start on the menu itself — unless a notification asked for a
  // panel — and re-read the auth token.
  useEffect(() => {
    if (!isOpen) {
      appliedTargetRef.current = null
      return
    }
    setSignedIn(hasAuthToken())
    const target = openToRef.current
    if (target) {
      appliedTargetRef.current = target
      setPanel(target.panel)
      setMessageWith(target.username ?? null)
      return
    }
    setPanel(null)
    setMessageWith(null)
  }, [isOpen])

  // A NEW target while the drawer is already open. Rare — the drawer's
  // backdrop covers the nav bar — but a pop-up can still fire one, and
  // silently ignoring it would be a dead click.
  useEffect(() => {
    if (!isOpen || !openTo) return
    if (appliedTargetRef.current === openTo) return
    appliedTargetRef.current = openTo
    setPanel(openTo.panel)
    setMessageWith(openTo.username ?? null)
  }, [isOpen, openTo])

  // Esc backs out one level: panel → menu → closed.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (panel) setPanel(null)
      else setIsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, panel])

  // ── live data ──────────────────────────────────────────────────────────
  // Requests only fire while the drawer is actually open: this component is
  // mounted on nearly every screen in the app.
  const active = isOpen && signedIn

  const meQuery = useQuery({
    queryKey: SOCIAL_KEYS.me,
    queryFn: profileApi.me,
    enabled: active,
    staleTime: 30_000,
  })

  const friendsQuery = useQuery({
    queryKey: SOCIAL_KEYS.friends,
    queryFn: socialApi.friends,
    enabled: active,
  })

  const threadsQuery = useQuery({
    queryKey: SOCIAL_KEYS.threads,
    queryFn: socialApi.threads,
    enabled: active,
  })

  const presence = useOnlineFriends(signedIn)

  /**
   * Incoming private-wager invites, from the app-wide store. `inviteFrom` is
   * what turns an ordinary ONLINE FRIENDS row into a JOIN row.
   */
  const { inviteFrom, acceptInvite } = useNotifications()

  // Badges must react to live events, not just to refetches.
  useSocialEvent(
    SOCIAL_EVENTS.friendRequest,
    () => void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.friends }),
    signedIn
  )
  useSocialEvent(
    SOCIAL_EVENTS.message,
    () => void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads }),
    signedIn
  )

  // ── derived ────────────────────────────────────────────────────────────
  /**
   * RANKED 2.0: the badge is derived from RP alone. `rankRpOf` prefers the
   * new `rp` field and falls back to the legacy `elo` mirror, so this card
   * is correct both before and after the server payload switches over
   * (see lib/api.ts). `getRankInfo` then gives us tier, DIVISION and the
   * progress within that division.
   */
  const myRp = rankRpOf(meQuery.data)
  const rank = myRp === null ? null : getRankInfo(myRp)

  const pendingRequests = friendsQuery.data?.incoming.length ?? 0
  const unreadMessages = threadsQuery.data?.unreadTotal ?? 0

  const onlineFriends = (friendsQuery.data?.friends ?? []).filter((friend) =>
    presence.onlineOf(friend.username, friend.online)
  )

  /** Friends panel → "message this person" jumps to the Messages panel. */
  const openConversation = (username: string) => {
    setMessageWith(username)
    setPanel('messages')
  }

  /**
   * THE private-wager entry point for both invite buttons (the ONLINE FRIENDS
   * row and the Friends-panel row).
   *
   * Closing the drawer FIRST is load-bearing, not cosmetic: this drawer sits
   * at z-[200] and the private-wager picker/room render at z-[120]/z-[110], so
   * leaving it open would hide the very thing the button just opened.
   * `requestPrivateInvite` then calls the host's `onInviteFriend` if one was
   * passed, and otherwise fires the window event `PrivateWagerHost` listens
   * for. Usernames only — no wallet is ever in play here.
   */
  const inviteToPrivateWager = (username: string) => {
    setIsOpen(false)
    setPanel(null)
    requestPrivateInvite(username, onInviteFriend)
  }

  /**
   * THE OTHER DIRECTION: this friend has already invited ME. Same drawer-first
   * ordering as `inviteToPrivateWager` and for the same z-index reason — the
   * waiting room renders at z-[110], under this drawer's z-[200].
   *
   * `acceptInvite` arms the store's `pendingJoin`, which `PrivateWagerHost`
   * (mounted once, app level) turns into `private:join`. Exactly the same path
   * the pop-up's JOIN button and the nav-bar bell take, so there is one
   * accept flow rather than three.
   */
  const joinPrivateWager = (roomId: string) => {
    setIsOpen(false)
    setPanel(null)
    acceptInvite(roomId)
  }

  // ── panel body ─────────────────────────────────────────────────────────
  function renderPanel(): ReactNode {
    switch (panel) {
      case 'friends':
        return (
          <FriendsPanel
            onClose={() => setPanel(null)}
            // Same drawer-closing wrappers as the ONLINE FRIENDS rows, so
            // every invite/join button behaves identically wherever it is
            // drawn (see inviteToPrivateWager / joinPrivateWager).
            onInviteFriend={inviteToPrivateWager}
            onJoinPrivateWager={joinPrivateWager}
            onMessage={openConversation}
          />
        )
      case 'messages':
        return (
          <MessagesPanel
            onClose={() => {
              setPanel(null)
              setMessageWith(null)
            }}
            initialUsername={messageWith}
          />
        )
      case 'stats':
        return <ForeignPanel Panel={StatsPanel} name="Stats" onBack={() => setPanel(null)} />
      case 'leaderboard':
        return (
          <ForeignPanel
            Panel={LeaderboardPanel}
            name="Leaderboard"
            onBack={() => setPanel(null)}
          />
        )
      case 'history':
        return (
          <ForeignPanel Panel={HistoryPanel} name="History" onBack={() => setPanel(null)} />
        )
      default:
        return null
    }
  }

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
              // Panels get a little more room than the menu does.
              className={`fixed top-0 left-0 bottom-0 ${
                panel ? 'w-[24rem] max-w-[92vw]' : 'w-80'
              } bg-[#081616] border-r border-[#00ffd1]/20 z-[200] flex flex-col font-mono shadow-[0_0_50px_rgba(0,255,209,0.1)] transition-[width] duration-200`}
            >
              {panel ? (
                // Panels bring their own header (with the ‹ back chevron).
                <div className="min-h-0 flex-1">
                  <SafeErrorBoundary
                    fallback={
                      <PanelFallback
                        text="That panel crashed — go back and try again"
                        onBack={() => setPanel(null)}
                      />
                    }
                  >
                    <Suspense fallback={<PanelFallback text="Loading…" onBack={() => setPanel(null)} />}>
                      {renderPanel()}
                    </Suspense>
                  </SafeErrorBoundary>
                </div>
              ) : (
                <>
                  {/* ── HEADER — logo top-LEFT, "MENU" beside it, X unmoved ── */}
                  <div className="flex items-center justify-between gap-3 p-6 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent">
                    <div className="flex min-w-0 items-center gap-3">
                      {/* The app's real logo asset (also used by the top nav
                          in App.tsx and by the Privy login modal). */}
                      <img
                        src="/NeonArcadeLogo.png"
                        alt="Neon Arcade"
                        referrerPolicy="no-referrer"
                        className="h-10 w-auto shrink-0 object-contain drop-shadow-[0_0_12px_rgba(0,255,209,0.6)]"
                      />
                      <h2 className="truncate text-2xl font-black uppercase tracking-[0.28em] text-[#00ffd1] drop-shadow-[0_0_14px_rgba(0,255,209,0.45)]">
                        Menu
                      </h2>
                    </div>
                    <button
                      onClick={() => setIsOpen(false)}
                      aria-label="Close menu"
                      className="shrink-0 text-white/50 hover:text-[#00FFD1] transition-colors cursor-pointer"
                    >
                      <XIcon size={24} />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    {/* ── BALANCE — one card, PRACTICE ⇄ WALLET ── */}
                    <BalanceCard tab={balanceTab} onTabChange={setBalanceTab} />

                    {/* ── RANK — Ranked 2.0, derived from RP alone ── */}
                    <div className="p-4 border border-[#00ffd1]/20 rounded-xl bg-black/40">
                      <div className="mb-2.5 flex items-center gap-2">
                        <Award
                          size={16}
                          className="shrink-0"
                          style={{ color: rank?.color ?? '#00ffd1' }}
                        />
                        <span className="text-[10px] uppercase tracking-widest text-[#00ffd1]/60">
                          Current Rank
                        </span>
                      </div>

                      {rank ? (
                        // The full read-out: "SILVER III · 2,240 RP", the
                        // division pips, and a bar across THAT DIVISION.
                        <RankMeter rank={rank} ladderLabel="1v1" />
                      ) : (
                        <>
                          <div className="truncate text-xl font-bold uppercase tracking-wider text-white">
                            {signedIn && meQuery.isPending ? '···' : 'Unranked'}
                          </div>
                          {/* Same empty bar the ranked state draws, so the
                              card does not jump height when data lands. */}
                          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-black/60 ring-1 ring-inset ring-white/5" />
                          <div className="mt-2 text-[9px] uppercase tracking-wider text-white/40">
                            {signedIn
                              ? 'Play a ranked match to earn RP'
                              : 'Sign in to rank up'}
                          </div>
                        </>
                      )}
                    </div>

                    {/* ── NAVIGATION — every item opens its panel ── */}
                    <div className="space-y-2">
                      <NavItem
                        icon={<Users size={20} />}
                        label="Friends"
                        count={pendingRequests}
                        onClick={() => setPanel('friends')}
                      />
                      <NavItem
                        icon={<MessageSquare size={20} />}
                        label="Messages"
                        count={unreadMessages}
                        onClick={() => {
                          setMessageWith(null)
                          setPanel('messages')
                        }}
                      />
                      <NavItem
                        icon={<History size={20} />}
                        label={`${gameTitle} History`}
                        onClick={() => setPanel('history')}
                      />
                      <NavItem
                        icon={<Trophy size={20} />}
                        label="Leaderboard"
                        onClick={() => setPanel('leaderboard')}
                      />
                      <NavItem
                        icon={<TrendingUp size={20} />}
                        label="Stats"
                        onClick={() => setPanel('stats')}
                      />
                      <NavItem
                        icon={<Settings size={20} />}
                        label="Settings"
                        onClick={
                          onOpenSettings
                            ? () => {
                                onOpenSettings()
                                setIsOpen(false)
                              }
                            : undefined
                        }
                      />
                    </div>

                    {/* ── ONLINE FRIENDS — social:friendsOnline ── */}
                    <div className="pt-4 border-t border-[#00ffd1]/20">
                      <div className="mb-4 flex items-center justify-between pl-2 pr-1">
                        <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                          Online Friends
                        </span>
                        {onlineFriends.length > 0 && (
                          <span className="text-[10px] font-bold text-[#00ffd1]/70">
                            {onlineFriends.length}
                          </span>
                        )}
                      </div>

                      <div className="space-y-1">
                        {!signedIn ? (
                          <SidebarNote text="Sign in to see your friends" />
                        ) : friendsQuery.isPending ? (
                          <SidebarNote text="Loading…" />
                        ) : onlineFriends.length === 0 ? (
                          <SidebarNote
                            text="Nobody online right now"
                            actionLabel="Find friends"
                            onAction={() => setPanel('friends')}
                          />
                        ) : (
                          onlineFriends.map((friend) => {
                            // Has this friend already invited ME? If so the
                            // row grows a JOIN button ahead of the invite one
                            // (accepting beats inviting back), and says so in
                            // place of the rank line — the button itself only
                            // appears on hover, so without this the invite
                            // would be invisible until you happened to point
                            // at the right row.
                            const invite = inviteFrom(friend.username)
                            return (
                              <UserRow
                                key={friend.username}
                                username={friend.username}
                                rank={friend.rank}
                                online
                                onClick={() => openConversation(friend.username)}
                                subtitle={
                                  invite ? (
                                    <span className="flex animate-pulse items-center gap-1 truncate text-[9px] uppercase tracking-[0.15em] text-[#00ffd1]">
                                      <Swords size={10} className="shrink-0" />
                                      Invited you · {invite.body}
                                    </span>
                                  ) : undefined
                                }
                                // The buttons sit on the RIGHT and only appear
                                // on hover (or keyboard focus).
                                hoverActions
                                actions={
                                  <>
                                    {invite?.invite && (
                                      <RowButton
                                        label={`Join ${friend.username}'s private wager`}
                                        onClick={() =>
                                          joinPrivateWager(invite.invite!.roomId)
                                        }
                                      >
                                        <LogIn size={14} />
                                      </RowButton>
                                    )}
                                    <RowButton
                                      label={`Invite ${friend.username} to a private wager`}
                                      onClick={() =>
                                        inviteToPrivateWager(friend.username)
                                      }
                                    >
                                      <Swords size={14} />
                                    </RowButton>
                                  </>
                                }
                              />
                            )
                          })
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

// ─────────────────────────────────────────────────
// BALANCE CARD — PRACTICE ⇄ WALLET
// ─────────────────────────────────────────────────
/**
 * ONE card, two faces:
 *
 *   PRACTICE   Neon Bucks from `useNeonBucks()` — the client-side practice
 *              currency, byte-for-byte the card that used to live here.
 *   WALLET     the Privy Solana wallet: truncated address + live SOL
 *              balance, read through the EXISTING `useWalletAddress()` /
 *              `useSolBalance()` hooks (same ones WalletPanel.tsx uses, so
 *              there is exactly one implementation of "what is my balance").
 *
 * ‼️ MY OWN wallet address is the only wallet that ever appears in this
 * drawer, and it never leaves it — every social surface is username-only.
 *
 * Nothing here can render NaN: the practice balance is a number by
 * construction, and the SOL balance is `number | null` with an explicit
 * loading / error / no-wallet branch for every other state.
 */
type BalanceTab = 'practice' | 'wallet'

function BalanceCard({
  tab,
  onTabChange,
}: {
  tab: BalanceTab
  onTabChange: (tab: BalanceTab) => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-[#00ffd1]/20 bg-gradient-to-br from-[#00ffd1]/10 to-transparent p-4">
      {/* Watermark — follows the selected face. Pushed below the toggle so
          it sits behind the BALANCE, the way this card always looked. */}
      <div className="pointer-events-none absolute right-0 top-14 p-3 opacity-20 transition-opacity group-hover:opacity-40">
        <img
          src={tab === 'practice' ? '/neon-bucks-icon.png' : '/solana-sol-icon.svg'}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="h-12 w-12 object-contain"
        />
      </div>

      {/* The toggle itself. `radiogroup` because the two options are one
          choice, not two independent buttons. */}
      <div
        role="radiogroup"
        aria-label="Balance to show"
        className="relative z-10 mb-3 grid grid-cols-2 gap-1 rounded-lg border border-[#00ffd1]/20 bg-black/50 p-1"
      >
        <BalanceTabButton
          label="Practice"
          active={tab === 'practice'}
          onClick={() => onTabChange('practice')}
        />
        <BalanceTabButton
          label="Wallet"
          active={tab === 'wallet'}
          onClick={() => onTabChange('wallet')}
        />
      </div>

      {/* Only the selected face is mounted — that keeps the devnet RPC call
          in useSolBalance from firing for players who never open WALLET. */}
      <div className="relative z-10">
        {tab === 'practice' ? <PracticeFace /> : <WalletFace />}
      </div>
    </div>
  )
}

function BalanceTabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`cursor-pointer rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] transition-all ${
        active
          ? 'bg-[#00ffd1]/15 text-[#00ffd1] shadow-[0_0_12px_rgba(0,255,209,0.3)] ring-1 ring-inset ring-[#00ffd1]/60'
          : 'text-white/40 hover:text-white/80'
      }`}
    >
      {label}
    </button>
  )
}

/** PRACTICE — Neon Bucks, exactly as this card has always rendered them. */
function PracticeFace() {
  const { balance } = useNeonBucks()

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#00ffd1]/30 bg-[#00ffd1]/10">
          <Wallet size={18} className="text-[#00ffd1]" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-[#00ffd1]/60">
            Practice Wallet
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-2xl font-black tracking-tighter text-white">
            <img
              src="/neon-bucks-icon.png"
              alt="NB"
              referrerPolicy="no-referrer"
              className="h-5 w-auto drop-shadow-[0_0_8px_rgba(0,255,209,0.5)]"
            />
            <span className="tabular-nums">{balance.toLocaleString()}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[#00ffd1]/10 pt-2 text-[9px] uppercase leading-relaxed tracking-wider text-white/40">
        <span>Practice Balance</span>
        <span className="animate-pulse font-bold text-[#00ffd1]/80">
          Sync Active
        </span>
      </div>
    </>
  )
}

/** `7Xk2…9fQa` — enough to recognise a wallet, short enough for the drawer. */
function truncateAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 5)}…${address.slice(-5)}`
    : address
}

/**
 * WALLET — the real Privy Solana wallet.
 *
 * Every not-signed-in path degrades to one calm line instead of a crash or
 * a NaN:
 *   Privy still booting  → "Connecting…"
 *   not authenticated    → "Sign in to see your wallet"
 *   authed, no wallet    → "No wallet connected yet"
 *   RPC failed           → an em dash + the hook's error, with a retry
 */
function WalletFace() {
  const { address, ready, authenticated } = useWalletAddress()
  const { balance, loading, error, refresh } = useSolBalance(address)
  const { currency, fromSol, formatSolAs, isNative } = useCurrency()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still on screen to read */
    }
  }

  if (!ready) return <WalletNote text="Connecting…" />
  if (!authenticated) return <WalletNote text="Sign in to see your wallet" />
  if (!address) return <WalletNote text="No wallet connected yet" />

  // The balance is READ in SOL and only DISPLAYED in the chosen currency.
  // No usable rate → fall all the way back to SOL rather than guessing; a
  // wrong number here is worse than an unfamiliar one. Probing with 1 SOL
  // (not the balance, which may still be null) keeps the unit label steady
  // while the RPC call is out.
  const canConvert = !isNative && fromSol(1) !== null

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#00ffd1]/30 bg-[#00ffd1]/10">
          <img
            src="/solana-sol-icon.svg"
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            className="h-4 w-4 object-contain"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-[#00ffd1]/60">
            Solana Wallet
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 text-2xl font-black tracking-tighter text-white">
            {/* `balance` is number | null — never a bare arithmetic result,
                so this line cannot print NaN. */}
            <span className="tabular-nums">
              {error
                ? '—'
                : balance === null
                  ? '…'
                  : canConvert
                    ? formatSolAs(balance, { bare: true })
                    : balance.toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
            </span>
            <span className="text-xs font-bold uppercase text-[#00ffd1]">
              {canConvert ? currency.code : 'SOL'}
            </span>
          </div>
          {/* The underlying SOL stays visible whenever a conversion is on
              screen — the player should always be able to see what they
              actually hold. */}
          {canConvert && !error && balance !== null && (
            <div className="mt-0.5 font-mono text-[10px] tracking-wider text-white/40 tabular-nums">
              ◎{balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh balance"
          aria-label="Refresh SOL balance"
          className="shrink-0 cursor-pointer rounded-full p-1.5 text-[#00ffd1] transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Truncated address + copy. */}
      <button
        type="button"
        onClick={() => void copy()}
        title={address}
        aria-label="Copy wallet address"
        className="mt-3 flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 transition-colors hover:border-[#00ffd1]/40"
      >
        <span className="truncate font-mono text-[11px] text-white/70">
          {truncateAddress(address)}
        </span>
        {copied ? (
          <Check size={13} className="shrink-0 text-[#00ffd1]" />
        ) : (
          <Copy size={13} className="shrink-0 text-white/40" />
        )}
      </button>

      <div className="mt-2 flex items-center justify-between border-t border-[#00ffd1]/10 pt-2 text-[9px] uppercase leading-relaxed tracking-wider text-white/40">
        <span>{SOLANA_CLUSTER}</span>
        {error ? (
          <span className="font-bold text-red-400/80">{error}</span>
        ) : (
          <span className="font-bold text-[#00ffd1]/80">Live balance</span>
        )}
      </div>
    </>
  )
}

/** One-line state for the WALLET face (not signed in, no wallet, booting). */
function WalletNote({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-black/40">
        <Wallet size={18} className="text-white/30" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-widest text-[#00ffd1]/60">
          Solana Wallet
        </div>
        <div className="mt-0.5 text-[11px] uppercase tracking-wider text-white/40">
          {text}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────
// SMALL PIECES
// ─────────────────────────────────────────────────

/**
 * A nav row. `count` renders only when there is something to see — a "0"
 * badge is noise, and the old mock's permanent 5/2 were pure fiction.
 * Without `onClick` the row is inert (Settings, until a host wires it).
 */
function NavItem({
  icon,
  label,
  count,
  onClick,
}: {
  icon: ReactNode
  label: string
  count?: number
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-white/70 disabled:hover:border-transparent"
    >
      <div className="flex items-center gap-3">
        {icon}
        <span className="uppercase tracking-wider text-sm">{label}</span>
      </div>
      {count !== undefined && count > 0 && (
        <span className="bg-[#00ffd1]/20 text-[#00ffd1] text-[10px] px-2 py-1 rounded-md font-bold">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

/** One-line note inside the ONLINE FRIENDS block, with an optional action. */
function SidebarNote({
  text,
  actionLabel,
  onAction,
}: {
  text: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="flex items-center justify-between px-2 py-2 text-[10px] uppercase tracking-wider text-white/30">
      <span>{text}</span>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="cursor-pointer text-[#00ffd1]/60 transition-colors hover:text-[#00ffd1]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

/** Shown while a lazy panel loads, or when it is not in this build yet. */
function PanelFallback({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col font-mono text-white">
      <div className="flex items-center gap-2 border-b border-[#00ffd1]/20 p-4">
        <button
          onClick={onBack}
          className="cursor-pointer text-[10px] uppercase tracking-widest text-white/50 hover:text-[#00ffd1]"
        >
          ‹ Back
        </button>
      </div>
      <div className="p-4 text-[10px] uppercase tracking-wider text-white/30">
        {text}
      </div>
    </div>
  )
}

/**
 * Renders a panel from another module, or explains its absence. Keeping the
 * "missing" case visible (instead of a blank drawer) is what makes the glob
 * resolution above safe to ship while those panels are still being built.
 */
function ForeignPanel({
  Panel,
  name,
  onBack,
}: {
  Panel: LazyExoticComponent<ComponentType<SocialPanelProps>> | null
  name: string
  onBack: () => void
}) {
  if (!Panel) {
    return <PanelFallback text={`${name} is not available in this build yet`} onBack={onBack} />
  }
  return <Panel onClose={onBack} />
}
