/**
 * GAME NAV SIDEBAR — the real arcade menu, in-game edition
 * ========================================================
 * Chess and Neon Connect used to render their own copy of this column as a
 * pure mock-up: a hardcoded "DIAMOND I" rank card, nav buttons with no
 * onClick, and three fictional friends. This is the ONE working replacement
 * both games mount instead.
 *
 * Nothing here reimplements the drawer. Every nav item deep-links into the
 * REAL SidebarMenu through the same `open-neon-arcade-menu` event the other
 * games' HUD buttons already dispatch — App.tsx reads `detail.panel` and
 * hands it to the drawer as a SidebarOpenTarget, exactly like a notification
 * row does. Settings skips the drawer (detail.settings) and opens Profile
 * Settings directly. So Friends/Messages/History/Leaderboard/Stats are the
 * live panels with their live data, not sidecar copies that could drift.
 *
 * The rank card and the ONLINE FRIENDS list read the SAME react-query keys
 * as SidebarMenu (SOCIAL_KEYS.me / .friends / .threads), so the cache is
 * shared: opening the drawer warms this sidebar and vice versa, and the
 * numbers can never disagree between the two.
 */
import { useQuery } from '@tanstack/react-query'
import {
  Award,
  History,
  MessageSquare,
  Settings,
  TrendingUp,
  Users,
} from 'lucide-react'
import { getRankInfo } from '@neon/types'
import { profileApi, rankRpOf, socialApi } from '../../lib/api'
import { RankMeter } from '../social/UserRow'
import { SOCIAL_KEYS } from '../social/socialContract'
import { hasAuthToken, useOnlineFriends } from '../social/usePresence'

/** Panels the drawer can open on — mirror of SidebarMenu's PanelId. */
type DrawerPanel = 'friends' | 'messages' | 'history' | 'leaderboard' | 'stats'

/** Deep-link into the real drawer (App.tsx owns the listener). */
function openDrawer(panel?: DrawerPanel) {
  window.dispatchEvent(
    new CustomEvent('open-neon-arcade-menu', panel ? { detail: { panel } } : undefined)
  )
}

function openSettings() {
  window.dispatchEvent(
    new CustomEvent('open-neon-arcade-menu', { detail: { settings: true } })
  )
}

