export * as SessionReadReceipt from "./read-receipt"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "./schema"
import { SessionReadReceiptTable } from "./sql"
import path from "path"

export type Client = Database.Client

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "SessionReadReceipt.InvalidInputError",
  {
    field: Schema.Literals(["canonicalPath", "digest", "settledSeq"]),
    message: Schema.String,
  },
) {}

export interface Receipt {
  readonly sessionID: SessionSchema.ID
  readonly canonicalPath: AbsolutePath
  /** Lowercase hexadecimal SHA-256 digest of the settled file content. */
  readonly digest: string
  readonly settledSeq: number
  readonly callID?: string
  readonly time: {
    readonly created: number
    readonly updated: number
  }
}

export interface Key {
  readonly sessionID: SessionSchema.ID
  readonly canonicalPath: AbsolutePath
}

export interface UpsertInput extends Key {
  readonly digest: string
  readonly settledSeq: number
  readonly callID?: string
}

export interface Interface {
  readonly get: (input: Key) => Effect.Effect<Receipt | undefined, InvalidInputError>
  readonly match: (input: Key & { readonly digest: string }) => Effect.Effect<boolean, InvalidInputError>
  readonly upsert: (input: UpsertInput) => Effect.Effect<Receipt, InvalidInputError>
  readonly invalidate: (input: Key) => Effect.Effect<boolean, InvalidInputError>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionReadReceipt") {}

export const getIn = Effect.fn("SessionReadReceipt.getIn")(function* (client: Client, input: Key) {
  yield* validateKey(input)
  const row = yield* client
    .select()
    .from(SessionReadReceiptTable)
    .where(
      and(
        eq(SessionReadReceiptTable.session_id, input.sessionID),
        eq(SessionReadReceiptTable.canonical_path, input.canonicalPath),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  return fromRow(row)
})

export const matchIn = Effect.fn("SessionReadReceipt.matchIn")(function* (
  client: Client,
  input: Key & { readonly digest: string },
) {
  yield* validateKey(input)
  yield* validateDigest(input.digest)
  return (
    (yield* client
      .select({ sessionID: SessionReadReceiptTable.session_id })
      .from(SessionReadReceiptTable)
      .where(
        and(
          eq(SessionReadReceiptTable.session_id, input.sessionID),
          eq(SessionReadReceiptTable.canonical_path, input.canonicalPath),
          eq(SessionReadReceiptTable.digest, input.digest),
        ),
      )
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

export const upsertIn = Effect.fn("SessionReadReceipt.upsertIn")(function* (client: Client, input: UpsertInput) {
  yield* validateKey(input)
  yield* validateDigest(input.digest)
  if (!Number.isSafeInteger(input.settledSeq) || input.settledSeq < 0)
    return yield* new InvalidInputError({
      field: "settledSeq",
      message: "settledSeq must be a non-negative integer",
    })
  const row = yield* client
    .insert(SessionReadReceiptTable)
    .values({
      session_id: input.sessionID,
      canonical_path: input.canonicalPath,
      digest: input.digest,
      settled_seq: input.settledSeq,
      call_id: input.callID,
    })
    .onConflictDoUpdate({
      target: [SessionReadReceiptTable.session_id, SessionReadReceiptTable.canonical_path],
      set: {
        digest: input.digest,
        settled_seq: input.settledSeq,
        call_id: input.callID ?? null,
        time_updated: Date.now(),
      },
    })
    .returning()
    .get()
    .pipe(Effect.orDie)
  return fromRow(row)
})

export const invalidateIn = Effect.fn("SessionReadReceipt.invalidateIn")(function* (client: Client, input: Key) {
  yield* validateKey(input)
  return (
    (yield* client
      .delete(SessionReadReceiptTable)
      .where(
        and(
          eq(SessionReadReceiptTable.session_id, input.sessionID),
          eq(SessionReadReceiptTable.canonical_path, input.canonicalPath),
        ),
      )
      .returning({ sessionID: SessionReadReceiptTable.session_id })
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

export const clearIn = Effect.fn("SessionReadReceipt.clearIn")(function* (client: Client, sessionID: SessionSchema.ID) {
  return (yield* client
    .delete(SessionReadReceiptTable)
    .where(eq(SessionReadReceiptTable.session_id, sessionID))
    .returning({ sessionID: SessionReadReceiptTable.session_id })
    .all()
    .pipe(Effect.orDie)).length
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return Service.of({
      get: (input) => getIn(db, input),
      match: (input) => matchIn(db, input),
      upsert: (input) => upsertIn(db, input),
      invalidate: (input) => invalidateIn(db, input),
      clear: (sessionID) => clearIn(db, sessionID),
    })
  }),
)

function fromRow(row: typeof SessionReadReceiptTable.$inferSelect): Receipt {
  return {
    sessionID: row.session_id,
    canonicalPath: AbsolutePath.make(row.canonical_path),
    digest: row.digest,
    settledSeq: row.settled_seq,
    callID: row.call_id ?? undefined,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

const validateKey = Effect.fn("SessionReadReceipt.validateKey")(function* (input: Key) {
  if (path.isAbsolute(input.canonicalPath)) return
  return yield* new InvalidInputError({ field: "canonicalPath", message: "canonicalPath must be absolute" })
})

const validateDigest = Effect.fn("SessionReadReceipt.validateDigest")(function* (digest: string) {
  if (/^[0-9a-f]{64}$/.test(digest)) return
  return yield* new InvalidInputError({ field: "digest", message: "digest must be lowercase 64-character hexadecimal" })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
