/**
 * MESSAGES PANEL — thread list + one open conversation (sidebar panel)
 * ====================================================================
 * Two views in one panel:
 *
 *   LIST    GET /api/social/messages → every conversation with an accepted
 *           friend, newest first, with an unread count and a preview
 *   THREAD  GET /api/social/messages/:username → the conversation itself,
 *           oldest→newest, plus a send box and a "load older" button
 *
 * Live delivery: `social:message { fromUsername, body, createdAt }` appends
 * to the open thread the moment it arrives and always refreshes the list so
 * the sidebar's unread badge stays honest.
 *
 * ‼️ SECURITY (design contract):
 *   - USERNAMES ONLY. A message carries `mine: boolean` instead of a sender
 *     identity, so no wallet is even representable on this screen.
 *   - AUTHORIZATION IS THE SERVER'S. Opening a thread with someone who is no
 *     longer an accepted friend answers 403 — we render that as text and go
 *     no further. The list is already filtered to current friendships.
 *   - XSS: message bodies are stored RAW and rendered as TEXT. React escapes
 *     them for us; `dangerouslySetInnerHTML` must never appear in this file.
 *     `whitespace-pre-wrap` keeps the sender's line breaks without markup.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, MessageSquare, RefreshCw, Send } from 'lucide-react'
import { socialApi } from '../../lib/api'
import type { ChatMessage, MessageThread, ThreadPage } from '../../lib/api'
import {
  SOCIAL_KEYS,
  formatAge,
  formatTime,
  readableApiError,
  sameUser,
  type SocialPanelProps,
} from './socialContract'
import { UserRow } from './UserRow'
import {
  SOCIAL_EVENTS,
  hasAuthToken,
  useOnlineFriends,
  useSocialEvent,
  type SocialMessageEvent,
} from './usePresence'

/** Server limit (routes/social.ts: 1–1000 chars after trim). */
const MAX_BODY = 1000

export interface MessagesPanelProps extends SocialPanelProps {
  /**
   * Open straight into this conversation — used when the Friends panel (or
   * anything else) says "message this person". Username only.
   */
  initialUsername?: string | null
}

