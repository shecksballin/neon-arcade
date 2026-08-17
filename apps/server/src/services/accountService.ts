/**
 * ACCOUNT SERVICE — one person, one arcade account
 * ================================================
 * Sign-in used to mean "this wallet is now the identity". That quietly
 * allowed duplicates: Privy gives the same human different wallets
 * depending on how they logged in (embedded wallet from an email login, a
 * different embedded wallet if they later use Google, Phantom when they
 * connect it directly), and each new address looked like a brand-new
 * person to us. So one player could end up with three accounts, three
 * usernames and three rank histories.
 *
 * This module is the fix. Sign-in now presents a SET of proven identities
 * — the wallet whose signature we just checked, plus the Privy DID,
 * verified emails and linked wallets from lib/privyIdentity.ts — and asks
 * one question:
 *
 *   "Do any of these already belong to an account?"
 *
 * If yes, that account is the answer, and every presented identity that
 * was not on file gets linked to it, so the next sign-in resolves faster
 * and by more routes. If no, one account is created and the identities
 * are attached to it. Either way the caller gets back the account's
 * CANONICAL wallet, which is what goes into the session JWT.
 *
 * WHY THE CANONICAL WALLET NEVER CHANGES
 * --------------------------------------
 * `users.wallet` is the join key for matches, friends, messages, stats and
 * rating history. Repointing it at whichever address a person happened to
 * sign in with would orphan all of that. So the first wallet an account is
 * created with stays its identity forever, and later wallets are recorded
 * in `account_identities` as additional ways to reach it. A player who
 * signs in with a second wallet therefore keeps their username, rank and
 * friends — which is the whole point.
 *
 * DEGRADED MODE
 * -------------
 * With no PRIVY_APP_ID (or a client that sends no Privy token) `identity`
 * is null and the only key is the proven wallet — the exact behaviour that
 * shipped before this module existed, no worse.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { requireDb } from '../db'
import { accountIdentities, users, type IdentityKind } from '../db/schema'
import type { PrivyIdentity } from '../lib/privyIdentity'

/** One (kind, value) pair as stored in `account_identities`. */
export interface IdentityKey {
  kind: IdentityKind
  value: string
}

/** The account a sign-in resolved to. */
export interface ResolvedAccount {
  /**
   * The account's canonical wallet — mint THIS into the session JWT, not
   * whichever address the client happened to sign with.
   */
  wallet: string
  /** `users.id`, or null when the server is running without a database. */
  userId: string | null
  username: string | null
  totpEnabled: boolean
  /**
   * True when the proven wallet is NOT this account's canonical wallet —
   * i.e. we recognised the person through their Privy identity and handed
   * back the account they already had. The client uses it to say "welcome
   * back" instead of walking them into account creation.
   */
  matchedExistingAccount: boolean
}

/**
 * Every identity a sign-in proves, de-duplicated and ordered so the
 * strongest key comes first.
 *
 * The proven wallet leads because its ownership was demonstrated by a
 * signature in THIS request. The Privy DID follows: it is the most stable
 * key (it outlives wallets and devices) but it is asserted by Privy rather
 * than by the caller. Emails come from the verified identity token and
 * exist to catch the one case a DID cannot — Privy issuing two user ids to
 * one human who signed in two different ways with the same address.
 */
export function identityKeys(
  provenWallet: string,
  identity: PrivyIdentity | null
): IdentityKey[] {
  const keys: IdentityKey[] = [{ kind: 'wallet', value: provenWallet }]
  if (identity) {
    keys.push({ kind: 'privy', value: identity.did })
    for (const email of identity.emails) keys.push({ kind: 'email', value: email })
    for (const wallet of identity.wallets) {
      if (wallet !== provenWallet) keys.push({ kind: 'wallet', value: wallet })
    }
  }

  // Same pair twice would make the WHERE clause redundant and the insert
  // conflict with itself.
  const seen = new Set<string>()
  return keys.filter((key) => {
    const id = `${key.kind}:${key.value}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** A drizzle predicate matching any of `keys` in account_identities. */
function matchesAnyKey(keys: IdentityKey[]) {
  return or(
    ...keys.map((key) =>
      and(eq(accountIdentities.kind, key.kind), eq(accountIdentities.value, key.value))
    )
  )
}

/**
 * Attach identities to an account.
 *
 * ON CONFLICT DO NOTHING is doing real work here, not just swallowing
 * races: the unique (kind, value) index means an identity already owned by
 * a REGISTERED account simply stays there. Linking can therefore never
 * move an identity off somebody's real account, whatever the caller asks
 * for.
 *
 * `reclaimUnclaimed` opens exactly one exception, needed by the PIN +
 * authenticator login. Signing in with a fresh Privy login creates an
 * empty placeholder account and links the new DID to it; when that person
 * then proves they own an older account, the DID must follow them there.
 * So a conflicting row is re-pointed ONLY when its current owner has no
 * username — a placeholder nobody has claimed. Registered accounts are
 * untouchable.
 */
export async function linkIdentities(
  userId: string,
  keys: IdentityKey[],
  options: { reclaimUnclaimed?: boolean } = {}
): Promise<{ reclaimedFrom: string[] }> {
  const empty = { reclaimedFrom: [] as string[] }
  const db = requireDb()
  if (!db || keys.length === 0) return empty

  // Never claim a wallet that is a REGISTERED account's canonical identity
  // — that address is how the other account is reached everywhere else.
  //
  // An unclaimed placeholder's wallet is a different matter during a
  // reclaim: that row was created minutes ago by the very sign-in the user
  // is now correcting. Leaving its wallet behind would mean the next
  // sign-in with that address resolves to the placeholder again whenever
  // the Privy token is unavailable. So it comes along, and the emptied
  // placeholder is pruned by the caller.
  const walletValues = keys.filter((k) => k.kind === 'wallet').map((k) => k.value)
  const foreignWallets = new Set<string>()
  if (walletValues.length > 0) {
    const owners = await db
      .select({ wallet: users.wallet, id: users.id, username: users.username })
      .from(users)
      .where(or(...walletValues.map((w) => eq(users.wallet, w))))
    for (const owner of owners) {
      if (owner.id === userId) continue
      if (options.reclaimUnclaimed && owner.username === null) continue
      foreignWallets.add(owner.wallet)
    }
  }

  const linkable = keys.filter(
    (key) => !(key.kind === 'wallet' && foreignWallets.has(key.value))
  )
  if (linkable.length === 0) return empty

  await db
    .insert(accountIdentities)
    .values(linkable.map((key) => ({ userId, kind: key.kind, value: key.value })))
    .onConflictDoNothing()

  if (!options.reclaimUnclaimed) return empty

  // Which of these identities are currently parked on SOMEBODY ELSE's row?
  // Read the owners before the update, because UPDATE … RETURNING reports
  // the row as it is afterwards — by then the previous owner is gone.
  const currentOwners = await db
    .select({ userId: accountIdentities.userId, username: users.username })
    .from(accountIdentities)
    .innerJoin(users, eq(users.id, accountIdentities.userId))
    .where(matchesAnyKey(linkable))

  const reclaimedFrom = [
    ...new Set(
      currentOwners
        // Only ever take an identity off an UNCLAIMED placeholder: a row
        // with a username is somebody's real account and is untouchable.
        .filter((owner) => owner.userId !== userId && owner.username === null)
        .map((owner) => owner.userId)
    ),
  ]
  if (reclaimedFrom.length === 0) return empty

  await db
    .update(accountIdentities)
    .set({ userId })
    .where(
      and(
        matchesAnyKey(linkable),
        inArray(accountIdentities.userId, reclaimedFrom)
      )
    )

  return { reclaimedFrom }
}

/**
 * THE SIGN-IN RESOLVER. Given a wallet whose signature was just verified
 * and (optionally) the verified Privy identity behind it, return the one
 * account this person owns — creating it if this is genuinely their first
 * time — and link every identity they presented to it.
 */
export async function resolveSignIn(
  provenWallet: string,
  identity: PrivyIdentity | null
): Promise<ResolvedAccount> {
  const db = requireDb()

  // No database: sign-in still works, the wallet is the identity, and
  // there is no registry to deduplicate against.
  if (!db) {
    return {
      wallet: provenWallet,
      userId: null,
      username: null,
      totpEnabled: false,
      matchedExistingAccount: false,
    }
  }

  const keys = identityKeys(provenWallet, identity)

  // 1. Which accounts do the presented identities already point at?
  const matches = await db
    .select({
      userId: accountIdentities.userId,
      kind: accountIdentities.kind,
      value: accountIdentities.value,
      wallet: users.wallet,
      username: users.username,
      totpEnabled: users.totpEnabled,
      createdAt: users.createdAt,
    })
    .from(accountIdentities)
    .innerJoin(users, eq(users.id, accountIdentities.userId))
    .where(matchesAnyKey(keys))

  type Match = (typeof matches)[number]

  /**
   * Which account wins when the presented identities disagree — a person
   * who accumulated more than one account before this existed.
   *
   * The Privy DID is the tiebreaker because it is the identity Privy
   * itself considers the user. Failing that, the wallet whose signature
   * was just checked. Failing that, the oldest account, so the one with
   * the longest history is the one they keep.
   */
  const pickWinner = (rows: Match[]): Match | null => {
    if (rows.length === 0) return null
    const byDid = identity && rows.find((r) => r.kind === 'privy' && r.value === identity.did)
    if (byDid) return byDid
    const byProvenWallet = rows.find(
      (r) => r.kind === 'wallet' && r.value === provenWallet
    )
    if (byProvenWallet) return byProvenWallet
    return rows.reduce((oldest, row) =>
      row.createdAt < oldest.createdAt ? row : oldest
    )
  }

  let winner = pickWinner(matches)
  let account: {
    id: string
    wallet: string
    username: string | null
    totpEnabled: boolean
  } | null = winner
    ? {
        id: winner.userId,
        wallet: winner.wallet,
        username: winner.username,
        totpEnabled: winner.totpEnabled,
      }
    : null

  // 2. No identity rows matched — but the account may PREDATE this table.
  //    Everyone who registered before identity linking shipped has a
  //    `users` row and no `account_identities` rows at all, so their very
  //    first sign-in afterwards has to be recognised by wallet alone.
  //
  //    Every wallet we know of is checked, not just the signing one. That
  //    matters for exactly the case this whole module exists for: someone
  //    with an old account who signs in with a second wallet. Privy lists
  //    both addresses on the identity token, so the account is found by
  //    the OTHER one and they keep it — instead of being handed a fresh
  //    placeholder and walked into creating a duplicate.
  if (!account) {
    const walletKeys = keys.filter((key) => key.kind === 'wallet').map((k) => k.value)
    const legacy = await db
      .select({
        id: users.id,
        wallet: users.wallet,
        username: users.username,
        totpEnabled: users.totpEnabled,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(or(...walletKeys.map((w) => eq(users.wallet, w))))

    if (legacy.length > 0) {
      // Same tiebreak as above: the wallet whose signature we just checked
      // wins, otherwise the account with the longest history.
      account =
        legacy.find((row) => row.wallet === provenWallet) ??
        legacy.reduce((oldest, row) => (row.createdAt < oldest.createdAt ? row : oldest))
    }
  }

  // 3. Genuinely new person: create the account row now, before any
  //    username exists, so their identities have something to hang off.
  //    The row is a placeholder — routes/profile.ts fills in the username,
  //    PIN and TOTP secret when they finish setup.
  if (!account) {
    const [created] = await db
      .insert(users)
      .values({ wallet: provenWallet })
      .onConflictDoNothing({ target: users.wallet })
      .returning({
        id: users.id,
        wallet: users.wallet,
        username: users.username,
        totpEnabled: users.totpEnabled,
      })

    if (created) {
      account = created
    } else {
      // Lost the insert race with a concurrent sign-in for the same
      // wallet — the row exists now, so read the winner's.
      const [existing] = await db
        .select({
          id: users.id,
          wallet: users.wallet,
          username: users.username,
          totpEnabled: users.totpEnabled,
        })
        .from(users)
        .where(eq(users.wallet, provenWallet))
        .limit(1)
      if (!existing) throw new Error('account row vanished during sign-in')
      account = existing
    }
  }

  // 4. Link whatever was not already on file, so the next sign-in
  //    recognises this person by any of these routes.
  await linkIdentities(account.id, keys)

  return {
    wallet: account.wallet,
    userId: account.id,
    username: account.username,
    totpEnabled: account.totpEnabled,
    matchedExistingAccount: account.wallet !== provenWallet,
  }
}

/**
 * Adopt a Privy identity into an account the caller just proved they own
 * some OTHER way (the PIN + authenticator login).
 *
 * This is what makes credential login a one-time step rather than a
 * recurring chore: once the new DID/wallet/email are attached, the next
 * ordinary wallet sign-in resolves straight to this account.
 */
export async function adoptIdentity(
  userId: string,
  provenWallet: string | null,
  identity: PrivyIdentity | null
): Promise<void> {
  if (!identity && !provenWallet) return
  const db = requireDb()
  if (!db) return

  // ── THE ONE-TIME RULE ──────────────────────────────────────────────
  // Adoption writes a PERMANENT sign-in credential: a linked DID resolves
  // straight to this account on every future /verify, and there is no
  // unlink flow. So it happens only while the account has no Privy
  // identity at all — the migration case this exists for, where an
  // account created before identity linking meets its owner's Privy login
  // for the first time.
  //
  // Once an account HAS a Privy identity, a credential login will not
  // attach a second one. That closes a real hole: PIN + authenticator can
  // be entered on a borrowed or shared machine, and whatever Privy
  // session that browser happens to hold — a bystander's, or one left
  // there deliberately — would otherwise be welded onto the account for
  // good. Credential login still works every time; it just stops handing
  // out standing keys. Genuinely changing Privy accounts is an account-
  // recovery conversation, not a side effect of signing in.
  if (identity) {
    const existing = await db
      .select({ value: accountIdentities.value })
      .from(accountIdentities)
      .where(
        and(eq(accountIdentities.userId, userId), eq(accountIdentities.kind, 'privy'))
      )
      .limit(1)

    const linkedDid = existing[0]?.value
    if (linkedDid && linkedDid !== identity.did) {
      console.warn(
        '[account] credential login presented a different Privy identity than the one already linked — not adopting it'
      )
      return
    }
  }

  const keys = identityKeys(provenWallet ?? '', identity).filter(
    (key) => key.value.length > 0
  )
  const { reclaimedFrom } = await linkIdentities(userId, keys, {
    reclaimUnclaimed: true,
  })

  // Whatever those identities were parked on was a placeholder created
  // moments ago by this very sign-in. Now that nothing points at it, it is
  // a row nobody can reach — clear it out rather than leaving litter.
  for (const orphanId of reclaimedFrom) await pruneEmptyPlaceholder(orphanId)
}

/**
 * Placeholder accounts (created at sign-in, never registered) that hold no
 * identities any more — the leftovers of an `adoptIdentity` that moved a
 * fresh Privy login onto the user's real account.
 *
 * Deliberately narrow: `username IS NULL` and `pin_hash IS NULL` means the
 * row never completed registration, and no identity rows means nothing can
 * reach it. Such a row cannot have played a match (matchmaking requires a
 * username), so nothing references it.
 */
export async function pruneEmptyPlaceholder(userId: string): Promise<void> {
  const db = requireDb()
  if (!db) return
  try {
    await db
      .delete(users)
      .where(
        and(
          eq(users.id, userId),
          isNull(users.username),
          isNull(users.pinHash),
          sql`NOT EXISTS (
            SELECT 1 FROM ${accountIdentities}
            WHERE ${accountIdentities.userId} = ${users.id}
          )`
        )
      )
  } catch (err) {
    // Housekeeping only — never fail a sign-in because a stray row
    // could not be tidied up.
    console.warn('[account] placeholder cleanup skipped:', err)
  }
}
