import assert from 'node:assert/strict'

// This probe intentionally models an Anthropic client: every turn is a new
// HTTP request and the client replays the complete messages array. It does
// not use previous_response_id or any server-side conversation identifier.
// Strict protocol mode is the default. Set
// CHAT2API_CLAUDE_ALLOW_DUPLICATE_MESSAGE_START=true only to continue the
// semantic stages while retaining the duplicate-event warning in the report.
const configuredBaseUrl = (process.env.CHAT2API_CLAUDE_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_CLAUDE_API_KEY || 'sk-litellm-local'
const model = process.env.CHAT2API_CLAUDE_MODEL || 'Qwen3.8-Max'
const mode = (process.env.CHAT2API_CLAUDE_MODE || 'all').toLowerCase()
const timeoutMs = envInteger('CHAT2API_CLAUDE_TIMEOUT_MS', 600_000, 1)
const headerMaxMs = envInteger('CHAT2API_CLAUDE_HEADER_MAX_MS', timeoutMs, 1)
const contextChars = envInteger('CHAT2API_CLAUDE_CONTEXT_CHARS', 1_572_864, 1)
const toolCount = envInteger('CHAT2API_CLAUDE_TOOL_COUNT', 40, 1)
const stressRequests = envInteger('CHAT2API_CLAUDE_STRESS_REQUESTS', 4, 0)
const stressConcurrency = envInteger('CHAT2API_CLAUDE_STRESS_CONCURRENCY', 2, 1)
const stressContextChars = envInteger('CHAT2API_CLAUDE_STRESS_CONTEXT_CHARS', 24_576, 1)
const countTokensEnabled = envBoolean('CHAT2API_CLAUDE_COUNT_TOKENS', true)
const allowDuplicateMessageStart = envBoolean('CHAT2API_CLAUDE_ALLOW_DUPLICATE_MESSAGE_START', false)
const streamPattern = parseStreamPattern(
  process.env.CHAT2API_CLAUDE_STREAM_PATTERN || 'false,true,false,true',
)

assert.ok(['all', 'long', 'stress', 'count'].includes(mode), 'CHAT2API_CLAUDE_MODE must be all, long, stress, or count')
assert.ok(toolCount <= 128, 'CHAT2API_CLAUDE_TOOL_COUNT must not exceed 128')
assert.ok(stressConcurrency <= 32, 'CHAT2API_CLAUDE_STRESS_CONCURRENCY must not exceed 32')
assert.ok(model.trim(), 'CHAT2API_CLAUDE_MODEL must be set')

const markers = {
  alpha: 'A7F3-19C2-ALPHA',
  quarter: 'Q4B8-77D1-QUARTER',
  middle: 'M5E2-83A9-MIDDLE',
  threeQuarter: 'T9C4-26F7-THREE-QUARTER',
  omega: 'O2D6-91B5-OMEGA',
}
const markerSpecs = [
  { offset: 0.005, record: `MEMORY_NEEDLE_ALPHA=${markers.alpha}` },
  { offset: 0.25, record: `MEMORY_NEEDLE_QUARTER=${markers.quarter}` },
  { offset: 0.5, record: `MEMORY_NEEDLE_MIDDLE=${markers.middle}` },
  { offset: 0.75, record: `MEMORY_NEEDLE_THREE_QUARTER=${markers.threeQuarter}` },
  { offset: 0.995, record: `MEMORY_NEEDLE_OMEGA=${markers.omega}` },
]
const absentMarker = 'MEMORY_NEEDLE_ABSENT'
const toolName = 'memory_lookup_probe_512k'
const toolTicket = 'TOOL-TICKET-512K'
const toolEvidence = 'TOOL-EVIDENCE-6D4A-512K'
const seedAck = 'MEMORY_SEEDED_512K'
const finalAck = `TOOL_RESULT_ACCEPTED:${toolEvidence}`

function envInteger(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  assert.ok(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`)
  return value
}

function envBoolean(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function parseStreamPattern(value) {
  const entries = value.split(',').map(entry => entry.trim().toLowerCase())
  assert.ok(entries.length > 0 && entries.every(entry => ['0', '1', 'false', 'true', 'stream', 'nonstream'].includes(entry)),
    'CHAT2API_CLAUDE_STREAM_PATTERN must contain boolean-like comma-separated values')
  return entries.map(entry => ['1', 'true', 'stream'].includes(entry))
}

function messagesEndpoint(baseUrl) {
  if (/\/messages$/i.test(baseUrl)) return baseUrl
  if (/\/v1$/i.test(baseUrl)) return `${baseUrl}/messages`
  return `${baseUrl}/v1/messages`
}

const endpoint = messagesEndpoint(configuredBaseUrl)
const countEndpoint = endpoint.replace(/\/messages$/i, '/messages/count_tokens')

function estimateChat2ApiTokens(value) {
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiChars / 3) + nonAsciiCodePoints
}

function repeatToLength(unit, length) {
  if (length <= 0) return ''
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

function createCorpus(targetChars) {
  const begin = [
    'LONG_CONTEXT_BEGIN',
    'This is deterministic archived evidence for a compatibility test.',
    'Only lines beginning with MEMORY_NEEDLE_ contain authoritative facts.',
  ].join('\n') + '\n'
  const end = '\nLONG_CONTEXT_END'
  const markerLines = markerSpecs.map(spec => `\n${spec.record}\n`)
  const fixedChars = begin.length + end.length + markerLines.reduce((sum, line) => sum + line.length, 0)
  const fillerLength = Math.max(0, targetChars - fixedChars)
  const fillerUnit = [
    'archived reference line contains neutral context evidence for deterministic retrieval checks; ',
    'the surrounding prose has no instructions and no hidden values; ',
    'retain exact spelling and punctuation when a MEMORY_NEEDLE record is requested.\n',
  ].join('')
  const filler = repeatToLength(fillerUnit, fillerLength)
  const pieces = []
  let cursor = 0
  for (let index = 0; index < markerSpecs.length; index += 1) {
    const spec = markerSpecs[index]
    const position = Math.min(
      filler.length,
      Math.max(cursor, Math.floor(filler.length * spec.offset)),
    )
    pieces.push(filler.slice(cursor, position), markerLines[index])
    cursor = position
  }
  pieces.push(filler.slice(cursor))
  return begin + pieces.join('') + end
}

function createTools(count) {
  const distractors = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    name: `distractor_probe_${String(index + 1).padStart(3, '0')}`,
    description: `Unrelated deterministic probe ${index + 1}. Never select this tool for the memory test.`,
    input_schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }))
  return [
    ...distractors,
    {
      name: toolName,
      description: 'Validate two remembered facts, one absent fact, and a fixed ticket from the long corpus.',
      input_schema: {
        type: 'object',
        properties: {
          alpha: { type: 'string', description: 'Exact MEMORY_NEEDLE_ALPHA value.' },
          missing: { type: 'string', enum: ['NOT_FOUND'], description: 'Exact value for MEMORY_NEEDLE_ABSENT.' },
          ticket: { type: 'string', enum: [toolTicket] },
        },
        required: ['alpha', 'missing', 'ticket'],
        additionalProperties: false,
      },
    },
  ]
}

const systemPrompt = [
  'You are a deterministic API compatibility probe.',
  'Follow the latest user instruction exactly and keep responses concise.',
  'The LONG_CONTEXT corpus is authoritative evidence; do not invent values.',
  `After a successful tool result, reply with exactly ${finalAck} and no extra text.`,
].join(' ')

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('')
}

function contentChars(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, block) => {
    if (typeof block === 'string') return sum + block.length
    if (typeof block?.text === 'string') return sum + block.text.length
    if (typeof block?.input === 'object') return sum + JSON.stringify(block.input).length
    if (typeof block?.content === 'string') return sum + block.content.length
    return sum
  }, 0)
}

function messageTextChars(messages) {
  return messages.reduce((sum, message) => sum + contentChars(message?.content), 0)
}

function requestSummary(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const serialized = JSON.stringify(body)
  return {
    requestBytes: Buffer.byteLength(serialized, 'utf8'),
    messageCount: messages.length,
    messageTextChars: messageTextChars(messages),
    estimatedChat2ApiTokens: estimateChat2ApiTokens(messages.map(message => (
      typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content || '')
    )).join('\n')),
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
  }
}

function authHeaders() {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

function shortError(value) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, 1_000)
}

function emptyStreamState() {
  return {
    eventCount: 0,
    eventTypes: {},
    messageStartCount: 0,
    messageStopCount: 0,
    doneMarkerCount: 0,
    invalidJsonCount: 0,
    errorEvents: [],
    text: '',
    reasoningChars: 0,
    blocks: new Map(),
    stopReason: undefined,
    firstContentMs: undefined,
  }
}

function blockFor(state, index, fallbackType = 'text') {
  if (!state.blocks.has(index)) {
    state.blocks.set(index, {
      index,
      type: fallbackType,
      text: '',
      partialJson: '',
    })
  }
  return state.blocks.get(index)
}

function processSseFrame(frame, state, nowMs, startedAt) {
  const lines = frame.split(/\r?\n/)
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return
  if (data === '[DONE]') {
    state.doneMarkerCount += 1
    return
  }
  state.eventCount += 1
  let event
  try {
    event = JSON.parse(data)
  } catch {
    state.invalidJsonCount += 1
    return
  }
  const type = typeof event?.type === 'string' ? event.type : 'unknown'
  state.eventTypes[type] = (state.eventTypes[type] || 0) + 1
  if (type === 'message_start') state.messageStartCount += 1
  if (type === 'message_stop') state.messageStopCount += 1
  if (type === 'error' || event?.error) {
    state.errorEvents.push({ type, message: shortError(event?.error?.message || event?.message || data) })
  }
  if (type === 'message_delta') state.stopReason = event?.delta?.stop_reason ?? state.stopReason
  if (type === 'content_block_start') {
    const index = Number.isInteger(event.index) ? event.index : state.blocks.size
    const source = event.content_block || {}
    const block = blockFor(state, index, source.type || 'text')
    block.type = source.type || block.type
    if (source.id) block.id = source.id
    if (source.name) block.name = source.name
    if (source.input && typeof source.input === 'object') block.input = source.input
    if (typeof source.text === 'string') block.text = source.text
    if (typeof source.thinking === 'string') block.thinking = source.thinking
  }
  if (type === 'content_block_delta') {
    const index = Number.isInteger(event.index) ? event.index : 0
    const delta = event.delta || {}
    const block = blockFor(state, index, delta.type === 'input_json_delta' ? 'tool_use' : 'text')
    if (delta.type === 'text_delta') {
      const text = delta.text || ''
      block.type = 'text'
      block.text = `${block.text || ''}${text}`
      state.text += text
      if (state.firstContentMs === undefined && text.length > 0) state.firstContentMs = nowMs - startedAt
    } else if (delta.type === 'thinking_delta') {
      const thinking = delta.thinking || ''
      block.type = 'thinking'
      block.thinking = `${block.thinking || ''}${thinking}`
      state.reasoningChars += thinking.length
    } else if (delta.type === 'input_json_delta') {
      block.type = 'tool_use'
      block.partialJson = `${block.partialJson || ''}${delta.partial_json || ''}`
    }
  }
}

function finalizeStream(state) {
  const content = [...state.blocks.values()]
    .sort((left, right) => left.index - right.index)
    .map(block => {
      if (block.type === 'tool_use') {
        let input = block.input
        if (block.partialJson) {
          try {
            input = JSON.parse(block.partialJson)
          } catch {
            state.invalidJsonCount += 1
          }
        }
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: input && typeof input === 'object' ? input : {},
        }
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking || '' }
      }
      return { type: 'text', text: block.text || '' }
    })
  return {
    content,
    text: textFromContent(content),
    toolUses: content.filter(block => block.type === 'tool_use'),
    eventCount: state.eventCount,
    eventTypes: state.eventTypes,
    messageStartCount: state.messageStartCount,
    messageStopCount: state.messageStopCount,
    doneMarkerCount: state.doneMarkerCount,
    invalidJsonCount: state.invalidJsonCount,
    errorEvents: state.errorEvents,
    reasoningChars: state.reasoningChars,
    stopReason: state.stopReason,
    firstContentMs: state.firstContentMs,
  }
}

async function readStreamingResponse(response, startedAt) {
  assert.ok(response.body, 'streaming response body is missing')
  const state = emptyStreamState()
  const decoder = new TextDecoder()
  let pending = ''
  const reader = response.body.getReader()
  let firstByteMs
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt
    pending += decoder.decode(chunk.value, { stream: true })
    const frames = pending.split(/\r?\n\r?\n/)
    pending = frames.pop() || ''
    for (const frame of frames) processSseFrame(frame, state, Date.now(), startedAt)
  }
  pending += decoder.decode()
  if (pending.trim()) processSseFrame(pending, state, Date.now(), startedAt)
  return { ...finalizeStream(state), firstByteMs }
}

function parseNonStreamingResponse(payload) {
  let data
  try {
    data = JSON.parse(payload)
  } catch {
    throw new Error(`non-stream response was not JSON: ${shortError(payload)}`)
  }
  const content = Array.isArray(data.content) ? data.content : []
  return {
    content,
    text: textFromContent(content),
    toolUses: content.filter(block => block?.type === 'tool_use'),
    eventCount: 1,
    eventTypes: { message: 1 },
    messageStartCount: 1,
    messageStopCount: 1,
    doneMarkerCount: 0,
    invalidJsonCount: 0,
    errorEvents: data.error ? [{ type: 'error', message: shortError(data.error.message || data.error) }] : [],
    reasoningChars: content
      .filter(block => block?.type === 'thinking')
      .reduce((sum, block) => sum + String(block.thinking || '').length, 0),
    stopReason: data.stop_reason,
    usage: data.usage,
    responseId: data.id,
    model: data.model,
  }
}

async function sendMessage({ messages, stream, tools, toolChoice, maxTokens = 256 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream,
    system: systemPrompt,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  }
  const requestStats = requestSummary(body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const headersMs = Date.now() - startedAt
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HTTP ${response.status}: ${shortError(errorText)}`)
    }
    const parsed = stream
      ? await readStreamingResponse(response, startedAt)
      : parseNonStreamingResponse(await response.text())
    const totalMs = Date.now() - startedAt
    const terminalCount = stream
      ? parsed.messageStopCount + parsed.doneMarkerCount
      : 1
    return {
      ...parsed,
      stream,
      status: response.status,
      headersMs,
      totalMs,
      terminalCount,
      request: requestStats,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function countTokens(body) {
  const serialized = JSON.stringify(body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`count_tokens exceeded ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(countEndpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: serialized,
      signal: controller.signal,
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${shortError(text)}`)
    return {
      pass: Number.isInteger(data?.input_tokens) && data.input_tokens > 0,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      inputTokens: data?.input_tokens,
      requestBytes: Buffer.byteLength(serialized, 'utf8'),
    }
  } finally {
    clearTimeout(timer)
  }
}

function assistantMessage(result) {
  const content = Array.isArray(result.content) ? result.content : []
  return {
    role: 'assistant',
    content: content.length > 0 ? content : result.text,
  }
}

function expectedRecall(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`recall response did not contain a JSON object: ${shortError(trimmed)}`)
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  }
  const expected = { ...markers, missing: 'NOT_FOUND' }
  const pass = Object.keys(expected).every(key => parsed[key] === expected[key])
    && Object.keys(parsed).length === Object.keys(expected).length
  return { pass, parsed, expected }
}

