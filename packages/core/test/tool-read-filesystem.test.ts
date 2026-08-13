import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "path"
import { Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const files = yield* FileSystem.FileSystem
  const directory = yield* files.makeTempDirectoryScoped()
  return { fs, files, directory }
})

describe("ReadToolFileSystem", () => {
  it.effect("fails with a typed filesystem error when a resolved file disappears", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture
      const file = path.join(directory, "missing.txt")

      const error = yield* ReadToolFileSystem.read(fs, file, "missing.txt").pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "PlatformError" })
    }),
  )

  it.effect("fails when a file becomes the wrong path kind", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture

      const error = yield* ReadToolFileSystem.read(fs, directory, "folder").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.PathKindError)
    }),
  )

  it.effect("fails with a typed filesystem error when directory listing fails", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "file.txt")
      yield* files.writeFileString(file, "hello")

      const error = yield* ReadToolFileSystem.list(fs, file).pipe(Effect.flip)

      expect(error).toBeInstanceOf(FSUtil.FileSystemError)
      if (error instanceof FSUtil.FileSystemError) expect(error.method).toBe("readDirectoryEntries")
    }),
  )

  it.effect("reports binary and malformed UTF-8 content as typed errors", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const binary = path.join(directory, "archive.dat")
      const malformed = path.join(directory, "malformed.txt")
      yield* files.writeFile(binary, Uint8Array.of(0, 1, 2, 3))
      const malformedContent = new Uint8Array(64 * 1024 + 1).fill(97)
      malformedContent[64 * 1024] = 0x80
      yield* files.writeFile(malformed, malformedContent)

      const binaryError = yield* ReadToolFileSystem.read(fs, binary, "archive.dat").pipe(Effect.flip)
      const malformedError = yield* ReadToolFileSystem.read(fs, malformed, "malformed.txt").pipe(Effect.flip)

      expect(binaryError).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
      expect(binaryError.message).toBe("Cannot read binary file: archive.dat")
      expect(malformedError).toBeInstanceOf(ReadToolFileSystem.MalformedUtf8Error)
    }),
  )

  it.effect("reports out-of-range pagination as a typed error", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(file, "one\n")

      const error = yield* ReadToolFileSystem.read(fs, file, "short.txt", { offset: 2 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(error.message).toBe("Offset 2 is out of range")
    }),
  )

  it.effect("hashes the complete raw file for a partial text page", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "paged.txt")
      const content = "one\r\ntwo\r\nthree\r\n"
      yield* files.writeFileString(file, content)

      const result = yield* ReadToolFileSystem.readReceipt(fs, file, "paged.txt", { offset: 2, limit: 1 })

      expect(result.value).toMatchObject({ type: "text-page", content: "two", offset: 2, next: 3 })
      expect(result.digest).toBe(createHash("sha256").update(Buffer.from(content)).digest("hex"))
    }),
  )

  it.effect("keeps partial text buffering bounded while hashing the complete file", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "large.txt")
      const chunk = Buffer.from(`${"x".repeat(63)}\n`)
      const repeats = 16_384
      yield* files.writeFile(file, Buffer.concat(Array.from({ length: repeats }, () => chunk)))
      let largestRead = 0
      const controlled = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          fs.open(target, options).pipe(
            Effect.map(
              (handle) =>
                new Proxy(handle, {
                  get: (target, property) => {
                    if (property !== "readAlloc") return Reflect.get(target, property, target)
                    return (size: number) => {
                      largestRead = Math.max(largestRead, size)
                      if (size > 64 * 1024) throw new Error(`read allocation exceeded chunk bound: ${size}`)
                      return handle.readAlloc(size)
                    }
                  },
                }),
            ),
          ),
      })

      const result = yield* ReadToolFileSystem.readReceipt(controlled, file, "large.txt", { limit: 1 })

      expect(result.value).toMatchObject({ type: "text-page", content: "x".repeat(63), next: 2 })
      expect(result.digest).toBe(
        createHash("sha256")
          .update(Buffer.concat(Array.from({ length: repeats }, () => chunk)))
          .digest("hex"),
      )
      expect(largestRead).toBe(64 * 1024)
    }),
  )

  it.effect("keeps rendered output and digest on one opened snapshot during replacement", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "concurrent.txt")
      const replacement = path.join(directory, "replacement.txt")
      const original = `old\n${"a".repeat(128 * 1024)}\n`
      const next = `new\n${"b".repeat(128 * 1024)}\n`
      yield* files.writeFileString(file, original)
      const controlled = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          fs.open(target, options).pipe(
            Effect.map((handle) => {
              let reads = 0
              return new Proxy(handle, {
                get: (target, property) => {
                  if (property !== "readAlloc") return Reflect.get(target, property, target)
                  return (size: number) =>
                    handle.readAlloc(size).pipe(
                      Effect.tap(() => {
                        reads++
                        if (reads !== 1) return Effect.void
                        return files
                          .writeFileString(replacement, next)
                          .pipe(Effect.andThen(files.rename(replacement, file)))
                      }),
                    )
                },
              })
            }),
          ),
      })

      const result = yield* ReadToolFileSystem.readReceipt(controlled, file, "concurrent.txt", { limit: 1 })

      expect(result.value).toMatchObject({ type: "text-page", content: "old" })
      expect(result.digest).toBe(createHash("sha256").update(Buffer.from(original)).digest("hex"))
      expect(yield* files.readFileString(file)).toBe(next)
    }),
  )

  it.effect("rejects malformed or binary trailing bytes beyond the requested page", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const prefix = new TextEncoder().encode("one\n")
      for (const [name, trailing] of [
        ["malformed.txt", 0x80],
        ["nul.txt", 0],
      ] as const) {
        const file = path.join(directory, name)
        yield* files.writeFile(file, Uint8Array.from([...prefix, trailing]))

        const error = yield* ReadToolFileSystem.readReceipt(fs, file, name, { limit: 1 }).pipe(Effect.flip)

        expect(error).toBeInstanceOf(
          trailing === 0 ? ReadToolFileSystem.BinaryFileError : ReadToolFileSystem.MalformedUtf8Error,
        )
      }
    }),
  )

  it.effect("preserves the media ingestion limit message", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "oversized.png")
      yield* files.writeFile(file, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
      yield* files.truncate(file, ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES + 1)

      const error = yield* ReadToolFileSystem.read(fs, file, "oversized.png").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error.message).toBe(
        `Media exceeds ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} byte ingestion limit: oversized.png`,
      )
    }),
  )
})
