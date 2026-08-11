import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Env } from "@/env"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import type { Api, CacheRetention, Model, MutableModels, ProviderStreams, ThinkingBudgets } from "@earendil-works/pi-ai"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { PiAICredentials } from "./pi-ai-credentials"

export type Gate = boolean | { providers?: string[] } | undefined

export type Settings = {
  readonly api?: Api
  readonly compat?: Record<string, unknown>
  readonly cacheRetention?: CacheRetention
  readonly thinkingBudgets?: ThinkingBudgets
  readonly samplingParams?: Record<string, unknown>
}

export type ResolveInput = {
  readonly gate: Gate
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly runtime: Provider.RuntimeInfo
}

export type Resolved = {
  readonly type: "supported"
  readonly models: MutableModels
  readonly model: Model<Api>
  readonly settings: Settings
  readonly source: (providerID: string, modelID: string) => Model<Api> | undefined
}

export type Resolution = Resolved | { readonly type: "unsupported"; readonly reason: string }

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Resolution>
  readonly models: () => Effect.Effect<MutableModels>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PiAIModels") {}

type State = {
  readonly models: MutableModels
  readonly custom: Map<string, Promise<void>>
  readonly resolved: Map<string, Model<Api>>
}

const knownApis = new Set<Api>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
  "pi-messages",
])

export function enabled(gate: Gate, providerID: string) {
  if (gate === true) return true
  if (!gate) return false
  return gate.providers === undefined || gate.providers.includes(providerID)
}

function piProviderID(input: Pick<ResolveInput, "model" | "auth">) {
  if (input.model.providerID === "openai" && input.auth?.type === "oauth") return "openai-codex"
  if (input.model.providerID === "azure") return "azure-openai-responses"
  if (input.model.providerID === "vercel") return "vercel-ai-gateway"
  return String(input.model.providerID)
}

function inferredApi(npm: string): Api | undefined {
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages"
  if (npm === "@ai-sdk/openai") return "openai-responses"
  if (npm === "@ai-sdk/openai-compatible" || npm === "@openrouter/ai-sdk-provider") return "openai-completions"
  if (npm === "@ai-sdk/azure") return "azure-openai-responses"
  if (npm === "@ai-sdk/google") return "google-generative-ai"
  if (npm === "@ai-sdk/google-vertex") return "google-vertex"
  if (npm === "@ai-sdk/amazon-bedrock") return "bedrock-converse-stream"
  if (npm === "@ai-sdk/mistral") return "mistral-conversations"
}

function readSettings(value: unknown): Settings {
  if (!isRecord(value)) return {}
  return {
    api: typeof value.api === "string" && knownApis.has(value.api) ? value.api : undefined,
    compat: isRecord(value.compat) ? value.compat : undefined,
    cacheRetention:
      value.cacheRetention === "none" || value.cacheRetention === "short" || value.cacheRetention === "long"
        ? value.cacheRetention
        : undefined,
    thinkingBudgets: isRecord(value.thinkingBudgets) ? value.thinkingBudgets : undefined,
    samplingParams: isRecord(value.samplingParams) ? value.samplingParams : undefined,
  }
}

function settings(input: ResolveInput) {
  const provider = readSettings(input.provider.options.pi_ai)
  const model = readSettings(input.model.options.pi_ai)
  return {
    ...provider,
    ...model,
    compat: { ...provider.compat, ...model.compat },
    thinkingBudgets: { ...provider.thinkingBudgets, ...model.thinkingBudgets },
    samplingParams: { ...provider.samplingParams, ...model.samplingParams },
  } satisfies Settings
}

function modelCost(input: Provider.Model): Model<Api>["cost"] {
  return {
    input: input.cost.input,
    output: input.cost.output,
    cacheRead: input.cost.cache.read,
    cacheWrite: input.cost.cache.write,
    tiers: input.cost.tiers?.map((item) => ({
      input: item.input,
      output: item.output,
      cacheRead: item.cache.read,
      cacheWrite: item.cache.write,
      inputTokensAbove: item.tier.size,
    })),
  }
}

function resolvedModel(input: ResolveInput, models: MutableModels): Model<Api> | undefined {
  const providerID = piProviderID(input)
  const template = models.getModel(providerID, input.model.api.id) ?? models.getModel(providerID, input.model.id)
  const current = settings(input)
  const api = current.api ?? template?.api ?? inferredApi(input.model.api.npm)
  const baseUrl = input.runtime.baseURL ?? input.model.api.url ?? template?.baseUrl
  if (!api || !baseUrl) return

  const result = {
    ...template,
    id: input.model.api.id,
    name: input.model.name,
    api,
    provider: providerID,
    baseUrl,
    reasoning: input.model.capabilities.reasoning,
    input: ["text", ...(input.model.capabilities.input.image ? (["image"] as const) : [])],
    cost: template?.cost ?? modelCost(input.model),
    contextWindow: input.model.limit.context,
    maxTokens: input.model.limit.output,
    samplingParams: { ...template?.samplingParams, ...current.samplingParams },
    headers: { ...template?.headers, ...input.runtime.headers },
    compat: { ...(isRecord(template?.compat) ? template.compat : {}), ...current.compat },
  }
  return result as Model<Api>
}

