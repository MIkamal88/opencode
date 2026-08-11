import { SessionV1 } from "@opencode-ai/core/v1/session"
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { isRecord } from "@/util/record"

export type RequestInput = {
  readonly model: Model<Api>
  readonly system: readonly string[]
  readonly history?: readonly SessionV1.WithParts[]
  readonly suffix?: readonly ModelMessage[]
  readonly messages: readonly ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly abort: AbortSignal
  readonly source: (providerID: string, modelID: string) => Model<Api> | undefined
}

export type RequestResult =
  | { readonly type: "supported"; readonly context: Context }
  | { readonly type: "unsupported"; readonly reason: string }

type PiMetadata = {
  readonly api?: string
  readonly provider?: string
  readonly model?: string
  readonly responseModel?: string
  readonly responseId?: string
  readonly content?: Record<string, unknown>
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

function piMetadata(value: unknown): PiMetadata | undefined {
  if (!isRecord(value) || !isRecord(value.pi)) return
  const content = isRecord(value.pi.content) ? value.pi.content : undefined
  return {
    api: typeof value.pi.api === "string" ? value.pi.api : undefined,
    provider: typeof value.pi.provider === "string" ? value.pi.provider : undefined,
    model: typeof value.pi.model === "string" ? value.pi.model : undefined,
    responseModel: typeof value.pi.responseModel === "string" ? value.pi.responseModel : undefined,
    responseId: typeof value.pi.responseId === "string" ? value.pi.responseId : undefined,
    content,
  }
}

function signature(value: unknown, key: string) {
  const metadata = piMetadata(value)
  const current = metadata?.content?.[key]
  return typeof current === "string" ? current : undefined
}

function historicalUsage(info: SessionV1.Assistant, finish?: SessionV1.StepFinishPart): Usage {
  const tokens = finish?.tokens ?? info.tokens
  const reasoning = Math.max(0, tokens.reasoning)
  const output = Math.max(0, tokens.output) + reasoning
  const input = Math.max(0, tokens.input)
  const cacheRead = Math.max(0, tokens.cache.read)
  const cacheWrite = Math.max(0, tokens.cache.write)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens: tokens.total ?? input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: finish?.cost ?? info.cost },
  }
}

function stopReason(info: SessionV1.Assistant, finish?: SessionV1.StepFinishPart): AssistantMessage["stopReason"] {
  if (info.error) return info.error.name === "MessageAbortedError" ? "aborted" : "error"
  const reason = finish?.reason ?? info.finish
  if (reason === "tool-calls") return "toolUse"
  if (reason === "length") return "length"
  if (reason === "stop" || reason === "content-filter") return "stop"
  return "pending"
}

function assistantError(info: SessionV1.Assistant) {
  if (!info.error || !isRecord(info.error.data)) return undefined
  return typeof info.error.data.message === "string" ? info.error.data.message : undefined
}

function segments(parts: readonly SessionV1.Part[]) {
  const result: Array<{ parts: SessionV1.Part[]; finish?: SessionV1.StepFinishPart }> = []
  let current: SessionV1.Part[] = []
  for (const part of parts) {
    if (part.type === "step-start") {
      if (current.length > 0) result.push({ parts: current })
      current = []
      continue
    }
    if (part.type === "step-finish") {
      if (current.length > 0) result.push({ parts: current, finish: part })
      current = []
      continue
    }
    current.push(part)
  }
  if (current.length > 0) result.push({ parts: current })
  return result
}