function stageError(error) {
  return { pass: false, error: shortError(error instanceof Error ? error.message : error) }
}

function streamForRound(roundIndex) {
  return streamPattern[(roundIndex - 1) % streamPattern.length]
}

function validateCommon(result, stageName) {
  const errors = []
  const protocolWarnings = []
  if (result.status !== 200) errors.push(`status=${result.status}`)
  if (result.headersMs > headerMaxMs) errors.push(`headers=${result.headersMs}ms>${headerMaxMs}ms`)
  if (result.errorEvents.length > 0) errors.push(`error_events=${result.errorEvents.length}`)
  if (result.invalidJsonCount > 0) errors.push(`invalid_sse_json=${result.invalidJsonCount}`)
  if (result.reasoningChars > 0) errors.push(`reasoning_chars=${result.reasoningChars}`)
  if (result.stream && result.terminalCount !== 1) errors.push(`terminal_events=${result.terminalCount}`)
  if (result.stream && result.messageStartCount !== 1) {
    if (allowDuplicateMessageStart && result.messageStartCount > 1) {
      protocolWarnings.push(`duplicate_message_start=${result.messageStartCount}`)
    } else {
      errors.push(`message_start=${result.messageStartCount}`)
    }
  }
  if (result.stream && result.messageStopCount !== 1) errors.push(`message_stop=${result.messageStopCount}`)
  const strictPass = errors.length === 0 && protocolWarnings.length === 0
  if (errors.length > 0) return {
    pass: false,
    strictPass: false,
    protocolWarnings,
    error: `${stageName}: ${errors.join(', ')}`,
  }
  return {
    pass: true,
    strictPass,
    protocolWarnings,
  }
}

