/**
 * Timeout arithmetic and signal fusion. Extracted from DeepSeek Harness
 * `packages/util/timeout/src/index.ts` (MIT); reduced to the two members the
 * web capability uses.
 * @module dsh-web-kit/timeout
 */

/** Abort reason carrying a capability-owned code and the deadline that elapsed. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A deadline signal plus the cleanup that clears its timer. */
export interface Deadline {
  /** Aborts on upstream cancellation OR on timeout. */
  readonly signal: AbortSignal
  /** Clear the timer; safe to call more than once. */
  dispose(): void
}

/**
 * Fuse upstream cancellation with an identifiable timeout. `timeoutMs <= 0`
 * arms no timer.
 *
 * Unlike the upstream implementation this exposes a plain `dispose()` method
 * rather than `Symbol.dispose`, so callers need no `using` syntax and no
 * Explicit Resource Management support.
 */
export function deadline(upstream: AbortSignal | undefined, timeoutMs: number, code: string): Deadline {
  if (timeoutMs <= 0) {
    return { signal: upstream ?? new AbortController().signal, dispose: () => {} }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`deadline timeoutMs must be a finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const timer = new AbortController()
  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, timeoutMs)) }, timeoutMs)
  let cleared = false
  return {
    signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
    dispose() {
      if (cleared) return
      cleared = true
      clearTimeout(id)
    },
  }
}

/**
 * Recover a timeout reason from a reason-bearing object. Supplying `code`
 * distinguishes this deadline from a nested upstream deadline.
 */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined {
  const reason: unknown = x.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}
