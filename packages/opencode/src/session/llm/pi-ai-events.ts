import { LLMEvent, type ProviderMetadata, Usage } from "@opencode-ai/llm"
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai"
import { Effect } from "effect"

export function adapterState() {
  return {
    step: 0,
    tools: new Map<number, string[]>(),
  }
}

export class PiAIProviderError extends Error {
  readonly response: AssistantMessage
  readonly retryable: boolean

  constructor(response: AssistantMessage, retryable: boolean) {
    super(response.errorMessage ?? "pi-ai provider request failed")
    this.name = "PiAIProviderError"
    this.response = response
    this.retryable = retryable
  }
}

function contentMetadata(message: AssistantMessage, contentIndex?: number): ProviderMetadata {
  const content = contentIndex === undefined ? undefined : message.content[contentIndex]
  const signature =
    content?.type === "text"
      ? { textSignature: content.textSignature }
      : content?.type === "thinking"
        ? { thinkingSignature: content.thinkingSignature, redacted: content.redacted }
        : content?.type === "toolCall"
          ? { thoughtSignature: content.thoughtSignature }
          : undefined
  return {
    pi: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      responseId: message.responseId,
      diagnostics: message.diagnostics,
      rawStopReason: message.rawStopReason,
      content: signature,
    },
  }
}

function usage(message: AssistantMessage) {
  const current = message.usage
  return new Usage({
    inputTokens: current.input + current.cacheRead + current.cacheWrite,
    nonCachedInputTokens: current.input,
    outputTokens: current.output,
    reasoningTokens: current.reasoning,
    cacheReadInputTokens: current.cacheRead,
    cacheWriteInputTokens: current.cacheWrite,
    totalTokens: current.totalTokens,
  })
}

function finishMetadata(message: AssistantMessage): ProviderMetadata {
  return {
    pi: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      responseId: message.responseId,
      diagnostics: message.diagnostics,
      rawStopReason: message.rawStopReason,
      usage: {
        cacheWrite1h: message.usage.cacheWrite1h,
        cost: message.usage.cost,
      },
    },
  }
}

export function failureEvent(message: AssistantMessage) {
  return LLMEvent.stepFinish({
    index: 0,
    reason: "error",
    usage: usage(message),
    providerMetadata: finishMetadata(message),
  })
}

function finishReason(reason: AssistantMessage["stopReason"]) {
  if (reason === "stop") return "stop" as const
  if (reason === "length") return "length" as const
  if (reason === "toolUse") return "tool-calls" as const
  if (reason === "error") return "error" as const
  return "unknown" as const
}

function toolEvents(
  state: ReturnType<typeof adapterState>,
  event: Extract<AssistantMessageEvent, { type: "toolcall_end" }>,
) {
  const deltas = state.tools.get(event.contentIndex) ?? []
  state.tools.delete(event.contentIndex)
  const serialized = deltas.length > 0 ? deltas : [JSON.stringify(event.toolCall.arguments)]
  const metadata = contentMetadata(event.partial, event.contentIndex)
  return [
    LLMEvent.toolInputStart({ id: event.toolCall.id, name: event.toolCall.name, providerMetadata: metadata }),
    ...serialized.map((text) => LLMEvent.toolInputDelta({ id: event.toolCall.id, name: event.toolCall.name, text })),
    LLMEvent.toolInputEnd({ id: event.toolCall.id, name: event.toolCall.name, providerMetadata: metadata }),
    LLMEvent.toolCall({
      id: event.toolCall.id,
      name: event.toolCall.name,
      input: event.toolCall.arguments,
      providerMetadata: metadata,
    }),
  ]
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AssistantMessageEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, PiAIProviderError | DOMException> {
  switch (event.type) {
    case "start":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])
    case "text_start":
      return Effect.succeed([
        LLMEvent.textStart({
          id: `pi-text-${event.contentIndex}`,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "text_delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: `pi-text-${event.contentIndex}`,
          text: event.delta,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "text_end":
      return Effect.succeed([
        LLMEvent.textEnd({
          id: `pi-text-${event.contentIndex}`,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "thinking_start":
      return Effect.succeed([
        LLMEvent.reasoningStart({
          id: `pi-reasoning-${event.contentIndex}`,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "thinking_delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: `pi-reasoning-${event.contentIndex}`,
          text: event.delta,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "thinking_end":
      return Effect.succeed([
        LLMEvent.reasoningEnd({
          id: `pi-reasoning-${event.contentIndex}`,
          providerMetadata: contentMetadata(event.partial, event.contentIndex),
        }),
      ])
    case "toolcall_start":
      return Effect.sync(() => {
        state.tools.set(event.contentIndex, [])
        return []
      })
    case "toolcall_delta":
      return Effect.sync(() => {
        const deltas = state.tools.get(event.contentIndex) ?? []
        deltas.push(event.delta)
        state.tools.set(event.contentIndex, deltas)
        return []
      })
    case "toolcall_end":
      return Effect.succeed(toolEvents(state, event))
    case "done": {
      if (event.reason === "deferred") {
        return Effect.fail(
          new PiAIProviderError({ ...event.message, errorMessage: "Deferred responses are not supported" }, false),
        )
      }
      const reason = finishReason(event.message.stopReason)
      const currentUsage = usage(event.message)
      const metadata = finishMetadata(event.message)
      return Effect.sync(() => [
        LLMEvent.stepFinish({ index: state.step++, reason, usage: currentUsage, providerMetadata: metadata }),
        LLMEvent.finish({ reason, usage: currentUsage, providerMetadata: metadata }),
      ])
    }
    case "error":
      if (event.reason === "aborted") {
        return Effect.fail(new DOMException(event.error.errorMessage ?? "Aborted", "AbortError"))
      }
      return Effect.promise(() => import("@earendil-works/pi-ai")).pipe(
        Effect.flatMap((pi) =>
          Effect.fail(new PiAIProviderError(event.error, pi.isRetryableAssistantError(event.error))),
        ),
      )
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export function toolCall(event: LLMEvent): ToolCall | undefined {
  if (event.type !== "tool-call") return
  return {
    type: "toolCall",
    id: event.id,
    name: event.name,
    arguments: typeof event.input === "object" && event.input !== null ? (event.input as Record<string, unknown>) : {},
  }
}

export * as PiAIEvents from "./pi-ai-events"
