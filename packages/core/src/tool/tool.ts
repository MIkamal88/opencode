export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { ManagedOutput, StorageError } from "../tool-output-store"
import { take, type Pending as TrustedPending, type Receipt } from "./trusted-receipt"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<
    Schema.Schema.Type<Output> | TrustedPending<Schema.Schema.Type<Output>>,
    ToolFailure | StorageError
  >
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<Pending, ToolFailure | StorageError>
}

export interface Pending {
  readonly output: ToolOutput
  readonly receipt?: Receipt
  readonly managedOutput?: ManagedOutput
  readonly release?: () => Effect.Effect<void>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
>(config: Config<Input, Output, Structured>): Definition<Input, Structured> {
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          Effect.uninterruptibleMask((restore) => {
            let owned: ManagedOutput | undefined
            let release: (() => Effect.Effect<void>) | undefined
            return restore(config.execute(input, context)).pipe(
              Effect.flatMap((pending) => {
                const trusted = take(pending)
                owned = trusted.managedOutput
                release = trusted.release
                const metadata = {
                  ...(trusted.receipt ? { receipt: trusted.receipt } : {}),
                  ...(trusted.managedOutput ? { managedOutput: trusted.managedOutput } : {}),
                  ...(trusted.release ? { release: trusted.release } : {}),
                }
                return Schema.encodeEffect(config.output)(trusted.output).pipe(
                  Effect.flatMap((output) => {
                    if (!config.structured || !config.toStructuredOutput)
                      return Effect.succeed({ output, structured: output, ...metadata })
                    return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
                      Effect.map((structured) => ({ output, structured, ...metadata })),
                    )
                  }),
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({
                        message: `Tool returned an invalid value for its output schema: ${error.message}`,
                      }),
                  ),
                )
              }),
              Effect.map(({ output, structured, receipt, managedOutput, release }) => ({
                output: {
                  structured,
                  content:
                    config.toModelOutput?.({ input, output }).map((part) =>
                      part.type === "text"
                        ? { type: "text" as const, text: part.text }
                        : {
                            type: "file" as const,
                            uri: `data:${part.mime};base64,${part.data}`,
                            mime: part.mime,
                            name: part.name,
                          },
                    ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
                },
                ...(receipt ? { receipt } : {}),
                ...(managedOutput ? { managedOutput } : {}),
                ...(release ? { release } : {}),
              })),
              Effect.onError(() =>
                Effect.all([owned?.discard?.() ?? Effect.void, release?.() ?? Effect.void], { discard: true }),
              ),
            )
          }),
        ),
      ),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const withoutTrustedSettlement = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  const runtime = runtimeOf(tool)
  runtimes.set(decorated, {
    ...runtime,
    settle: (call, context) =>
      runtime
        .settle(call, context)
        .pipe(
          Effect.flatMap(({ output, managedOutput, release }) =>
            Effect.all([managedOutput?.discard?.() ?? Effect.void, release?.() ?? Effect.void], { discard: true }).pipe(
              Effect.as({ output }),
            ),
          ),
        ),
  })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
