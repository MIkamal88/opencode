export * as FileLockCoordinator from "./file-lock-coordinator"

import { Effect, Option } from "effect"
import { platform } from "os"
import { dirname, relative, resolve } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"

const locks = KeyedMutex.makeUnsafe<string>()

export interface Lease {
  readonly release: Effect.Effect<void>
}

export const canonical = Effect.fn("FileLockCoordinator.canonical")(function* (fs: FSUtil.Interface, filePath: string) {
  const absolute = resolve(filePath)
  const existing = yield* fs.realPath(absolute).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (existing) return existing

  const missing: string[] = []
  let anchor = absolute
  while (true) {
    const parent = dirname(anchor)
    missing.push(relative(parent, anchor))
    const resolved = yield* fs.realPath(parent).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (resolved) return resolve(resolved, ...missing.reverse())
    if (parent === anchor) return absolute
    anchor = parent
  }
})

export const keys = Effect.fn("FileLockCoordinator.keys")(function* (fs: FSUtil.Interface, paths: readonly string[]) {
  const groups = yield* Effect.forEach(paths, (filePath) => keysForPath(fs, filePath))
  const resolved = groups.flatMap((group) => group)
  return [...new Set(resolved)].sort((left, right) => left.localeCompare(right))
})

const keysForPath = Effect.fn("FileLockCoordinator.keysForPath")(function* (fs: FSUtil.Interface, filePath: string) {
  const resolved = yield* canonical(fs, filePath)
  const pathKey = `path:${platform() === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved}`
  const info = yield* fs.stat(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const ino = info && Option.getOrUndefined(info.ino)
  if (info && ino !== undefined) return [pathKey, `identity:${info.dev}:${ino}`]
  return [pathKey]
})

export const acquireLocks = (lockKeys: readonly string[]): Effect.Effect<Lease> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const acquired: KeyedMutex.Lease[] = []
      const sorted = [...new Set(lockKeys)].sort((left, right) => left.localeCompare(right))
      const result = yield* restore(
        Effect.forEach(sorted, (lockKey) =>
          locks.acquire(lockKey).pipe(Effect.tap((lease) => Effect.sync(() => void acquired.push(lease)))),
        ),
      ).pipe(Effect.exit)
      if (result._tag === "Failure") {
        yield* Effect.forEach(acquired.toReversed(), (lease) => lease.release, { discard: true })
        return yield* Effect.failCause(result.cause)
      }
      let released = false
      return {
        release: Effect.suspend(() => {
          if (released) return Effect.void
          released = true
          return Effect.forEach(acquired.toReversed(), (lease) => lease.release, { discard: true })
        }),
      }
    }),
  )

export const withLocks = <A, E, R>(lockKeys: readonly string[], effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireLocks(lockKeys),
    () => effect,
    (lease) => lease.release,
  )
