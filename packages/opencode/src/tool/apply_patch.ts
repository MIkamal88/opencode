import * as path from "path"
import { Cause, Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { FileMutationState } from "./file-mutation-state"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const mutations = yield* FileMutationState.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context
      const targets = yield* Effect.forEach(hunks, (hunk) =>
        Effect.gen(function* () {
          const requested = path.resolve(instance.directory, hunk.path)
          const source = yield* mutations.canonical(requested)
          yield* assertExternalDirectoryEffect(ctx, source)
          if (hunk.type !== "update" || !hunk.move_path) return { requested, source }
          const requestedMove = path.resolve(instance.directory, hunk.move_path)
          const move = yield* mutations.canonical(requestedMove)
          yield* assertExternalDirectoryEffect(ctx, move)
          return { requested, source, requestedMove, move }
        }),
      )

      const owners = new Map<string, number>()
      for (const [index, target] of targets.entries()) {
        for (const candidate of target.move ? [target.source, target.move] : [target.source]) {
          const owner = owners.get(candidate)
          if (owner !== undefined) {
            return yield* Effect.fail(
              new Error(
                `apply_patch verification failed: hunks[${owner}] and hunks[${index}] target the same canonical path: ${candidate}`,
              ),
            )
          }
          owners.set(candidate, index)
        }
      }

      return yield* mutations.withLocks(
        targets.flatMap((target) => (target.move ? [target.source, target.move] : [target.source])),
        Effect.gen(function* () {
          // Validate all file contents before permission or side effects.
          const fileChanges: Array<{
            filePath: string
            oldContent: string
            newContent: string
            type: "add" | "update" | "delete" | "move"
            movePath?: string
            diff: string
            additions: number
            deletions: number
            bom: boolean
            snapshot?: FileMutationState.Snapshot
            digest?: string
          }> = []

          let totalDiff = ""

          for (const [index, hunk] of hunks.entries()) {
            const filePath = targets[index].source

            switch (hunk.type) {
              case "add": {
                const snapshot = yield* mutations
                  .snapshot(filePath)
                  .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
                if (snapshot) {
                  return yield* Effect.fail(
                    new Error(`apply_patch verification failed: File already exists: ${filePath}`),
                  )
                }
                const oldContent = ""
                const newContent =
                  hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
                const next = Bom.split(newContent)
                const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

                let additions = 0
                let deletions = 0
                for (const change of diffLines(oldContent, next.text)) {
                  if (change.added) additions += change.count || 0
                  if (change.removed) deletions += change.count || 0
                }

                fileChanges.push({
                  filePath,
                  oldContent,
                  newContent: next.text,
                  type: "add",
                  diff,
                  additions,
                  deletions,
                  bom: next.bom,
                })

                totalDiff += diff + "\n"
                break
              }

              case "update": {
                // Check if file exists for update
                const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!stats || stats.type === "Directory") {
                  return yield* Effect.fail(
                    new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
                  )
                }

                const snapshot = yield* mutations.snapshot(filePath)
                const receipt = ctx.receipt
                if (!receipt) {
                  return yield* Effect.fail(new Error("The internal read receipt channel is unavailable."))
                }
                const digest = mutations.digest(snapshot.content)
                if (!(yield* receipt.match({ canonicalPath: filePath, digest }))) {
                  return yield* Effect.fail(
                    new Error(
                      `File ${filePath} has not been read in this session or has changed since it was read. Read it again before applying the patch.`,
                    ),
                  )
                }
                const source = Bom.decode(snapshot.content)
                const oldContent = source.text
                const ending = oldContent.includes("\r\n") ? "\r\n" : "\n"
                let newContent = oldContent
                let bom = source.bom

                // Apply the update chunks to get new content
                try {
                  const fileUpdate = Patch.deriveNewContentsFromChunks(
                    filePath,
                    hunk.chunks,
                    Bom.join(source.text.replaceAll("\r\n", "\n"), source.bom),
                  )
                  newContent = ending === "\r\n" ? fileUpdate.content.replaceAll("\n", "\r\n") : fileUpdate.content
                  bom = fileUpdate.bom
                } catch (error) {
                  return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
                }

                const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

                let additions = 0
                let deletions = 0
                for (const change of diffLines(oldContent, newContent)) {
                  if (change.added) additions += change.count || 0
                  if (change.removed) deletions += change.count || 0
                }

                const movePath = targets[index].move
                const destinationSnapshot = movePath
                  ? yield* mutations
                      .snapshot(movePath)
                      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
                  : undefined
                if (destinationSnapshot) {
                  return yield* Effect.fail(
                    new Error(`apply_patch verification failed: Move destination already exists: ${movePath}`),
                  )
                }

                fileChanges.push({
                  filePath,
                  oldContent,
                  newContent,
                  type: hunk.move_path ? "move" : "update",
                  movePath,
                  diff,
                  additions,
                  deletions,
                  bom,
                  snapshot,
                  digest,
                })

                totalDiff += diff + "\n"
                break
              }

              case "delete": {
                const snapshot = yield* mutations
                  .snapshot(filePath)
                  .pipe(
                    Effect.catch((error) =>
                      Effect.fail(
                        new Error(
                          `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                      ),
                    ),
                  )
                const source = Bom.decode(snapshot.content)
                const receipt = ctx.receipt
                if (!receipt) {
                  return yield* Effect.fail(new Error("The internal read receipt channel is unavailable."))
                }
                const digest = mutations.digest(snapshot.content)
                if (!(yield* receipt.match({ canonicalPath: filePath, digest }))) {
                  return yield* Effect.fail(
                    new Error(
                      `File ${filePath} has not been read in this session or has changed since it was read. Read it again before applying the patch.`,
                    ),
                  )
                }
                const contentToDelete = source.text
                const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

                const deletions = contentToDelete.split("\n").length

                fileChanges.push({
                  filePath,
                  oldContent: contentToDelete,
                  newContent: "",
                  type: "delete",
                  diff: deleteDiff,
                  additions: 0,
                  deletions,
                  bom: source.bom,
                  snapshot,
                  digest,
                })

                totalDiff += deleteDiff + "\n"
                break
              }
            }
          }

          // Build per-file metadata for UI rendering (used for both permission and result)
          const files = fileChanges.map((change) => ({
            filePath: change.filePath,
            relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
            type: change.type,
            patch: change.diff,
            additions: change.additions,
            deletions: change.deletions,
            movePath: change.movePath,
          }))

          // Check permissions if needed
          const relativePaths = [
            ...new Set(
              fileChanges.flatMap((change) =>
                [change.filePath, change.movePath]
                  .filter((filePath): filePath is string => filePath !== undefined)
                  .map((filePath) => path.relative(instance.worktree, filePath).replaceAll("\\", "/")),
              ),
            ),
          ]
          yield* ctx.ask({
            permission: "edit",
            patterns: relativePaths,
            always: ["*"],
            metadata: {
              filepath: relativePaths.join(", "),
              diff: totalDiff,
              files,
            },
          })

          for (const [index, change] of fileChanges.entries()) {
            const target = targets[index]
            const source = yield* mutations.canonical(target.requested)
            if (source !== change.filePath) {
              yield* assertExternalDirectoryEffect(ctx, source)
              return yield* Effect.fail(
                new Error(`File ${change.filePath} was redirected while waiting for permission. Retry the patch.`),
              )
            }
            if (change.snapshot && change.digest) {
              const checked = yield* mutations.snapshot(change.filePath)
              if (
                !mutations.sameIdentity(change.snapshot, checked) ||
                mutations.digest(checked.content) !== change.digest
              ) {
                return yield* Effect.fail(
                  new Error(`File ${change.filePath} changed while waiting for permission. Retry the patch.`),
                )
              }
            }
            if (change.type === "add") {
              const created = yield* afs.existsSafe(change.filePath)
              if (created) {
                return yield* Effect.fail(
                  new Error(`File ${change.filePath} was created while waiting for permission. Retry the patch.`),
                )
              }
            }
            if (!change.movePath || !target.requestedMove) continue
            const move = yield* mutations.canonical(target.requestedMove)
            if (move !== change.movePath) {
              yield* assertExternalDirectoryEffect(ctx, move)
              return yield* Effect.fail(
                new Error(
                  `Move destination ${change.movePath} was redirected while waiting for permission. Retry the patch.`,
                ),
              )
            }
            if (yield* afs.existsSafe(change.movePath)) {
              return yield* Effect.fail(
                new Error(
                  `Move destination ${change.movePath} was created while waiting for permission. Retry the patch.`,
                ),
              )
            }
          }

          const mutated: string[] = []
          let attempted = "patch settlement"
          const diagnostics = yield* Effect.gen(function* () {
            const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

            for (const change of fileChanges) {
              const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
              const receipt = ctx.receipt
              if (!receipt) {
                return yield* Effect.fail(new Error("The internal read receipt channel is unavailable."))
              }
              attempted = change.filePath
              yield* receipt.invalidate({ canonicalPath: change.filePath })
              if (change.movePath) yield* receipt.invalidate({ canonicalPath: change.movePath })
              switch (change.type) {
                case "add":
                  yield* createExclusive(afs, change.filePath, Bom.join(change.newContent, change.bom))
                  mutated.push(change.filePath)
                  updates.push({ file: change.filePath, event: "add" })
                  break

                case "update":
                  yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
                  mutated.push(change.filePath)
                  updates.push({ file: change.filePath, event: "change" })
                  break

                case "move":
                  if (change.movePath) {
                    attempted = change.movePath
                    yield* createExclusive(afs, change.movePath, Bom.join(change.newContent, change.bom))
                    mutated.push(change.movePath)
                    attempted = change.filePath
                    yield* afs.remove(change.filePath)
                    mutated.push(change.filePath)
                    updates.push({ file: change.filePath, event: "unlink" })
                    updates.push({ file: change.movePath, event: "add" })
                  }
                  break

                case "delete":
                  yield* afs.remove(change.filePath)
                  mutated.push(change.filePath)
                  updates.push({ file: change.filePath, event: "unlink" })
                  break
              }

              if (edited) {
                attempted = edited
                if (yield* format.file(edited)) {
                  yield* Bom.syncFile(afs, edited, change.bom)
                }
                yield* events.publish(FileSystem.Event.Edited, { file: edited })
              }
            }

            for (const update of updates) {
              attempted = update.file
              yield* events.publish(Watcher.Event.Updated, update)
            }

            for (const change of fileChanges) {
              if (change.type === "delete") continue
              const target = change.movePath ?? change.filePath
              attempted = target
              yield* lsp.touchFile(target, "document")
            }
            attempted = "LSP diagnostics"
            return yield* lsp.diagnostics()
          }).pipe(
            Effect.catchCause((cause) => {
              if (mutated.length === 0) return Effect.failCause(cause)
              const failure = Cause.squash(cause)
              const detail = failure instanceof Error ? failure.message : String(failure)
              return Effect.fail(
                new Error(
                  `apply_patch failed while processing ${attempted}; the patch was partially applied. Mutated paths: ${mutated.join(", ")}. Original failure: ${detail}`,
                  { cause: failure },
                ),
              )
            }),
            Effect.uninterruptible,
          )

          // Generate output summary
          const summaryLines = fileChanges.map((change) => {
            if (change.type === "add") {
              return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
            }
            if (change.type === "delete") {
              return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
            }
            const target = change.movePath ?? change.filePath
            return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
          })
          let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

          for (const change of fileChanges) {
            if (change.type === "delete") continue
            const target = change.movePath ?? change.filePath
            const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
            if (!block) continue
            const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
            output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
          }

          return {
            title: output,
            metadata: {
              diff: totalDiff,
              files,
              diagnostics,
            },
            output,
          }
        }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const createExclusive = Effect.fn("ApplyPatchTool.createExclusive")(function* (
  fs: FSUtil.Interface,
  filePath: string,
  content: string,
) {
  const write = fs.writeFileString(filePath, content, { flag: "wx" })
  yield* write.pipe(
    Effect.catchReason("PlatformError", "NotFound", () =>
      fs.ensureDir(path.dirname(filePath)).pipe(Effect.andThen(write)),
    ),
    Effect.catchReason("PlatformError", "AlreadyExists", () =>
      Effect.fail(new Error(`File ${filePath} was created before it could be written. Retry the patch.`)),
    ),
  )
})
