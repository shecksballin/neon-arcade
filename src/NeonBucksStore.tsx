/**
 * NEON BUCKS — client-side practice currency
 * ============================================
 * Pure currency state. No game logic.
 * Drop this provider near the root of your app, then call
 * useNeonBucks() inside any practice game to wager and pay out.
 */

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

const STORAGE_KEY = 'neon_bucks_v1'

interface NeonBucksState {
  balance: number
  usedFreeChance: boolean
}

interface NeonBucksContextValue {
  balance: number
  /** true when player has no bucks and hasn't taken their free chance yet */
  isFirstPractice: boolean
  /** can the player afford this wager right now */
  canAfford: (amount: number) => boolean
  /** deduct a wager. returns false (no deduction) if they can't afford it */
  wager: (amount: number) => boolean
  /** add winnings to balance */
  win: (amount: number) => void
  /** consume the one free chance (call when starting a free-stake game) */
  useFreeChance: () => void
  /** wipe balance and free-chance flag */
  reset: () => void
}

const Ctx = createContext<NeonBucksContextValue | null>(null)

function load(): NeonBucksState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { balance: 0, usedFreeChance: false }
}

export function NeonBucksProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NeonBucksState>(load)

  // persist on every change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
  }, [state])

  const isFirstPractice = state.balance === 0 && !state.usedFreeChance

  const canAfford = useCallback(
    (amount: number) => state.balance >= amount,
    [state.balance]
  )

  const wager = useCallback((amount: number): boolean => {
    let ok = false
    setState(prev => {
      if (prev.balance >= amount) {
        ok = true
        return { ...prev, balance: prev.balance - amount }
      }
      return prev
    })
    return ok
  }, [])

  const win = useCallback((amount: number) => {
    setState(prev => ({ ...prev, balance: prev.balance + amount }))
  }, [])

  const useFreeChance = useCallback(() => {
    setState(prev => ({ ...prev, usedFreeChance: true }))
  }, [])

  const reset = useCallback(() => {
    setState({ balance: 0, usedFreeChance: false })
  }, [])

  return (
    <Ctx.Provider value={{ balance: state.balance, isFirstPractice, canAfford, wager, win, useFreeChance, reset }}>
      {children}
    </Ctx.Provider>
  )
}

export function useNeonBucks() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNeonBucks must be used within NeonBucksProvider')
  return ctx
}
