import { LLMEvent, ToolResultValue } from "@opencode-ai/llm"
import type { ModelMessage, Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { errorMessage } from "@/util/error"
import type { Provider } from "@/provider/provider"
import { PiAIEvents } from "./pi-ai-events"
import { PiAIRequest } from "./pi-ai-request"
import type { PiAIModels } from "./pi-ai-models"

export type StreamInput = {
  readonly resolved: PiAIModels.Resolved
  readonly runtime: Provider.RuntimeInfo
  readonly system: readonly string[]
  readonly history?: readonly import("@opencode-ai/core/v1/session").SessionV1.WithParts[]
  readonly suffix?: readonly ModelMessage[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly sessionID: string
  readonly retries?: number
  readonly abort: AbortSignal
}

export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

function reasoning(value: Record<string, any> | undefined) {
  const current = value?.reasoningEffort ?? value?.reasoning
  if (
    current === "minimal" ||
    current === "low" ||
    current === "medium" ||
    current === "high" ||
    current === "xhigh" ||
    current === "max"
  )
    return current
}

function toolChoice(input: StreamInput) {
  if (input.toolChoice !== "required") return input.toolChoice
  if (
    input.resolved.model.api === "anthropic-messages" ||
    input.resolved.model.api === "google-generative-ai" ||
    input.resolved.model.api === "google-vertex" ||
    input.resolved.model.api === "bedrock-converse-stream"
  )
    return "any" as const
  return "required" as const
}

function execute(input: StreamInput, event: LLMEvent) {
  if (event.type !== "tool-call") return Effect.succeed([] as LLMEvent[])
  const item = input.tools[event.name]
  if (!item?.execute) {
    return Effect.succeed([
      LLMEvent.toolError({
        id: event.id,
        name: event.name,
        message: item ? `Tool has no execute handler: ${event.name}` : `Unknown tool: ${event.name}`,
      }),
    ])
  }
  return Effect.tryPromise({
    try: () =>
      item.execute!(event.input, {
        toolCallId: event.id,
        messages: input.messages,
        abortSignal: input.abort,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => [
        LLMEvent.toolError({ id: event.id, name: event.name, message: errorMessage(error), error }),
      ],
      onSuccess: (result) => [
        LLMEvent.toolResult({
          id: event.id,
          name: event.name,
          result: ToolResultValue.make(result),
        }),
      ],
    }),
  )
}

export const stream = Effect.fn("PiAIRuntime.stream")(function* (input: StreamInput) {
  const request = yield* Effect.promise(() =>
    PiAIRequest.prepare({
      model: input.resolved.model,
      system: input.system,
      history: input.history,
      suffix: input.suffix,
      messages: input.messages,
      tools: input.tools,
      abort: input.abort,
      source: input.resolved.source,
    }),
  )
  if (request.type === "unsupported") return request

  const samplingParams = {
    ...input.resolved.settings.samplingParams,
    ...(input.topP === undefined ? {} : { top_p: input.topP }),
    ...(input.topK === undefined ? {} : { top_k: input.topK }),
  }
  const events = input.resolved.models.streamSimple(input.resolved.model, request.context, {
    signal: input.abort,
    apiKey: input.runtime.apiKey,
    fetch: input.runtime.fetch,
    headers: { ...input.runtime.headers, ...input.headers },
    temperature: input.temperature,
    samplingParams,
    maxTokens: input.maxOutputTokens,
    reasoning: reasoning(input.providerOptions),
    thinkingBudgets: input.resolved.settings.thinkingBudgets,
    cacheRetention: input.resolved.settings.cacheRetention,
    sessionId: input.sessionID,
    maxRetries: input.retries,
    timeoutMs: typeof input.runtime.options.timeout === "number" ? input.runtime.options.timeout : undefined,
    maxRetryDelayMs:
      typeof input.runtime.options.maxRetryDelayMs === "number" ? input.runtime.options.maxRetryDelayMs : undefined,
    toolChoice: toolChoice(input),
  } as Parameters<typeof input.resolved.models.streamSimple>[2] & { toolChoice?: ReturnType<typeof toolChoice> })
  const state = PiAIEvents.adapterState()
  const provider = Stream.fromAsyncIterable(events, (error) => error).pipe(
    Stream.mapEffect((event) => PiAIEvents.toLLMEvents(state, event)),
    Stream.flatMap((current) => Stream.fromIterable(current)),
  )
  const result = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        const output = provider.pipe(
          Stream.flatMap(
            (event): Stream.Stream<LLMEvent, never> =>
              event.type !== "tool-call"
                ? Stream.make(event)
                : Stream.make(event).pipe(
                    Stream.concat(
                      Stream.fromEffectDrain(
                        execute(input, event).pipe(
                          Effect.flatMap((items) => Queue.offerAll(results, items)),
                          Effect.catchCause((cause) => Queue.failCause(results, cause)),
                          Effect.asVoid,
                          FiberSet.run(settlements, { startImmediately: true }),
                        ),
                      ),
                    ),
                  ),
          ),
          Stream.concat(
            Stream.fromEffectDrain(
              FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid),
            ),
          ),
        )
        return output.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )
  return { type: "supported" as const, stream: result }
})

export * as PiAIRuntime from "./pi-ai-runtime"
