export * as ReadToolFileSystem from "./read-filesystem"

import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { makeLocationNode } from "../effect/app-node"
import { AbsolutePath, PositiveInt, RelativePath } from "../schema"
import { createHash } from "node:crypto"

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

export class BinaryFileError extends Schema.TaggedErrorClass<BinaryFileError>()("ReadTool.BinaryFileError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Cannot read binary file: ${this.resource}`
  }
}

export class MediaIngestLimitError extends Schema.TaggedErrorClass<MediaIngestLimitError>()(
  "ReadTool.MediaIngestLimitError",
  {
    resource: Schema.String,
    maximumBytes: Schema.Number,
  },
) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.resource}`
  }
}

export class MalformedUtf8Error extends Schema.TaggedErrorClass<MalformedUtf8Error>()("ReadTool.MalformedUtf8Error", {
  resource: Schema.String,
}) {
  override get message() {
    return `File is not valid UTF-8: ${this.resource}`
  }
}

export class OffsetOutOfRangeError extends Schema.TaggedErrorClass<OffsetOutOfRangeError>()(
  "ReadTool.OffsetOutOfRangeError",
  { offset: Schema.Number },
) {
  override get message() {
    return `Offset ${this.offset} is out of range`
  }
}

export class PathKindError extends Schema.TaggedErrorClass<PathKindError>()("ReadTool.PathKindError", {
  resource: Schema.String,
  expected: Schema.Literals(["a file", "a file or directory"]),
}) {
  override get message() {
    return `Path is not ${this.expected}: ${this.resource}`
  }
}

export type InspectError = FSUtil.Error | PathKindError
export type ReadError =
  | FSUtil.Error
  | BinaryFileError
  | MediaIngestLimitError
  | MalformedUtf8Error
  | OffsetOutOfRangeError
  | PathKindError

export const PageInput = Schema.Struct({
  offset: PositiveInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_READ_LINES)).pipe(Schema.optional),
})
export type PageInput = typeof PageInput.Type

export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: PositiveInt,
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
}) {}

export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly inspect: (path: AbsolutePath) => Effect.Effect<"file" | "directory", InspectError>
  readonly read: (
    path: AbsolutePath,
    resource: string,
    page?: PageInput,
  ) => Effect.Effect<FileSystem.Content | TextPage, ReadError>
  readonly readReceipt: (path: AbsolutePath, resource: string, page?: PageInput) => Effect.Effect<ReadResult, ReadError>
  readonly list: (path: AbsolutePath, page?: PageInput) => Effect.Effect<ListPage, FSUtil.Error>
}

export interface ReadResult {
  readonly value: FileSystem.Content | TextPage
  readonly digest: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReadToolFileSystem") {}

const extensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
const imageMime = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
}
const decodeUtf8 = (resource: string, decoder: TextDecoder, bytes?: Uint8Array) =>
  Effect.try({
    try: () => decoder.decode(bytes, { stream: bytes !== undefined }),
    catch: (error) => {
      if (error instanceof TypeError) return new MalformedUtf8Error({ resource })
      throw error
    },
  })
export const inspect = Effect.fn("ReadTool.inspect")(function* (fs: FSUtil.Interface, input: string) {
  const info = yield* fs.stat(input)
  const type = info.type === "File" ? "file" : info.type === "Directory" ? "directory" : undefined
  if (!type) return yield* Effect.fail(new PathKindError({ resource: input, expected: "a file or directory" }))
  return type
})

export const readReceipt = Effect.fn("ReadTool.readReceipt")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: PageInput = {},
) {
  const real = yield* fs.realPath(input)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(real, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") return yield* Effect.fail(new PathKindError({ resource, expected: "a file" }))
      const first = Option.getOrElse(yield* file.readAlloc(READ_CHUNK_BYTES), () => new Uint8Array())
      const mime = imageMime(first)
      if (mime) {
        if (info.size > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        const chunks: Uint8Array[] = []
        const hasher = createHash("sha256")
        let total = 0
        const retain = (chunk: Uint8Array) => {
          total += chunk.length
          if (total > MAX_MEDIA_INGEST_BYTES) return false
          hasher.update(chunk)
          chunks.push(chunk)
          return true
        }
        if (!retain(first))
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        while (true) {
          const chunk = yield* file.readAlloc(READ_CHUNK_BYTES)
          if (Option.isNone(chunk)) break
          if (retain(chunk.value)) continue
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        }
        return {
          value: {
            uri: pathToFileURL(real).href,
            name: path.basename(real),
            content: Buffer.concat(
              chunks.map((chunk) => Buffer.from(chunk)),
              total,
            ).toString("base64"),
            encoding: "base64" as const,
            mime,
          },
          digest: hasher.digest("hex"),
        }
      }
      if (startsWith(first, [0x25, 0x50, 0x44, 0x46]) || extensions.has(path.extname(resource).toLowerCase()))
        return yield* Effect.fail(new BinaryFileError({ resource }))
      const paged = info.size > MAX_READ_BYTES || page.offset !== undefined || page.limit !== undefined
      const offset = page.offset ?? 1
      const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const lines: string[] = []
      const decoder = new TextDecoder("utf-8", { fatal: true })
      const content: string[] = []
      const hasher = createHash("sha256")
      let collect = !paged
      let pending = ""
      let discard = false
      let line = 0
      let bytes = 0
      let total = 0
      let nonPrintable = 0
      let cut = false
      const append = (input: string) => {
        line++
        if (line < offset || lines.length >= limit || cut) return
        const text = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : input
        const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
        if (bytes + size > MAX_READ_BYTES) {
          cut = true
          return
        }
        lines.push(text)
        bytes += size
      }
      const consume = (input: string) => {
        let text = input
        while (true) {
          const index = text.indexOf("\n")
          if (index === -1) {
            if (!discard) {
              pending += text
              if (pending.length > MAX_LINE_LENGTH) {
                pending = pending.slice(0, MAX_LINE_LENGTH + 1)
                discard = true
              }
            }
            break
          }
          const current = pending + (discard ? "" : text.slice(0, index))
          pending = ""
          discard = false
          text = text.slice(index + 1)
          append(current.endsWith("\r") ? current.slice(0, -1) : current)
        }
      }
      const consumeChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
        hasher.update(chunk)
        total += chunk.length
        for (const byte of chunk) {
          if (byte === 0) return yield* Effect.fail(new BinaryFileError({ resource }))
          if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
        }
        const text = yield* decodeUtf8(resource, decoder, chunk)
        if (collect && total <= MAX_READ_BYTES) content.push(text)
        else if (collect) {
          collect = false
          content.length = 0
        }
        consume(text)
        return
      })
      yield* consumeChunk(first)
      while (true) {
        const chunk = yield* file.readAlloc(READ_CHUNK_BYTES)
        if (Option.isNone(chunk)) break
        yield* consumeChunk(chunk.value)
      }
      const tail = yield* decodeUtf8(resource, decoder)
      if (collect) content.push(tail)
      consume(tail)
      if (pending || discard) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
      if (total > 0 && nonPrintable / total > 0.3) return yield* Effect.fail(new BinaryFileError({ resource }))
      const digest = hasher.digest("hex")
      if (!paged && collect) {
        return {
          value: {
            uri: pathToFileURL(real).href,
            name: path.basename(real),
            content: content.join(""),
            encoding: "utf8" as const,
            mime: FSUtil.mimeType(real),
          },
          digest,
        }
      }
      if (line < offset && !(line === 0 && offset === 1))
        return yield* Effect.fail(new OffsetOutOfRangeError({ offset }))
      const next = cut || line > offset - 1 + lines.length ? offset + lines.length : undefined
      return {
        value: new TextPage({
          type: "text-page",
          content: lines.join("\n"),
          mime: FSUtil.mimeType(real),
          offset,
          truncated: next !== undefined,
          ...(next === undefined ? {} : { next }),
        }),
        digest,
      }
    }),
  )
})

export const read = Effect.fn("ReadTool.read")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: PageInput = {},
) {
  return (yield* readReceipt(fs, input, resource, page)).value
})

export const list = Effect.fn("ReadTool.list")(function* (fs: FSUtil.Interface, input: string, page: PageInput = {}) {
  const real = yield* fs.realPath(input)
  const items = yield* fs.readDirectoryEntries(real)
  const offset = page.offset ?? 1
  const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
  const entries = yield* Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        const absolute = path.join(real, item.name)
        const target = yield* fs.realPath(absolute).pipe(Effect.catch(() => Effect.void))
        if (!target || !FSUtil.contains(real, target)) return
        const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.void))
        const type = info?.type === "Directory" ? "directory" : info?.type === "File" ? "file" : undefined
        if (!type) return
        return FileSystem.Entry.make({
          path: RelativePath.make(item.name + (type === "directory" ? path.sep : "")),
          type,
        })
      }),
    { concurrency: 16 },
  )
  const visible = entries
    .filter((item): item is FileSystem.Entry => item !== undefined)
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < visible.length
  return new ListPage({ entries: selected, truncated, ...(truncated ? { next: offset + selected.length } : {}) })
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return Service.of({
      inspect: (path) => inspect(fs, path),
      read: (path, resource, page) => read(fs, path, resource, page),
      readReceipt: (path, resource, page) => readReceipt(fs, path, resource, page),
      list: (path, page) => list(fs, path, page),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })
