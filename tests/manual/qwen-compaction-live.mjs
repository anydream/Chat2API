import assert from 'node:assert/strict'

const protocol = (process.env.CHAT2API_LIVE_PROTOCOL || 'openai').toLowerCase()
const sourceChars = Number(process.env.CHAT2API_LIVE_CHARS || 135000)
const timeoutMs = Number(process.env.CHAT2API_LIVE_TIMEOUT_MS || 900000)
// By default, use the same end-to-end budget as the real client. A caller can
// still impose a separate header target when measuring first-response latency.
const headerMaxMs = Number(process.env.CHAT2API_LIVE_HEADER_MAX_MS || timeoutMs)
const model = process.env.CHAT2API_LIVE_MODEL || 'Qwen3.8-Max-Preview'
const baseUrl = process.env.CHAT2API_LIVE_BASE_URL
  || (protocol === 'anthropic' ? 'http://127.0.0.1:4000/v1' : 'http://127.0.0.1:8080/v1')
const apiKey = process.env.CHAT2API_LIVE_API_KEY
  || (protocol === 'anthropic' ? 'sk-litellm-local' : 'sk-chat2api-local')
const sourceMarkers = Array.from(
  { length: 12 },
  (_, index) => `DECISION_${String(index + 1).padStart(2, '0')}`,
)

assert.ok(Number.isSafeInteger(sourceChars) && sourceChars > 0, 'CHAT2API_LIVE_CHARS must be positive')
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'CHAT2API_LIVE_TIMEOUT_MS must be positive')
assert.ok(Number.isSafeInteger(headerMaxMs) && headerMaxMs > 0, 'CHAT2API_LIVE_HEADER_MAX_MS must be positive')
assert.ok(protocol === 'openai' || protocol === 'anthropic', 'protocol must be openai or anthropic')

const compactInstruction = [
  'CRITICAL: Respond with TEXT ONLY.',
  'Do NOT call or use any tools.',
  'Summarize the complete conversation context and history for continuation.',
  'Preserve decisions, constraints, identifiers, completed work, and pending work.',
  `Preserve every source decision identifier exactly: ${sourceMarkers.join(', ')}.`,
  'Return only the summary text.',
].join('\n')

function createSourceMessages(totalChars) {
  const segmentCount = 12
  const messages = []
  let remaining = totalChars
  for (let index = 0; index < segmentCount; index += 1) {
    const remainingSegments = segmentCount - index
    const targetLength = Math.ceil(remaining / remainingSegments)
    const prefix = `SOURCE_SEGMENT_${String(index + 1).padStart(2, '0')}: `
    const fact = `${sourceMarkers[index]}=keep; path=C:/workspace/file-${index + 1}.ts; pending=step-${index + 1}. `
    const repeats = Math.ceil(Math.max(0, targetLength - prefix.length) / fact.length)
    const content = `${prefix}${fact.repeat(repeats)}`.slice(0, targetLength)
    remaining -= content.length
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
    })
  }
  messages.push({ role: 'user', content: compactInstruction })
  return messages
}

