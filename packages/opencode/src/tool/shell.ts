import { Effect, Fiber, Stream } from "effect"
import os from "os"
import { open, type FileHandle } from "node:fs/promises"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

export function writeAll(file: FileHandle, bytes: Uint8Array) {
  return Effect.tryPromise({
    try: async () => {
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await file.write(bytes, offset, bytes.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error("Shell output artifact write made no progress")
        offset += result.bytesWritten
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathShaped(text: string) {
  const value = unquote(text)
  return (
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith("~\\") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith(".\\") ||
    value.startsWith("../") ||
    value.startsWith("..\\") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  const start = text.length - MAX_METADATA_LENGTH
  const safe =
    start < text.length && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff ? start + 1 : start
  return "...\n\n" + text.slice(safe)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  const trailingNewline = text.endsWith("\n")
  if (trailingNewline) lines.pop()
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
      kind: "lines" as const,
      startLine: 1,
      endLine: lines.length,
      retainedBytes: Buffer.byteLength(text, "utf-8"),
    }
  }

  const out: string[] = []
  let bytes = trailingNewline ? 1 : 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - (maxBytes - bytes)
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
        bytes += buf.length - start
      }
      return {
        text: out.join("\n") + (trailingNewline ? "\n" : ""),
        cut: true,
        kind: "bytes" as const,
        startLine: lines.length - out.length + 1,
        endLine: lines.length,
        retainedBytes: bytes,
      }
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n") + (trailingNewline ? "\n" : ""),
    cut: true,
    kind: "lines" as const,
    startLine: lines.length - out.length + 1,
    endLine: lines.length,
    retainedBytes: bytes,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      const inspect = Effect.fnUntraced(function* (arg: string) {
        const resolved = yield* argPath(arg, cwd, ps, shell)
        yield* Effect.logInfo("resolved path", { arg, resolved })
        if (!resolved || containsPath(resolved, instance)) return
        const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      })

      for (const redirect of root.descendantsOfType("file_redirect")) {
        const destination = redirect?.childForFieldName("destination")
        if (destination) yield* inspect(destination.text)
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        const candidates = new Set(
          command
            .slice(1)
            .filter((item) => pathShaped(item.text))
            .map((item) => item.text),
        )

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          pathArgs(command, ps, shellKind === "cmd").forEach((arg) => candidates.add(arg))
        }
        if (cmd === "tee") pathArgs(command, ps).forEach((arg) => candidates.add(arg))
        if (cmd === "dd") {
          command
            .slice(1)
            .map((item) => unquote(item.text).match(/^of=(.+)$/)?.[1])
            .filter((item): item is string => Boolean(item))
            .forEach((arg) => candidates.add(arg))
        }
        for (const candidate of candidates) yield* inspect(candidate)

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let last = ""
      const list: Chunk[] = []
      const pending: Uint8Array[] = []
      let displayTailBytes = 0
      let totalBytes = 0
      let totalDisplayBytes = 0
      let totalLines = 0
      let hasOutput = false
      let endsWithNewline = false
      let file = ""
      let sink: FileHandle | undefined
      let cut = false
      let expired = false
      let aborted = false
      let incomplete = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        yield* Effect.tryPromise(() => stream.close())
        sink = undefined
      })

      const discardArtifact = Effect.fnUntraced(function* () {
        yield* closeSink().pipe(Effect.ignore)
        if (!file) return
        yield* fs.remove(file).pipe(Effect.ignore)
        file = ""
      })

      return yield* Effect.gen(function* () {
        yield* ctx.metadata({
          metadata: {
            output: "",
          },
        })

        const code: number | null = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => closeSink().pipe(Effect.catch(() => Effect.void)))
            const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
            const decoder = new TextDecoder()
            const rootExit = CrossSpawnSpawner.rootExitCode(handle)

            const consume = yield* Effect.forkScoped(
              Stream.runForEach(handle.all, (bytes) =>
                Effect.gen(function* () {
                  const chunk = decoder.decode(bytes, { stream: true })
                  totalBytes += bytes.byteLength
                  totalDisplayBytes += Buffer.byteLength(chunk, "utf-8")
                  totalLines += chunk.split("\n").length - 1
                  if (chunk) {
                    hasOutput = true
                    endsWithNewline = chunk.endsWith("\n")
                  }
                  list.push({ text: chunk, size: Buffer.byteLength(chunk, "utf-8") })
                  displayTailBytes += Buffer.byteLength(chunk, "utf-8")
                  while (displayTailBytes > keep && list.length > 1) {
                    const item = list.shift()
                    if (!item) break
                    displayTailBytes -= item.size
                    cut = true
                  }

                  last = preview(last + chunk)

                  if (sink) {
                    yield* writeAll(sink, bytes)
                  } else {
                    pending.push(bytes.slice())
                    if (
                      totalBytes > limits.maxBytes ||
                      totalDisplayBytes > limits.maxBytes ||
                      totalLines > limits.maxLines
                    ) {
                      yield* Effect.uninterruptible(
                        Effect.gen(function* () {
                          file = yield* trunc.write(Buffer.concat(pending))
                          pending.length = 0
                          cut = true
                          sink = yield* Effect.tryPromise(() => open(file, "a"))
                        }),
                      )
                    }
                  }

                  yield* ctx.metadata({
                    metadata: {
                      output: last,
                    },
                  })
                }),
              ),
            )

            const abort = Effect.callback<void>((resume) => {
              if (ctx.abort.aborted) return resume(Effect.void)
              const handler = () => resume(Effect.void)
              ctx.abort.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
            })

            const timeout = Effect.sleep(`${input.timeout + 100} millis`)

            const exit = yield* Effect.raceAll([
              rootExit.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
              abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
              timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
            ])

            if (exit.kind === "abort") {
              aborted = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }
            if (exit.kind === "timeout") {
              expired = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }

            yield* CrossSpawnSpawner.finalizeAtRootExit(handle)
            const drained = yield* Effect.raceFirst(
              Fiber.join(consume).pipe(Effect.as(true)),
              Effect.sleep("3 seconds").pipe(Effect.as(false)),
            )
            if (!drained) yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
            const forced = drained
              ? true
              : yield* Effect.raceFirst(
                  Fiber.join(consume).pipe(Effect.as(true)),
                  Effect.sleep("3 seconds").pipe(Effect.as(false)),
                )
            if (!forced) {
              incomplete = true
              yield* Fiber.interrupt(consume)
            }

            const final = decoder.decode()
            if (final) {
              const size = Buffer.byteLength(final, "utf-8")
              totalDisplayBytes += size
              totalLines += final.split("\n").length - 1
              hasOutput = true
              endsWithNewline = final.endsWith("\n")
              list.push({ text: final, size })
              displayTailBytes += size
              last = preview(last + final)
              while (displayTailBytes > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                displayTailBytes -= item.size
                cut = true
              }
              if (!file && totalDisplayBytes > limits.maxBytes) {
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    file = yield* trunc.write(Buffer.concat(pending))
                    pending.length = 0
                    cut = true
                  }),
                )
              }
            }
            yield* closeSink()
            if (hasOutput && !endsWithNewline) totalLines++

            return exit.kind === "exit" ? exit.code : null
          }),
        ).pipe(Effect.onError(discardArtifact), Effect.orDie)

        const meta: string[] = []
        if (expired) {
          meta.push(
            `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
          )
        }
        if (aborted) meta.push("User aborted the command")
        if (incomplete) {
          meta.push(
            "Shell output capture stopped after descendant cleanup did not close inherited output pipes; displayed and saved output may be incomplete.",
          )
        }
        const raw = list.map((item) => item.text).join("")
        const end = tail(raw, limits.maxLines, limits.maxBytes)
        if (end.cut) cut = true
        if (!file && end.cut) {
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              file = yield* trunc.write(Buffer.concat(pending))
            }),
          )
        }

        let output = end.text
        if (!output) output = "(no output)"

        if (cut && file) {
          const bufferedTailCut = displayTailBytes < totalDisplayBytes
          const retainedLines = Math.max(1, end.endLine - end.startLine + 1)
          const startLine = Math.max(1, totalLines - retainedLines + 1)
          const range =
            totalDisplayBytes !== totalBytes
              ? `Showing a UTF-8-decoded tail of ${end.retainedBytes} display bytes from ${totalBytes} raw bytes (${totalLines} lines total); invalid or incomplete UTF-8 is replaced for display. The saved file contains the exact raw bytes.`
              : end.kind === "bytes" || bufferedTailCut
                ? `Showing the last ${end.retainedBytes} bytes of ${totalBytes} bytes (${totalLines} lines total); the first displayed line may be partial.`
                : `Showing lines ${startLine}-${totalLines} of ${totalLines} (${totalBytes} bytes total).`
          output =
            `...output truncated...\n${range}\nFull output saved to: ${file}\n` +
            `Use grep with path ${JSON.stringify(file)} to search the ${incomplete ? "captured" : "complete"} output, or read with filePath ${JSON.stringify(file)}, offset ${startLine}, and limit ${retainedLines} to inspect the retained range.\n\n` +
            output
        }

        if (meta.length > 0) {
          output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
        }
        const result = {
          title: input.command,
          metadata: {
            output: last || preview(output),
            exit: code,
            truncated: cut,
            ...(cut && file ? { outputPath: file } : {}),
          },
          output,
        }
        if (!cut || !file) return result
        return Tool.attachOwnership(result, trunc.ownership(file))
      }).pipe(Effect.onError(discardArtifact))
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
