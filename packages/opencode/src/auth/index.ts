import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flock } from "@opencode-ai/core/util/flock"
import { randomUUID } from "crypto"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly modify: <E, R>(
    key: string,
    update: (current: Info | undefined) => Effect.Effect<Info | undefined, E, R>,
  ) => Effect.Effect<Info | undefined, AuthError | E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const normalize = (key: string) => key.replace(/\/+$/, "")

    const read = Effect.fn("Auth.read")(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const write = Effect.fn("Auth.write")(
      function* (data: Record<string, Info>) {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
        yield* fsys.writeFileString(temporary, JSON.stringify(data, null, 2))
        yield* fsys.chmod(temporary, 0o600)
        yield* fsys.rename(temporary, file)
      },
      Effect.mapError(fail("Failed to write auth data")),
    )

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      return yield* read()
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const modify: Interface["modify"] = Effect.fn("Auth.modify")(function* (key, update) {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        return yield* new AuthError({ message: "Cannot modify auth while OPENCODE_AUTH_CONTENT is set" })
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`auth:${file}`)
          const norm = normalize(key)
          const data = yield* read()
          const current = data[norm] ?? data[key] ?? data[norm + "/"]
          const next = yield* update(current)
          if (next === undefined) return current
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          data[norm] = next
          yield* write(data)
          return next
        }),
      )
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* modify(key, () => Effect.succeed(info))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        return yield* new AuthError({ message: "Cannot modify auth while OPENCODE_AUTH_CONTENT is set" })
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`auth:${file}`)
          const norm = normalize(key)
          const data = yield* read()
          delete data[key]
          delete data[norm]
          delete data[norm + "/"]
          yield* write(data)
        }),
      )
    })

    return Service.of({ get, all, set, remove, modify })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
