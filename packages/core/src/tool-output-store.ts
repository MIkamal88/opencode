export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { open, type FileHandle } from "node:fs/promises"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@opencode-ai/llm"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)
export const MANAGED_DIRECTORY = "tool-output"

export interface ManagedOutput {
  readonly path?: string
  readonly tail: string
  readonly rawBytes: number
  readonly displayBytes: number
  readonly totalLines: number
  readonly retainedDisplayBytes: number
  readonly startLine: number
  readonly endLine: number
  readonly byteLimited: boolean
  readonly retain?: () => Effect.Effect<void>
  readonly discard?: () => Effect.Effect<void>
}

export interface Capture {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, StorageError>
  readonly finish: () => Effect.Effect<ManagedOutput, StorageError>
  readonly discard: () => Effect.Effect<void>
}

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
  readonly managedOutput?: ManagedOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
  readonly retain?: () => Effect.Effect<void>
  readonly discard?: () => Effect.Effect<void>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "open", "write", "flush", "close"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly capture: () => Effect.Effect<Capture, StorageError>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const logicalLines = (text: string) => {
  if (!text) return 0
  const newlines = text.split("\n").length - 1
  return newlines + (text.endsWith("\n") ? 0 : 1)
}

const tail = (text: string, totalLines: number, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  const selected = lines.slice(Math.max(0, lines.length - maxLines)).join("\n") + (text.endsWith("\n") ? "\n" : "")
  const byteLimited = Buffer.byteLength(selected) > maxBytes
  const value = byteLimited ? takeSuffix(selected, maxBytes) : selected
  const retainedLines = logicalLines(value)
  return {
    value,
    retainedDisplayBytes: Buffer.byteLength(value),
    startLine: retainedLines === 0 ? 0 : Math.max(1, totalLines - retainedLines + 1),
    endLine: totalLines,
    byteLimited,
  }
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled) <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  return {
    head: takePrefix(sampled, Math.ceil(maxBytes / 2)),
    tail: takeSuffix(sampled, Math.floor(maxBytes / 2)),
  }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker)
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const create = Effect.fn("ToolOutputStore.create")(function* () {
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "open", cause })))
      if (process.platform !== "win32")
        yield* fs
          .chmod(directory, 0o700)
          .pipe(Effect.mapError((cause) => new StorageError({ operation: "open", cause })))
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      const handle = yield* Effect.tryPromise({
        try: () => open(file, "wx", 0o600),
        catch: (cause) => new StorageError({ operation: "open", cause }),
      })
      return { file, handle }
    })

    const capture = Effect.fn("ToolOutputStore.capture")(function* () {
      const outputLimits = yield* limits()
      const decoder = new TextDecoder()
      const pending: Uint8Array[] = []
      let handle: FileHandle | undefined
      let outputPath: string | undefined
      let display = ""
      let rawBytes = 0
      let displayBytes = 0
      let newlines = 0
      let lastByte: number | undefined
      let finished: ManagedOutput | undefined
      let retained = false

      const close = Effect.fnUntraced(function* () {
        const current = handle
        if (!current) return
        yield* Effect.tryPromise({
          try: () => current.close(),
          catch: (cause) => new StorageError({ operation: "close", cause }),
        })
        handle = undefined
      })
      const discard = Effect.fn("ToolOutputStore.capture.discard")(function* () {
        yield* close().pipe(Effect.ignore)
        if (retained || !outputPath) return
        yield* fs.remove(outputPath).pipe(Effect.ignore)
        outputPath = undefined
      })

      const promote = Effect.fnUntraced(function* () {
        if (handle) return
        const created = yield* create()
        handle = created.handle
        outputPath = created.file
        for (const chunk of pending)
          yield* Effect.tryPromise({
            try: () => created.handle.writeFile(chunk),
            catch: (cause) => new StorageError({ operation: "write", cause }),
          })
        pending.length = 0
      })

      const appendDisplay = (text: string) => {
        if (!text) return
        displayBytes += Buffer.byteLength(text)
        display = takeSuffix(display + text, outputLimits.maxBytes * 2)
      }

      const write = Effect.fn("ToolOutputStore.capture.write")(function* (bytes: Uint8Array) {
        if (finished) return yield* new StorageError({ operation: "write", cause: new Error("Capture is finished") })
        const copy = bytes.slice()
        rawBytes += copy.byteLength
        for (const byte of copy) if (byte === 0x0a) newlines++
        if (copy.length > 0) lastByte = copy[copy.length - 1]
        appendDisplay(decoder.decode(copy, { stream: true }))
        const totalLines = rawBytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1)
        const retained = !handle
        if (retained) pending.push(copy)
        if (
          !handle &&
          (rawBytes > outputLimits.maxBytes ||
            displayBytes > outputLimits.maxBytes ||
            totalLines > outputLimits.maxLines)
        )
          yield* promote()
        if (handle && !retained)
          yield* Effect.tryPromise({
            try: () => handle!.writeFile(copy),
            catch: (cause) => new StorageError({ operation: "write", cause }),
          })
      })

      const finish = Effect.fn("ToolOutputStore.capture.finish")(function* () {
        if (finished) return finished
        appendDisplay(decoder.decode())
        const totalLines = rawBytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1)
        if (
          !handle &&
          (rawBytes > outputLimits.maxBytes ||
            displayBytes > outputLimits.maxBytes ||
            totalLines > outputLimits.maxLines)
        )
          yield* promote()
        if (handle)
          yield* Effect.tryPromise({
            try: () => handle!.sync(),
            catch: (cause) => new StorageError({ operation: "flush", cause }),
          })
        yield* close()
        const bounded = tail(display, totalLines, outputLimits.maxLines, outputLimits.maxBytes)
        finished = {
          ...(outputPath ? { path: outputPath } : {}),
          tail: bounded.value,
          rawBytes,
          displayBytes,
          totalLines,
          retainedDisplayBytes: bounded.retainedDisplayBytes,
          startLine: bounded.startLine,
          endLine: bounded.endLine,
          byteLimited: bounded.byteLimited || displayBytes > Buffer.byteLength(display),
          ...(outputPath
            ? {
                retain: () =>
                  Effect.sync(() => {
                    retained = true
                  }),
                discard,
              }
            : {}),
        }
        return finished
      })

      return { write, finish, discard }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string) {
      const created = yield* create()
      yield* Effect.acquireUseRelease(
        Effect.succeed(created.handle),
        (handle) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => handle.writeFile(content),
              catch: (cause) => new StorageError({ operation: "write", cause }),
            })
            yield* Effect.tryPromise({
              try: () => handle.sync(),
              catch: (cause) => new StorageError({ operation: "flush", cause }),
            })
          }),
        (handle) =>
          Effect.tryPromise({
            try: () => handle.close(),
            catch: () => undefined,
          }).pipe(Effect.ignore),
      ).pipe(Effect.onError(() => fs.remove(created.file).pipe(Effect.ignore)))
      return created.file
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const structured = yield* Effect.option(
        Effect.try({
          try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
          catch: (cause) => new StorageError({ operation: "encode", cause }),
        }),
      )
      const contextual =
        input.output.content.length === 0
          ? Option.getOrElse(structured, () => String(input.output.structured))
          : text.map((item) => item.text).join("")
      const projectedStructured =
        Option.isSome(structured) && text.length > 0 && text.every((item) => structured.value.includes(item.text))
      const contentBytes = input.output.content.reduce(
        (total, item) => total + Buffer.byteLength(item.type === "text" ? item.text : item.uri),
        0,
      )
      const totalBytes =
        contentBytes + (projectedStructured || Option.isNone(structured) ? 0 : Buffer.byteLength(structured.value))
      if (logicalLines(contextual) <= outputLimits.maxLines && totalBytes <= outputLimits.maxBytes)
        return {
          output: input.output,
          outputPaths: input.managedOutput?.path ? [input.managedOutput.path] : [],
          ...(input.managedOutput?.retain ? { retain: input.managedOutput.retain } : {}),
          ...(input.managedOutput?.discard ? { discard: input.managedOutput.discard } : {}),
        }

      const complete =
        media.length > 0 || (text.length > 0 && !projectedStructured && Option.isSome(structured))
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : contextual
      const outputPath = input.managedOutput?.path ?? (yield* write(complete))
      const marker = `... output truncated; full content saved to ${outputPath} ...`
      const discard = input.managedOutput?.discard ?? (() => fs.remove(outputPath).pipe(Effect.ignore))
      return {
        output: {
          structured:
            Option.isSome(structured) && Buffer.byteLength(structured.value) > outputLimits.maxBytes
              ? { truncated: true }
              : input.output.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
          ],
        },
        outputPaths: [outputPath],
        retain: input.managedOutput?.retain ?? (() => Effect.void),
        discard,
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, capture, bound, cleanup })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })
export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