async function runLongSuite() {
  const suiteStartedAt = Date.now()
  const corpus = createCorpus(contextChars)
  const seedContent = [
    corpus,
    '',
    `Retain this complete corpus for later requests. Reply with exactly ${seedAck} and nothing else.`,
  ].join('\n')
  const tools = createTools(toolCount)
  const stats = {
    targetContextTokens: 512 * 1024,
    contextChars,
    corpusChars: corpus.length,
    corpusBytes: Buffer.byteLength(corpus, 'utf8'),
    conservativeEstimatedCorpusTokens: estimateChat2ApiTokens(corpus),
    markerCount: markerSpecs.length,
    toolCount: tools.length,
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    clientConversationMode: 'replayed_full_messages_each_request',
  }
  const stages = {}
  let history = [{ role: 'user', content: seedContent }]
  let seedResult

  console.error(`[claude-512k] round 1/4 seed: ${stats.corpusBytes} bytes, stream=${streamForRound(1)}`)
  try {
    seedResult = await sendMessage({ messages: history, stream: streamForRound(1), maxTokens: 128 })
    const common = validateCommon(seedResult, 'seed')
    stages.seed = {
      pass: common.pass && seedResult.text.trim() === seedAck && seedResult.toolUses.length === 0,
      strictProtocolPass: common.strictPass,
      protocolWarnings: common.protocolWarnings,
      ...seedResult,
      output: seedResult.text.slice(0, 300),
      ...(common.pass ? {} : { error: common.error }),
    }
    if (!stages.seed.pass) throw new Error(stages.seed.error || `expected ${seedAck}, got ${shortError(seedResult.text)}`)
    history = [...history, assistantMessage(seedResult)]
  } catch (error) {
    stages.seed = { ...stageError(error), stream: streamForRound(1), request: requestSummary({ messages: history }) }
  }

  if (stages.seed.pass) {
    const recallPrompt = [
      'Use only exact MEMORY_NEEDLE records from the retained corpus.',
      'Return one minified JSON object with exactly these keys: alpha, quarter, middle, threeQuarter, omega, missing.',
      'Map each named key to its corresponding MEMORY_NEEDLE value.',
      `The record ${absentMarker} is absent; its value must be exactly NOT_FOUND.`,
      'Return no markdown and no extra keys.',
    ].join(' ')
    const recallMessages = [...history, { role: 'user', content: recallPrompt }]
    console.error(`[claude-512k] round 2/4 recall: ${requestSummary({ messages: recallMessages }).requestBytes} request bytes, stream=${streamForRound(2)}`)
    try {
      const result = await sendMessage({ messages: recallMessages, stream: streamForRound(2), maxTokens: 256 })
      const common = validateCommon(result, 'recall')
      const check = expectedRecall(result.text)
      stages.recall = {
        pass: common.pass && check.pass && result.toolUses.length === 0,
        strictProtocolPass: common.strictPass,
        protocolWarnings: common.protocolWarnings,
        ...result,
        parsed: check.parsed,
        expected: check.expected,
        ...(common.pass ? {} : { error: common.error }),
      }
      if (!stages.recall.pass) throw new Error(stages.recall.error || `recall mismatch: ${shortError(result.text)}`)
      history = [...recallMessages, assistantMessage(result)]
    } catch (error) {
      stages.recall = { ...stageError(error), stream: streamForRound(2), request: requestSummary({ messages: recallMessages }) }
    }
  } else {
    stages.recall = { pass: false, skipped: true, error: 'seed stage failed' }
  }

  let toolResult
  if (stages.recall.pass) {
    const toolPrompt = [
      `Call ${toolName} exactly once.`,
      `Set alpha to MEMORY_NEEDLE_ALPHA, missing to NOT_FOUND, and ticket to ${toolTicket}.`,
      'Do not emit prose before the tool call; use the completion phrase from the system instruction after its result.',
    ].join(' ')
    const toolMessages = [...history, { role: 'user', content: toolPrompt }]
    console.error(`[claude-512k] round 3/4 tool: ${requestSummary({ messages: toolMessages, tools }).requestBytes} request bytes, ${tools.length} tools, stream=${streamForRound(3)}`)
    try {
      toolResult = await sendMessage({
        messages: toolMessages,
        stream: streamForRound(3),
        tools,
        toolChoice: { type: 'tool', name: toolName },
        maxTokens: 512,
      })
      const common = validateCommon(toolResult, 'tool')
      const call = toolResult.toolUses[0]
      const args = call?.input || {}
      const pass = common.pass
        && toolResult.toolUses.length === 1
        && call?.name === toolName
        && args.alpha === markers.alpha
        && args.missing === 'NOT_FOUND'
        && args.ticket === toolTicket
      stages.tool = {
        pass,
        strictProtocolPass: common.strictPass,
        protocolWarnings: common.protocolWarnings,
        ...toolResult,
        returnedToolCount: toolResult.toolUses.length,
        toolName: call?.name,
        toolUseId: call?.id,
        arguments: args,
        ...(common.pass ? {} : { error: common.error }),
      }
      if (!pass) throw new Error(stages.tool.error || `tool mismatch: ${JSON.stringify({ name: call?.name, args })}`)
      history = [...toolMessages, assistantMessage(toolResult)]
    } catch (error) {
      stages.tool = { ...stageError(error), stream: streamForRound(3), request: requestSummary({ messages: toolMessages, tools }), toolCount: tools.length }
    }
  } else {
    stages.tool = { pass: false, skipped: true, error: 'recall stage failed' }
  }

  if (stages.tool.pass && toolResult?.toolUses?.[0]?.id) {
    const call = toolResult.toolUses[0]
    const toolMessages = [
      ...history,
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify({ status: 'ok', evidence: toolEvidence }),
            is_error: false,
          },
        ],
      },
    ]
    console.error(`[claude-512k] round 4/4 tool_result: ${requestSummary({ messages: toolMessages, tools }).requestBytes} request bytes, stream=${streamForRound(4)}`)
    try {
      const result = await sendMessage({
        messages: toolMessages,
        stream: streamForRound(4),
        tools,
        toolChoice: { type: 'auto' },
        maxTokens: 256,
      })
      const common = validateCommon(result, 'tool_result')
      stages.toolResult = {
        pass: common.pass && result.text.trim() === finalAck && result.toolUses.length === 0,
        strictProtocolPass: common.strictPass,
        protocolWarnings: common.protocolWarnings,
        ...result,
        output: result.text.slice(0, 300),
        unexpectedTools: result.toolUses.map(block => block.name),
        ...(common.pass ? {} : { error: common.error }),
      }
    } catch (error) {
      stages.toolResult = { ...stageError(error), stream: streamForRound(4), request: requestSummary({ messages: toolMessages, tools }), toolCount: tools.length }
    }
  } else {
    stages.toolResult = { pass: false, skipped: true, error: 'valid tool call unavailable' }
  }

  const required = ['seed', 'recall', 'tool', 'toolResult']
  const protocolWarnings = required.flatMap(name => (
    (stages[name]?.protocolWarnings || []).map(warning => ({ stage: name, warning }))
  ))
  return {
    pass: required.every(name => stages[name]?.pass === true),
    strictProtocolPass: required.every(name => stages[name]?.strictProtocolPass !== false),
    protocolWarnings,
    elapsedMs: Date.now() - suiteStartedAt,
    context: stats,
    stages: sanitizeStages(stages),
  }
}

