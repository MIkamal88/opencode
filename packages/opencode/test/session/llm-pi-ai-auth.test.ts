import { describe, expect, test } from "bun:test"
import type { AuthInteraction, Credential, OAuthAuth, Provider, ProviderAuth } from "@earendil-works/pi-ai"
import { builtinModels } from "@earendil-works/pi-ai/providers/all"
import { PiAIAuth } from "@/session/llm/pi-ai-auth"

const unusedStream = () => {
  throw new Error("streaming is not used by auth tests")
}

function provider(id: string, auth: ProviderAuth): Provider {
  return {
    id,
    name: id,
    auth,
    getModels: () => [],
    stream: unusedStream,
    streamSimple: unusedStream,
  }
}

function oauth(name: string, login: OAuthAuth["login"]): OAuthAuth {
  return {
    name,
    login,
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  }
}

function runtime(input: {
  providers: Record<string, Provider>
  login?: (providerID: string, type: "api_key" | "oauth", interaction: AuthInteraction) => Promise<Credential>
}): PiAIAuth.Runtime {
  return {
    getProvider: (id) => input.providers[id],
    login:
      input.login ??
      (async () => ({
        type: "api_key",
        key: "unused",
      })),
  }
}

describe("PiAIAuth", () => {
  test("discovers required built-in login methods", () => {
    const models = builtinModels()
    expect(PiAIAuth.methods(models, "anthropic").map((method) => method.type)).toEqual(["oauth", "api_key"])
    expect(PiAIAuth.methods(models, "openai").map((method) => method.type)).toEqual(["oauth", "api_key"])
    expect(PiAIAuth.methods(models, "openrouter").map((method) => method.type)).toEqual(["oauth", "api_key"])
    expect(PiAIAuth.methods(models, "opencode-go").map((method) => method.type)).toEqual(["api_key"])
  })

  test("maps OpenAI OAuth to Codex while keeping API-key OpenAI", () => {
    const models = runtime({
      providers: {
        openai: provider("openai", {
          apiKey: {
            name: "OpenAI API key",
            login: async () => ({ type: "api_key", key: "key" }),
            resolve: async () => undefined,
          },
        }),
        "openai-codex": provider("openai-codex", {
          oauth: oauth("OpenAI subscription", async () => ({
            type: "oauth",
            access: "access",
            refresh: "refresh",
            expires: 1,
          })),
        }),
      },
    })

    expect(PiAIAuth.methods(models, "openai")).toEqual([
      { type: "oauth", label: "OpenAI subscription", providerID: "openai-codex" },
      { type: "api_key", label: "OpenAI API key", providerID: "openai" },
    ])
  })

  test("forwards dynamic prompts and events with one session ID", async () => {
    const seen: string[] = []
    const models = runtime({
      providers: {},
      login: async (providerID, type, interaction) => {
        expect(providerID).toBe("test")
        expect(type).toBe("oauth")
        interaction.notify({ type: "progress", message: "Starting" })
        expect(
          await interaction.prompt({
            type: "select",
            message: "Method",
            options: [{ id: "browser", label: "Browser" }],
          }),
        ).toBe("browser")
        return { type: "oauth", access: "access", refresh: "refresh", expires: 1 }
      },
    })
    const session = PiAIAuth.start({
      models,
      method: { type: "oauth", label: "OAuth", providerID: "test" },
      interaction: {
        notify: (input) => seen.push(`notify:${input.sessionID}:${input.event.type}`),
        prompt: async (input) => {
          seen.push(`prompt:${input.sessionID}:${input.prompt.type}`)
          return "browser"
        },
      },
    })

    expect(await session.result).toEqual({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 1,
    })
    expect(session.id).toStartWith("auth_")
    expect(seen).toEqual([`notify:${session.id}:progress`, `prompt:${session.id}:select`])
  })

  test("cancels the login and every pending host prompt", async () => {
    const ready = Promise.withResolvers<AbortSignal>()
    const models = runtime({
      providers: {},
      login: async (_providerID, _type, interaction) => {
        await interaction.prompt({ type: "manual_code", message: "Code" })
        return { type: "api_key", key: "unreachable" }
      },
    })
    const session = PiAIAuth.start({
      models,
      method: { type: "oauth", label: "OAuth", providerID: "test" },
      interaction: {
        notify: () => {},
        prompt: (input) => {
          ready.resolve(input.prompt.signal!)
          return new Promise((_resolve, reject) => {
            input.prompt.signal!.addEventListener("abort", () => reject(input.prompt.signal!.reason), { once: true })
          })
        },
      },
    })
    const signal = await ready.promise
    const result = session.result.then(
      () => undefined,
      (error: unknown) => error,
    )
    session.cancel()

    expect(signal.aborted).toBe(true)
    expect(await result).toBeDefined()
  })

  test("allows a provider callback to cancel only its pending manual prompt", async () => {
    const prompt = new AbortController()
    const models = runtime({
      providers: {},
      login: async (_providerID, _type, interaction) => {
        const answer = interaction.prompt({ type: "manual_code", message: "Code", signal: prompt.signal })
        prompt.abort()
        await answer.catch(() => undefined)
        return { type: "oauth", access: "access", refresh: "refresh", expires: 1 }
      },
    })
    const session = PiAIAuth.start({
      models,
      method: { type: "oauth", label: "OAuth", providerID: "test" },
      interaction: {
        notify: () => {},
        prompt: (input) =>
          new Promise((_resolve, reject) => {
            input.prompt.signal!.addEventListener("abort", () => reject(input.prompt.signal!.reason), { once: true })
          }),
      },
    })

    expect(await session.result).toEqual({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 1,
    })
  })
})
