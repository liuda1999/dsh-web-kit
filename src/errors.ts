/**
 * Error base carrying a stable machine-routable `code` plus `cause` chaining.
 * Extracted from DeepSeek Harness `packages/llm/llm/src/error.ts` (MIT).
 * @module dsh-web-kit/errors
 */

/**
 * Base error class. Route on {@link HarnessError.code}; never parse `message`.
 */
export class HarnessError extends Error {
  /** Stable machine-routable failure class, e.g. `WEB_INVALID_URL`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Whether a thrown value is a {@link HarnessError} (real instance, not duck-typed). */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}

/**
 * Render a thrown value with its full `cause` chain and AggregateError members.
 * Diagnostic surface only (messages, logs) — never parse the result.
 */
export function errorChain(value: unknown): string {
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null ? '' : render(current.cause)
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}
