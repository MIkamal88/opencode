import type { AbsolutePath } from "../schema"
import type { ManagedOutput } from "../tool-output-store"

export interface Receipt {
  readonly canonicalPath: AbsolutePath
  readonly digest: string
}

export interface Pending<A> {
  readonly output: A
}

export interface Metadata {
  readonly receipt?: Receipt
  readonly managedOutput?: ManagedOutput
  readonly release?: () => import("effect").Effect.Effect<void>
}

const settlements = new WeakMap<object, Metadata>()

export function make<A>(output: A, receipt: Receipt, release?: Metadata["release"]): Pending<A> {
  const pending = Object.freeze({ output })
  settlements.set(pending, { receipt, ...(release ? { release } : {}) })
  return pending
}

export function managed<A>(output: A, managedOutput: ManagedOutput, receipt?: Receipt): Pending<A> {
  const pending = Object.freeze({ output })
  settlements.set(pending, { managedOutput, ...(receipt ? { receipt } : {}) })
  return pending
}

export function take<A>(value: A | Pending<A>): { readonly output: A } & Metadata {
  if (typeof value !== "object" || value === null) return { output: value as A }
  const metadata = settlements.get(value)
  if (!metadata) return { output: value as A }
  return { output: (value as Pending<A>).output, ...metadata }
}
