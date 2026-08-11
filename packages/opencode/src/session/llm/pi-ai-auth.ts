import type { AuthEvent, AuthPrompt, AuthType, Credential, Models } from "@earendil-works/pi-ai"
import { randomUUID } from "crypto"

export type Runtime = Pick<Models, "getProvider" | "login">
export type SessionID = `auth_${string}`

export type Method = {
  readonly type: AuthType
  readonly label: string
  readonly providerID: string
}

export type Interaction = {
  readonly prompt: (input: { readonly sessionID: SessionID; readonly prompt: AuthPrompt }) => Promise<string>
  readonly notify: (input: { readonly sessionID: SessionID; readonly event: AuthEvent }) => void
}

export type Session = {
  readonly id: SessionID
  readonly providerID: string
  readonly type: AuthType
  readonly result: Promise<Credential>
  readonly cancel: (reason?: unknown) => void
}

function runtimeProviderID(providerID: string, type: AuthType) {
  if (providerID === "openai" && type === "oauth") return "openai-codex"
  if (providerID === "azure") return "azure-openai-responses"
  if (providerID === "vercel") return "vercel-ai-gateway"
  return providerID
}

export function methods(models: Pick<Models, "getProvider">, providerID: string): Method[] {
  const oauthID = runtimeProviderID(providerID, "oauth")
  const apiKeyID = runtimeProviderID(providerID, "api_key")
  const oauth = models.getProvider(oauthID)?.auth.oauth
  const apiKey = models.getProvider(apiKeyID)?.auth.apiKey
  return [
    ...(oauth ? [{ type: "oauth" as const, label: oauth.loginLabel ?? oauth.name, providerID: oauthID }] : []),
    ...(apiKey?.login ? [{ type: "api_key" as const, label: apiKey.name, providerID: apiKeyID }] : []),
  ]
}

export function start(input: {
  readonly models: Pick<Models, "login">
  readonly method: Method
  readonly interaction: Interaction
  readonly signal?: AbortSignal
}): Session {
  const id: SessionID = `auth_${randomUUID()}`
  const controller = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
  const result = input.models.login(input.method.providerID, input.method.type, {
    signal,
    prompt(prompt) {
      return input.interaction.prompt({
        sessionID: id,
        prompt: {
          ...prompt,
          signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal,
        },
      })
    },
    notify(event) {
      input.interaction.notify({ sessionID: id, event })
    },
  })
  return {
    id,
    providerID: input.method.providerID,
    type: input.method.type,
    result,
    cancel: (reason) => controller.abort(reason),
  }
}

export * as PiAIAuth from "./pi-ai-auth"