async function apiStreams(): Promise<Partial<Record<Api, ProviderStreams>>> {
  const [anthropic, completions, responses, codex, azure, google, vertex, mistral, bedrock, piMessages] =
    await Promise.all([
      import("@earendil-works/pi-ai/api/anthropic-messages.lazy"),
      import("@earendil-works/pi-ai/api/openai-completions.lazy"),
      import("@earendil-works/pi-ai/api/openai-responses.lazy"),
      import("@earendil-works/pi-ai/api/openai-codex-responses.lazy"),
      import("@earendil-works/pi-ai/api/azure-openai-responses.lazy"),
      import("@earendil-works/pi-ai/api/google-generative-ai.lazy"),
      import("@earendil-works/pi-ai/api/google-vertex.lazy"),
      import("@earendil-works/pi-ai/api/mistral-conversations.lazy"),
      import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy"),
      import("@earendil-works/pi-ai/api/pi-messages.lazy"),
    ])
  return {
    "anthropic-messages": anthropic.anthropicMessagesApi(),
    "openai-completions": completions.openAICompletionsApi(),
    "openai-responses": responses.openAIResponsesApi(),
    "openai-codex-responses": codex.openAICodexResponsesApi(),
    "azure-openai-responses": azure.azureOpenAIResponsesApi(),
    "google-generative-ai": google.googleGenerativeAIApi(),
    "google-vertex": vertex.googleVertexApi(),
    "mistral-conversations": mistral.mistralConversationsApi(),
    "bedrock-converse-stream": bedrock.bedrockConverseStreamApi(),
    "pi-messages": piMessages.piMessagesApi(),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const fsys = yield* FSUtil.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("PiAIModels.state")(function* () {
        const bridge = yield* EffectBridge.make()
        const [{ builtinModels }, { registerBunOAuthFlows }] = yield* Effect.promise(() =>
          Promise.all([import("@earendil-works/pi-ai/providers/all"), import("@earendil-works/pi-ai/bun-oauth")]),
        )
        registerBunOAuthFlows()
        return {
          models: builtinModels({
            credentials: PiAICredentials.make({ auth, bridge }),
            authContext: {
              env: (name) => bridge.promise(env.get(name)),
              fileExists: (value) =>
                bridge.promise(
                  fsys.existsSafe(value.startsWith("~/") ? path.join(Global.Path.home, value.slice(2)) : value),
                ),
            },
          }),
          custom: new Map(),
          resolved: new Map(),
        }
      }),
    )

    const ensureProvider = (current: State, input: ResolveInput, model: Model<Api>) => {
      if (current.models.getProvider(model.provider)) return Effect.void
      const existing = current.custom.get(model.provider)
      if (existing) return Effect.promise(() => existing)
      const load = Promise.all([import("@earendil-works/pi-ai"), apiStreams()]).then(([pi, api]) => {
        current.models.setProvider(
          pi.createProvider({
            id: model.provider,
            name: input.provider.name,
            auth: {
              apiKey: pi.envApiKeyAuth(`${input.provider.name} API key`, input.provider.env),
            },
            models: [],
            api,
          }),
        )
      })
      current.custom.set(model.provider, load)
      return Effect.promise(() => load)
    }

    const resolve = Effect.fn("PiAIModels.resolve")(function* (input: ResolveInput) {
      if (!enabled(input.gate, input.model.providerID)) {
        return { type: "unsupported" as const, reason: "pi-ai is not enabled for this provider" }
      }
      if (input.model.api.npm === "gitlab-ai-provider") {
        return { type: "unsupported" as const, reason: "GitLab workflow models require the AI SDK runtime" }
      }

      const current = yield* InstanceState.get(state)
      const model = resolvedModel(input, current.models)
      if (!model) {
        return { type: "unsupported" as const, reason: "model API or base URL cannot be resolved by pi-ai" }
      }
      yield* ensureProvider(current, input, model)
      current.resolved.set(`${input.model.providerID}/${input.model.id}`, model)
      current.resolved.set(`${input.model.providerID}/${input.model.api.id}`, model)
      return {
        type: "supported" as const,
        models: current.models,
        model,
        settings: settings(input),
        source(providerID: string, modelID: string) {
          const known = current.resolved.get(`${providerID}/${modelID}`)
          if (known) return known
          const direct = current.models.getModel(providerID, modelID)
          if (direct) return direct
          if (providerID === "azure") return current.models.getModel("azure-openai-responses", modelID)
          if (providerID === "vercel") return current.models.getModel("vercel-ai-gateway", modelID)
          if (providerID === "openai")
            return current.models.getModel("openai-codex", modelID) ?? current.models.getModel("openai", modelID)
          return undefined
        },
      }
    })

    const models = Effect.fn("PiAIModels.models")(() => InstanceState.use(state, (current) => current.models))
    return Service.of({ resolve, models })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Auth.node, Env.node, FSUtil.node],
})

export * as PiAIModels from "./pi-ai-models"
