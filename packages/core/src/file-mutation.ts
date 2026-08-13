export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { dirname, resolve } from "path"
import { FSUtil } from "./fs-util"
import { FileLockCoordinator } from "./file-lock-coordinator"
import { SessionReadReceipt } from "./session/read-receipt"
import { SessionSchema } from "./session/schema"
import { AbsolutePath } from "./schema"
import { createHash } from "node:crypto"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface RemoveInput {
  readonly target: Target
}

export interface ConditionalRemoveInput extends RemoveInput {
  readonly expected: Uint8Array
}

export interface Receipt {
  readonly canonicalPath: AbsolutePath
  readonly digest: string
}

export interface SettlementLease {
  readonly release: () => Effect.Effect<void>
}

export interface CheckedTextWriteInput extends TextWriteInput {
  readonly sessionID: SessionSchema.ID
}

export interface ModifyTextInput<A, E, R> {
  readonly sessionID: SessionSchema.ID
  readonly target: Target
  readonly modify: (input: {
    readonly content: Uint8Array
    readonly text: string
    readonly bom: boolean
  }) => Effect.Effect<{ readonly content: string; readonly value: A }, E, R>
}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Operations {
  readonly create: (input: WriteInput) => Effect.Effect<WriteResult, TargetExistsError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  readonly writeTextPreservingBom: (input: TextWriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, FSUtil.Error>
  readonly removeIfUnchanged: (
    input: ConditionalRemoveInput,
  ) => Effect.Effect<RemoveResult, StaleContentError | FSUtil.Error>
}

export interface Batch {
  readonly targets: readonly Target[]
  readonly operations: Operations
  readonly requireReceipt: (input: {
    readonly sessionID: SessionSchema.ID
    readonly target: Target
    readonly content: Uint8Array
  }) => Effect.Effect<void, StaleContentError>
  readonly invalidateReceipt: (input: {
    readonly sessionID: SessionSchema.ID
    readonly target: Target
  }) => Effect.Effect<void>
}

export interface Interface {
  readonly withBatch: <A, E, R>(
    targets: readonly Target[],
    run: (batch: Batch) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StaleContentError | FSUtil.Error, R>
  /** Create without replacing an existing target. */
  readonly create: (
    input: WriteInput,
  ) => Effect.Effect<WriteResult, TargetExistsError | StaleContentError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, StaleContentError | FSUtil.Error>
  /** Transport one render-and-digest result produced from a single opened file snapshot. */
  readonly readReceipt: <A, E, R>(input: {
    readonly target: Target
    readonly read: Effect.Effect<{ readonly value: A; readonly digest: string }, E, R>
  }) => Effect.Effect<{ readonly value: A; readonly receipt: Receipt }, E | StaleContentError | FSUtil.Error, R>
  /** Create an absent target, or overwrite only when the session receipt matches its current bytes. */
  readonly createOrCheckedOverwriteText: (
    input: CheckedTextWriteInput,
  ) => Effect.Effect<
    { readonly result: WriteResult; readonly receipt: Receipt } & SettlementLease,
    StaleContentError | FSUtil.Error
  >
  /** Check the receipt, derive one text mutation from the locked snapshot, and write once. */
  readonly modifyText: <A, E, R>(
    input: ModifyTextInput<A, E, R>,
  ) => Effect.Effect<
    { readonly value: A; readonly receipt: Receipt } & SettlementLease,
    E | StaleContentError | FSUtil.Error,
    R
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileMutation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const receipts = yield* SessionReadReceipt.Service
    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const removeResult = (target: Target, existed: boolean): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const operations: Operations = {
      write: Effect.fn("FileMutation.writeUnlocked")((input: WriteInput) =>
        Effect.gen(function* () {
          const existed = yield* fs.exists(input.target.canonical)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return writeResult(input.target, existed)
        }),
      ),
      writeTextPreservingBom: Effect.fn("FileMutation.writeTextPreservingBomUnlocked")((input: TextWriteInput) =>
        Effect.gen(function* () {
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          yield* fs.writeWithDirs(
            input.target.canonical,
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          return writeResult(input.target, current !== undefined)
        }),
      ),
      create: Effect.fn("FileMutation.createUnlocked")((input: WriteInput) =>
        Effect.gen(function* () {
          const write =
            typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
          )
          return writeResult(input.target, false)
        }),
      ),
      writeIfUnchanged: Effect.fn("FileMutation.writeIfUnchangedUnlocked")((input: ConditionalWriteInput) =>
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          return writeResult(input.target, true)
        }),
      ),
      remove: Effect.fn("FileMutation.removeUnlocked")((input: RemoveInput) =>
        Effect.gen(function* () {
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          return removeResult(input.target, existed)
        }),
      ),
      removeIfUnchanged: Effect.fn("FileMutation.removeIfUnchangedUnlocked")((input: ConditionalRemoveInput) =>
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* fs.remove(input.target.canonical)
          return removeResult(input.target, true)
        }),
      ),
    }

    const withBatch: Interface["withBatch"] = (targets, run) =>
      Effect.gen(function* () {
        const mapped = yield* canonicalTargets(fs, targets)
        return yield* FileLockCoordinator.withLocks(
          yield* FileLockCoordinator.keys(
            fs,
            mapped.map((target) => target.canonical),
          ),
          Effect.uninterruptible(
            Effect.gen(function* () {
              const checked = yield* canonicalTargets(fs, mapped)
              return yield* run({
                targets: checked,
                operations,
                requireReceipt: (input) =>
                  requireReceipt(receipts, input.sessionID, input.target.canonical, input.content),
                invalidateReceipt: (input) =>
                  receipts
                    .invalidate({
                      sessionID: input.sessionID,
                      canonicalPath: AbsolutePath.make(input.target.canonical),
                    })
                    .pipe(Effect.orDie, Effect.asVoid),
              })
            }),
          ),
        )
      })

    const withRetainedBatch = <A, E, R>(
      targets: readonly Target[],
      run: (batch: Batch) => Effect.Effect<A, E, R>,
    ): Effect.Effect<{ readonly value: A } & SettlementLease, E | StaleContentError | FSUtil.Error, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const mapped = yield* canonicalTargets(fs, targets)
          const lease = yield* restore(
            FileLockCoordinator.acquireLocks(
              yield* FileLockCoordinator.keys(
                fs,
                mapped.map((target) => target.canonical),
              ),
            ),
          )
          const result = yield* restore(
            Effect.gen(function* () {
              const checked = yield* canonicalTargets(fs, mapped)
              return yield* run({
                targets: checked,
                operations,
                requireReceipt: (input) =>
                  requireReceipt(receipts, input.sessionID, input.target.canonical, input.content),
                invalidateReceipt: (input) =>
                  receipts
                    .invalidate({
                      sessionID: input.sessionID,
                      canonicalPath: AbsolutePath.make(input.target.canonical),
                    })
                    .pipe(Effect.orDie, Effect.asVoid),
              })
            }),
          ).pipe(Effect.onError(() => lease.release))
          return { value: result, release: () => lease.release }
        }),
      )

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withBatch([input.target], (batch) => batch.operations.create({ ...input, target: batch.targets[0] })),
    )
    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withBatch([input.target], (batch) => batch.operations.write({ ...input, target: batch.targets[0] })),
    )
    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withBatch([input.target], (batch) =>
        batch.operations.writeTextPreservingBom({ ...input, target: batch.targets[0] }),
      ),
    )
    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withBatch([input.target], (batch) => batch.operations.writeIfUnchanged({ ...input, target: batch.targets[0] })),
    )
    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withBatch([input.target], (batch) => batch.operations.remove({ target: batch.targets[0] })),
    )

    const readReceipt: Interface["readReceipt"] = (input) =>
      withBatch([input.target], (batch) =>
        Effect.gen(function* () {
          const result = yield* input.read
          return {
            value: result.value,
            receipt: { canonicalPath: AbsolutePath.make(batch.targets[0].canonical), digest: result.digest },
          }
        }),
      )

    const createOrCheckedOverwriteText = Effect.fn("FileMutation.createOrCheckedOverwriteText")(function* (
      input: CheckedTextWriteInput,
    ) {
      const settled = yield* withRetainedBatch([input.target], (batch) =>
        Effect.gen(function* () {
          const target = batch.targets[0]
          const current = yield* fs
            .readFile(target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          if (!current) {
            const next = joinBom(input.content, splitBom(input.content).bom)
            yield* receipts
              .invalidate({ sessionID: input.sessionID, canonicalPath: AbsolutePath.make(target.canonical) })
              .pipe(Effect.orDie)
            const write = fs.writeFileString(target.canonical, next, { flag: "wx" })
            yield* write.pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                fs.ensureDir(dirname(target.canonical)).pipe(Effect.andThen(write)),
              ),
              Effect.catchReason("PlatformError", "AlreadyExists", () =>
                Effect.fail(new StaleContentError({ path: target.canonical })),
              ),
            )
            return { result: writeResult(target, false), receipt: receipt(target.canonical, bytes(next)) }
          }
          yield* requireReceipt(receipts, input.sessionID, target.canonical, current)
          const checked = yield* fs.readFile(target.canonical)
          if (!sameBytes(current, checked)) return yield* new StaleContentError({ path: target.canonical })
          yield* receipts
            .invalidate({ sessionID: input.sessionID, canonicalPath: AbsolutePath.make(target.canonical) })
            .pipe(Effect.orDie)
          const next = joinBom(input.content, hasUtf8Bom(current) || splitBom(input.content).bom)
          yield* fs.writeFileString(target.canonical, next)
          return { result: writeResult(target, true), receipt: receipt(target.canonical, bytes(next)) }
        }),
      )
      return { ...settled.value, release: settled.release }
    })

    const modifyText: Interface["modifyText"] = (input) =>
      withRetainedBatch([input.target], (batch) =>
        Effect.gen(function* () {
          const target = batch.targets[0]
          const content = yield* fs.readFile(target.canonical)
          yield* requireReceipt(receipts, input.sessionID, target.canonical, content)
          const decoded = decodeText(content)
          const modified = yield* input.modify({ content, text: decoded.text, bom: decoded.bom })
          const checked = yield* fs.readFile(target.canonical)
          if (!sameBytes(content, checked)) return yield* new StaleContentError({ path: target.canonical })
          yield* receipts
            .invalidate({ sessionID: input.sessionID, canonicalPath: AbsolutePath.make(target.canonical) })
            .pipe(Effect.orDie)
          const next = joinBom(modified.content, decoded.bom || splitBom(modified.content).bom)
          yield* fs.writeFileString(target.canonical, next)
          return { value: modified.value, receipt: receipt(target.canonical, bytes(next)) }
        }),
      ).pipe(Effect.map((settled) => ({ ...settled.value, release: settled.release })))

    return Service.of({
      withBatch,
      create,
      write,
      writeTextPreservingBom,
      writeIfUnchanged,
      remove,
      readReceipt,
      createOrCheckedOverwriteText,
      modifyText,
    })
  }),
)

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

