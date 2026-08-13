import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionReadReceipt } from "@opencode-ai/core/session/read-receipt"
import { SessionRevert } from "@opencode-ai/core/session/revert"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_revert_receipt_test")
const boundary = SessionMessage.ID.make("msg_revert_boundary")
const created = DateTime.makeUnsafe(0)
const restoredPath = RelativePath.make("restored.txt")
const snapshotID = Snapshot.ID.make("snapshot")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
let cleared = false
let restored = false

const receipts = Layer.mock(SessionReadReceipt.Service, {
  clear: () =>
    Effect.sync(() => {
      cleared = true
      return 1
    }),
})

const snapshot = Layer.mock(Snapshot.Service, {
  capture: () => Effect.succeed(snapshotID),
  restore: () =>
    Effect.sync(() => {
      expect(cleared).toBe(true)
      restored = true
    }),
  diff: () => Effect.succeed([]),
})

const events = Layer.mock(EventV2.Service, {
  publish: (definition, data) =>
    Effect.succeed({
      id: EventV2.ID.create(),
      type: definition.type,
      data,
    }),
})

const layer = LayerNode.compile(Database.node).pipe(
  Layer.provideMerge(receipts),
  Layer.provideMerge(snapshot),
  Layer.provideMerge(events),
)
const it = testEffect(layer)

const session = {
  id: sessionID,
  projectID: Project.ID.global,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created },
  title: "revert",
  location: { directory: AbsolutePath.make("/project") },
  revert: {
    messageID: boundary,
    snapshot: snapshotID,
    files: [{ path: restoredPath, status: "modified" as const, additions: 1, deletions: 1, patch: "patch" }],
  },
} satisfies SessionV2.Info

describe("SessionRevert receipts", () => {
  it.effect("clears receipts before stage restores files", () =>
    Effect.gen(function* () {
      cleared = false
      restored = false
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "revert",
          directory: "/project",
          title: "revert",
          version: "test",
        })
        .run()
      const encoded = encodeMessage(
        SessionMessage.Assistant.make({
          id: boundary,
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [],
          time: { created },
        }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: boundary,
          session_id: sessionID,
          type: encoded.type,
          seq: 1,
          time_created: 0,
          data: encoded,
        })
        .run()

      yield* SessionRevert.stage({ session, messageID: boundary })
      expect(cleared).toBe(true)
      expect(restored).toBe(true)
    }),
  )

  it.effect("clears receipts before clear restores files", () =>
    Effect.gen(function* () {
      cleared = false
      restored = false
      yield* SessionRevert.clear(session)
      expect(cleared).toBe(true)
      expect(restored).toBe(true)
    }),
  )
})
