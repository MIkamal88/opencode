import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { tmpdir as managedTmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

const NODE = process.execPath
const cmd = (...args: string[]) => ChildProcess.make(NODE, args)

const capture = <A, E, R>(
  body: (process: AppProcess.Interface, store: ToolOutputStore.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => managedTmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        return yield* body(yield* AppProcess.Service, yield* ToolOutputStore.Service)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([AppProcess.node, ToolOutputStore.nodeWithoutConfig]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const waitForFile = (file: string) =>
  Effect.promise(async () => {
    while (true) {
      try {
        return await fs.readFile(file, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
  })

describe("AppProcess", () => {
  describe("runCapture", () => {
    it.live("preserves observed stdout and stderr order and nonzero exits", () =>
      capture((process, store) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* store.capture()
            const script = `process.stdout.write('out-1\\n');setTimeout(()=>process.stderr.write('err-1\\n'),20);setTimeout(()=>{process.stdout.write('out-2\\n');process.exit(7)},40)`
            const result = yield* process.runCapture(cmd("-e", script), sink)
            expect(result.exitCode).toBe(7)
            expect(result.timeout).toBe(false)
            expect(result.capture.tail).toBe("out-1\nerr-1\nout-2\n")
          }),
        ),
      ),
    )

    if (process.platform !== "win32") {
      it.live(
        "retains timeout output emitted before process-group termination",
        () =>
          capture((process, store) =>
            Effect.scoped(
              Effect.gen(function* () {
                const sink = yield* store.capture()
                const script = `process.stdout.write('before-timeout\\n');process.on('SIGTERM',()=>{process.stderr.write('during-termination\\n');process.exit(0)});setInterval(()=>{},60000)`
                const result = yield* process.runCapture(cmd("-e", script), sink, { timeout: "250 millis" })
                expect(result.timeout).toBe(true)
                expect(result.capture.tail).toContain("before-timeout")
                expect(result.capture.tail).toContain("during-termination")
              }),
            ),
          ),
        5_000,
      )

      it.live(
        "waits through a quiet inherited pipe and captures active post-exit output",
        () =>
          capture((process, store) =>
            Effect.scoped(
              Effect.gen(function* () {
                const sink = yield* store.capture()
                const script = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>process.stdout.write('late\\n'),300);setTimeout(()=>process.exit(0),400)")}],{stdio:['ignore',process.stdout,process.stderr]});child.unref();process.stdout.write('early\\n')`
                const result = yield* process.runCapture(cmd("-e", script), sink)
                expect(result.exitCode).toBe(0)
                expect(result.capture.tail).toBe("early\nlate\n")
              }),
            ),
          ),
        5_000,
      )

      it.live(
        "preserves root exit while cleaning up a descendant that continuously writes",
        () =>
          capture((process, store) =>
            Effect.scoped(
              Effect.gen(function* () {
                const sink = yield* store.capture()
                const child = `setInterval(()=>process.stdout.write('tick\\n'),10)`
                const script = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',process.stdout,process.stderr]});child.unref()`
                const started = Date.now()
                const result = yield* process.runCapture(cmd("-e", script), sink, { timeout: "5 seconds" })
                expect(result.timeout).toBe(false)
                expect(result.exitCode).toBe(0)
                expect(Date.now() - started).toBeLessThan(4_000)
                expect(result.capture.tail).toContain("tick")
              }),
            ),
          ),
        5_000,
      )

      it.live("maps signal-only root exits to conventional status codes", () =>
        capture((process, store) =>
          Effect.scoped(
            Effect.gen(function* () {
              const sink = yield* store.capture()
              const result = yield* process.runCapture(cmd("-e", "process.kill(process.pid, 'SIGTERM')"), sink)
              expect(result.exitCode).toBe(143)
            }),
          ),
        ),
      )

      it.live(
        "escalates process-group cleanup when SIGTERM is ignored",
        Effect.acquireUseRelease(
          Effect.promise(() => managedTmpdir()),
          (tmp) => {
            const pidFile = path.join(tmp.path, "stubborn-pid")
            return capture((process, store) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const sink = yield* store.capture()
                  const child = `process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('tick\\n'),10)`
                  const script = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref()`
                  const result = yield* process.runCapture(cmd("-e", script), sink, { timeout: "250 millis" })
                  expect(result.timeout).toBe(true)
                  const pid = Number(yield* waitForFile(pidFile))
                  const info = yield* Effect.promise(() =>
                    Bun.$`ps -o stat= -p ${pid}`
                      .quiet()
                      .text()
                      .catch(() => ""),
                  )
                  expect(info.trim() === "" || info.trim().startsWith("Z")).toBe(true)
                }),
              ),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
        8_000,
      )

      it.live(
        "terminates descendants that keep inherited pipes open after the idle cutoff",
        Effect.acquireUseRelease(
          Effect.promise(() => managedTmpdir()),
          (tmp) => {
            const pidFile = path.join(tmp.path, "descendant-pid")
            return capture((process, store) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const sink = yield* store.capture()
                  const child = `setInterval(()=>{},60000)`
                  const script = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();process.stdout.write('early\\n')`
                  const result = yield* process.runCapture(cmd("-e", script), sink)
                  expect(result.capture.tail).toBe("early\n")
                  const pid = Number(yield* waitForFile(pidFile))
                  const info = yield* Effect.promise(() =>
                    Bun.$`ps -o stat= -p ${pid}`
                      .quiet()
                      .text()
                      .catch(() => ""),
                  )
                  expect(info.trim() === "" || info.trim().startsWith("Z")).toBe(true)
                }),
              ),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
        10_000,
      )
    }

    it.live("preserves Effect interruption", () =>
      capture((process, store) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* store.capture()
            const fiber = yield* process.runCapture(cmd("-e", "setInterval(()=>{},60000)"), sink).pipe(Effect.forkChild)
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Interrupt")).toBe(true)
          }),
        ),
      ),
    )

    it.live("preserves AbortSignal cancellation", () =>
      capture((process, store) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* store.capture()
            const controller = new AbortController()
            controller.abort(new Error("cancel capture"))
            const exit = yield* process
              .runCapture(cmd("-e", "setInterval(()=>{},60000)"), sink, { signal: controller.signal })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit))
              expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
                _tag: "AppProcessError",
                message: expect.stringContaining("cancel capture"),
              })
          }),
        ),
      ),
    )

    it.effect(
      "propagates capture write and finish failures without wrapping them",
      Effect.gen(function* () {
        const process = yield* AppProcess.Service
        const writeFailure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("sink write") })
        const writeExit = yield* process
          .runCapture(cmd("-e", "process.stdout.write('output')"), {
            write: () => Effect.fail(writeFailure),
            finish: () => Effect.die("unused"),
            discard: () => Effect.void,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(writeExit)).toBe(true)
        if (Exit.isFailure(writeExit))
          expect(Option.getOrUndefined(Cause.findErrorOption(writeExit.cause))).toBe(writeFailure)

        for (const operation of ["flush", "close"] as const) {
          const failure = new ToolOutputStore.StorageError({ operation, cause: new Error(`sink ${operation}`) })
          const exit = yield* process
            .runCapture(cmd("-e", "process.exit(0)"), {
              write: () => Effect.void,
              finish: () => Effect.fail(failure),
              discard: () => Effect.void,
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure)
        }
      }),
    )

    if (process.platform !== "win32") {
      it.live(
        "terminates the process promptly when capture storage fails",
        Effect.acquireUseRelease(
          Effect.promise(() => managedTmpdir()),
          (tmp) => {
            const settled = path.join(tmp.path, "storage-failure-settled")
            return Effect.gen(function* () {
              const process = yield* AppProcess.Service
              const failure = new ToolOutputStore.StorageError({ operation: "write", cause: new Error("disk full") })
              const script = `const fs=require('fs');process.stdout.write('output');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
              const exit = yield* process
                .runCapture(cmd("-e", script), {
                  write: () => Effect.fail(failure),
                  finish: () => Effect.die("unused"),
                  discard: () => Effect.void,
                })
                .pipe(Effect.exit)
              expect(Exit.isFailure(exit)).toBe(true)
              expect(yield* waitForFile(settled)).toBe("settled")
            })
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
        5_000,
      )
    }
  })

  describe("run", () => {
    it.effect(
      "captures stdout and exit code zero",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hi\n")
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(false)
      }),
    )

    it.effect(
      "captures stdout and stderr in emission order",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script = [
          'process.stdout.write("out 1\\n")',
          'setTimeout(() => process.stderr.write("err 1\\n"), 10)',
          'setTimeout(() => process.stdout.write("out 2\\n"), 20)',
        ].join(";")
        const result = yield* svc.run(cmd("-e", script), { combineOutput: true })
        expect(result.output?.toString("utf8")).toBe("out 1\nerr 1\nout 2\n")
        expect(result.stdout.toString("utf8")).toBe("")
        expect(result.stderr.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "non-zero exit returns RunResult; caller can require success",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(1)"))
        expect(result.exitCode).toBe(1)
      }),
    )

    it.effect(
      "requireSuccess fails on non-zero exit",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const exit = yield* Effect.exit(
          svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(AppProcess.requireSuccess)),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(1)
            expect((reason.error as AppProcess.AppProcessError).message).toContain("Command failed (exit 1)")
          } else {
            throw new Error("expected fail reason")
          }
        }
      }),
    )

    it.effect(
      "requireSuccess succeeds on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(AppProcess.requireSuccess))
        expect(result.exitCode).toBe(0)
      }),
    )

    it.effect(
      "requireExitIn allowlists multiple exit codes",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const requireZeroOrOne = AppProcess.requireExitIn([0, 1])
        const okZero = yield* svc.run(cmd("-e", "process.exit(0)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okZero.exitCode).toBe(0)
        const okOne = yield* svc.run(cmd("-e", "process.exit(1)")).pipe(Effect.flatMap(requireZeroOrOne))
        expect(okOne.exitCode).toBe(1)
        const exit = yield* Effect.exit(svc.run(cmd("-e", "process.exit(2)")).pipe(Effect.flatMap(requireZeroOrOne)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
            expect((reason.error as AppProcess.AppProcessError).exitCode).toBe(2)
          }
        }
      }),
    )

    it.effect(
      "truncates stdout when maxOutputBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('0123456789')"), { maxOutputBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(true)
        expect(result.stderrTruncated).toBe(false)
        expect(result.stdout.length).toBe(5)
        expect(result.stdout.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "truncates stderr when maxErrorBytes is set",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stderr.write('0123456789')"), { maxErrorBytes: 5 })
        expect(result.exitCode).toBe(0)
        expect(result.stdoutTruncated).toBe(false)
        expect(result.stderrTruncated).toBe(true)
        expect(result.stderr.length).toBe(5)
        expect(result.stderr.toString("utf8")).toBe("01234")
      }),
    )

    it.effect(
      "result includes command description",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", "process.stdout.write('hi')"))
        expect(result.command).toBe(`${NODE} -e process.stdout.write('hi')`)
      }),
    )

    if (process.platform !== "win32") {
      it.live(
        "timeout cleans up the scoped child process",
        Effect.acquireUseRelease(
          Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "opencode-process-timeout-"))),
          (directory) => {
            const ready = path.join(directory, "ready")
            const settled = path.join(directory, "settled")
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              const exit = yield* Effect.exit(svc.run(cmd("-e", script), { timeout: "250 millis" }))
              expect(Exit.isFailure(exit)).toBe(true)
              expect(yield* waitForFile(ready)).toMatch(/^\d+$/)
              expect(yield* waitForFile(settled)).toBe("settled")
            })
          },
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        ),
        5_000,
      )

      it.live(
        "fiber interruption cleans up the scoped child process after readiness",
        Effect.acquireUseRelease(
          Effect.promise(() => fs.mkdtemp(path.join(tmpdir(), "opencode-process-interrupt-"))),
          (directory) => {
            const ready = path.join(directory, "ready")
            const settled = path.join(directory, "settled")
            const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(settled)},'settled');process.exit(0)});setInterval(()=>{},60000)`
            return Effect.gen(function* () {
              const svc = yield* AppProcess.Service
              const fiber = yield* svc.run(cmd("-e", script)).pipe(Effect.forkChild)
              expect(yield* waitForFile(ready)).toMatch(/^\d+$/)
              yield* Fiber.interrupt(fiber)
              expect(yield* waitForFile(settled)).toBe("settled")
            })
          },
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        ),
        5_000,
      )
    }
  })

  describe("inherited platform methods", () => {
    it.effect(
      "string returns stdout as string",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.string(cmd("-e", "process.stdout.write('hi\\n')"))
        expect(out).toBe("hi\n")
      }),
    )

    it.effect(
      "lines returns the platform's array of lines",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const out = yield* svc.lines(cmd("-e", "process.stdout.write('a\\nb\\n')"))
        expect(Array.from(out)).toEqual(["a", "b"])
      }),
    )
  })

  describe("run with stdin option", () => {
    const echoStdin = "process.stdin.on('data', c => process.stdout.write(c))"

    it.effect(
      "feeds a string to stdin and returns it on stdout",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "hello" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("hello")
      }),
    )

    it.effect(
      "feeds a Uint8Array to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const bytes = new TextEncoder().encode("bytes")
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: bytes })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("bytes")
      }),
    )

    it.effect(
      "feeds a Stream of Uint8Array chunks to stdin",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const enc = new TextEncoder()
        const stream = Stream.fromIterable([enc.encode("one"), enc.encode("-two"), enc.encode("-three")])
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: stream })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("one-two-three")
      }),
    )

    it.effect(
      "completes correctly with empty input",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.run(cmd("-e", echoStdin), { stdin: "" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("")
      }),
    )

    it.effect(
      "carries existing Command options like env",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const script =
          "process.stdout.write(process.env.FEED + ':'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { env: { FEED: "envset" }, extendEnv: true })
        const result = yield* svc.run(command, { stdin: "payload" })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString("utf8")).toBe("envset:payload")
      }),
    )

    it.effect(
      "carries existing Command options like cwd",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const dir = realpathSync(tmpdir())
        const script =
          "process.stdout.write(process.cwd() + '|'); process.stdin.on('data', c => process.stdout.write(c))"
        const command = ChildProcess.make(NODE, ["-e", script], { cwd: dir })
        const result = yield* svc.run(command, { stdin: "ok" })
        expect(result.exitCode).toBe(0)
        const [cwd, stdin] = result.stdout.toString("utf8").split("|")
        expect(realpathSync(cwd)).toBe(dir)
        expect(stdin).toBe("ok")
      }),
    )
  })

  describe("runStream", () => {
    it.live(
      "emits lines incrementally and ends cleanly on exit 0",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc
          .runStream(cmd("-e", "console.log('one'); console.log('two'); console.log('three')"))
          .pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["one", "two", "three"])
      }),
    )

    it.live(
      "okExitCodes determines whether a non-zero exit fails the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const allowed = yield* svc
          .runStream(cmd("-e", "console.log('only'); process.exit(1)"), { okExitCodes: [0, 1] })
          .pipe(Stream.runCollect)
        expect(Array.from(allowed)).toEqual(["only"])
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "console.log('a'); process.exit(2)"), { okExitCodes: [0, 1] })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0]
          if (reason && reason._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(AppProcess.AppProcessError)
          }
        }
      }),
    )

    it.live(
      "without okExitCodes, never fails on exit code",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const result = yield* svc.runStream(cmd("-e", "console.log('only'); process.exit(7)")).pipe(Stream.runCollect)
        expect(Array.from(result)).toEqual(["only"])
      }),
    )

    it.live(
      "AbortSignal interrupts the stream",
      Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        const controller = new AbortController()
        controller.abort()
        const exit = yield* Effect.exit(
          svc
            .runStream(cmd("-e", "setInterval(() => {}, 60_000)"), { signal: controller.signal })
            .pipe(Stream.runCollect),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("spawn (inherited)", () => {
    it.live(
      "returns the platform ChildProcessHandle for advanced use",
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* AppProcess.Service
          const handle = yield* svc.spawn(cmd("-e", "setInterval(() => {}, 1_000)"))
          expect(yield* handle.isRunning).toBe(true)
          yield* handle.kill()
        }),
      ),
    )
  })
})
