#!/usr/bin/env bun

import path from "path"

const providers = ["anthropic", "openai", "openrouter", "opencode-go"] as const
type Provider = (typeof providers)[number]
type CatalogModel = { id: string; api: { npm: string } }

const root = path.resolve(import.meta.dir, "..")
const source = path.join(root, "packages/opencode/src/index.ts")
const config = JSON.stringify({
  experimental: { pi_ai: { providers } },
  provider: Object.fromEntries(providers.map((provider) => [provider, {}])),
})

const args = Bun.argv.slice(2)
const values = (name: string) =>
  args
    .map((arg, index) => (arg === name ? args[index + 1] : undefined))
    .filter((value): value is string => Boolean(value))
const live = args.includes("--live")
const list = args.includes("--list")
const matrix = args.includes("--opencode-go-matrix")
const anthropicPure = args.includes("--anthropic-pure")
const prompt = values("--prompt").at(-1) ?? "Reply exactly: OK."
const timeout = Number(values("--timeout").at(-1) ?? "120000")
const requestedProviders = values("--provider")
const requestedModels = values("--model")

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: bun script/pi-m1-verify.ts [options]

  --list                         list source catalogs without model requests
  --provider <id>                select a provider (repeatable)
  --model <provider/model>       override a model (repeatable)
  --opencode-go-matrix           select all three OpenCode Go API families
  --live                         make model requests (required for dispatch)
  --anthropic-pure               bypass the installed Max compatibility plugin
  --prompt <text>                override the minimal verification prompt
  --timeout <ms>                 per-command timeout (default: 120000)

