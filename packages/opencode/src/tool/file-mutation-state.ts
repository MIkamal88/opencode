import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileLockCoordinator } from "@opencode-ai/core/file-lock-coordinator"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer, Option } from "effect"

export interface Snapshot {
  readonly content: Uint8Array
  readonly dev: number
  readonly ino?: number
  readonly birthtime?: number
}

export interface ReadResult {
  readonly digest: string
}

export interface Interface {
  readonly canonical: (filePath: string) => Effect.Effect<string>
  readonly digest: (content: Uint8Array) => string
  readonly snapshot: (filePath: string) => Effect.Effect<Snapshot, FSUtil.Error>
  readonly read: <E, R>(
    filePath: string,
    consume: (chunk: Uint8Array) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<ReadResult, FSUtil.Error | E, R>
  readonly sameIdentity: (left: Snapshot, right: Snapshot) => boolean
  readonly acquireLock: (canonicalPath: string) => Effect.Effect<FileLockCoordinator.Lease>
  readonly withLock: <A, E, R>(canonicalPath: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withLocks: <A, E, R>(
    canonicalPaths: readonly string[],
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/V1FileMutationState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const snapshot = Effect.fn("V1FileMutationState.snapshot")(function* (filePath: string) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filePath, { flag: "r" })
          const info = yield* file.stat
          const chunks: Uint8Array[] = []
          while (true) {
            const chunk = yield* file.readAlloc(64 * 1024)
            if (Option.isNone(chunk)) break
            chunks.push(chunk.value)
          }
          return {
            content: Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
            dev: info.dev,
            ino: Option.getOrUndefined(info.ino),
            birthtime: Option.getOrUndefined(info.birthtime)?.getTime(),
          }
        }),
      )
    })
    const read: Interface["read"] = (filePath, consume) =>
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filePath, { flag: "r" })
          const hasher = new Bun.CryptoHasher("sha256")
          while (true) {
            const chunk = yield* file.readAlloc(64 * 1024)
            if (Option.isNone(chunk)) break
            hasher.update(chunk.value)
            yield* consume(chunk.value)
          }
          return { digest: hasher.digest("hex") }
        }),
      )
    return Service.of({
      canonical: (filePath) => FileLockCoordinator.canonical(fs, filePath),
      digest: (content) => new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      snapshot,
      read,
      sameIdentity: (left, right) => {
        if (left.dev !== right.dev) return false
        if (left.ino !== undefined || right.ino !== undefined) return left.ino === right.ino
        if (left.birthtime === undefined || right.birthtime === undefined) return false
        return left.birthtime === right.birthtime
      },
      acquireLock: (canonicalPath) =>
        FileLockCoordinator.keys(fs, [canonicalPath]).pipe(
          Effect.flatMap((lockKeys) => FileLockCoordinator.acquireLocks(lockKeys)),
        ),
      withLock: (canonicalPath, effect) =>
        FileLockCoordinator.keys(fs, [canonicalPath]).pipe(
          Effect.flatMap((lockKeys) => FileLockCoordinator.withLocks(lockKeys, effect)),
        ),
      withLocks: (canonicalPaths, effect) =>
        FileLockCoordinator.keys(fs, canonicalPaths).pipe(
          Effect.flatMap((lockKeys) => FileLockCoordinator.withLocks(lockKeys, effect)),
        ),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

export * as FileMutationState from "./file-mutation-state"
