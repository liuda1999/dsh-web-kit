/**
 * Recovering text that HTML hides outside text nodes.
 *
 * Form controls do not hold their content in a text node the way `<p>` does:
 * `<input>` writes it into a `value` attribute, `<select>` into child
 * `<option>`s, `<textarea>` into CDATA. Stripping tags therefore erases them
 * completely — a reference page rendered as controls came back as a few orphan
 * paragraphs with every value gone.
 *
 * Trafilatura exposes this as `include_*` switches rather than a fixed policy,
 * and that is the precedent followed by {@link EXTRACT_MODES}: keeping control
 * text is a per-mode decision, not an unconditional one. Deleting it silently
 * is worse than keeping it, because the values are usually the answer.
 *
 * NEW CODE — not present in DeepSeek Harness.
 *
 * @module dsh-web-kit/filter/controls
 */

/**
 * `<input>` types whose value must never be recovered.
 *
 * `hidden` is the important one: it is where frameworks park CSRF tokens,
 * session identifiers and other opaque state. Reading it would inject secrets
 * into both the model context and the local index. The rest are either
 * duplicates of their own `<label>` (checkbox, radio) or carry no text worth
 * having (submit, button, image, file).
 */
export const UNREADABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'hidden', 'password', 'submit', 'reset', 'button', 'image', 'file', 'checkbox', 'radio',
])

/**
 * Attributes tried in order when recovering a control's visible text.
 *
 * `value` is what the form would submit, which is also what the reader sees.
 * `placeholder` and `aria-label` are the fallback for empty fields, where the
 * hint is often more informative than nothing — a search box marks itself as a
 * search box here, which is useful context rather than noise.
 */
const VALUE_ATTRIBUTES = ['value', 'placeholder', 'aria-label', 'alt', 'title'] as const

/** Ceiling on one recovered value, so a single field cannot flood the output. */
const MAX_CONTROL_CHARS = 200

/** Attribute lookup that reports absence rather than throwing. */
export type AttributeReader = (name: string) => string | null

/**
 * The readable text a form control contributes, or `''` for none.
 *
 * Neutral about where the attributes come from, so the same policy serves both
 * the lexical scanner (raw attribute strings) and a DOM-based converter
 * (`getAttribute`). One policy, two readers — they cannot drift apart.
 */
export function controlValue(read: AttributeReader): string {
  const type = (read('type') ?? '').trim().toLowerCase()
  if (type !== '' && UNREADABLE_INPUT_TYPES.has(type)) return ''
  for (const name of VALUE_ATTRIBUTES) {
    const raw = read(name)
    if (raw === null) continue
    const value = raw.replace(/\s+/g, ' ').trim()
    if (value === '') continue
    return value.slice(0, MAX_CONTROL_CHARS)
  }
  return ''
}
