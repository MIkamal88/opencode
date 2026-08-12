import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionSummary } from "@/session/summary"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { httpError, raw, reply, TestLLMServer } from "../lib/llm-server"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in pi integration tests"),
    authenticate: () => Effect.die("unexpected MCP auth in pi integration tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in pi integration tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Permission.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const localRef = {
  providerID: ProviderV2.ID.make("pi-local"),
  modelID: ModelV2.ID.make("pi-local-model"),
}

function localConfig(url: string) {
  return {
    autoupdate: false,
    share: "disabled" as const,
    enabled_providers: ["pi-local"],
    experimental: { pi_ai: { providers: ["pi-local"] } },
    provider: {
      "pi-local": {
        name: "Pi Local",
        env: [],
        npm: "@invalid/pi-integration-provider",
        api: url,
        models: {
          "pi-local-model": {
            id: "upstream-pi-local",
            name: "Pi Local Model",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2026-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 2, output: 4, cache_read: 1, cache_write: 3 },
            modalities: { input: ["text"], output: ["text"] },
            options: { pi_ai: { api: "openai-completions" } },
          },
        },
        options: { apiKey: "offline-test-key", baseURL: url },
      },
    },
  }
}

const setup = Effect.fn("test.piIntegration.setup")(function* () {
  const test = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(
      path.join(test.directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...localConfig(llm.url) }),
    ),
  )
  return { directory: test.directory, llm }
})

const promptUser = Effect.fn("test.piIntegration.promptUser")(function* (
  prompt: SessionPrompt.Interface,
  sessionID: SessionV1.SessionInfo["id"],
  text: string,
) {
  return yield* prompt.prompt({
    sessionID,
    agent: "build",
    model: localRef,
    noReply: true,
    parts: [{ type: "text", text }],
  })
})

const pendingPermission = (permission: Permission.Interface, name: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      return (yield* permission.list()).find((item) => item.permission === name)
    }),
    `timed out waiting for ${name} permission`,
    "10 seconds",
  )

it.instance(
  "routes local pi tools through reject and approve permissions with exactly-once execution",
  () =>
    Effect.gen(function* () {
      const { directory, llm } = yield* setup()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const output = path.join(directory, "permission-executions.txt")
      const command = `printf 'executed\\n' >> ${JSON.stringify(output)}`

      const rejected = yield* sessions.create({
        title: "pi permission reject",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "ask" },
        ],
      })
      yield* promptUser(prompt, rejected.id, "reject this tool")
      yield* llm.tool("bash", { command, description: "append execution marker" })
      const rejectedRun = yield* prompt.loop({ sessionID: rejected.id }).pipe(Effect.forkChild)
      const rejectedAsk = yield* pendingPermission(permission, "bash")
      yield* permission.reply({ requestID: rejectedAsk.id, reply: "reject" })
      expect(Exit.isSuccess(yield* Fiber.await(rejectedRun))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(output).exists())).toBe(false)

      const approved = yield* sessions.create({
        title: "pi permission approve",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "ask" },
        ],
      })
      yield* promptUser(prompt, approved.id, "approve this tool")
      yield* llm.tool("bash", { command, description: "append execution marker" })
      yield* llm.text("tool complete")
      const approvedRun = yield* prompt.loop({ sessionID: approved.id }).pipe(Effect.forkChild)
      const approvedAsk = yield* pendingPermission(permission, "bash")
      yield* permission.reply({ requestID: approvedAsk.id, reply: "once" })
      const approvedExit = yield* Fiber.await(approvedRun)

      expect(Exit.isSuccess(approvedExit)).toBe(true)
      expect((yield* Effect.promise(() => Bun.file(output).text())).trim().split("\n")).toEqual(["executed"])
      const tools = (yield* sessions.messages({ sessionID: approved.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
      expect(tools).toHaveLength(1)
      expect(tools[0]?.state.status).toBe("completed")
    }),
  { git: true },
  30_000,
)

