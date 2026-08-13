import { Effect, Schema, Scope } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import { FileMutationState } from "./file-mutation-state"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | FileMutationState.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope
    const mutations = yield* FileMutationState.Service

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // LSP warm-up is optional; do not let a background defect fail an otherwise successful read.
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readFile = Effect.fn("ReadTool.readFile")(function* (
      filepath: string,
      opts: { limit: number; offset: number },
    ) {
      const raw: string[] = []
      const mediaChunks: Uint8Array[] = []
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let mediaMime: string | undefined
      let first = true
      let pending = ""
      let discard = false
      let count = 0
      let bytes = 0
      let cut = false
      let nonPrintable = 0
      let total = 0
      const append = (value: string) => {
        count++
        if (count < opts.offset || raw.length >= opts.limit || cut) return
        const line = value.length > MAX_LINE_LENGTH ? value.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : value
        const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          cut = true
          return
        }
        raw.push(line)
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
      const decoded = yield* mutations.read(
        filepath,
        Effect.fnUntraced(function* (chunk) {
          if (first) {
            first = false
            const mime = sniffAttachmentMime(chunk.subarray(0, SAMPLE_BYTES), FSUtil.mimeType(filepath))
            if (SUPPORTED_IMAGE_MIMES.has(mime) || isPdfAttachment(mime)) mediaMime = mime
            else if (isBinaryFile(filepath, chunk.subarray(0, SAMPLE_BYTES)))
              return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
          }
          total += chunk.length
          if (mediaMime) {
            if (total > MAX_MEDIA_INGEST_BYTES) {
              return yield* Effect.fail(
                new Error(`Media exceeds ${MAX_MEDIA_INGEST_BYTES} byte ingestion limit: ${filepath}`),
              )
            }
            mediaChunks.push(chunk)
            return
          }
          for (const byte of chunk) {
            if (byte === 0) return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
            if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
          }
          try {
            consume(decoder.decode(chunk, { stream: true }))
          } catch (error) {
            return yield* Effect.fail(
              new Error("File contains malformed UTF-8 and cannot be safely edited.", { cause: error }),
            )
          }
          return
        }),
      )
      if (first && isBinaryFile(filepath, new Uint8Array()))
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      if (mediaMime) {
        return {
          type: "media" as const,
          mime: mediaMime,
          content: Buffer.concat(
            mediaChunks.map((chunk) => Buffer.from(chunk)),
            total,
          ),
          digest: decoded.digest,
        }
      }
      try {
        consume(decoder.decode())
      } catch (error) {
        return yield* Effect.fail(
          new Error("File contains malformed UTF-8 and cannot be safely edited.", { cause: error }),
        )
      }
      if (pending || discard) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
      if (total > 0 && nonPrintable / total > 0.3)
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      return {
        type: "text" as const,
        raw,
        count,
        cut,
        more: cut || count > opts.offset - 1 + raw.length,
        offset: opts.offset,
        digest: decoded.digest,
      }
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }
      const title = path.relative(instance.worktree, filepath)

      const initialStat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      const authorizedPath = yield* mutations.canonical(filepath)

      yield* assertExternalDirectoryEffect(ctx, authorizedPath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: initialStat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      const canonicalPath = yield* mutations.canonical(filepath)
      if (canonicalPath !== authorizedPath) {
        yield* assertExternalDirectoryEffect(ctx, canonicalPath, {
          bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
          kind: initialStat?.type === "Directory" ? "directory" : "file",
        })
      }
      const stat = yield* fs.stat(canonicalPath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )
      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        return yield* mutations.withLock(
          canonicalPath,
          Effect.gen(function* () {
            const checked = yield* mutations.canonical(filepath)
            if (checked !== canonicalPath) {
              yield* assertExternalDirectoryEffect(ctx, checked, {
                bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
                kind: "directory",
              })
              return yield* Effect.fail(new Error(`Directory ${filepath} was redirected while waiting for permission.`))
            }
            const items = yield* list(canonicalPath)
            const limit = params.limit ?? DEFAULT_READ_LIMIT
            const offset = params.offset || 1
            const start = offset - 1
            const sliced = items.slice(start, start + limit)
            const truncated = start + sliced.length < items.length

            return {
              title,
              output: [
                `<path>${filepath}</path>`,
                `<type>directory</type>`,
                `<entries>`,
                sliced.join("\n"),
                truncated
                  ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
                  : `\n(${items.length} entries)`,
                `</entries>`,
              ].join("\n"),
              metadata: {
                preview: sliced.slice(0, 20).join("\n"),
                truncated,
                loaded: [] as string[],
                display: {
                  type: "directory" as const,
                  path: filepath,
                  entries: sliced,
                  offset,
                  totalEntries: items.length,
                  truncated,
                },
              },
            }
          }),
        )
      }

      return yield* mutations.withLock(
        canonicalPath,
        Effect.gen(function* () {
          const checked = yield* mutations.canonical(filepath)
          if (checked !== canonicalPath) {
            yield* assertExternalDirectoryEffect(ctx, checked, {
              bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            })
            return yield* Effect.fail(new Error(`File ${filepath} was redirected while waiting for permission.`))
          }
          const loaded = yield* instruction.resolve(ctx.messages, canonicalPath, ctx.messageID)
          const file = yield* readFile(canonicalPath, {
            limit: params.limit ?? DEFAULT_READ_LIMIT,
            offset: params.offset || 1,
          })
          if (file.type === "media") {
            const msg = isPdfAttachment(file.mime) ? "PDF read successfully" : "Image read successfully"
            if (ctx.receipt) yield* ctx.receipt.settle({ canonicalPath, digest: file.digest })
            return {
              title,
              output: msg,
              metadata: {
                preview: msg,
                truncated: false,
                loaded: loaded.map((item) => item.filepath),
              },
              attachments: [
                {
                  type: "file" as const,
                  mime: file.mime,
                  url: `data:${file.mime};base64,${file.content.toString("base64")}`,
                },
              ],
            }
          }
          if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
            return yield* Effect.fail(
              new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
            )
          }

          let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
          output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

          const last = file.offset + file.raw.length - 1
          const next = last + 1
          const truncated = file.more || file.cut
          if (file.cut) {
            output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
          } else if (file.more) {
            output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
          } else {
            output += `\n\n(End of file - total ${file.count} lines)`
          }
          output += "\n</content>"

          yield* warm(canonicalPath)

          if (loaded.length > 0) {
            output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
          }

          if (ctx.receipt) yield* ctx.receipt.settle({ canonicalPath, digest: file.digest })
          return {
            title,
            output,
            metadata: {
              preview: file.raw.slice(0, 20).join("\n"),
              truncated,
              loaded: loaded.map((item) => item.filepath),
              display: {
                type: "file" as const,
                path: filepath,
                text: file.raw.join("\n"),
                lineStart: file.offset,
                lineEnd: last,
                totalLines: file.count,
                truncated,
              },
            },
          }
        }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
