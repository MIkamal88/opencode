export * as KeyedMutex from "./keyed-mutex"

import { Effect, Semaphore } from "effect"

export interface KeyedMutex<in Key> {
  readonly size: Effect.Effect<number>
  readonly acquire: (key: Key) => Effect.Effect<Lease>
  readonly withLock: (key: Key) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export interface Lease {
  readonly release: Effect.Effect<void>
}

/**
 * Creates an in-memory mutex with one lock per key. Entries are removed when no
 * holder or waiter remains.
 *
 *   same key      -> queue
 *   different key -> run independently
 *
 * `users` counts holders and waiters so an entry is not removed while a waiter
 * will reuse it.
 */
export const makeUnsafe = <Key>(): KeyedMutex<Key> => {
  const locks = new Map<Key, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const acquire = (key: Key) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const current = locks.get(key)
        const entry = current ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        if (!current) locks.set(key, entry)
        entry.users++
        const abandon = Effect.sync(() => {
          entry.users--
          if (entry.users === 0) locks.delete(key)
        })
        return restore(entry.semaphore.take(1)).pipe(
          Effect.onError(() => abandon),
          Effect.map(() => {
            let released = false
            return {
              release: Effect.suspend(() => {
                if (released) return Effect.void
                released = true
                return entry.semaphore.release(1).pipe(Effect.andThen(abandon))
              }),
            }
          }),
        )
      }),
    )

  const withLock =
    (key: Key) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        acquire(key),
        () => effect,
        (lease) => lease.release,
      )

  return { size: Effect.sync(() => locks.size), acquire, withLock }
}

/** Creates an in-memory keyed mutex inside an Effect workflow. */
export const make = <Key>(): Effect.Effect<KeyedMutex<Key>> => Effect.sync(makeUnsafe<Key>)