const canonicalTargets = Effect.fn("FileMutation.canonicalTargets")(function* (
  fs: FSUtil.Interface,
  targets: readonly Target[],
) {
  return yield* Effect.forEach(targets, (target) =>
    FileLockCoordinator.canonical(fs, target.canonical).pipe(
      Effect.flatMap((canonical) =>
        samePath(target.canonical, canonical)
          ? Effect.succeed({ ...target, canonical })
          : Effect.fail(new StaleContentError({ path: target.canonical })),
      ),
    ),
  )
})

function samePath(left: string, right: string) {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  if (process.platform !== "win32") return normalizedLeft === normalizedRight
  return normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
}

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

function receipt(canonical: string, content: Uint8Array): Receipt {
  return { canonicalPath: AbsolutePath.make(canonical), digest: digest(content) }
}

function bytes(content: string) {
  return new TextEncoder().encode(content)
}

function decodeText(content: Uint8Array) {
  const bom = hasUtf8Bom(content)
  return { bom, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const requireReceipt = Effect.fn("FileMutation.requireReceipt")(function* (
  receipts: SessionReadReceipt.Interface,
  sessionID: SessionSchema.ID,
  canonical: string,
  content: Uint8Array,
) {
  if (
    yield* receipts
      .match({ sessionID, canonicalPath: AbsolutePath.make(canonical), digest: digest(content) })
      .pipe(Effect.orDie)
  )
    return
  return yield* new StaleContentError({ path: canonical })
})

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, SessionReadReceipt.node] })

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