async function image(part: { mime: string; url: string; filename?: string }, abort: AbortSignal) {
  if (!part.mime.startsWith("image/")) {
    return { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
  }

  try {
    if (part.url.startsWith("data:")) {
      const comma = part.url.indexOf(",")
      if (comma === -1) throw new Error("invalid data URL")
      const header = part.url.slice(5, comma)
      const raw = part.url.slice(comma + 1)
      const data = header.includes(";base64") ? raw : Buffer.from(decodeURIComponent(raw)).toString("base64")
      return { type: "image" as const, mimeType: part.mime, data }
    }
    if (part.url.startsWith("file:")) {
      const data = Buffer.from(await Bun.file(new URL(part.url)).arrayBuffer()).toString("base64")
      return { type: "image" as const, mimeType: part.mime, data }
    }
    if (part.url.startsWith("http://") || part.url.startsWith("https://")) {
      const response = await fetch(part.url, { signal: abort })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("image exceeds 20 MiB")
      return { type: "image" as const, mimeType: part.mime, data: Buffer.from(bytes).toString("base64") }
    }
  } catch {}

  return { type: "text" as const, text: `[Image unavailable: ${part.filename ?? part.url}]` }
}

async function userMessage(input: SessionV1.WithParts, abort: AbortSignal): Promise<Message | undefined> {
  if (input.info.role !== "user") return
  const content = await Promise.all(
    input.parts.flatMap((part): Array<Promise<TextContent | ImageContent>> => {
      if (part.type === "text" && !part.ignored && part.text !== "") {
        return [Promise.resolve({ type: "text", text: part.text })]
      }
      if (part.type === "file") return [image(part, abort)]
      if (part.type === "compaction") return [Promise.resolve({ type: "text", text: "What did we do so far?" })]
      if (part.type === "subtask") {
        return [Promise.resolve({ type: "text", text: `The following tool was executed by the user\n${part.prompt}` })]
      }
      return []
    }),
  )
  if (content.length === 0) return
  return { role: "user", content, timestamp: input.info.time.created }
}

function identity(input: SessionV1.WithParts, parts: readonly SessionV1.Part[], source: RequestInput["source"]) {
  if (input.info.role !== "assistant") return
  const metadata = parts
    .flatMap((part) => ("metadata" in part ? [piMetadata(part.metadata)] : []))
    .find((item) => item?.api && item.provider && item.model)
  if (metadata?.api && metadata.provider && metadata.model) return metadata
  const model = source(input.info.providerID, input.info.modelID)
  if (!model) return
  return { api: model.api, provider: model.provider, model: model.id }
}

async function toolResult(part: SessionV1.ToolPart, abort: AbortSignal): Promise<ToolResultMessage> {
  const state = part.state
  const attachments = state.status === "completed" ? (state.attachments ?? []) : []
  const content = await Promise.all([
    Promise.resolve({
      type: "text" as const,
      text:
        state.status === "completed"
          ? state.time.compacted
            ? "[Old tool result content cleared]"
            : state.output
          : state.status === "error"
            ? typeof state.metadata?.output === "string"
              ? state.metadata.output
              : state.error
            : "[Tool execution was interrupted]",
    }),
    ...attachments.map((attachment) => image(attachment, abort)),
  ])
  return {
    role: "toolResult",
    toolCallId: part.callID,
    toolName: part.tool,
    content,
    details: "metadata" in state ? state.metadata : undefined,
    isError: state.status !== "completed",
    timestamp: "time" in state ? state.time.start : Date.now(),
  }
}

async function assistantMessages(
  input: SessionV1.WithParts,
  abort: AbortSignal,
  source: RequestInput["source"],
): Promise<Message[] | undefined> {
  if (input.info.role !== "assistant") return
  const result: Message[] = []
  for (const segment of segments(input.parts)) {
    const provenance = identity(input, segment.parts, source)
    if (!provenance?.api || !provenance.provider || !provenance.model) return
    const content: AssistantMessage["content"] = []
    const results: ToolResultMessage[] = []
    for (const part of segment.parts) {
      if (part.type === "text") {
        const textSignature = signature(part.metadata, "textSignature")
        if (part.text !== "" || textSignature) content.push({ type: "text", text: part.text, textSignature })
      }
      if (part.type === "reasoning") {
        const legacy = isRecord(part.metadata?.anthropic) ? part.metadata.anthropic.signature : undefined
        const thinkingSignature = signature(part.metadata, "thinkingSignature")
        const redacted = piMetadata(part.metadata)?.content?.redacted === true
        if (part.text !== "" || thinkingSignature || legacy)
          content.push({
            type: "thinking",
            thinking: part.text,
            thinkingSignature: thinkingSignature ?? (typeof legacy === "string" ? legacy : undefined),
            redacted,
          })
      }
      if (part.type === "tool") {
        content.push({
          type: "toolCall",
          id: part.callID,
          name: part.tool,
          arguments: part.state.input,
          thoughtSignature: signature(part.metadata, "thoughtSignature"),
        })
        results.push(await toolResult(part, abort))
      }
    }
    if (content.length === 0) continue
    const metadata = segment.parts
      .flatMap((part) => ("metadata" in part ? [piMetadata(part.metadata)] : []))
      .find((item) => item)
    result.push({
      role: "assistant",
      content,
      api: provenance.api,
      provider: provenance.provider,
      model: provenance.model,
      responseModel: metadata?.responseModel,
      responseId: metadata?.responseId,
      usage: historicalUsage(input.info, segment.finish),
      stopReason: stopReason(input.info, segment.finish),
      errorMessage: assistantError(input.info),
      timestamp: input.info.time.created,
    })
    result.push(...results)
  }
  return result
}

function text(value: unknown) {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "")
}