export default function MessagesPanel({
  onClose,
  initialUsername = null,
}: MessagesPanelProps) {
  const queryClient = useQueryClient()
  const signedIn = hasAuthToken()

  const [openWith, setOpenWith] = useState<string | null>(initialUsername)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** True once older pages are in the cache — see the live-append note. */
  const [olderLoaded, setOlderLoaded] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // A new `initialUsername` from the host means "switch conversation".
  useEffect(() => {
    if (initialUsername) setOpenWith(initialUsername)
  }, [initialUsername])

  // ── data ───────────────────────────────────────────────────────────────
  const threadsQuery = useQuery({
    queryKey: SOCIAL_KEYS.threads,
    queryFn: socialApi.threads,
    enabled: signedIn,
  })

  const threadKey = useMemo(
    () => (openWith ? SOCIAL_KEYS.thread(openWith) : ['social', 'thread', '']),
    [openWith]
  )

  const threadQuery = useQuery({
    queryKey: threadKey,
    queryFn: () => socialApi.thread(openWith as string),
    enabled: signedIn && !!openWith,
  })

  const presence = useOnlineFriends(signedIn)

  const messages = threadQuery.data?.messages ?? []
  const threads = threadsQuery.data?.threads ?? []

  // Reading a thread marks it read SERVER-SIDE (inside the GET), so the
  // unread badge in the sidebar is stale the moment a fetch lands.
  useEffect(() => {
    if (!threadQuery.isSuccess) return
    void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })
  }, [threadQuery.isSuccess, threadQuery.dataUpdatedAt, queryClient])

  // ── live delivery ──────────────────────────────────────────────────────
  useSocialEvent<SocialMessageEvent>(
    SOCIAL_EVENTS.message,
    (payload) => {
      if (!payload || typeof payload.body !== 'string') return

      // The badge/preview list always changes, whichever thread it hit.
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })

      if (!openWith || !sameUser(payload.fromUsername, openWith)) return

      if (olderLoaded) {
        // History is paged in; a refetch would throw it away, so append the
        // message locally. (Its unread flag clears on the next open.)
        queryClient.setQueryData<ThreadPage>(threadKey, (prev) =>
          prev
            ? {
                ...prev,
                messages: [...prev.messages, liveMessage(payload)],
              }
            : prev
        )
        return
      }

      // Normal case: append for instant feedback, then re-read the page so
      // the row gets its real id AND the server marks it read (the mark-read
      // happens inside GET /messages/:username).
      queryClient.setQueryData<ThreadPage>(threadKey, (prev) =>
        prev
          ? { ...prev, messages: [...prev.messages, liveMessage(payload)] }
          : prev
      )
      void threadQuery.refetch()
    },
    signedIn
  )

  // ── send ───────────────────────────────────────────────────────────────
  const send = useMutation({
    mutationFn: ({ username, body }: { username: string; body: string }) =>
      socialApi.sendMessage(username, body),
    onMutate: () => setError(null),
    onSuccess: (data, vars) => {
      queryClient.setQueryData<ThreadPage>(
        SOCIAL_KEYS.thread(vars.username),
        (prev) =>
          prev
            ? { ...prev, messages: [...prev.messages, data.message] }
            : { messages: [data.message], nextCursor: null }
      )
      setDraft('')
      void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })
    },
    onError: (err) =>
      setError(readableApiError(err, 'Could not send that message')),
  })

  const submit = useCallback(() => {
    const body = draft.trim()
    if (!openWith || !body || send.isPending) return
    send.mutate({ username: openWith, body })
  }, [draft, openWith, send])

  // ── older pages ────────────────────────────────────────────────────────
  const loadOlder = useCallback(async () => {
    const cursor = threadQuery.data?.nextCursor
    if (!openWith || !cursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await socialApi.thread(openWith, cursor)
      queryClient.setQueryData<ThreadPage>(SOCIAL_KEYS.thread(openWith), (prev) =>
        prev
          ? {
              // The older page is itself oldest→newest, so it goes in FRONT.
              messages: [...page.messages, ...prev.messages],
              nextCursor: page.nextCursor,
            }
          : page
      )
      setOlderLoaded(true)
    } catch (err) {
      setError(readableApiError(err, 'Could not load older messages'))
    } finally {
      setLoadingOlder(false)
    }
  }, [openWith, threadQuery.data?.nextCursor, loadingOlder, queryClient])

  // ── scrolling ──────────────────────────────────────────────────────────
  // Stick to the bottom as messages arrive. Skipped while older pages are
  // being prepended, which would otherwise yank the reader back down.
  useEffect(() => {
    if (!openWith || loadingOlder) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [openWith, messages.length, loadingOlder])

  // ── open / close a conversation ────────────────────────────────────────
  const openThread = (username: string) => {
    setOpenWith(username)
    setDraft('')
    setError(null)
    setOlderLoaded(false)
  }

  const backToList = () => {
    setOpenWith(null)
    setError(null)
    setOlderLoaded(false)
    // Opening the thread marked it read server-side — refresh the badge.
    void queryClient.invalidateQueries({ queryKey: SOCIAL_KEYS.threads })
  }

  // ── render ─────────────────────────────────────────────────────────────
  const inThread = !!openWith

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-white">
      {/* Header — the ‹ chevron goes back to the list first, then the menu */}
      <div className="flex items-center gap-2 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent p-4">
        {(inThread || onClose) && (
          <button
            onClick={inThread ? backToList : onClose}
            aria-label="Back"
            className="cursor-pointer text-white/50 transition-colors hover:text-[#00ffd1]"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <MessageSquare size={16} className="shrink-0 text-[#00ffd1]" />
        <h3 className="flex-1 truncate text-sm font-black uppercase tracking-[0.2em] text-[#00ffd1]">
          {openWith ?? 'Messages'}
        </h3>
        <button
          onClick={() =>
            void (inThread ? threadQuery.refetch() : threadsQuery.refetch())
          }
          aria-label="Refresh"
          disabled={inThread ? threadQuery.isFetching : threadsQuery.isFetching}
          className="cursor-pointer text-white/40 transition-colors hover:text-[#00ffd1] disabled:opacity-40"
        >
          <RefreshCw
            size={14}
            className={
              (inThread ? threadQuery.isFetching : threadsQuery.isFetching)
                ? 'animate-spin'
                : ''
            }
          />
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[10px] uppercase tracking-wider text-red-300">
          {error}
        </div>
      )}

      {!signedIn ? (
        <Empty text="Sign in to message your friends" />
      ) : !inThread ? (
        /* ─────────── THREAD LIST ─────────── */
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4">
          {threadsQuery.isPending ? (
            <Empty text="Loading…" />
          ) : threadsQuery.isError ? (
            <Empty
              text={readableApiError(
                threadsQuery.error,
                'Could not load your messages'
              )}
            />
          ) : threads.length === 0 ? (
            <Empty text="No conversations yet — add a friend and say hi" />
          ) : (
            threads.map((thread: MessageThread) => (
              <UserRow
                key={thread.username}
                username={thread.username}
                rank={thread.rank}
                online={presence.onlineOf(thread.username, thread.online)}
                onClick={() => openThread(thread.username)}
                subtitle={<Preview thread={thread} />}
                trailing={
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[9px] text-white/30">
                      {formatAge(thread.lastAt)}
                    </span>
                    {thread.unread > 0 && (
                      <span className="rounded-md bg-[#00ffd1]/20 px-1.5 py-0.5 text-[9px] font-bold text-[#00ffd1]">
                        {thread.unread}
                      </span>
                    )}
                  </div>
                }
              />
            ))
          )}
        </div>
      ) : (
        /* ─────────── ONE CONVERSATION ─────────── */
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
            {threadQuery.data?.nextCursor && (
              <button
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="mx-auto mb-3 block cursor-pointer rounded-md border border-[#00ffd1]/20 px-3 py-1 text-[9px] uppercase tracking-widest text-white/40 transition-colors hover:border-[#00ffd1]/50 hover:text-[#00ffd1] disabled:opacity-40"
              >
                {loadingOlder ? 'Loading…' : 'Load older'}
              </button>
            )}

            {threadQuery.isPending ? (
              <Empty text="Loading…" />
            ) : threadQuery.isError ? (
              <Empty
                text={readableApiError(
                  threadQuery.error,
                  'You can only message accepted friends'
                )}
              />
            ) : messages.length === 0 ? (
              <Empty text="No messages yet — say something" />
            ) : (
              <div className="space-y-2">
                {messages.map((message: ChatMessage) => (
                  <Bubble key={message.id} message={message} />
                ))}
              </div>
            )}
          </div>

          {/* Send box */}
          <div className="border-t border-[#00ffd1]/20 p-3">
            <div className="flex items-end gap-2 rounded-lg border border-[#00ffd1]/20 bg-black/40 px-3 py-2 focus-within:border-[#00ffd1]/50">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_BODY))}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter makes a new line.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                rows={1}
                maxLength={MAX_BODY}
                placeholder="MESSAGE"
                aria-label="Message"
                className="max-h-24 min-w-0 flex-1 resize-none bg-transparent text-xs tracking-wide text-white outline-none placeholder:text-white/25"
              />
              <button
                onClick={submit}
                disabled={!draft.trim() || send.isPending}
                aria-label="Send message"
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-[#00ffd1]/30 text-[#00ffd1]/80 transition-colors hover:border-[#00ffd1]/60 hover:bg-[#00ffd1]/10 hover:text-[#00ffd1] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={14} />
              </button>
            </div>
            <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-white/25">
              <span>Enter to send</span>
              {draft.length > MAX_BODY - 100 && (
                <span>
                  {draft.length}/{MAX_BODY}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────
// SMALL PIECES
// ─────────────────────────────────────────────────

/** A locally-appended live message. Real ids arrive with the next fetch. */
function liveMessage(payload: SocialMessageEvent): ChatMessage {
  return {
    id: `live-${payload.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    mine: false,
    body: payload.body,
    createdAt: payload.createdAt,
  }
}

/** One chat bubble. TEXT ONLY — see the security note at the top. */
function Bubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`flex ${message.mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
          message.mine
            ? 'border border-[#00ffd1]/30 bg-[#00ffd1]/10 text-white'
            : 'border border-white/10 bg-white/5 text-white/85'
        }`}
      >
        {/* React escapes this string; pre-wrap preserves the sender's own
            line breaks without letting any markup through. */}
        <div className="whitespace-pre-wrap break-words">{message.body}</div>
        <div className="mt-1 text-right text-[9px] text-white/25">
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  )
}

/** Last-message preview in the thread list. Also text only. */
function Preview({ thread }: { thread: MessageThread }) {
  if (!thread.lastBody) {
    return (
      <span className="text-[9px] uppercase tracking-[0.15em] text-white/30">
        No preview
      </span>
    )
  }
  return (
    <span className="block truncate text-[10px] text-white/40">
      {thread.lastMine ? 'You: ' : ''}
      {thread.lastBody}
    </span>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="p-4 text-[10px] uppercase tracking-wider text-white/30">
      {text}
    </div>
  )
}
