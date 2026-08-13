import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionReadReceipt } from "@opencode-ai/core/session/read-receipt"
import { SessionReadReceiptTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionReadReceipt.node])))
const firstSession = SessionV2.ID.make("ses_read_receipt_first")
const secondSession = SessionV2.ID.make("ses_read_receipt_second")
const canonicalPath = AbsolutePath.make("/project/file.txt")
const firstDigest = "1".repeat(64)
const secondDigest = "2".repeat(64)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      [firstSession, secondSession].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionReadReceipt", () => {
  it.effect("upserts and matches the latest settled digest", () =>
    Effect.gen(function* () {
      yield* setup
      const receipts = yield* SessionReadReceipt.Service
      const key = { sessionID: firstSession, canonicalPath }

      const inserted = yield* receipts.upsert({ ...key, digest: firstDigest, settledSeq: 3, callID: "call_read" })
      expect(inserted).toMatchObject({ ...key, digest: firstDigest, settledSeq: 3, callID: "call_read" })
      expect(yield* receipts.match({ ...key, digest: firstDigest })).toBeTrue()

      const updated = yield* receipts.upsert({ ...key, digest: secondDigest, settledSeq: 8 })
      expect(updated).toMatchObject({ ...key, digest: secondDigest, settledSeq: 8 })
      expect(updated.callID).toBeUndefined()
      expect(yield* receipts.match({ ...key, digest: firstDigest })).toBeFalse()
      expect(yield* receipts.match({ ...key, digest: secondDigest })).toBeTrue()
      expect(yield* receipts.get(key)).toEqual(updated)
    }),
  )

  it.effect("isolates, invalidates, and clears receipts by session", () =>
    Effect.gen(function* () {
      yield* setup
      const receipts = yield* SessionReadReceipt.Service
      const first = { sessionID: firstSession, canonicalPath }
      const second = { sessionID: secondSession, canonicalPath }
      yield* receipts.upsert({ ...first, digest: firstDigest, settledSeq: 1 })
      yield* receipts.upsert({ ...second, digest: secondDigest, settledSeq: 2 })

      expect(yield* receipts.invalidate(first)).toBeTrue()
      expect(yield* receipts.invalidate(first)).toBeFalse()
      expect(yield* receipts.get(second)).toBeDefined()
      yield* receipts.upsert({ ...first, digest: firstDigest, settledSeq: 3 })
      expect(yield* receipts.clear(firstSession)).toBe(1)
      expect(yield* receipts.get(first)).toBeUndefined()
      expect(yield* receipts.get(second)).toBeDefined()
    }),
  )

  it.effect("cascades receipt deletion with its session", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const receipts = yield* SessionReadReceipt.Service
      yield* receipts.upsert({ sessionID: firstSession, canonicalPath, digest: firstDigest, settledSeq: 1 })

      yield* db.delete(SessionTable).where(eq(SessionTable.id, firstSession)).run().pipe(Effect.orDie)

      expect(yield* receipts.get({ sessionID: firstSession, canonicalPath })).toBeUndefined()
    }),
  )

  it.effect("rolls back transaction-compatible receipt helpers", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const input = { sessionID: firstSession, canonicalPath, digest: firstDigest, settledSeq: 7 }

      const exit = yield* db
        .transaction((tx) => SessionReadReceipt.upsertIn(tx, input).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBeTrue()
      expect(yield* SessionReadReceipt.getIn(db, input)).toBeUndefined()
      expect(yield* db.select().from(SessionReadReceiptTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("rejects invalid operational receipt inputs", () =>
    Effect.gen(function* () {
      yield* setup
      const receipts = yield* SessionReadReceipt.Service
      expect(
        yield* receipts
          .get({ sessionID: firstSession, canonicalPath: AbsolutePath.make("relative.txt") })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionReadReceipt.InvalidInputError)
      expect(
        yield* receipts.match({ sessionID: firstSession, canonicalPath, digest: "A".repeat(64) }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionReadReceipt.InvalidInputError)
      expect(
        yield* receipts
          .upsert({ sessionID: firstSession, canonicalPath, digest: firstDigest, settledSeq: -1 })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionReadReceipt.InvalidInputError)
      expect(
        yield* receipts
          .upsert({ sessionID: firstSession, canonicalPath, digest: "abc", settledSeq: 0 })
          .pipe(Effect.flip),
      ).toBeInstanceOf(SessionReadReceipt.InvalidInputError)
      expect(yield* receipts.get({ sessionID: firstSession, canonicalPath })).toBeUndefined()
    }),
  )
})
