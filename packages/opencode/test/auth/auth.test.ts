import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Schema } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"
import { EffectBridge } from "@/effect/bridge"
import { PiAICredentials } from "@/session/llm/pi-ai-credentials"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("preserves JSON-safe OAuth metadata", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const value = Schema.decodeUnknownSync(Auth.Info)({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: 1,
        metadata: {
          availableModelIds: ["gpt-5", "claude-sonnet"],
          nested: { enabled: true },
        },
      })
      yield* auth.set("github-copilot", value)
      expect(yield* auth.get("github-copilot")).toEqual(value)
    }),
  )

  it.instance("serializes concurrent modifications without losing updates", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("counter", { type: "api", key: "0" })
      yield* Effect.forEach(
        Array.from({ length: 20 }),
        () =>
          auth.modify("counter", (current) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow
              const value = current?.type === "api" ? Number(current.key) : 0
              return new Auth.Api({ type: "api", key: String(value + 1) })
            }),
          ),
        { concurrency: "unbounded", discard: true },
      )
      expect(yield* auth.get("counter")).toEqual({ type: "api", key: "20" })
    }),
  )

  it.instance("modify preserves the current credential when the callback returns undefined", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", { type: "api", key: "sk-test" })
      const result = yield* auth.modify("anthropic", () => Effect.succeed(undefined))
      expect(result).toEqual({ type: "api", key: "sk-test" })
      expect(yield* auth.get("anthropic")).toEqual(result)
    }),
  )

  it.instance("rejects writes while OPENCODE_AUTH_CONTENT is set", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ anthropic: { type: "api", key: "fixed" } })
      const result = yield* auth.set("anthropic", { type: "api", key: "changed" }).pipe(Effect.exit)
      delete process.env.OPENCODE_AUTH_CONTENT
      expect(result._tag).toBe("Failure")
    }),
  )

  it.instance("bridges API and OAuth credentials through canonical pi provider aliases", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const store = PiAICredentials.make({ auth, bridge: yield* EffectBridge.make() })

      yield* auth.set("cloudflare-ai-gateway", {
        type: "api",
        key: "cloudflare-key",
        metadata: { accountId: "account", gatewayId: "gateway" },
      })
      expect(yield* Effect.promise(() => store.read("cloudflare-ai-gateway"))).toEqual({
        type: "api_key",
        key: "cloudflare-key",
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_GATEWAY_ID: "gateway",
        },
      })

      yield* Effect.promise(() =>
        store.modify("openai-codex", async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: 10,
          accountId: "account-id",
          availableModelIds: ["gpt-5"],
        })),
      )
      expect(yield* auth.get("openai")).toEqual({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: 10,
        accountId: "account-id",
        metadata: { availableModelIds: ["gpt-5"] },
      })
      expect(yield* Effect.promise(() => store.read("openai-codex"))).toMatchObject({
        type: "oauth",
        accountId: "account-id",
        availableModelIds: ["gpt-5"],
      })
      expect(yield* Effect.promise(() => store.list())).toEqual(
        expect.arrayContaining([{ providerId: "openai-codex", type: "oauth" }]),
      )
    }),
  )
})