it.instance(
  "asks on the third identical pi tool call and does not execute the rejected call",
  () =>
    Effect.gen(function* () {
      const { directory, llm } = yield* setup()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const output = path.join(directory, "doom-executions.txt")
      const command = `printf 'executed\\n' >> ${JSON.stringify(output)}`
      const session = yield* sessions.create({
        title: "pi doom loop",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "doom_loop", pattern: "*", action: "ask" },
        ],
      })
      yield* promptUser(prompt, session.id, "repeat the same tool")
      const calls = [0, 1, 2].map((index) => ({
        index,
        id: `doom-call-${index}`,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command, description: "append execution marker" }) },
      }))
      yield* llm.push(
        raw({
          chunks: [
            {
              id: "chatcmpl-doom",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            },
            ...calls.map((call) => ({
              id: "chatcmpl-doom",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
            })),
            {
              id: "chatcmpl-doom",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            },
          ],
        }),
      )

      const run = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      const ask = yield* pendingPermission(permission, "doom_loop")
      expect(ask.patterns).toEqual(["bash"])
      yield* permission.reply({ requestID: ask.id, reply: "reject" })
      expect(Exit.isSuccess(yield* Fiber.await(run))).toBe(true)

      const tools = (yield* sessions.messages({ sessionID: session.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "bash")
      expect(tools).toHaveLength(3)
      const completed = tools.filter((part) => part.state.status === "completed")
      expect(completed.length).toBeLessThanOrEqual(2)
      expect(tools.find((part) => part.callID === "doom-call-2")?.state.status).toBe("error")
      const executions = yield* Effect.promise(async () => {
        if (!(await Bun.file(output).exists())) return []
        return (await Bun.file(output).text()).trim().split("\n")
      })
      expect(executions.length).toBeLessThanOrEqual(2)
      expect(tools.every((part) => part.state.status === "completed" || part.state.status === "error")).toBe(true)
    }),
  { git: true },
  30_000,
)

it.instance("persists pi usage and authoritative cost on the assistant and step part", () =>
  Effect.gen(function* () {
    const { llm } = yield* setup()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "pi usage",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* promptUser(prompt, session.id, "report usage")
    yield* llm.push(reply().text("metered").usage({ input: 11, output: 7 }).stop())

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    if (result.info.role !== "assistant") return
    expect(result.info.tokens).toMatchObject({ input: 11, output: 7 })
    expect(result.info.cost).toBeCloseTo(0.00005, 8)

    const stored = yield* sessions.messages({ sessionID: session.id })
    const assistant = stored.find((message) => message.info.id === result.info.id)
    expect(assistant?.info).toMatchObject({ cost: result.info.cost, tokens: result.info.tokens })
    expect(assistant?.parts.find((part) => part.type === "step-finish")).toMatchObject({
      type: "step-finish",
      cost: result.info.cost,
      tokens: result.info.tokens,
      providerMetadata: {
        pi: {
          api: "openai-completions",
          provider: "pi-local",
          usage: {
            cost: {
              total: result.info.cost,
            },
          },
        },
      },
    })
  }),
)

it.instance("persists pi terminal metadata when the provider request fails", () =>
  Effect.gen(function* () {
    const { llm } = yield* setup()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "pi provider failure",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* promptUser(prompt, session.id, "fail this request")
    yield* llm.push(httpError(400, { error: { message: "offline provider failure" } }))

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    if (result.info.role !== "assistant") return
    expect(result.info.error).toMatchObject({
      name: "APIError",
      data: {
        message: '400: {"message":"offline provider failure"}',
        isRetryable: false,
        metadata: { api: "openai-completions", provider: "pi-local", model: "upstream-pi-local" },
      },
    })
    expect(result.info.cost).toBe(0)
    expect(result.parts.find((part) => part.type === "step-finish")).toMatchObject({
      type: "step-finish",
      reason: "error",
      cost: 0,
      providerMetadata: {
        pi: {
          api: "openai-completions",
          provider: "pi-local",
          usage: { cost: { total: 0 } },
        },
      },
    })
  }),
)

it.instance(
  "does not persist a failed pi attempt when the outer retry succeeds",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "pi provider retry",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* promptUser(prompt, session.id, "retry this request")
      yield* llm.push(httpError(500, { error: { message: "temporary provider failure" } }))
      yield* llm.push(reply().text("recovered").usage({ input: 5, output: 2 }).stop())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.error).toBeUndefined()
      expect(result.parts.filter((part) => part.type === "step-finish")).toEqual([
        expect.objectContaining({ type: "step-finish", reason: "stop" }),
      ])
      expect((yield* llm.hits).length).toBe(2)
    }),
  15_000,
)