function requestDefinition() {
  const messages = createSourceMessages(sourceChars)
  if (protocol === 'anthropic') {
    return {
      url: `${baseUrl.replace(/\/$/, '')}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 4096,
        stream: true,
        messages,
        tools: [{
          name: 'live_probe_tool',
          description: 'A probe that must not be used during context compaction.',
          input_schema: { type: 'object', properties: {} },
        }],
      },
    }
  }

  return {
    url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: {
      model,
      stream: true,
      messages,
      tools: [{
        type: 'function',
        function: {
          name: 'live_probe_tool',
          description: 'A probe that must not be used during context compaction.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: 'auto',
    },
  }
}

function inspectSseFrame(frame, metrics) {
  const lines = frame.split(/\r?\n/)
  if (lines.some(line => line.startsWith(':'))) metrics.commentFrames += 1
  const dataLines = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
  if (dataLines.length === 0) return

  const raw = dataLines.join('\n')
  metrics.dataFrames += 1
  if (raw === '[DONE]') {
    metrics.terminalFrames += 1
    return
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    metrics.invalidJsonFrames += 1
    return
  }

  if (data.error || data.type === 'error') metrics.errorFrames += 1
  if (protocol === 'anthropic') {
    if (data.type === 'message_stop') metrics.terminalFrames += 1
    if (data.type === 'ping') metrics.commentFrames += 1
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      metrics.content += data.delta.text || ''
      metrics.contentFrames += 1
    }
    if (data.delta?.type === 'thinking_delta') metrics.reasoningFrames += 1
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      metrics.toolFrames += 1
    }
    return
  }

  const delta = data.choices?.[0]?.delta
  if (typeof delta?.content === 'string' && delta.content.length > 0) {
    metrics.content += delta.content
    metrics.contentFrames += 1
  }
  if (typeof delta?.reasoning_content === 'string') metrics.reasoningFrames += 1
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) metrics.toolFrames += 1
}

const request = requestDefinition()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error(`live probe exceeded ${timeoutMs}ms`)), timeoutMs)
const startedAt = Date.now()
const response = await fetch(request.url, {
  method: 'POST',
  headers: request.headers,
  body: JSON.stringify(request.body),
  signal: controller.signal,
})
const headersMs = Date.now() - startedAt
if (!response.ok) {
  throw new Error(`HTTP ${response.status}: ${await response.text()}`)
}
assert.ok(response.body, 'streaming response body is missing')

const metrics = {
  protocol,
  sourceChars,
  status: response.status,
  headersMs,
  firstByteMs: undefined,
  firstContentMs: undefined,
  commentFrames: 0,
  dataFrames: 0,
  contentFrames: 0,
  reasoningFrames: 0,
  toolFrames: 0,
  errorFrames: 0,
  invalidJsonFrames: 0,
  terminalFrames: 0,
  content: '',
}

const decoder = new TextDecoder()
let pending = ''
for await (const chunk of response.body) {
  const now = Date.now()
  if (metrics.firstByteMs === undefined) metrics.firstByteMs = now - startedAt
  pending += decoder.decode(chunk, { stream: true })
  const frames = pending.split(/\r?\n\r?\n/)
  pending = frames.pop() || ''
  for (const frame of frames) {
    const previousContentLength = metrics.content.length
    inspectSseFrame(frame, metrics)
    if (metrics.content.length > previousContentLength && metrics.firstContentMs === undefined) {
      metrics.firstContentMs = now - startedAt
    }
  }
}
pending += decoder.decode()
if (pending.trim()) inspectSseFrame(pending, metrics)
clearTimeout(timeout)

const totalMs = Date.now() - startedAt
assert.ok(headersMs < headerMaxMs, `response headers were delayed ${headersMs}ms (limit ${headerMaxMs}ms)`)
assert.equal(metrics.errorFrames, 0, 'received an upstream error event')
assert.equal(metrics.invalidJsonFrames, 0, 'received invalid SSE JSON')
assert.equal(metrics.reasoningFrames, 0, 'reasoning leaked into the context-summary response')
assert.equal(metrics.toolFrames, 0, 'the compaction request invoked a tool')
assert.equal(metrics.terminalFrames, 1, 'expected exactly one terminal event')
assert.ok(metrics.content.trim().length > 0, 'context summary was empty')
const missingSourceMarkers = sourceMarkers.filter(marker => !metrics.content.includes(marker))
assert.deepEqual(missingSourceMarkers, [], `summary omitted source markers: ${missingSourceMarkers.join(', ')}`)

console.log(JSON.stringify({
  ...metrics,
  content: undefined,
  sourceMarkerCount: sourceMarkers.length,
  missingSourceMarkers,
  summaryChars: metrics.content.length,
  totalMs,
}, null, 2))