function createStressCorpus(chars, marker) {
  const base = createCorpus(chars)
  return `${base}\nSTRESS_MARKER=${marker}`
}

async function runStressRequest(index) {
  const startedAt = Date.now()
  const marker = `STRESS-${String(index + 1).padStart(4, '0')}-512K-PROBE`
  const stream = index % 2 === 1
  const useTool = index % 4 >= 2
  try {
    const corpus = createStressCorpus(stressContextChars, marker)
    if (useTool) {
      const target = `stress_target_${String(index + 1).padStart(4, '0')}`
      const stressTools = [{
        name: target,
        description: 'Return the exact stress marker.',
        input_schema: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
          additionalProperties: false,
        },
      }, ...createTools(4).slice(0, 3)]
      const result = await sendMessage({
        messages: [{ role: 'user', content: `${corpus}\nCall ${target} exactly once with marker=${marker}.` }],
        stream,
        tools: stressTools,
        toolChoice: { type: 'tool', name: target },
        maxTokens: 128,
      })
      const call = result.toolUses[0]
      const common = validateCommon(result, `stress-${index + 1}`)
      const pass = common.pass && result.toolUses.length === 1 && call?.name === target && call.input?.marker === marker
      return {
        index: index + 1,
        kind: stream ? 'stream_tool' : 'nonstream_tool',
        pass,
        strictProtocolPass: common.strictPass,
        protocolWarnings: common.protocolWarnings,
        elapsedMs: Date.now() - startedAt,
        request: result.request,
        error: pass ? undefined : (common.error || `tool=${call?.name || ''} marker=${call?.input?.marker || ''}`),
      }
    }
    const expected = `STRESS_OK:${marker}`
    const result = await sendMessage({
      messages: [{ role: 'user', content: `${corpus}\nReply with exactly ${expected}.` }],
      stream,
      maxTokens: 128,
    })
    const common = validateCommon(result, `stress-${index + 1}`)
    const pass = common.pass && result.toolUses.length === 0 && result.text.trim() === expected
    return {
      index: index + 1,
      kind: stream ? 'stream_text' : 'nonstream_text',
      pass,
      strictProtocolPass: common.strictPass,
      protocolWarnings: common.protocolWarnings,
      elapsedMs: Date.now() - startedAt,
      request: result.request,
      error: pass ? undefined : (common.error || `text=${shortError(result.text)}`),
    }
  } catch (error) {
    return {
      index: index + 1,
      kind: useTool ? (stream ? 'stream_tool' : 'nonstream_tool') : (stream ? 'stream_text' : 'nonstream_text'),
      pass: false,
      strictProtocolPass: false,
      elapsedMs: Date.now() - startedAt,
      error: shortError(error instanceof Error ? error.message : error),
    }
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))
  return sorted[index]
}