Without --live, the script queries catalogs and prints the planned requests.`)
  process.exit(0)
}

const selectedProviders = (
  requestedProviders.length
    ? requestedProviders
    : list || (!live && requestedModels.length === 0 && !matrix)
      ? providers
      : []
) as string[]
const invalidProvider = selectedProviders.find((provider) => !providers.includes(provider as Provider))
if (invalidProvider) fail(`unsupported provider: ${invalidProvider}`)
if (!Number.isFinite(timeout) || timeout < 1) fail("--timeout must be a positive number")
if (requestedModels.some((model) => !/^[a-z0-9-]+\/[A-Za-z0-9._:~/-]+$/.test(model))) fail("invalid --model value")
if (live && selectedProviders.length === 0 && requestedModels.length === 0 && !matrix)
  fail("--live requires --provider, --model, or --opencode-go-matrix")

const catalogs = new Map<Provider, CatalogModel[]>()
for (const provider of new Set<Provider>([
  ...(selectedProviders as Provider[]),
  ...requestedModels.map((model) => model.slice(0, model.indexOf("/")) as Provider),
  ...(matrix ? (["opencode-go"] as const) : []),
])) {
  if (!providers.includes(provider)) fail(`unsupported model provider: ${provider}`)
  const result = await sourceCommand(["models", provider, "--verbose"])
  if (result.exitCode !== 0) fail(`catalog query failed for ${provider} (exit ${result.exitCode})`)
  const models = parseCatalog(provider, result.stdout)
  if (models.length === 0) fail(`catalog is empty for ${provider}`)
  catalogs.set(provider, models)
}

if (list) {
  for (const [provider, models] of catalogs) {
    console.log(`${provider}:`)
    for (const model of models) console.log(`  ${provider}/${model.id}`)
  }
  process.exit(0)
}

const targets = matrix
  ? [...requestedModels]
  : requestedModels.length
    ? requestedModels
    : selectedProviders.map((provider) => {
        const model = catalogs.get(provider as Provider)?.[0]
        if (!model) return fail(`catalog is empty for ${provider}`)
        return `${provider}/${model.id}`
      })

if (matrix) {
  const models = catalogs.get("opencode-go")!
  const candidates = requestedModels.length
    ? models.filter((model) => requestedModels.includes(`opencode-go/${model.id}`))
    : models
  const families = new Map(candidates.map((model) => [apiFamily(model.api.npm), `opencode-go/${model.id}`]))
  for (const family of ["anthropic-messages", "openai-completions", "openai-responses"]) {
    const model = families.get(family)
    if (!model) fail(`OpenCode Go matrix has no ${family} model`)
    if (!targets.includes(model)) targets.push(model)
  }
}

for (const target of targets) {
  const provider = target.slice(0, target.indexOf("/")) as Provider
  const modelID = target.slice(target.indexOf("/") + 1)
  if (!providers.includes(provider)) fail(`unsupported model provider: ${provider}`)
  if (!catalogs.get(provider)?.some((model) => model.id === modelID))
    fail(`model not found in source catalog: ${target}`)
}

if (!live) {
  console.log(`DRY-RUN PASS: ${targets.length} request(s) planned; no model requests made`)
  for (const target of targets) console.log(`  ${target}${matrixApi(target, catalogs)}`)
  process.exit(0)
}

let failed = false
for (const target of targets) {
  const provider = target.slice(0, target.indexOf("/")) as Provider
  const result = await sourceCommand(
    [
      "--print-logs",
      "--log-level",
      "INFO",
      "run",
      "--format",
      "json",
      "--title",
      "Pi M1 verification",
      "--model",
      target,
      prompt,
    ],
    { pure: provider !== "anthropic" || anthropicPure },
  )
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  const finish = events.findLast((event) => event.type === "step_finish")?.part
  const model = target.slice(target.indexOf("/") + 1)
  const expectedApi = piApi(target, catalogs)
  const evidence = finishEvidence(finish, provider, expectedApi)
  const runtimeLine = result.stderr
    .split("\n")
    .find(
      (line) =>
        line.includes("llm.runtime=pi-ai") &&
        line.includes(`llm.provider=${provider}`) &&
        line.includes(`llm.model=${model}`) &&
        line.includes(`llm.pi_api=${expectedApi}`),
    )
  const runtime = runtimeLine !== undefined
  const pluginExpected = provider === "anthropic" && !anthropicPure
  const plugin = !pluginExpected || runtimeLine?.includes("llm.auth_plugin=true") === true
  const noErrors = !events.some((event) => event.type === "error")
  const passed =
    result.exitCode === 0 &&
    runtime &&
    plugin &&
    noErrors &&
    evidence.success &&
    evidence.usage &&
    evidence.cost &&
    evidence.metadata &&
    (!pluginExpected || evidence.costValue === 0)
  failed ||= !passed
  console.log(
    `${passed ? "PASS" : "FAIL"}: ${target} runtime=${runtime ? "pi-ai" : "missing"}${pluginExpected ? ` auth-plugin=${plugin ? "loaded" : "missing"}` : ""} finish=${evidence.success ? "stop" : "failed"} metadata=${evidence.metadata ? "pi" : "missing"} usage=${evidence.usage ? "present" : "missing"} cost=${evidence.cost ? `authoritative(${evidence.costValue})` : "missing"} exit=${result.exitCode}`,
  )
  if (!passed) {
    const diagnostics = [
      ...result.stderr
        .split("\n")
        .filter(
          (line) =>
            line.includes("level=ERROR") ||
            line.includes("llm runtime selected") ||
            line.includes("pi-ai runtime unavailable"),
        ),
      ...events.filter((event) => event.type === "error").map((event) => JSON.stringify(event)),
    ].slice(-20)
    for (const line of diagnostics) {
      const output = line.length > 1200 ? `${line.slice(0, 1200)}...` : line
      console.error(`  ${output}`)
    }
  }
}
process.exit(failed ? 1 : 0)

async function sourceCommand(command: string[], options: { pure?: boolean } = {}) {
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", source, ...(options.pure === false ? [] : ["--pure"]), ...command],
    {
      cwd: root,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => proc.kill(), timeout)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  return { stdout, stderr, exitCode }
}

function parseCatalog(provider: Provider, output: string) {
  const lines = output.split("\n")
  return lines.flatMap((line, index) => {
    if (!line.startsWith(`${provider}/`)) return []
    const chunks: string[] = []
    for (const next of lines.slice(index + 1)) {
      chunks.push(next)
      if (next === "}") break
    }
    try {
      const model = JSON.parse(chunks.join("\n")) as CatalogModel
      return model.id && model.api?.npm ? [model] : []
    } catch {
      return []
    }
  })
}

function apiFamily(npm: string) {
  if (npm === "@ai-sdk/anthropic") return "anthropic-messages"
  if (npm === "@ai-sdk/openai") return "openai-responses"
  if (npm === "@ai-sdk/openai-compatible") return "openai-completions"
  return "unknown"
}

function matrixApi(target: string, catalogs: Map<Provider, CatalogModel[]>) {
  if (!matrix || !target.startsWith("opencode-go/")) return ""
  const family = matrixFamily(target, catalogs)
  return family ? ` (${family})` : ""
}

function matrixFamily(target: string, catalogs: Map<Provider, CatalogModel[]>) {
  if (!target.startsWith("opencode-go/")) return undefined
  const model = catalogs.get("opencode-go")?.find((item) => item.id === target.slice("opencode-go/".length))
  return model ? apiFamily(model.api.npm) : undefined
}

function piApi(target: string, catalogs: Map<Provider, CatalogModel[]>) {
  if (target.startsWith("anthropic/")) return "anthropic-messages"
  if (target.startsWith("openai/")) return "openai-codex-responses"
  if (target.startsWith("openrouter/")) return "openai-completions"
  return matrixFamily(target, catalogs) ?? "unknown"
}

function finishEvidence(input: unknown, provider: Provider, api: string) {
  const missing = { success: false, usage: false, cost: false, metadata: false, costValue: undefined }
  if (!input || typeof input !== "object") return missing
  const part = input as Record<string, unknown>
  if (!part.tokens || typeof part.tokens !== "object") return missing
  const tokens = part.tokens as Record<string, unknown>
  const cache = tokens.cache as Record<string, unknown> | undefined
  const usage =
    Number.isFinite(tokens.total) &&
    Number.isFinite(tokens.input) &&
    Number.isFinite(tokens.output) &&
    Number.isFinite(tokens.reasoning) &&
    Boolean(cache && Number.isFinite(cache.read) && Number.isFinite(cache.write))
  const providerMetadata = part.providerMetadata as Record<string, unknown> | undefined
  const pi = providerMetadata?.pi as Record<string, unknown> | undefined
  const metadata =
    pi?.api === api &&
    pi.provider === (provider === "openai" ? "openai-codex" : provider) &&
    typeof pi.model === "string"
  const piUsage = pi?.usage as Record<string, unknown> | undefined
  const piCost = piUsage?.cost as Record<string, unknown> | undefined
  const cost = Number.isFinite(part.cost) && Number.isFinite(piCost?.total) && part.cost === piCost?.total
  return {
    success: part.reason === "stop",
    usage,
    cost,
    metadata,
    costValue: typeof part.cost === "number" ? part.cost : undefined,
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