function suffixMessages(messages: readonly ModelMessage[], model: Model<Api>): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === "system") return []
    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part): TextContent => ({ type: "text", text: text(part) }))
      return [{ role: "user", content, timestamp: Date.now() }]
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = []
      if (typeof message.content === "string") content.push({ type: "text", text: message.content })
      if (typeof message.content !== "string") {
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text })
          if (part.type === "reasoning") content.push({ type: "thinking", thinking: part.text })
          if (part.type === "tool-call")
            content.push({
              type: "toolCall",
              id: part.toolCallId,
              name: part.toolName,
              arguments: isRecord(part.input) ? part.input : { value: part.input },
            })
        }
      }
      return [
        {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ]
    }
    return message.content.flatMap((part): ToolResultMessage[] => {
      if (part.type !== "tool-result") return []
      return [
        {
          role: "toolResult",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          content: [{ type: "text", text: text(part.output) }],
          isError: isRecord(part.output) && part.output.type === "error-text",
          timestamp: Date.now(),
        },
      ]
    })
  })
}

async function toolDefinitions(input: Record<string, Tool>): Promise<Context["tools"]> {
  const { Type } = await import("@earendil-works/pi-ai")
  return Object.entries(input).map(([name, item]) => {
    const schema = asSchema(item.inputSchema).jsonSchema
    return {
      name,
      description: item.description ?? "",
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      constrainedSampling:
        item.strict === false
          ? false
          : { type: "json_schema" as const, strict: item.strict === true ? ("require" as const) : ("prefer" as const) },
    }
  })
}

export async function prepare(input: RequestInput): Promise<RequestResult> {
  const messages: Message[] = []
  if (input.history) {
    for (const item of input.history) {
      const user = await userMessage(item, input.abort)
      if (user) messages.push(user)
      const assistant = await assistantMessages(item, input.abort, input.source)
      if (assistant === undefined && item.info.role === "assistant") {
        return {
          type: "unsupported",
          reason: `cannot resolve historical pi API for ${item.info.providerID}/${item.info.modelID}`,
        }
      }
      if (assistant) messages.push(...assistant)
    }
  } else {
    messages.push(...suffixMessages(input.messages, input.model))
  }
  messages.push(...suffixMessages(input.suffix ?? [], input.model))

  return {
    type: "supported",
    context: {
      systemPrompt: input.system.filter(Boolean).join("\n"),
      messages,
      tools: await toolDefinitions(input.tools),
    },
  }
}

export * as PiAIRequest from "./pi-ai-request"
