import assert from 'node:assert/strict'

const sourceChars = Number(process.env.CHAT2API_LIVE_CHARS || 100000)
const toolCount = Number(process.env.CHAT2API_LIVE_TOOL_COUNT || 0)
const toolDescriptionChars = Number(process.env.CHAT2API_LIVE_TOOL_DESCRIPTION_CHARS || 0)
const toolChoice = (process.env.CHAT2API_LIVE_TOOL_CHOICE || 'none').toLowerCase()
const timeoutMs = Number(process.env.CHAT2API_LIVE_TIMEOUT_MS || 60000)
const transport = (process.env.CHAT2API_LIVE_TRANSPORT || 'inline').toLowerCase()
const model = process.env.CHAT2API_LIVE_MODEL || 'Qwen3.8-Max'
const baseUrl = process.env.CHAT2API_LIVE_BASE_URL || 'http://127.0.0.1:8080/v1'
const apiKey = process.env.CHAT2API_LIVE_API_KEY || 'sk-chat2api-local'

for (const [name, value] of Object.entries({ sourceChars, toolCount, toolDescriptionChars, timeoutMs })) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer`)
}
assert.ok(sourceChars > 0, 'sourceChars must be positive')
assert.ok(timeoutMs > 0, 'timeoutMs must be positive')
assert.ok(transport === 'inline' || transport === 'file', 'transport must be inline or file')
assert.ok(['none', 'auto', 'required'].includes(toolChoice), 'toolChoice must be none, auto, or required')

function deterministicText(length) {
  const lines = []
  let index = 0
  let produced = 0
  while (produced < length) {
    index += 1
    const line = `FACT_${String(index).padStart(7, '0')}=retain; path=C:/workspace/src/file-${index % 997}.ts; value=${(index * 2654435761) >>> 0};\n`
    lines.push(line)
    produced += line.length
  }
  return lines.join('').slice(0, length)
}

const sourceText = deterministicText(sourceChars)
let messages
if (transport === 'file') {
  messages = [{
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Read the complete attached context, then reply with exactly QWEN_ADMISSION_OK and do not call tools.',
      },
      {
        type: 'file',
        filename: 'qwen-admission-context.txt',
        mime_type: 'text/plain',
        file_url: {
          url: `data:text/plain;base64,${Buffer.from(sourceText, 'utf8').toString('base64')}`,
        },
      },
    ],
  }]
} else {
  const segmentCount = 12
  messages = []
  let offset = 0
  for (let index = 0; index < segmentCount; index += 1) {
    const remainingChars = sourceText.length - offset
    const targetLength = Math.ceil(remainingChars / (segmentCount - index))
    const content = sourceText.slice(offset, offset + targetLength)
    messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content })
    offset += content.length
  }
  messages.push({
    role: 'user',
    content: 'This is an admission probe. Reply with exactly QWEN_ADMISSION_OK and do not call tools.',
  })
}

const tools = Array.from({ length: toolCount }, (_, index) => ({
  type: 'function',
  function: {
    name: `probe_tool_${index + 1}`,
    description: deterministicText(toolDescriptionChars),
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Probe value.' },
      },
      required: ['value'],
      additionalProperties: false,
    },
  },
}))

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error(`probe exceeded ${timeoutMs}ms`)), timeoutMs)
const startedAt = Date.now()
let response
let outcome = 'unknown'
let responseText = ''
try {
  response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    }),
    signal: controller.signal,
  })
  responseText = await response.text()
  outcome = response.ok ? 'success' : 'http_error'
} catch (error) {
  outcome = controller.signal.aborted ? 'client_timeout' : 'transport_error'
  responseText = error instanceof Error ? error.message : String(error)
} finally {
  clearTimeout(timeout)
}

let responsePreview = responseText.replace(/\s+/g, ' ').trim().slice(0, 240)
try {
  const parsed = JSON.parse(responseText)
  responsePreview = parsed.choices?.[0]?.message?.content
    || parsed.error?.code
    || parsed.error?.message
    || responsePreview
} catch {}

console.log(JSON.stringify({
  outcome,
  status: response?.status,
  elapsedMs: Date.now() - startedAt,
  sourceChars,
  messageCount: messages.length,
  toolCount,
  toolDescriptionChars,
  toolChoice,
  transport,
  responsePreview,
}, null, 2))
