/**
 * IN-APP POP-UPS
 * ==============
 * The bottom-right stack. It renders whatever `useNotifications().toasts`
 * holds, which is already the filtered set — the store decides what pops up
 * (prefs) and when (never mid-match; see NotificationsStore). This file only
 * has to draw them and time them out.
 *
 * Each card owns its own dismissal timer rather than the store running one
 * ticker for the lot: a timer in the provider would re-render the entire app,
 * and the provider sits above <App/>.
 *
 * ACTIONS
 * -------
 *   invite          JOIN (opens the waiting room) / Later
 *   message         Reply (opens that conversation in the sidebar)
 *   friend_request  View (opens the Friends panel)
 *
 * ‼️ SECURITY: usernames and message previews are rendered as TEXT — React
 * escapes them. Never dangerouslySetInnerHTML here.
 */

import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { MessageSquare, Swords, UserPlus, UserRoundCheck, X } from 'lucide-react'
import { useNotifications } from './NotificationsStore'
import {
  MAX_VISIBLE_TOASTS,
  TOAST_DURATION_MS,
  type NotificationItem,
  type NotificationKind,
} from './types'

export interface NotificationToastsProps {
  /** Open the Messages panel on a conversation. */
  onOpenMessages: (username: string) => void
  /** Open the Friends panel. */
  onOpenFriends: () => void
}

/** Icon + accent per kind — the same language the notification centre uses. */
const KIND_ICON: Record<NotificationKind, typeof Swords> = {
  invite: Swords,
  message: MessageSquare,
  friend_request: UserPlus,
  friend_accepted: UserRoundCheck,
}

const KIND_LABEL: Record<NotificationKind, string> = {
  invite: 'Private wager invite',
  message: 'New message',
  friend_request: 'Friend request',
  friend_accepted: 'Friend request accepted',
}

export function NotificationToasts({
  onOpenMessages,
  onOpenFriends,
}: NotificationToastsProps) {
  const { toasts } = useNotifications()

  // Only the newest few are on screen; the rest sit in the list until one
  // times out. A wall of cards is worse than a queue.
  const visible = toasts.slice(0, MAX_VISIBLE_TOASTS)

  return (
    // pointer-events-none on the column so the gaps between cards never eat a
    // click meant for the game underneath; each card re-enables its own.
    <div className="pointer-events-none fixed bottom-6 right-6 z-[150] flex max-w-[calc(100vw-3rem)] flex-col gap-2 font-mono">
      <AnimatePresence initial={false}>
        {visible.map((item) => (
          <motion.div
            key={item.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ type: 'spring', damping: 26, stiffness: 260 }}
            className="pointer-events-auto"
          >
            <ToastCard
              item={item}
              onOpenMessages={onOpenMessages}
              onOpenFriends={onOpenFriends}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({
  item,
  onOpenMessages,
  onOpenFriends,
}: {
  item: NotificationItem
} & NotificationToastsProps) {
  const { dismissToast, acceptInvite, declineInvite } = useNotifications()
  const Icon = KIND_ICON[item.kind]

  // Self-dismissal. Re-armed whenever the card is folded into again
  // (`createdAt` moves), so a second message from the same person buys the
  // card a fresh window instead of vanishing mid-read.
  const dismissRef = useRef(dismissToast)
  dismissRef.current = dismissToast
  useEffect(() => {
    const timer = window.setTimeout(
      () => dismissRef.current(item.id),
      TOAST_DURATION_MS[item.kind]
    )
    return () => window.clearTimeout(timer)
  }, [item.id, item.kind, item.createdAt])

  const isInvite = item.kind === 'invite'

  return (
    <div
      role="status"
      className={`w-80 max-w-full rounded-xl border bg-[#041010]/95 p-4 shadow-[0_0_40px_rgba(0,255,209,0.2)] backdrop-blur-md ${
        isInvite ? 'border-[#00FFD1]/50' : 'border-[#00FFD1]/25'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[#00FFD1]" />
        <p className="flex-1 text-[10px] uppercase tracking-[0.25em] text-[#B1C5FF]/60">
          {KIND_LABEL[item.kind]}
        </p>
        <button
          type="button"
          onClick={() => dismissToast(item.id)}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded-full p-1 text-white/30 transition-colors hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mt-2 text-sm tracking-wide text-white">
        <span className="font-black uppercase italic">{item.from}</span>{' '}
        <span className="text-white/55">{item.body}</span>
      </p>

      {item.count > 1 && (
        <p className="mt-1 text-[9px] uppercase tracking-[0.2em] text-[#00FFD1]/60">
          +{item.count - 1} more
        </p>
      )}

      <div className="mt-3 flex gap-2">
        {isInvite && item.invite ? (
          <>
            <button
              type="button"
              onClick={() => acceptInvite(item.invite!.roomId)}
              className="flex-1 cursor-pointer rounded-lg bg-gradient-to-br from-[#00FFD1] to-[#00bda0] py-2 text-[10px] font-black uppercase tracking-[0.2em] text-[#081616] transition-all hover:shadow-[0_0_20px_rgba(0,255,209,0.5)]"
            >
              Join
            </button>
            <button
              type="button"
              onClick={() => declineInvite(item.invite!.roomId)}
              className="cursor-pointer rounded-lg border border-[#00FFD1]/30 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[#B1C5FF]/60 transition-all hover:border-[#00FFD1]/70 hover:text-white"
            >
              Later
            </button>
          </>
        ) : item.kind === 'message' ? (
          <button
            type="button"
            onClick={() => {
              dismissToast(item.id)
              onOpenMessages(item.from)
            }}
            className="flex-1 cursor-pointer rounded-lg border border-[#00FFD1]/30 py-2 text-[10px] uppercase tracking-[0.2em] text-[#B1C5FF]/70 transition-all hover:border-[#00FFD1]/70 hover:text-white"
          >
            Reply
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              dismissToast(item.id)
              onOpenFriends()
            }}
            className="flex-1 cursor-pointer rounded-lg border border-[#00FFD1]/30 py-2 text-[10px] uppercase tracking-[0.2em] text-[#B1C5FF]/70 transition-all hover:border-[#00FFD1]/70 hover:text-white"
          >
            {item.kind === 'friend_request' ? 'View request' : 'View friends'}
          </button>
        )}
      </div>
    </div>
  )
}
