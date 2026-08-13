import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileMutationState } from "@/tool/file-mutation-state"

const receipt = (initial?: Uint8Array) => {
  const state = { digest: initial ? new Bun.CryptoHasher("sha256").update(initial).digest("hex") : undefined }
  return {
    state,
    channel: {
      match: (input: { digest: string }) => Effect.succeed(state.digest === input.digest),
      invalidate: () => Effect.sync(() => void (state.digest = undefined)),
      settle: (input: { digest: string }) => Effect.sync(() => void (state.digest = input.digest)),
      pending: () => undefined,
    },
  }
}

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  receipt: {
    match: () => Effect.succeed(true),
    invalidate: () => Effect.void,
    settle: () => Effect.void,
    pending: () => undefined,
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    LSP.node,
    FSUtil.node,
    Format.node,
    EventV2Bridge.node,
    Truncate.node,
    Agent.node,
    FileMutationState.node,
  ]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const failWithContext = Effect.fn("EditToolTest.failWithContext")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("read receipts", () => {
    it.instance("fails closed when the internal receipt channel is unavailable", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unavailable.txt")
        yield* put(filepath, "one")

        expect(
          (yield* failWithContext(
            { filePath: filepath, oldString: "one", newString: "two" },
            { ...ctx, receipt: undefined },
          )).message,
        ).toContain("receipt channel is unavailable")
        expect(yield* load(filepath)).toBe("one")
      }),
    )

    it.instance("rejects missing and stale receipts and refreshes a successful mutation", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "receipt.txt")
        yield* put(filepath, "one")
        const tracked = receipt()
        const next = { ...ctx, receipt: tracked.channel }

        expect(
          (yield* failWithContext({ filePath: filepath, oldString: "one", newString: "two" }, next)).message,
        ).toContain("has not been read")
        tracked.state.digest = new Bun.CryptoHasher("sha256").update("one").digest("hex")
        yield* put(filepath, "external")
        expect(
          (yield* failWithContext({ filePath: filepath, oldString: "external", newString: "two" }, next)).message,
        ).toContain("changed since")
        tracked.state.digest = new Bun.CryptoHasher("sha256").update("external").digest("hex")
        yield* run({ filePath: filepath, oldString: "external", newString: "two" }, next)
        expect(tracked.state.digest).toBe(new Bun.CryptoHasher("sha256").update("two").digest("hex"))
      }),
    )

    it.instance("canonicalizes existing symlink aliases", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "target.txt")
        const alias = path.join(test.directory, "alias.txt")
        yield* put(filepath, "one")
        yield* Effect.promise(() => fs.symlink(filepath, alias))
        const tracked = receipt(Buffer.from("one"))
        yield* run({ filePath: alias, oldString: "one", newString: "two" }, { ...ctx, receipt: tracked.channel })
        expect(yield* load(filepath)).toBe("two")
      }),
    )

    it.instance("revalidates the bytes after permission approval", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "permission-race.txt")
        yield* put(filepath, "one")
        const tracked = receipt(Buffer.from("one"))
        const error = yield* failWithContext(
          { filePath: filepath, oldString: "one", newString: "two" },
          {
            ...ctx,
            receipt: tracked.channel,
            ask: () => Effect.promise(() => fs.writeFile(filepath, "external")),
          },
        )

        expect(error.message).toContain("changed while waiting for permission")
        expect(yield* load(filepath)).toBe("external")
      }),
    )

    it.instance("rejects malformed UTF-8 without permission or mutation", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "malformed.txt")
        const bytes = Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0xff]), Buffer.from("editable")])
        yield* Effect.promise(() => fs.writeFile(filepath, bytes))
        const tracked = receipt(bytes)
        let asked = false

        expect(
          (yield* failWithContext(
            { filePath: filepath, oldString: "editable", newString: "changed" },
            { ...ctx, receipt: tracked.channel, ask: () => Effect.sync(() => void (asked = true)) },
          )).message,
        ).toContain("malformed UTF-8")
        expect(asked).toBeFalse()
        expect(Buffer.compare(yield* Effect.promise(() => fs.readFile(filepath)), bytes)).toBe(0)
      }),
    )

    it.instance("creates new files exclusively after permission approval", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "creation-race.txt")
        const error = yield* failWithContext(
          { filePath: filepath, oldString: "", newString: "agent" },
          {
            ...ctx,
            ask: () => Effect.promise(() => fs.writeFile(filepath, "external")),
          },
        )

        expect(error.message).toContain("created while waiting for permission")
        expect(yield* load(filepath)).toBe("external")
      }),
    )
  })

  describe("batch edits", () => {
    it.instance("matches every entry against the original snapshot", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "batch.txt")
        yield* put(filepath, "alpha beta gamma")
        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "alpha", newString: "beta" },
            { oldString: "beta", newString: "delta" },
          ],
        })
        expect(yield* load(filepath)).toBe("beta delta gamma")
      }),
    )

    it.instance("reports indexed ambiguity and leaves the file unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "ambiguous.txt")
        yield* put(filepath, "same x same")
        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: "x", newString: "y" },
            { oldString: "same", newString: "other" },
          ],
        })
        expect(error.message).toContain("edits[1]")
        expect(error.message).toContain("multiple matches")
        expect(yield* load(filepath)).toBe("same x same")
      }),
    )

    it.instance("rejects distinct unique candidates produced by fuzzy matchers", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fuzzy-ambiguous.txt")
        yield* put(filepath, "target value\ntarget    value")
        const error = yield* fail({
          filePath: filepath,
          edits: [{ oldString: "target\tvalue", newString: "changed" }],
        })

        expect(error.message).toContain("multiple fuzzy matches")
        expect(yield* load(filepath)).toBe("target value\ntarget    value")
      }),
    )

    it.instance("rejects equally plausible block-anchor candidates", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "block-ambiguous.txt")
        yield* put(filepath, "start\nactual abd\nend\nnoise\nstart\nactual abe\nend\n")
        const error = yield* fail({
          filePath: filepath,
          edits: [{ oldString: "start\nactual abf\nend", newString: "changed" }],
        })

        expect(error.message).toContain("multiple fuzzy matches")
        expect(yield* load(filepath)).toBe("start\nactual abd\nend\nnoise\nstart\nactual abe\nend\n")
      }),
    )

    it.instance("rejects overlapping entries before writing", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "overlap.txt")
        yield* put(filepath, "abcdef")
        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: "abcd", newString: "x" },
            { oldString: "cdef", newString: "y" },
          ],
        })
        expect(error.message).toContain("edits[1]")
        expect(error.message).toContain("overlaps edits[0]")
        expect(yield* load(filepath)).toBe("abcdef")
      }),
    )

    it.instance("preserves BOM and CRLF across a batch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "batch.cs")
        yield* put(filepath, "\uFEFFone\r\ntwo\r\n")
        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "one\n", newString: "first\n" },
            { oldString: "two", newString: "second" },
          ],
        })
        expect(yield* Effect.promise(() => fs.readFile(filepath))).toEqual(Buffer.from("\uFEFFfirst\r\nsecond\r\n"))
      }),
    )
  })
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("retains the lock across post-hook and durable publication settlement", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "settlement.txt")
        yield* put(filepath, "one")
        const pending = {
          value: undefined as
            | { canonicalPath: string; digest: string; release?: () => Effect.Effect<void> }
            | undefined,
        }
        const channel = {
          match: (input: { digest: string }) =>
            Effect.succeed(input.digest === new Bun.CryptoHasher("sha256").update(yieldDigest()).digest("hex")),
          invalidate: () => Effect.void,
          settle: (input: NonNullable<typeof pending.value>) => Effect.sync(() => void (pending.value = input)),
          pending: () => pending.value,
        }
        const yieldDigest = () => (pending.value ? "two" : "one")
        yield* run({ filePath: filepath, oldString: "one", newString: "two" }, { ...ctx, receipt: channel })
        const secondAsked = yield* Deferred.make<void>()
        const second = yield* run(
          { filePath: filepath, oldString: "two", newString: "three" },
          { ...ctx, receipt: channel, ask: () => Deferred.succeed(secondAsked, undefined) },
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(secondAsked)).toBeFalse()

        yield* pending.value!.release!()
        yield* Deferred.await(secondAsked)
        yield* Fiber.join(second)
        yield* pending.value!.release!()
        expect(yield* load(filepath)).toBe("three")
      }),
    )

    it.instance("releases an interrupted mutation before settlement", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "interrupted.txt")
        yield* put(filepath, "one")
        const entered = yield* Deferred.make<void>()
        const interrupted = yield* run(
          { filePath: filepath, oldString: "one", newString: "two" },
          {
            ...ctx,
            ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(interrupted)

        yield* run({ filePath: filepath, oldString: "one", newString: "three" })
        expect(yield* load(filepath)).toBe("three")
      }),
    )

    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})
