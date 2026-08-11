import type { Auth } from "@/auth"
import type { EffectBridge } from "@/effect/bridge"
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"
import { Effect, Schema } from "effect"

const aliases: Record<string, string> = {
  "openai-codex": "openai",
  "azure-openai-responses": "azure",
  "vercel-ai-gateway": "vercel",
}

const metadataEnv: Record<string, Record<string, string>> = {
  "cloudflare-ai-gateway": {
    accountId: "CLOUDFLARE_ACCOUNT_ID",
    gatewayId: "CLOUDFLARE_GATEWAY_ID",
  },
  "cloudflare-workers-ai": {
    accountId: "CLOUDFLARE_ACCOUNT_ID",
  },
}

function canonical(providerID: string) {
  return aliases[providerID] ?? providerID
}

function apiEnv(providerID: string, metadata: Record<string, string> | undefined) {
  if (!metadata) return undefined
  const mapping = metadataEnv[providerID] ?? {}
  const result = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [mapping[key] ?? key, value]))
  return Object.keys(result).length === 0 ? undefined : result
}

function apiMetadata(providerID: string, env: Record<string, string> | undefined) {
  if (!env) return undefined
  const mapping = Object.fromEntries(Object.entries(metadataEnv[providerID] ?? {}).map(([key, value]) => [value, key]))
  const result = Object.fromEntries(Object.entries(env).map(([key, value]) => [mapping[key] ?? key, value]))
  return Object.keys(result).length === 0 ? undefined : result
}

export function toCredential(providerID: string, info: Auth.Info | undefined): Credential | undefined {
  if (!info || info.type === "wellknown") return undefined
  if (info.type === "api") {
    return {
      type: "api_key",
      key: info.key,
      env: apiEnv(providerID, info.metadata),
    }
  }
  return {
    ...info.metadata,
    type: "oauth",
    refresh: info.refresh,
    access: info.access,
    expires: info.expires,
    ...(info.accountId ? { accountId: info.accountId } : {}),
    ...(info.enterpriseUrl ? { enterpriseUrl: info.enterpriseUrl } : {}),
  }
}

export function fromCredential(providerID: string, credential: Credential): Auth.Info {
  if (credential.type === "api_key") {
    return {
      type: "api",
      key: credential.key ?? "",
      metadata: apiMetadata(providerID, credential.env),
    }
  }

  const { type: _, refresh, access, expires, accountId, enterpriseUrl, ...rest } = credential
  const metadata = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    Object.fromEntries(Object.entries(rest).filter((entry) => Schema.is(Schema.Json)(entry[1]))),
  )
  return {
    type: "oauth",
    refresh,
    access,
    expires,
    accountId: typeof accountId === "string" ? accountId : undefined,
    enterpriseUrl: typeof enterpriseUrl === "string" ? enterpriseUrl : undefined,
    metadata: Object.keys(metadata).length === 0 ? undefined : metadata,
  }
}

function providerID(key: string, info: Auth.Info) {
  if (key === "openai" && info.type === "oauth") return "openai-codex"
  if (key === "azure") return "azure-openai-responses"
  if (key === "vercel") return "vercel-ai-gateway"
  return key
}

export function make(input: { auth: Auth.Interface; bridge: EffectBridge.Shape }): CredentialStore {
  const abort = (options: AuthOperationOptions | undefined) => options?.signal?.throwIfAborted()

  return {
    async read(providerId, options) {
      abort(options)
      return toCredential(providerId, await input.bridge.promise(input.auth.get(canonical(providerId))))
    },
    async list(options) {
      abort(options)
      const values = await input.bridge.promise(input.auth.all())
      return Object.entries(values).flatMap(([key, info]): CredentialInfo[] => {
        const credential = toCredential(providerID(key, info), info)
        return credential ? [{ providerId: providerID(key, info), type: credential.type }] : []
      })
    },
    async modify(providerId, update, options) {
      abort(options)
      return input.bridge.promise(
        input.auth
          .modify(canonical(providerId), (current) =>
            Effect.promise(() => update(toCredential(providerId, current))).pipe(
              Effect.map((next) => (next ? fromCredential(providerId, next) : undefined)),
            ),
          )
          .pipe(Effect.map((next) => toCredential(providerId, next))),
      )
    },
    async delete(providerId, options) {
      abort(options)
      await input.bridge.promise(input.auth.remove(canonical(providerId)))
    },
  }
}

export * as PiAICredentials from "./pi-ai-credentials"