async function runStressSuite() {
  const startedAt = Date.now()
  const results = []
  for (let offset = 0; offset < stressRequests; offset += stressConcurrency) {
    const batchSize = Math.min(stressConcurrency, stressRequests - offset)
    console.error(`[claude-512k] stress batch ${offset + 1}-${offset + batchSize}/${stressRequests}`)
    const batch = await Promise.all(Array.from({ length: batchSize }, (_, index) => runStressRequest(offset + index)))
    results.push(...batch)
  }
  const latencies = results.map(result => result.elapsedMs)
  const failures = results.filter(result => !result.pass)
  const elapsedMs = Date.now() - startedAt
  const protocolWarnings = results.flatMap(result => (
    (result.protocolWarnings || []).map(warning => ({
      index: result.index,
      kind: result.kind,
      warning,
    }))
  ))
  const kinds = [...new Set(results.map(result => result.kind))]
  const byKind = Object.fromEntries(kinds.map(kind => {
    const matching = results.filter(result => result.kind === kind)
    const values = matching.map(result => result.elapsedMs)
    return [kind, {
      requests: matching.length,
      passed: matching.filter(result => result.pass).length,
      failed: matching.filter(result => !result.pass).length,
      latencyMs: { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values, 0) },
    }]
  }))
  return {
    pass: failures.length === 0,
    strictProtocolPass: results.every(result => result.strictProtocolPass === true),
    protocolWarnings,
    requests: stressRequests,
    concurrency: Math.min(stressConcurrency, Math.max(1, stressRequests)),
    contextCharsPerRequest: stressContextChars,
    passed: results.length - failures.length,
    failed: failures.length,
    elapsedMs,
    throughputRequestsPerSecond: elapsedMs > 0
      ? Number((results.length * 1000 / elapsedMs).toFixed(3))
      : 0,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: Math.max(...latencies, 0),
    },
    byKind,
    failures: failures.slice(0, 20),
  }
}

