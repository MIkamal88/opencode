/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { make as trustedReceipt } from "./trusted-receipt"

export const name = "edit"

const Path = Schema.String.annotate({
  description:
    "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
})
const LegacyInput = Schema.Struct({
  path: Path,
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})
const BatchEdit = Schema.Struct({
  oldString: Schema.String.annotate({ description: "Exact text to replace once" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
})
const BatchInput = Schema.Struct({
  path: Path,
  edits: Schema.Array(BatchEdit).annotate({
    description: "Exact, non-overlapping replacements matched against one original file snapshot",
  }),
})
export const Input = Schema.Union([LegacyInput, BatchInput])

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => {
              const edits = "edits" in input ? input.edits : [input]
              return [
                {
                  type: "text",
                  text: toModelOutput(
                    output,
                    edits.map((edit) => edit.oldString).join("\n"),
                    edits.map((edit) => edit.newString).join("\n"),
                  ),
                },
              ]
            },
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "File changed after permission approval. Read it again before editing.",
                        })
                      : error instanceof ToolFailure
                        ? error
                        : new ToolFailure({ message: `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const edits = "edits" in input ? input.edits : [input]
                if (edits.length === 0)
                  return yield* new ToolFailure({ message: "edits must contain at least one replacement." })
                for (const [index, edit] of edits.entries()) {
                  const prefix = "edits" in input ? `edits[${index}]: ` : ""
                  if (edit.oldString === edit.newString)
                    return yield* new ToolFailure({
                      message: `${prefix}No changes to apply: oldString and newString are identical.`,
                    })
                  if (edit.oldString === "")
                    return yield* new ToolFailure({
                      message: `${prefix}oldString must not be empty. Use write to create or overwrite a file.`,
                    })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const modified = yield* unableToEdit(
                  files.modifyText({
                    sessionID: context.sessionID,
                    target,
                    modify: ({ text }) =>
                      Effect.gen(function* () {
                        const ending = detectLineEnding(text)
                        const plans: Array<{
                          readonly offset: number
                          readonly end: number
                          readonly newString: string
                          readonly editIndex: number
                        }> = []
                        for (const [index, edit] of edits.entries()) {
                          const oldString = convertToLineEnding(edit.oldString, ending)
                          const newString = convertToLineEnding(edit.newString, ending)
                          const offsets: number[] = []
                          for (
                            let offset = text.indexOf(oldString);
                            offset !== -1;
                            offset = text.indexOf(oldString, offset + oldString.length)
                          )
                            offsets.push(offset)
                          const prefix = "edits" in input ? `edits[${index}]: ` : ""
                          if (offsets.length === 0)
                            return yield* new ToolFailure({
                              message: `${prefix}Could not find oldString in the file. It must match exactly, including whitespace and indentation.`,
                            })
                          if (offsets.length > 1 && !("replaceAll" in input && input.replaceAll === true))
                            return yield* new ToolFailure({
                              message: `${prefix}Found multiple exact matches for oldString. Provide more surrounding context${"edits" in input ? "." : " or set replaceAll to true."}`,
                            })
                          plans.push(
                            ...offsets.map((offset) => ({
                              offset,
                              end: offset + oldString.length,
                              newString,
                              editIndex: index,
                            })),
                          )
                        }
                        const ordered = plans.sort((left, right) => left.offset - right.offset)
                        const overlap = ordered.findIndex(
                          (plan, index) => index > 0 && plan.offset < ordered[index - 1]!.end,
                        )
                        if (overlap !== -1) {
                          const left = ordered[overlap - 1]!
                          const right = ordered[overlap]!
                          return yield* new ToolFailure({
                            message: `Batch edits overlap in the original file: edits[${left.editIndex}] and edits[${right.editIndex}].`,
                          })
                        }
                        const replaced = ordered.reduceRight(
                          (content, plan) => content.slice(0, plan.offset) + plan.newString + content.slice(plan.end),
                          text,
                        )
                        const counts = diffLines(text, replaced).reduce(
                          (result, item) => ({
                            additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                            deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                          }),
                          { additions: 0, deletions: 0 },
                        )
                        return {
                          content: replaced,
                          value: {
                            files: [
                              {
                                file: target.resource,
                                patch: createTwoFilesPatch(target.resource, target.resource, text, replaced),
                                status: "modified" as const,
                                ...counts,
                              },
                            ],
                            replacements: ordered.length,
                          } satisfies Output,
                        }
                      }),
                  }),
                )
                return trustedReceipt(modified.value, modified.receipt, modified.release)
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, PermissionV2.node],
})
