import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import fsNative from "node:fs/promises"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty

      const store = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.node, FSUtil.node]), [
        [Global.node, global],
        [Config.node, configured],
      ])
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(store))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live(
    "captures early and late raw bytes losslessly beyond one MiB with one lazy artifact",
    () =>
      withStore(({ root, store }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const capture = yield* store.capture()
            const early = Buffer.from("EARLY-" + "x".repeat(700_000))
            const late = Buffer.from("y".repeat(700_000) + "-LATE")
            yield* capture.write(early)
            yield* capture.write(late)
            const result = yield* capture.finish()

            expect(result.path).toBeDefined()
            expect(yield* Effect.promise(() => fsNative.readFile(result.path!))).toEqual(Buffer.concat([early, late]))
            expect(result.rawBytes).toBe(early.length + late.length)
            expect(result.displayBytes).toBe(result.rawBytes)
            expect(result.tail.endsWith("-LATE")).toBe(true)
            expect(
              (yield* Effect.promise(() => fsNative.readdir(path.join(root, ToolOutputStore.MANAGED_DIRECTORY))))
                .length,
            ).toBe(1)
            if (result.retain) yield* result.retain()
          }),
        ),
      ),
    15_000,
  )

  it.live("decodes split and invalid UTF-8 safely while preserving exact raw bytes", () =>
    withStore(({ store }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* store.capture()
          const prefix = Buffer.alloc(ToolOutputStore.MAX_BYTES, 0x61)
          const chunks = [prefix, Uint8Array.of(0xe2), Uint8Array.of(0x82, 0xac, 0xff, 0x0a, 0x7a)]
          yield* Effect.forEach(chunks, capture.write, { discard: true })
          const result = yield* capture.finish()

          expect(result.path).toBeDefined()
          expect(yield* Effect.promise(() => fsNative.readFile(result.path!))).toEqual(
            Buffer.concat(chunks.map(Buffer.from)),
          )
          expect(result.tail).toContain("€�\nz")
          expect(Buffer.from(result.tail, "utf8").toString("utf8")).toBe(result.tail)
          expect(result.rawBytes).toBe(prefix.length + 6)
          expect(result.displayBytes).toBe(prefix.length + Buffer.byteLength("€�\nz"))
          expect(result.totalLines).toBe(2)
          if (result.retain) yield* result.retain()
        }),
      ),
    ),
  )

  it.live("bounds a giant logical line with exact ranges", () =>
    withStore(({ store }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* store.capture()
          yield* capture.write(Buffer.from("g".repeat(ToolOutputStore.MAX_BYTES * 3)))
          const result = yield* capture.finish()
          expect(result.totalLines).toBe(1)
          expect(result.startLine).toBe(1)
          expect(result.endLine).toBe(1)
          expect(result.byteLimited).toBe(true)
          expect(result.retainedDisplayBytes).toBe(ToolOutputStore.MAX_BYTES)
          if (result.retain) yield* result.retain()
        }),
      ),
    ),
  )

  it.live("keeps total line count and displayed tail range after capture eviction", () =>
    withStore(({ store }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* store.capture()
          const lines = Array.from({ length: ToolOutputStore.MAX_LINES + 500 }, (_, index) => `line-${index + 1}\n`)
          yield* capture.write(Buffer.from(lines.join("")))
          const result = yield* capture.finish()
          expect(result.totalLines).toBe(ToolOutputStore.MAX_LINES + 500)
          expect(result.startLine).toBeGreaterThan(500)
          expect(result.endLine).toBe(ToolOutputStore.MAX_LINES + 500)
          expect(result.tail).toContain("line-2500")
          if (result.retain) yield* result.retain()
        }),
      ),
    ),
  )

  it.live("removes an unretained capture artifact when discarded", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const capture = yield* store.capture()
        yield* capture.write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1))
        const result = yield* capture.finish()
        expect(result.path).toBeDefined()
        yield* capture.discard()
        expect(yield* fs.exists(result.path!)).toBe(false)
      }),
    ),
  )

  it.live("retains a capture artifact only after explicit settlement ownership", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const capture = yield* store.capture()
        yield* capture.write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1))
        const result = yield* capture.finish()
        if (result.retain) yield* result.retain()
        yield* capture.discard()
        expect(yield* fs.exists(result.path!)).toBe(true)
      }),
    ),
  )

  if (process.platform !== "win32") {
    it.live("creates private managed directories and files", () =>
      withStore(({ root, store }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const capture = yield* store.capture()
            yield* capture.write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1))
            const result = yield* capture.finish()
            expect(
              (yield* Effect.promise(() => fsNative.stat(path.join(root, ToolOutputStore.MANAGED_DIRECTORY)))).mode &
                0o777,
            ).toBe(0o700)
            expect((yield* Effect.promise(() => fsNative.stat(result.path!))).mode & 0o777).toBe(0o600)
            if (result.retain) yield* result.retain()
          }),
        ),
      ),
    )
  }

  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual({
          structured: { kind: "report" },
          content: [
            { type: "text", text: first },
            { type: "text", text: second },
          ],
        })
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual({ truncated: true })
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("retains oversized structured data alongside projected text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const output = {
          structured: { payload: "s".repeat(ToolOutputStore.MAX_BYTES) },
          content: [{ type: "text" as const, text: "summary" }],
        }
        const result = yield* store.bound({ sessionID, toolCallID: "call-structured-text", output })
        expect(result.output.structured).toEqual({ truncated: true })
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(output)
      }),
    ),
  )

  it.live("bounds data URI media and retains the complete output once", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toHaveLength(1)
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("saved to") })
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toMatchObject({
          content: [{ type: "file", uri: `data:image/png;base64,${data}` }],
        })
        expect(
          (yield* Effect.promise(() => fsNative.readdir(path.join(root, ToolOutputStore.MANAGED_DIRECTORY)))).length,
        ).toBe(1)
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toMatchObject({
          content: [{ type: "text", text }, media],
        })
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const store = AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig, [
        [Global.node, Global.layerWith({ data: root.path })],
        [FSUtil.node, blockedFilesystem],
      ])
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