function NavItem({
  icon,
  label,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer"
    >
      {icon}
      <span className="uppercase tracking-wider text-xs flex-1 text-left">{label}</span>
      {/* Real counts only — the fake "5"/"2" chips are gone. Zero renders nothing. */}
      {badge !== undefined && badge > 0 && (
        <span className="bg-[#00ffd1]/20 text-[#00ffd1] text-[9px] px-1.5 py-0.5 rounded flex items-center justify-center font-bold">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

export function GameNavSidebar({ gameTitle = 'Neon Arcade' }: { gameTitle?: string }) {
  const signedIn = hasAuthToken()

  // Shared cache with SidebarMenu — identical keys, identical fetchers.
  const meQuery = useQuery({
    queryKey: SOCIAL_KEYS.me,
    queryFn: profileApi.me,
    enabled: signedIn,
    staleTime: 30_000,
  })
  const friendsQuery = useQuery({
    queryKey: SOCIAL_KEYS.friends,
    queryFn: socialApi.friends,
    enabled: signedIn,
    staleTime: 30_000,
  })
  const threadsQuery = useQuery({
    queryKey: SOCIAL_KEYS.threads,
    queryFn: socialApi.threads,
    enabled: signedIn,
    staleTime: 30_000,
  })

  const myRp = rankRpOf(meQuery.data)
  const rank = myRp === null ? null : getRankInfo(myRp)

  const pendingRequests = friendsQuery.data?.incoming.length ?? 0
  const unreadMessages = threadsQuery.data?.unreadTotal ?? 0

  // Same presence overlay SidebarMenu applies: the REST snapshot's `online`
  // flag corrected live by the social:friendsOnline socket event.
  const presence = useOnlineFriends(signedIn)
  const onlineFriends = (friendsQuery.data?.friends ?? []).filter((friend) =>
    presence.onlineOf(friend.username, friend.online)
  )

  return (
    <div className="hidden lg:flex w-64 border-r border-[#00FFD1]/20 bg-[#040b0b] flex-col h-[100dvh] sticky top-0 overflow-hidden shrink-0 z-50">
      <div className="flex items-center justify-between p-4 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent">
        <h2 className="text-lg font-black text-[#00ffd1] uppercase tracking-[0.2em]">
          {gameTitle} Menu
        </h2>
      </div>

      <div className="flex-1 p-2.5 flex flex-col gap-2.5 min-h-0">
        {/* ── RANK — real Ranked 2.0 badge, never "DIAMOND I" by fiat ── */}
        <div className="p-3 border border-[#00ffd1]/20 rounded-xl bg-black/40">
          <div className="mb-2 flex items-center gap-2">
            <Award size={16} className="shrink-0" style={{ color: rank?.color ?? '#00ffd1' }} />
            <span className="text-[10px] uppercase tracking-widest text-[#00ffd1]/60">
              Current Rank
            </span>
          </div>
          {rank ? (
            <RankMeter rank={rank} ladderLabel="1v1" />
          ) : (
            <>
              <div className="truncate text-base font-bold uppercase tracking-wider text-white">
                {signedIn && meQuery.isPending ? '···' : 'Unranked'}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/60 ring-1 ring-inset ring-white/5" />
              <div className="mt-2 text-[9px] uppercase tracking-wider text-white/40">
                {signedIn ? 'Play a ranked match to earn RP' : 'Sign in to rank up'}
              </div>
            </>
          )}
        </div>

        {/* ── NAVIGATION — every item opens the real drawer panel ── */}
        <div className="space-y-1">
          <NavItem
            icon={<Users size={16} />}
            label="Friends"
            badge={pendingRequests}
            onClick={() => openDrawer('friends')}
          />
          <NavItem
            icon={<MessageSquare size={16} />}
            label="Messages"
            badge={unreadMessages}
            onClick={() => openDrawer('messages')}
          />
          <NavItem
            icon={<History size={16} />}
            label={`${gameTitle} History`}
            onClick={() => openDrawer('history')}
          />
          <NavItem
            icon={<Award size={16} />}
            label="Leaderboard"
            onClick={() => openDrawer('leaderboard')}
          />
          <NavItem
            icon={<TrendingUp size={16} />}
            label="Stats"
            onClick={() => openDrawer('stats')}
          />
          <NavItem
            icon={<Settings size={16} />}
            label="Settings"
            onClick={openSettings}
          />
        </div>

        {/* ── ONLINE FRIENDS — the live list, or an honest empty state ── */}
        <div className="pt-2 border-t border-[#00ffd1]/20 flex-1 flex flex-col min-h-0 pb-4">
          <div className="text-[10px] text-white/40 uppercase tracking-[0.2em] mb-2 pl-2 shrink-0">
            Online Friends
          </div>
          <div className="space-y-1 overflow-y-auto custom-scrollbar flex-1">
            {onlineFriends.length === 0 ? (
              <div className="px-2 py-3 text-[10px] font-mono uppercase tracking-widest text-white/30">
                {signedIn
                  ? friendsQuery.isPending
                    ? 'Loading…'
                    : 'No friends online'
                  : 'Sign in to see friends'}
              </div>
            ) : (
              onlineFriends.map((friend) => (
                <button
                  key={friend.username}
                  onClick={() => openDrawer('friends')}
                  className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#00ffd1]/40 to-blue-500/40 border border-[#00ffd1]/20" />
                      <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#081616] bg-green-500" />
                    </div>
                    <div className="text-left">
                      <div className="text-sm text-white/90 group-hover:text-white transition-colors tracking-wide leading-none">
                        {friend.username}
                      </div>
                      <div className="text-[10px] text-green-400 mt-1">Online</div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