function sanitizeStages(stages) {
  return Object.fromEntries(Object.entries(stages).map(([name, stage]) => {
    const sanitized = { ...stage }
    delete sanitized.content
    delete sanitized.blocks
    delete sanitized.eventTypes
    return [name, sanitized]
  }))
}

async function runCountSuite(corpus, tools) {
  console.error(`[claude-512k] count_tokens: ${Buffer.byteLength(corpus, 'utf8')} corpus bytes`)
  try {
    const result = await countTokens({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: `${corpus}\nReply with ${seedAck}.` }],
      tools,
    })
    return {
      ...result,
      targetContextTokens: 512 * 1024,
      estimatedCorpusTokens: estimateChat2ApiTokens(corpus),
      ratioTo512k: result.inputTokens ? Number((result.inputTokens / (512 * 1024)).toFixed(3)) : undefined,
      calibrationWarning: result.inputTokens > (512 * 1024) * 1.5
        ? 'local count_tokens is substantially more conservative than upstream usage'
        : undefined,
    }
  } catch (error) {
    return { ...stageError(error), targetContextTokens: 512 * 1024 }
  }
}

const startedAt = Date.now()
const corpusForCount = createCorpus(contextChars)
const toolsForCount = createTools(toolCount)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  protocol: 'anthropic_messages',
  endpoint,
  model,
  mode,
  config: {
    timeoutMs,
    headerMaxMs,
    contextChars,
    toolCount,
    stressRequests,
    stressConcurrency,
    stressContextChars,
    streamPattern,
    countTokensEnabled,
    allowDuplicateMessageStart,
  },
}

if (mode === 'all' || mode === 'long' || mode === 'count') {
  report.countTokens = countTokensEnabled
    ? await runCountSuite(corpusForCount, toolsForCount)
    : { skipped: true }
}
if (mode === 'all' || mode === 'long') report.long = await runLongSuite()
if (mode === 'all' || mode === 'stress') report.stress = await runStressSuite()

const requiredSuites = []
if (report.long) requiredSuites.push(report.long)
if (report.stress) requiredSuites.push(report.stress)
const countPass = !report.countTokens || report.countTokens.skipped || report.countTokens.pass === true
const strictProtocolPass = requiredSuites.every(suite => suite.strictProtocolPass !== false)
report.strictProtocolPass = strictProtocolPass
report.protocolWarnings = requiredSuites.flatMap(suite => suite.protocolWarnings || [])
report.semanticPass = countPass && requiredSuites.every(suite => suite.pass === true)
report.pass = report.semanticPass && strictProtocolPass
report.totalElapsedMs = Date.now() - startedAt
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.pass ? 0 : 1
