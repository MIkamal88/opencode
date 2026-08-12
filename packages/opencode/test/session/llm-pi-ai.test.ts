import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Usage } from "@opencode-ai/llm"
import { Effect, Stream } from "effect"
import { jsonSchema, tool, type JSONSchema7, type ModelMessage } from "ai"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai"
import { PiAIModels } from "@/session/llm/pi-ai-models"
import { PiAIRequest } from "@/session/llm/pi-ai-request"
import { PiAIRuntime } from "@/session/llm/pi-ai-runtime"
import { PiAIProviderError } from "@/session/llm/pi-ai-events"
import { PiAIAuth } from "@/session/llm/pi-ai-auth"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { Auth } from "@/auth"

const it = testEffect(LayerNode.compile(LayerNode.group([PiAIModels.node, Auth.node])))

describe("session.llm.pi-ai models", () => {
  it.instance("lazily registers the complete built-in provider collection", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const models = yield* service.models()
      expect(models.getProviders().length).toBeGreaterThanOrEqual(40)
      expect(models.getProvider("anthropic")).toBeDefined()
      expect(models.getProvider("openai-codex")).toBeDefined()
      expect(models.getProvider("openrouter")).toBeDefined()
      expect(models.getProvider("opencode-go")).toBeDefined()
    }),
  )

  it.instance("uses a pi catalog model as the runtime template", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const models = yield* service.models()
      const template = models.getModels("anthropic")[0]
      if (!template) return yield* Effect.die("missing anthropic test model")
      const model = ProviderTest.model({
        id: ModelV2.ID.make(template.id),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { id: template.id, url: "https://catalog.example.test/v1", npm: "@ai-sdk/anthropic" },
        name: template.name,
        capabilities: {
          ...ProviderTest.model().capabilities,
          reasoning: template.reasoning,
          input: {
            ...ProviderTest.model().capabilities.input,
            image: template.input.includes("image"),
          },
        },
      })
      const provider = ProviderTest.info({ id: ProviderV2.ID.make("anthropic") }, model)
      const result = yield* service.resolve({
        gate: true,
        model,
        provider,
        auth: undefined,
        runtime: { baseURL: "https://catalog.example.test/v1", options: {} },
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.model).toMatchObject({
        provider: "anthropic",
        id: template.id,
        api: template.api,
        baseUrl: template.baseUrl,
        compat: template.compat,
      })
    }),
  )

  it.instance("preserves an explicit base URL over a pi catalog template", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const models = yield* service.models()
      const template = models.getModels("anthropic")[0]
      if (!template) return yield* Effect.die("missing anthropic test model")
      const model = ProviderTest.model({
        id: ModelV2.ID.make(template.id),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { id: template.id, url: "https://catalog.example.test/v1", npm: "@ai-sdk/anthropic" },
      })
      const provider = ProviderTest.info(
        { id: ProviderV2.ID.make("anthropic"), options: { baseURL: "https://proxy.example.test" } },
        model,
      )
      const result = yield* service.resolve({
        gate: true,
        model,
        provider,
        auth: undefined,
        runtime: { baseURL: "https://proxy.example.test", options: { baseURL: "https://proxy.example.test" } },
        explicitBaseURL: true,
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.model.baseUrl).toBe("https://proxy.example.test")
    }),
  )

  it.instance("preserves an explicit provider API over a pi catalog template", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const models = yield* service.models()
      const template = models.getModels("anthropic")[0]
      if (!template) return yield* Effect.die("missing anthropic test model")
      const model = ProviderTest.model({
        id: ModelV2.ID.make(template.id),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { id: template.id, url: "https://proxy.example.test", npm: "@ai-sdk/anthropic" },
      })
      const result = yield* service.resolve({
        gate: true,
        model,
        provider: ProviderTest.info({ id: ProviderV2.ID.make("anthropic") }, model),
        auth: undefined,
        runtime: { baseURL: "https://proxy.example.test", options: {} },
        explicitBaseURL: true,
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.model.baseUrl).toBe("https://proxy.example.test")
    }),
  )

  it.instance("uses zero catalog cost for Anthropic subscription plugin requests", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const models = yield* service.models()
      const template = models.getModels("anthropic")[0]
      if (!template) return yield* Effect.die("missing anthropic test model")
      const model = ProviderTest.model({
        id: ModelV2.ID.make(template.id),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { id: template.id, url: template.baseUrl, npm: "@ai-sdk/anthropic" },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      })
      const customFetch = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
        { preconnect: () => undefined },
      ) satisfies typeof fetch
      const result = yield* service.resolve({
        gate: true,
        model,
        provider: ProviderTest.info({ id: ProviderV2.ID.make("anthropic") }, model),
        auth: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 60_000 },
        runtime: { baseURL: template.baseUrl, apiKey: "", fetch: customFetch, authPlugin: true, options: {} },
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.model.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

      const metered = yield* service.resolve({
        gate: true,
        model,
        provider: ProviderTest.info({ id: ProviderV2.ID.make("anthropic") }, model),
        auth: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 60_000 },
        runtime: { baseURL: template.baseUrl, fetch: customFetch, options: {} },
      })
      expect(metered.type).toBe("supported")
      if (metered.type === "unsupported") return
      expect(metered.model.cost).toEqual(template.cost)
    }),
  )

  it.instance("constructs and registers an unmatched OpenAI-compatible provider", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const model = ProviderTest.model({
        id: ModelV2.ID.make("local-model"),
        providerID: ProviderV2.ID.make("local-test"),
        api: {
          id: "upstream-local-model",
          url: "http://127.0.0.1:11434/v1",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const provider = ProviderTest.info(
        {
          id: ProviderV2.ID.make("local-test"),
          env: [],
          options: { pi_ai: { compat: { supportsUsageInStreaming: false } } },
        },
        model,
      )
      const result = yield* service.resolve({
        gate: { providers: ["local-test"] },
        model,
        provider,
        auth: undefined,
        runtime: { baseURL: "http://127.0.0.1:11434/v1", options: {} },
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.model).toMatchObject({
        provider: "local-test",
        id: "upstream-local-model",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        compat: { supportsUsageInStreaming: false },
      })
      expect(result.models.getProvider("local-test")).toBeDefined()
      expect(yield* Effect.promise(() => result.models.getAuth(result.model))).toMatchObject({
        auth: { apiKey: "unused" },
        source: "keyless provider",
      })
    }),
  )

  it.instance("declines providers outside the rollout allowlist", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const model = ProviderTest.model({ providerID: ProviderV2.ID.make("openai") })
      const result = yield* service.resolve({
        gate: { providers: ["anthropic"] },
        model,
        provider: ProviderTest.info({ id: ProviderV2.ID.make("openai") }, model),
        auth: undefined,
        runtime: { baseURL: model.api.url, options: {} },
      })
      expect(result).toEqual({ type: "unsupported", reason: "pi-ai is not enabled for this provider" })
    }),
  )

  it.instance("persists and removes an OpenCode Go API key through OpenCode auth", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const auth = yield* Auth.Service
      const models = yield* service.models()
      const method = PiAIAuth.methods(models, "opencode-go").find((item) => item.type === "api_key")
      if (!method) return yield* Effect.die("missing OpenCode Go API-key login")
      const session = PiAIAuth.start({
        models,
        method,
        interaction: {
          notify: () => {},
          prompt: async () => "go-test-key",
        },
      })

      expect(yield* Effect.promise(() => session.result)).toEqual({ type: "api_key", key: "go-test-key" })
      expect(yield* auth.get("opencode-go")).toEqual({ type: "api", key: "go-test-key", metadata: undefined })
      yield* Effect.promise(() => models.logout("opencode-go"))
      expect(yield* auth.get("opencode-go")).toBeUndefined()
    }),
  )

  it.instance("persists, refreshes, and removes Codex OAuth under the OpenAI alias", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const auth = yield* Auth.Service
      const models = yield* service.models()
      const faux = fauxProvider({ provider: "openai-codex" })
      const events: string[] = []
      let refreshes = 0
      models.setProvider({
        ...faux.provider,
        auth: {
          oauth: {
            name: "Test OAuth",
            async login(interaction) {
              interaction.notify({ type: "auth_url", url: "https://example.com/login" })
              expect(await interaction.prompt({ type: "manual_code", message: "Code" })).toBe("test-code")
              return { type: "oauth", access: "old-access", refresh: "refresh", expires: 1 }
            },
            async refresh(credential) {
              refreshes++
              return { ...credential, access: "new-access", expires: Date.now() + 60 * 60 * 1000 }
            },
            async toAuth(credential) {
              return { apiKey: credential.access }
            },
          },
        },
      })
      const method = PiAIAuth.methods(models, "openai").find((item) => item.type === "oauth")
      if (!method) return yield* Effect.die("missing test OAuth login")
      const session = PiAIAuth.start({
        models,
        method,
        interaction: {
          notify: (input) => events.push(`${input.sessionID}:${input.event.type}`),
          prompt: async (input) => {
            events.push(`${input.sessionID}:${input.prompt.type}`)
            return "test-code"
          },
        },
      })

      yield* Effect.promise(() => session.result)
      expect(yield* auth.get("openai")).toMatchObject({ type: "oauth", access: "old-access" })
      expect(yield* Effect.promise(() => models.getAuth("openai-codex"))).toMatchObject({
        auth: { apiKey: "new-access" },
        source: "OAuth",
      })
      expect(refreshes).toBe(1)
      expect(events).toEqual([`${session.id}:auth_url`, `${session.id}:manual_code`])
      expect(yield* auth.get("openai")).toMatchObject({ type: "oauth", access: "new-access" })
      yield* Effect.promise(() => models.logout("openai-codex"))
      expect(yield* auth.get("openai")).toBeUndefined()
    }),
  )

  it.instance("carries a stored Codex account ID through Models dispatch", () =>
    Effect.gen(function* () {
      const service = yield* PiAIModels.Service
      const auth = yield* Auth.Service
      const models = yield* service.models()
      const token = [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify({ sub: "claimless" })).toString("base64url"),
        "signature",
      ].join(".")
      yield* auth.set("openai", {
        type: "oauth",
        access: token,
        refresh: "refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "account-test",
      })

      expect(yield* Effect.promise(() => models.getAuth("openai-codex"))).toMatchObject({
        auth: { apiKey: token, headers: { "chatgpt-account-id": "account-test" } },
      })
      const model = models.getModels("openai-codex")[0]
      if (!model) return yield* Effect.die("missing Codex test model")
      const sent = Promise.withResolvers<Headers>()
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          sent.resolve(new Request(input, init).headers)
          return new Response(JSON.stringify({ error: { message: "expected test stop" } }), { status: 400 })
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch
      const events = models.streamSimple(
        model,
        { systemPrompt: "system", messages: [{ role: "user", content: "test", timestamp: 1 }], tools: [] },
        {
          transport: "sse",
          maxRetries: 0,
          fetch: customFetch,
        },
      )
      yield* Effect.promise(async () => {
        for await (const event of events) {
          if (event.type === "error") return
        }
      })
      const headers = yield* Effect.promise(() => sent.promise)
      expect(headers.get("authorization")).toBe(`Bearer ${token}`)
      expect(headers.get("chatgpt-account-id")).toBe("account-test")
      yield* auth.remove("openai")
    }),
  )

  it.instance("converts canonical history into source-aware pi messages", () =>
    Effect.gen(function* () {
      const source: Model<"anthropic-messages"> = {
        id: "claude-test",
        name: "Claude Test",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 8_000,
      }
      const sessionID = SessionID.make("ses_pi_history")
      const userID = MessageID.make("msg_pi_user")
      const assistantID = MessageID.make("msg_pi_assistant")
      const history: SessionV1.WithParts[] = [
        {
          info: {
            id: userID,
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-test") },
          },
          parts: [{ id: PartID.make("prt_pi_user"), messageID: userID, sessionID, type: "text", text: "hello" }],
        },
        {
          info: {
            id: assistantID,
            parentID: userID,
            sessionID,
            role: "assistant",
            time: { created: 2, completed: 3 },
            modelID: ModelV2.ID.make("claude-test"),
            providerID: ProviderV2.ID.make("anthropic"),
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0.1,
            tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
            finish: "tool-calls",
          },
          parts: [
            { id: PartID.make("prt_pi_step"), messageID: assistantID, sessionID, type: "step-start" },
            {
              id: PartID.make("prt_pi_reasoning"),
              messageID: assistantID,
              sessionID,
              type: "reasoning",
              text: "thinking",
              time: { start: 2, end: 2 },
              metadata: {
                pi: {
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "claude-test",
                  content: { thinkingSignature: "signed-thinking" },
                },
              },
            },
            {
              id: PartID.make("prt_pi_tool"),
              messageID: assistantID,
              sessionID,
              type: "tool",
              callID: "call-1",
              tool: "lookup",
              state: {
                status: "completed",
                input: { query: "weather" },
                output: "sunny",
                title: "Lookup",
                metadata: {},
                time: { start: 2, end: 3 },
              },
              metadata: { pi: { content: { thoughtSignature: "signed-call" } } },
            },
            {
              id: PartID.make("prt_pi_finish"),
              messageID: assistantID,
              sessionID,
              type: "step-finish",
              reason: "tool-calls",
              cost: 0.1,
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
            },
          ],
        },
      ]
      const result = yield* Effect.promise(() =>
        PiAIRequest.prepare({
          model: source,
          system: ["system"],
          history,
          messages: [],
          tools: {},
          abort: new AbortController().signal,
          source: () => source,
        }),
      )
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.context.messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "thinking", thinkingSignature: "signed-thinking" },
            {
              type: "toolCall",
              id: "call-1",
              name: "lookup",
              arguments: { query: "weather" },
              thoughtSignature: "signed-call",
            },
          ],
        },
        { role: "toolResult", toolCallId: "call-1", toolName: "lookup", isError: false },
      ])
    }),
  )

  it.instance("closes object tool schemas before enabling constrained sampling", () =>
    Effect.gen(function* () {
      const faux = fauxProvider({ provider: "faux-opencode" })
      const result = yield* Effect.promise(() =>
        PiAIRequest.prepare({
          model: faux.getModel(),
          system: ["system"],
          messages: [{ role: "user", content: "lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup",
              strict: true,
              inputSchema: jsonSchema({
                type: "object",
                properties: {
                  query: { type: "string" },
                  options: {
                    type: "object",
                    properties: { limit: { type: "number" } },
                    required: ["limit"],
                  },
                  mode: { enum: [{ type: "object", properties: { untouched: true } }] },
                },
                required: ["query", "options", "mode"],
              }),
            }),
            bounded: tool({
              description: "Bounded lookup",
              inputSchema: jsonSchema({
                type: "object",
                properties: { limit: { type: "integer", minimum: 0 } },
                required: ["limit"],
              }),
            }),
          },
          abort: new AbortController().signal,
          source: () => faux.getModel(),
        }),
      )
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      expect(result.context.tools).toMatchObject([
        {
          name: "lookup",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              options: { type: "object", additionalProperties: false },
              mode: { enum: [{ type: "object", properties: { untouched: true } }] },
            },
          },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
        {
          name: "bounded",
          parameters: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 0 } },
          },
          constrainedSampling: false,
        },
      ])

      yield* Effect.promise(async () => {
        const invalidSchemas: JSONSchema7[] = [
          {
            type: "object",
            properties: { optional: { type: "string" } },
            required: [],
          },
          {
            type: "object",
            properties: {
              tuple: {
                type: "array",
                items: [
                  {
                    type: "object",
                    properties: { optional: { type: "string" } },
                    required: [],
                  },
                ],
              },
            },
            required: ["tuple"],
          },
        ]
        for (const inputSchema of invalidSchemas) {
          await expect(
            PiAIRequest.prepare({
              model: faux.getModel(),
              system: ["system"],
              messages: [{ role: "user", content: "lookup" }],
              tools: { invalid: tool({ strict: true, inputSchema: jsonSchema(inputSchema) }) },
              abort: new AbortController().signal,
              source: () => faux.getModel(),
            }),
          ).rejects.toThrow('Tool "invalid" requires strict sampling but its schema is not strict-compatible')
        }
      })
    }),
  )

  it.instance("streams faux pi events and executes an OpenCode tool exactly once", () =>
    Effect.gen(function* () {
      const faux = fauxProvider({ provider: "faux-opencode" })
      const models = createModels()
      models.setProvider(faux.provider)
      faux.setResponses([
        fauxAssistantMessage(
          [fauxThinking("checking"), fauxToolCall("lookup", { query: "weather" }, { id: "call-1" })],
          { stopReason: "toolUse" },
        ),
      ])
      const model = faux.getModel()
      let executions = 0
      const messages: ModelMessage[] = [{ role: "user", content: "weather?" }]
      const result = yield* PiAIRuntime.stream({
        resolved: {
          type: "supported",
          models,
          model,
          settings: {},
          source: () => model,
        },
        runtime: { apiKey: "unused", options: {} },
        system: ["system"],
        messages,
        tools: {
          lookup: tool({
            description: "Lookup weather",
            inputSchema: jsonSchema({
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            }),
            execute: async () => {
              executions++
              return { output: "sunny", title: "Lookup", metadata: {} }
            },
          }),
        },
        headers: {},
        sessionID: "ses_pi_runtime",
        abort: new AbortController().signal,
      })
      expect(result.type).toBe("supported")
      if (result.type === "unsupported") return
      const events = Array.from(yield* result.stream.pipe(Stream.runCollect))
      expect(executions).toBe(1)
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1)
      expect(events.find((event) => event.type === "step-finish")).toMatchObject({
        reason: "tool-calls",
        providerMetadata: { pi: { provider: "faux-opencode" } },
      })
    }),
  )

  it.instance("maps pi provider failures and authoritative cost into OpenCode session semantics", () =>
    Effect.gen(function* () {
      const response = fauxAssistantMessage("partial", {
        stopReason: "error",
        errorMessage: "temporary upstream failure",
      })
      const error = new PiAIProviderError(response, true)
      expect(MessageV2.fromError(error, { providerID: ProviderV2.ID.make("faux-opencode") })).toMatchObject({
        name: "APIError",
        data: {
          message: "temporary upstream failure",
          isRetryable: true,
          metadata: { provider: "faux", api: "faux", model: "faux-1" },
        },
      })

      const model = ProviderTest.model({
        cost: { input: 100, output: 100, cache: { read: 100, write: 100 } },
      })
      const current = SessionNs.getUsage({
        model,
        usage: new Usage({
          inputTokens: 10,
          outputTokens: 10,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 20,
        }),
        metadata: { pi: { usage: { cost: { total: 1.2345 } } } },
      })
      expect(current.cost).toBe(1.2345)
    }),
  )
})
