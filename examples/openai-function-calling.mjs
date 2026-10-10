/**
 * Wire the tools into an OpenAI-compatible endpoint.
 *
 * Works against OpenAI, a local gateway, or anything speaking
 * `/v1/chat/completions` with `tools`. The parameter schemas are already plain
 * JSON Schema, so no translation layer is needed.
 *
 * Without configuration it prints the converted schemas and stops. To run a
 * real tool-calling round trip:
 *
 *   OPENAI_BASE_URL=http://192.168.0.108:23456/v1 OPENAI_MODEL=local \
 *     node examples/openai-function-calling.mjs "what is deepseek"
 */
import { createWebKit, webToolPromptSections } from 'dsh-web-kit'

const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
const apiKey = process.env.OPENAI_API_KEY ?? 'not-needed-for-local'
const question = process.argv.slice(2).join(' ') || 'what changed in the latest Node.js release?'

const kit = createWebKit()
const byName = new Map(kit.tools.map(def => [def.name, def]))

/** The tool payload OpenAI-compatible endpoints expect. */
const tools = kit.tools.map(def => ({
  type: 'function',
  function: { name: def.name, description: def.description, parameters: def.parameters },
}))

console.log('converted schemas:')
for (const t of tools) {
  console.log(`  ${t.function.name}(${Object.keys(t.function.parameters.properties).join(', ')})`)
}

if (baseUrl === undefined) {
  console.log('\nset OPENAI_BASE_URL (and OPENAI_MODEL) to run a real tool-calling round trip')
  await kit.dispose()
  process.exit(0)
}

const messages = [
  {
    role: 'system',
    content: [
      'You are a research assistant with web access.',
      ...webToolPromptSections({ search: true, fetch: true }),
    ].join('\n'),
  },
  { role: 'user', content: question },
]

async function chat(withTools) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, ...withTools ? { tools, tool_choice: 'auto' } : {} }),
  })
  if (!response.ok) throw new Error(`chat ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

// Round 1: let the model ask for tools.
const first = await chat(true)
const choice = first.choices?.[0]
if (choice === undefined) throw new Error('endpoint returned no choices')
messages.push(choice.message)

const calls = choice.message.tool_calls ?? []
console.log(`\nmodel requested ${calls.length} tool call(s)`)

// Execute each call through the kit. A failure is returned to the model as
// tool output — it can then rephrase the query instead of the host crashing.
for (const call of calls) {
  const def = byName.get(call.function.name)
  if (def === undefined) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: unknown tool ${call.function.name}` })
    continue
  }
  let args = {}
  try {
    args = JSON.parse(call.function.arguments || '{}')
  } catch {
    messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: malformed arguments' })
    continue
  }
  const out = await def.handler(args)
  console.log(`  ${call.function.name} -> isError=${out.isError} code=${out.code ?? '-'}`)
  messages.push({ role: 'tool', tool_call_id: call.id, content: out.text })
}

// Round 2: the model answers with the tool output in context.
const second = await chat(false)
console.log('\nanswer:\n', second.choices?.[0]?.message?.content ?? '(none)')

await kit.dispose()