it.instance(
  "keeps a recoverable pi context overflow non-terminal through compaction",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "pi context overflow",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* promptUser(prompt, session.id, "overflow this request")
      yield* llm.push(httpError(400, { error: { message: "context window exceeded" } }))
      yield* llm.push(reply().text("compacted summary").usage({ input: 3, output: 2 }).stop())
      yield* llm.push(reply().text("recovered after compaction").usage({ input: 4, output: 2 }).stop())

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "recovered after compaction" })]),
      )
      const stored = yield* sessions.messages({ sessionID: session.id })
      const overflow = stored.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.parentID === stored.find((item) => item.info.role === "user")?.info.id,
      )
      expect(overflow?.info.role).toBe("assistant")
      if (overflow?.info.role !== "assistant") return
      expect(overflow.info.error).toBeUndefined()
      expect(overflow.info.finish).toBeUndefined()
      expect(overflow.parts.some((part) => part.type === "step-finish")).toBe(false)
      expect(stored.flatMap((message) => message.parts).find((part) => part.type === "compaction")).toMatchObject({
        type: "compaction",
        auto: true,
        overflow: true,
      })
      expect((yield* llm.hits).length).toBe(3)
    }),
  30_000,
)

it.instance(
  "keeps an aborted pi turn coherent and continues the same session successfully",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "pi abort continuation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* promptUser(prompt, session.id, "start hanging")
      yield* llm.hang
      const run = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "pi request did not reach the faux server", "10 seconds")
      yield* awaitWithTimeout(prompt.cancel(session.id), "pi cancellation did not return", "5 seconds")
      const aborted = yield* awaitWithTimeout(Fiber.await(run), "cancelled pi loop did not settle", "5 seconds")
      expect(Exit.isSuccess(aborted)).toBe(true)
      if (Exit.isFailure(aborted) || aborted.value.info.role !== "assistant") return
      expect(aborted.value.info.error?.name).toBe("MessageAbortedError")
      expect(aborted.value.info.time.completed).toBeNumber()

      yield* promptUser(prompt, session.id, "continue after abort")
      yield* llm.text("continued successfully", { usage: { input: 4, output: 2 } })
      const continued = yield* awaitWithTimeout(
        prompt.loop({ sessionID: session.id }),
        "session did not continue after pi cancellation",
        "10 seconds",
      )
      expect(continued.info.role).toBe("assistant")
      expect(continued.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "continued successfully" })]),
      )
      const stored = yield* sessions.messages({ sessionID: session.id })
      expect(
        stored.some(
          (message) => message.info.role === "assistant" && message.info.error?.name === "MessageAbortedError",
        ),
      ).toBe(true)
      const hits = yield* llm.hits
      const history = JSON.stringify(hits.at(-1)?.body.messages)
      expect(history).toContain("start hanging")
      expect(history).toContain("continue after abort")
    }),
  { git: true },
  30_000,
)

it.instance("transforms signed Anthropic tool history into paired local-provider history", () =>
  Effect.gen(function* () {
    const { llm } = yield* setup()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "pi cross-provider history",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const sourceUser = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-source") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: sourceUser.id,
      sessionID: session.id,
      type: "text",
      text: "use the signed tool",
    })
    const sourceAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      parentID: sourceUser.id,
      sessionID: session.id,
      role: "assistant",
      time: { created: 2, completed: 3 },
      modelID: ModelV2.ID.make("claude-source"),
      providerID: ProviderV2.ID.make("anthropic"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0.01,
      tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: sourceAssistant.id,
      sessionID: session.id,
      type: "reasoning",
      text: "signed thought",
      time: { start: 2, end: 2 },
      metadata: {
        pi: {
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-source",
          content: { thinkingSignature: "anthropic-thinking-signature" },
        },
      },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: sourceAssistant.id,
      sessionID: session.id,
      type: "tool",
      callID: "cross-provider-call",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/tmp/source.txt" },
        output: "source result",
        title: "Read source",
        metadata: {},
        time: { start: 2, end: 3 },
      },
      metadata: { pi: { content: { thoughtSignature: "anthropic-tool-signature" } } },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: sourceAssistant.id,
      sessionID: session.id,
      type: "step-finish",
      reason: "tool-calls",
      cost: 0.01,
      tokens: sourceAssistant.tokens,
    })
    yield* promptUser(prompt, session.id, "continue on local")
    yield* llm.text("local accepted history")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "local accepted history" })]),
    )
    const body = (yield* llm.hits).at(-1)?.body
    const serialized = JSON.stringify(body?.messages)
    expect(serialized).toContain("cross-provider-call")
    expect(serialized).toContain("source result")
    expect(serialized).not.toContain("anthropic-thinking-signature")
    expect(serialized).not.toContain("anthropic-tool-signature")
  }),
)
