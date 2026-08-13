import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { FileMutationState } from "@/tool/file-mutation-state"
import { FileLockCoordinator } from "@opencode-ai/core/file-lock-coordinator"
import { Tool } from "@/tool/tool"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      Format.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      FileMutationState.node,
    ]),
  ),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = Parameters<Tool.Context["ask"]>[0]

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
  receipt?: {
    match: (input: { canonicalPath: string; digest: string }) => Effect.Effect<boolean>
    invalidate: (input: { canonicalPath: string }) => Effect.Effect<void>
    settle: (input: { canonicalPath: string; digest: string }) => Effect.Effect<void>
    pending: () => { canonicalPath: string; digest: string } | undefined
  }
}

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (params: { patchText: string }, ctx: ToolCtx) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const makeCtx = () => {
  const calls: AskInput[] = []
  const invalidated: string[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
    receipt: {
      match: () => Effect.succeed(true),
      invalidate: ({ canonicalPath }) => Effect.sync(() => void invalidated.push(canonicalPath)),
      settle: () => Effect.void,
      pending: () => undefined,
    },
  }

  return { ctx, calls, invalidated }
}

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))
const makeDir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

const expectReadFailure = (filepath: string) => expectFailure(readText(filepath))

describe("tool.apply_patch freeform", () => {
  it.live("requires patchText", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "" }, ctx), "patchText is required")
    }),
  )

  it.live("rejects invalid patch format", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "invalid patch" }, ctx), "apply_patch verification failed")
    }),
  )

  it.live("rejects empty patch", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "*** Begin Patch\n*** End Patch" }, ctx), "patch rejected: empty patch")
    }),
  )

  it.instance(
    "applies add/update/delete in one patch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const modifyPath = path.join(test.directory, "modify.txt")
        const deletePath = path.join(test.directory, "delete.txt")
        yield* writeText(modifyPath, "line1\nline2\n")
        yield* writeText(deletePath, "obsolete\n")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        // Strict formatting assertions for slashes
        expect(result.output).toMatch(/A nested\/new\.txt/)
        expect(result.output).toMatch(/D delete\.txt/)
        expect(result.output).toMatch(/M modify\.txt/)
        if (process.platform === "win32") {
          expect(result.output).not.toContain("\\")
        }
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.length).toBe(1)

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls[0]
        const metadata = permissionCall.metadata as unknown as {
          files: Array<{
            filePath: string
            relativePath: string
            type: "add" | "update" | "delete" | "move"
            patch: string
            additions: number
            deletions: number
            movePath?: string
          }>
        }
        expect(metadata.files).toHaveLength(3)
        expect(metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = metadata.files.find((f) => f.type === "add")
        expect(addFile?.relativePath).toBe("nested/new.txt")
        expect(addFile?.patch).toContain("+created")

        const updateFile = metadata.files.find((f) => f.type === "update")
        expect(updateFile?.patch).toContain("-line2")
        expect(updateFile?.patch).toContain("+changed")

        expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
        expect(yield* readText(modifyPath)).toBe("line1\nchanged\n")
        yield* expectReadFailure(deletePath)
      }),
    { git: true },
  )

  it.instance(
    "permission metadata includes move file info",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const original = path.join(test.directory, "old", "name.txt")
        yield* makeDir(path.dirname(original))
        yield* writeText(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(calls.length).toBe(1)
        const permissionCall = calls[0]
        const moveFile = (permissionCall.metadata as unknown as { files: unknown[] }).files[0] as {
          type: string
          relativePath: string
          movePath?: string
          patch: string
        }
        expect((permissionCall.metadata as unknown as { files: unknown[] }).files).toHaveLength(1)
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(test.directory, "renamed/dir/name.txt"))
        expect(moveFile.patch).toContain("-old content")
        expect(moveFile.patch).toContain("+new content")
        expect(permissionCall.patterns).toEqual(["old/name.txt", "renamed/dir/name.txt"])
      }),
    { git: true },
  )

  it.instance("applies multiple hunks to one file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi.txt")
      yield* writeText(target, "line1\nline2\nline3\nline4\n")

      const patchText =
        "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("line1\nchanged2\nline3\nchanged4\n")
    }),
  )

  it.instance("does not invent a first-line diff for BOM files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const bom = String.fromCharCode(0xfeff)
      const target = path.join(test.directory, "example.cs")
      yield* writeText(target, `${bom}using System;\n\nclass Test {}\n`)

      const patchText =
        "*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(calls.length).toBe(1)
      const shown =
        ((calls[0].metadata as unknown as { files: Array<{ patch: string }> }).files[0]?.patch as string | undefined) ??
        ""
      expect(shown).not.toContain(bom)
      expect(shown).not.toContain("-using System;")
      expect(shown).not.toContain("+using System;")

      const content = yield* readText(target)
      expect(content.charCodeAt(0)).toBe(0xfeff)
      expect(content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n")
    }),
  )

  it.instance("inserts lines with insert-only hunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "insert_only.txt")
      yield* writeText(target, "alpha\nomega\n")

      const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("alpha\nbeta\nomega\n")
    }),
  )

  it.instance("appends trailing newline on update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "no_newline.txt")
      yield* writeText(target, "no newline at end")

      const patchText =
        "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const contents = yield* readText(target)
      expect(contents.endsWith("\n")).toBe(true)
      expect(contents).toBe("first line\nsecond line\n")
    }),
  )

  it.instance("moves file to a new directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const moved = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* expectReadFailure(original)
      expect(yield* readText(moved)).toBe("new content\n")
    }),
  )

  it.instance("rejects a move to an existing destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      const destination = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* makeDir(path.dirname(destination))
      yield* writeText(original, "from\n")
      yield* writeText(destination, "existing\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "Move destination already exists")

      expect(yield* readText(original)).toBe("from\n")
      expect(yield* readText(destination)).toBe("existing\n")
    }),
  )

  it.instance("rejects adding an existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old content\n")

      const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "File already exists")
      expect(yield* readText(target)).toBe("old content\n")
    }),
  )

  it.instance("requires a matching read receipt and invalidates the changed path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const calls: string[] = []
      const target = path.join(test.directory, "receipt.txt")
      yield* writeText(target, "before\n")
      const ctx: ToolCtx = {
        ...baseCtx,
        ask: () => Effect.void,
        receipt: {
          match: () => Effect.sync(() => calls.push("match")).pipe(Effect.as(true)),
          invalidate: () => Effect.sync(() => calls.push("invalidate")),
          settle: () => Effect.sync(() => calls.push("settle")),
          pending: () => undefined,
        },
      }

      yield* execute(
        { patchText: "*** Begin Patch\n*** Update File: receipt.txt\n@@\n-before\n+after\n*** End Patch" },
        ctx,
      )
      expect(yield* readText(target)).toBe("after\n")
      expect(calls).toEqual(["match", "invalidate"])
    }),
  )

  it.instance("rejects a missing read receipt before permission or mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "unread.txt")
      yield* writeText(target, "before\n")
      const permission: string[] = []
      const ctx: ToolCtx = {
        ...baseCtx,
        ask: () => Effect.sync(() => void permission.push("asked")),
        receipt: {
          match: () => Effect.succeed(false),
          invalidate: () => Effect.die("must not invalidate"),
          settle: () => Effect.die("must not settle"),
          pending: () => undefined,
        },
      }

      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** Update File: unread.txt\n@@\n-before\n+after\n*** End Patch" }, ctx),
        "has not been read in this session",
      )
      expect(permission).toEqual([])
      expect(yield* readText(target)).toBe("before\n")
    }),
  )

  it.instance("rejects malformed UTF-8 before permission or mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "malformed.txt")
      const bytes = Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0xff]), Buffer.from("\nbefore\n")])
      yield* Effect.promise(() => fs.writeFile(target, bytes))
      const { ctx, calls, invalidated } = makeCtx()

      yield* expectFailure(
        execute(
          { patchText: "*** Begin Patch\n*** Update File: malformed.txt\n@@\n-before\n+after\n*** End Patch" },
          ctx,
        ),
        "malformed UTF-8",
      )
      expect(calls).toEqual([])
      expect(invalidated).toEqual([])
      expect(Buffer.compare(yield* Effect.promise(() => fs.readFile(target)), bytes)).toBe(0)
    }),
  )

  it.instance("preserves CRLF while applying an update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "windows.txt")
      yield* writeText(target, "first\r\nsecond\r\n")

      yield* execute(
        { patchText: "*** Begin Patch\n*** Update File: windows.txt\n@@\n-second\n+changed\n*** End Patch" },
        ctx,
      )
      expect(yield* readText(target)).toBe("first\r\nchanged\r\n")
    }),
  )

  it.instance("rejects duplicate canonical targets before permission or mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const target = path.join(test.directory, "duplicate-source.txt")
      yield* writeText(target, "before\n")
      const patchText =
        "*** Begin Patch\n*** Update File: duplicate-source.txt\n@@\n-before\n+first\n*** Update File: duplicate-source.txt\n@@\n-before\n+second\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "target the same canonical path")
      expect(calls).toEqual([])
      expect(yield* readText(target)).toBe("before\n")
    }),
  )

  it.instance("rejects stale existing content after permission approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "stale.txt")
      yield* writeText(target, "before\n")
      const ctx: ToolCtx = {
        ...baseCtx,
        ask: () => writeText(target, "external\n"),
        receipt: makeCtx().ctx.receipt,
      }

      yield* expectFailure(
        execute({ patchText: "*** Begin Patch\n*** Update File: stale.txt\n@@\n-before\n+after\n*** End Patch" }, ctx),
        "changed while waiting for permission",
      )
      expect(yield* readText(target)).toBe("external\n")
    }),
  )

  it.instance("creates additions exclusively after permission approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "created-during-permission.txt")
      const ctx: ToolCtx = {
        ...baseCtx,
        ask: () => writeText(target, "external\n"),
      }

      yield* expectFailure(
        execute(
          { patchText: "*** Begin Patch\n*** Add File: created-during-permission.txt\n+agent\n*** End Patch" },
          ctx,
        ),
        "created while waiting for permission",
      )
      expect(yield* readText(target)).toBe("external\n")
    }),
  )

  it.instance("asks for the canonical external target behind an internal symlink", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const external = yield* Effect.promise(() => fs.mkdtemp(path.join(path.dirname(test.directory), "external-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(external, { recursive: true, force: true })))
      const target = path.join(external, "target.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* writeText(target, "before\n")
      yield* Effect.promise(() => fs.symlink(target, alias))
      const { ctx, calls } = makeCtx()

      yield* execute(
        { patchText: "*** Begin Patch\n*** Update File: alias.txt\n@@\n-before\n+after\n*** End Patch" },
        ctx,
      )

      expect(calls[0]?.permission).toBe("external_directory")
      expect(calls[0]?.patterns).toContain(path.join(external, "*").replaceAll("\\", "/"))
      expect(yield* readText(target)).toBe("after\n")
    }),
  )

  it.instance("serializes edit-style locks against patch permission and commit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mutations = yield* FileMutationState.Service
      const target = path.join(test.directory, "shared.txt")
      yield* writeText(target, "before\n")
      const permissionEntered = yield* Deferred.make<void>()
      const releasePermission = yield* Deferred.make<void>()
      const editEntered = yield* Deferred.make<void>()
      const ctx: ToolCtx = {
        ...baseCtx,
        ask: () =>
          Deferred.succeed(permissionEntered, undefined).pipe(Effect.andThen(Deferred.await(releasePermission))),
        receipt: makeCtx().ctx.receipt,
      }
      const patch = yield* execute(
        { patchText: "*** Begin Patch\n*** Update File: shared.txt\n@@\n-before\n+patch\n*** End Patch" },
        ctx,
      ).pipe(Effect.forkChild)
      yield* Deferred.await(permissionEntered)
      const edit = yield* mutations
        .withLock(target, Deferred.succeed(editEntered, undefined).pipe(Effect.andThen(writeText(target, "edit\n"))))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(editEntered)).toBe(false)

      yield* Deferred.succeed(releasePermission, undefined)
      yield* Fiber.join(patch)
      yield* Fiber.join(edit)
      expect(yield* readText(target)).toBe("edit\n")
    }),
  )

  it.instance("shares the process-global coordinator across V1 and Core runtimes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mutations = yield* FileMutationState.Service
      const filesystem = yield* FSUtil.Service
      const target = yield* mutations.canonical(path.join(test.directory, "shared.txt"))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const coreEntered = yield* Deferred.make<void>()
      const v1 = yield* mutations
        .withLock(target, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const core = yield* FileLockCoordinator.withLocks(
        yield* FileLockCoordinator.keys(filesystem, [target]),
        Deferred.succeed(coreEntered, undefined),
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(coreEntered)).toBe(false)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(v1)
      yield* Fiber.join(core)
      expect(yield* Deferred.isDone(coreEntered)).toBe(true)
    }),
  )

  it.instance("rejects update when target file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

      yield* expectFailure(
        execute({ patchText }, ctx),
        "apply_patch verification failed: Failed to read file to update",
      )
    }),
  )

  it.instance("rejects delete when file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects delete when target is a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const dirPath = path.join(test.directory, "dir")
      yield* makeDir(dirPath)

      const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects invalid hunk header", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
    }),
  )

  it.instance("rejects update with missing context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "line1\nline2\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
      expect(yield* readText(target)).toBe("line1\nline2\n")
    }),
  )

  it.instance("verification failure leaves no side effects", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText =
        "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      yield* expectReadFailure(path.join(test.directory, "created.txt"))
    }),
  )

  it.instance("reports earlier mutations when a later write fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "second.txt")
      yield* writeText(first, "before first\n")
      yield* writeText(second, "before second\n")
      const { ctx } = makeCtx()
      const filesystem = yield* FSUtil.Service
      const failedFilesystem = FSUtil.Service.of({
        ...filesystem,
        writeWithDirs: (target, content, mode) =>
          target === second
            ? Effect.fail(
                new FSUtil.FileSystemError({
                  method: "writeWithDirs",
                  cause: new Error("injected late write failure"),
                }),
              )
            : filesystem.writeWithDirs(target, content, mode),
      })
      const patchText =
        "*** Begin Patch\n*** Update File: first.txt\n@@\n-before first\n+after first\n*** Update File: second.txt\n@@\n-before second\n+after second\n*** End Patch"
      const exit = yield* execute({ patchText }, ctx).pipe(
        Effect.provideService(FSUtil.Service, failedFilesystem),
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("patch was partially applied")
        expect(message).toContain(first)
        expect(message).toContain(second)
        expect(message).toContain("injected late write failure")
      }
      expect(yield* readText(first)).toBe("after first\n")
      expect(yield* readText(second)).toBe("before second\n")
    }),
  )

  it.instance("finishes the sequential commit phase when interrupted after the first mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "second.txt")
      yield* writeText(first, "first\n")
      yield* writeText(second, "second\n")
      const { ctx } = makeCtx()
      const removeStarted = yield* Deferred.make<void>()
      const releaseRemove = yield* Deferred.make<void>()
      const filesystem = yield* FSUtil.Service
      const blockedFilesystem = FSUtil.Service.of({
        ...filesystem,
        remove: (target, options) =>
          target === second
            ? Deferred.succeed(removeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRemove)),
                Effect.andThen(filesystem.remove(target, options)),
              )
            : filesystem.remove(target, options),
      })
      const patchText = "*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"
      const run = yield* execute({ patchText }, ctx).pipe(
        Effect.provideService(FSUtil.Service, blockedFilesystem),
        Effect.forkChild,
      )
      yield* Deferred.await(removeStarted)
      const interrupt = yield* Fiber.interrupt(run).pipe(Effect.forkChild)
      yield* Deferred.succeed(releaseRemove, undefined)
      yield* Fiber.join(interrupt)

      yield* expectReadFailure(first)
      yield* expectReadFailure(second)
    }),
  )

  it.instance("supports end of file anchor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "tail.txt")
      yield* writeText(target, "alpha\nlast\n")

      const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("alpha\nend\n")
    }),
  )

  it.instance("rejects missing second chunk context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "two_chunks.txt")
      yield* writeText(target, "a\nb\nc\nd\n")

      const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      expect(yield* readText(target)).toBe("a\nb\nc\nd\n")
    }),
  )

  it.instance("disambiguates change context with @@ header", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi_ctx.txt")
      yield* writeText(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")

      const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
    }),
  )

  it.instance("EOF anchor matches from end of file first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "eof_anchor.txt")
      // File has duplicate "marker" lines - one in middle, one at end
      yield* writeText(target, "start\nmarker\nmiddle\nmarker\nend\n")

      // With EOF anchor, should match the LAST "marker" line, not the first
      const patchText =
        "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      // First marker unchanged, second marker changed
      expect(yield* readText(target)).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_test.txt"))).toBe("heredoc content\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch without cat", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_no_cat.txt"))).toBe("no cat prefix\n")
    }),
  )

  it.instance("matches with trailing whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_ws.txt")
      // File has trailing spaces on some lines
      yield* writeText(target, "line1  \nline2\nline3   \n")

      // Patch doesn't have trailing spaces - should still match via rstrip pass
      const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("line1  \nchanged\nline3   \n")
    }),
  )

  it.instance("matches with leading whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "leading_ws.txt")
      // File has leading spaces
      yield* writeText(target, "  line1\nline2\n  line3\n")

      // Patch without leading spaces - should match via trim pass
      const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("  line1\nchanged\n  line3\n")
    }),
  )

  it.instance("matches with Unicode punctuation differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "unicode.txt")
      // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
      const leftQuote = "\u201C"
      const rightQuote = "\u201D"
      const emDash = "\u2014"
      yield* writeText(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)

      // Patch uses ASCII equivalents - should match via normalized pass
      // The replacement uses ASCII quotes from the patch (not preserving Unicode)
      const patchText =
        '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

      yield* execute({ patchText }, ctx)
      // Result has ASCII quotes because that's what the patch specifies
      expect(yield* readText(target)).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
    }),
  )
})
