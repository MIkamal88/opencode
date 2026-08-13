import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { FileMutationState } from "./file-mutation-state"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const mutations = yield* FileMutationState.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const requestedPath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          const filepath = yield* mutations.canonical(requestedPath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const lease = yield* restore(mutations.acquireLock(filepath))
              return yield* restore(
                Effect.gen(function* () {
                  const exists = yield* fs.existsSafe(filepath)
                  const original = exists ? yield* mutations.snapshot(filepath) : undefined
                  const source = original
                    ? Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(original.content))
                    : { bom: false, text: "" }
                  const digest = original && mutations.digest(original.content)
                  const receipt = ctx.receipt
                  if (digest !== undefined) {
                    if (!receipt) throw new Error("The internal read receipt channel is unavailable.")
                    if (!(yield* receipt.match({ canonicalPath: filepath, digest }))) {
                      throw new Error(
                        `File ${filepath} has not been read in this session or has changed since it was read. Read it again before overwriting.`,
                      )
                    }
                  }
                  const next = Bom.split(params.content)
                  const desiredBom = source.bom || next.bom
                  const contentOld = source.text
                  const contentNew = next.text

                  const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
                  yield* ctx.ask({
                    permission: "edit",
                    patterns: [path.relative(instance.worktree, filepath)],
                    always: ["*"],
                    metadata: {
                      filepath,
                      diff,
                    },
                  })

                  const authorizedPath = yield* mutations.canonical(requestedPath)
                  if (authorizedPath !== filepath) {
                    throw new Error(
                      `File ${filepath} was created or redirected while waiting for permission. Read it before overwriting.`,
                    )
                  }
                  if (original && digest !== undefined) {
                    const checked = yield* mutations.snapshot(filepath)
                    if (!mutations.sameIdentity(original, checked) || mutations.digest(checked.content) !== digest) {
                      throw new Error(
                        `File ${filepath} changed while waiting for permission. Read it again before overwriting.`,
                      )
                    }
                    yield* receipt!.invalidate({ canonicalPath: filepath })
                    yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
                  } else {
                    const write = fs.writeFileString(filepath, Bom.join(contentNew, desiredBom), { flag: "wx" })
                    yield* write.pipe(
                      Effect.catchReason("PlatformError", "NotFound", () =>
                        fs.ensureDir(path.dirname(filepath)).pipe(Effect.andThen(write)),
                      ),
                      Effect.catchReason("PlatformError", "AlreadyExists", () =>
                        Effect.fail(
                          new Error(
                            `File ${filepath} was created while waiting for permission. Read it before overwriting.`,
                          ),
                        ),
                      ),
                    )
                  }
                  if (yield* format.file(filepath)) {
                    yield* Bom.syncFile(fs, filepath, desiredBom)
                  }
                  yield* events.publish(FileSystem.Event.Edited, { file: filepath })
                  yield* events.publish(Watcher.Event.Updated, {
                    file: filepath,
                    event: exists ? "change" : "add",
                  })

                  let output = "Wrote file successfully."
                  yield* lsp.touchFile(filepath, "document")
                  const diagnostics = yield* lsp.diagnostics()
                  const normalizedFilepath = FSUtil.normalizePath(filepath)
                  let projectDiagnosticsCount = 0
                  for (const [file, issues] of Object.entries(diagnostics)) {
                    const current = file === normalizedFilepath
                    if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
                    const block = LSP.Diagnostic.report(current ? filepath : file, issues)
                    if (!block) continue
                    if (current) {
                      output += `\n\nLSP errors detected in this file, please fix:\n${block}`
                      continue
                    }
                    projectDiagnosticsCount++
                    output += `\n\nLSP errors detected in other files:\n${block}`
                  }

                  if (receipt) {
                    yield* receipt.settle({
                      canonicalPath: filepath,
                      digest: mutations.digest(yield* fs.readFile(filepath)),
                      release: () => lease.release,
                    })
                    if (!receipt.pending()?.release) yield* lease.release
                  } else {
                    yield* lease.release
                  }
                  return {
                    title: path.relative(instance.worktree, filepath),
                    metadata: {
                      diagnostics,
                      filepath,
                      exists: exists,
                    },
                    output,
                  }
                }),
              ).pipe(Effect.onError(() => lease.release))
            }),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
