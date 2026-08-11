# Pi AI Integration Notes

## Baseline

- Chassis: `anomalyco/opencode` `dev` at `d041eee55c4b669f583fcbe0eb73e78d53393ae8`.
- Fork: `MIkamal88/opencode`; local branch `pi-ai-engine`.
- Runtime policy: pi-ai owns the alternate LLM engine, including its provider factories, wire APIs, auth flows, compatibility transforms, transport retries, usage, and cost. OpenCode remains authoritative for model selection, config, credentials, prompts, sessions, tools, guardrails, persistence, MCP, plugins, and UI state.
- Engine order for M1: pi-ai when enabled and supported, existing native runtime when enabled and supported, then AI SDK fallback. Runtime selection is final before provider dispatch starts.

## Runtime Flow

```text
SessionPrompt
  -> LLM.Service request preparation and runtime selection
  -> pi-ai | native @opencode-ai/llm | AI SDK
  -> normalized @opencode-ai/llm LLMEvent stream
  -> SessionProcessor
  -> persisted messages/parts, tool guardrails, snapshots, retries, compaction, TUI events
```

All engines must preserve the `LLMEvent` vocabulary. The pi-ai adapter must not execute tools independently of OpenCode's existing tool wrappers and permission pipeline.

## M1 Seam Map

| Path                                                     | Current role                                                                                                                                                                                             | M1 relevance                                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode/src/session/llm.ts`                   | Session-owned request preparation and per-request runtime selection. Resolves auth, config, provider, plugins, telemetry, and tools before selecting pi-ai, native, or AI SDK execution.                 | Owns the opt-in pi-ai gate and selects pi-ai before native and AI SDK without constructing an AI SDK language model unless both earlier paths decline.                                     |
| `packages/opencode/src/session/llm/ai-sdk.ts`            | Converts AI SDK `fullStream` parts into normalized `@opencode-ai/llm` `LLMEvent`s.                                                                                                                       | Reference for pi-ai event lowering, usage mapping, block IDs, tool-call correlation, and finish/error behavior.                                                                            |
| `packages/opencode/src/session/llm/native-runtime.ts`    | Checks native runtime support, bridges OpenCode tools, builds a native request, and delegates transport to `LLMClient`.                                                                                  | Structural model for `pi-ai-runtime.ts`: narrow support gate, concrete fallback reasons, and OpenCode-owned tool execution.                                                                |
| `packages/opencode/src/session/llm/native-request.ts`    | Lowers prepared AI SDK-shaped messages and tools into canonical native LLM request values while preserving provider metadata.                                                                            | Reference for `pi-ai-request.ts`, especially system/message/media/reasoning/tool-call/tool-result conversion and continuation metadata.                                                    |
| `packages/opencode/src/session/llm/pi-ai-models.ts`      | Lazily creates one private per-instance pi `Models` collection with all built-in provider factories and resolves OpenCode models against it.                                                             | Owns the pi gate, catalog-template lookup, aliases, custom-provider construction, and all ten wire API registrations.                                                                      |
| `packages/opencode/src/session/llm/pi-ai-request.ts`     | Lowers canonical `SessionV1.WithParts[]`, system input, suffixes, media, and OpenCode tool definitions into a pi request.                                                                                | Preserves source identity, continuation signatures, assistant steps, and tool pairing for same- and cross-provider history.                                                                |
| `packages/opencode/src/session/llm/pi-ai-events.ts`      | Converts pi stream events, errors, usage, diagnostics, and cost into invariant `LLMEvent`s.                                                                                                              | Keeps `SessionProcessor` and the TUI engine-agnostic.                                                                                                                                      |
| `packages/opencode/src/session/llm/pi-ai-runtime.ts`     | Dispatches only through pi `Models`, bridges OpenCode tool closures, and emits normalized events.                                                                                                        | Pi reports calls; OpenCode executes each tool exactly once through its existing guardrails.                                                                                                |
| `packages/opencode/src/session/llm/pi-ai-credentials.ts` | Implements pi's `CredentialStore` over `Auth.Service`.                                                                                                                                                   | Preserves one credential file, contextual provider aliases, JSON-safe OAuth metadata, and serialized refresh writes.                                                                       |
| `packages/opencode/src/session/llm/pi-ai-auth.ts`        | Exposes generic pi login methods and cancellable login sessions with IDs, dynamic prompts, and auth events.                                                                                              | Powers `opencode auth login` for pi-enabled providers, including browser/manual OAuth, device codes, progress, and API-key setup.                                                          |
| `packages/opencode/src/session/processor.ts`             | Consumes the invariant `LLMEvent` stream. Persists text/reasoning/tool parts, detects exact three-call doom loops, tracks snapshots/patches, accounts usage/cost, retries, compacts, and settles aborts. | Must remain engine-agnostic. M1 should require no behavioral changes here beyond any strictly necessary usage mapping.                                                                     |
| `packages/opencode/src/provider/provider.ts`             | Builds the V1 provider/model catalog from models.dev, config, auth, plugins, AI SDK packages, and provider-specific loaders.                                                                             | Source for resolving an OpenCode `providerID/modelID` to a pi-ai model or constructing one for custom/local OpenAI-compatible endpoints. Avoid adding more orchestration to this monolith. |
| `packages/opencode/src/provider/transform.ts`            | Applies V1 provider/model request and message compatibility transformations.                                                                                                                             | Behavior reference only. Do not port it wholesale; pi-ai owns its own wire compatibility and message transforms.                                                                           |
| `packages/opencode/src/auth/index.ts`                    | Stores API, OAuth, and well-known credentials in one mode-0600 `auth.json`.                                                                                                                              | Back the pi-ai credential-store bridge so OpenCode remains the single credential source.                                                                                                   |
| `packages/opencode/src/plugin/index.ts`                  | Loads built-in and external server plugins and runs hooks in deterministic order. Contains current Codex, Copilot, and other auth plugins.                                                               | Existing plugins remain available on fallback paths. Pi-enabled login delegates directly to pi's generic auth runtime instead of adding one plugin per OAuth provider.                     |
| `packages/opencode/src/cli/cmd/providers.ts`             | Implements credential list/login/logout UX.                                                                                                                                                              | Selects pi auth before plugin auth only when `experimental.pi_ai` enables the chosen OpenCode provider; otherwise existing behavior is unchanged.                                          |

## M1 Invariants

1. Pi-ai reports tool calls but never bypasses OpenCode tool definitions, permission asks, external-directory checks, doom-loop detection, snapshots, or LSP diagnostics.
2. Unsupported models fall back without changing existing native or AI SDK behavior.
3. Assistant provenance and continuation metadata survive exact same-model turns and are conservatively lowered or removed on provider/model switches.
4. OpenCode `auth.json` remains the only persisted credential store.
5. The TUI and `SessionProcessor` consume the same types and events regardless of engine.
