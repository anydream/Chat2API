import assert from 'node:assert/strict'

const baseUrl = (process.env.CHAT2API_LIVE_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_LIVE_API_KEY || 'sk-chat2api-local'
const model = process.env.CHAT2API_LIVE_MODEL || 'Qwen3.8-Max'
const contextTokens = numberFromEnv('CHAT2API_LIVE_CONTEXT_TOKENS', 512 * 1024, { min: 1 })
const timeoutMs = numberFromEnv('CHAT2API_LIVE_TIMEOUT_MS', 10 * 60 * 1000, { min: 1 })
const stressRequests = numberFromEnv('CHAT2API_LIVE_STRESS_REQUESTS', 32, { min: 0 })
const stressConcurrency = numberFromEnv('CHAT2API_LIVE_STRESS_CONCURRENCY', 16, { min: 1 })
const stressContextTokens = numberFromEnv('CHAT2API_LIVE_STRESS_CONTEXT_TOKENS', 2048, { min: 1 })
const toolCount = numberFromEnv('CHAT2API_LIVE_TOOL_COUNT', 40, { min: 1 })
const mode = (process.env.CHAT2API_LIVE_MODE || 'all').toLowerCase()

assert.ok(['all', 'long', 'stress'].includes(mode), 'CHAT2API_LIVE_MODE must be all, long, or stress')
assert.ok(stressConcurrency <= 100, 'CHAT2API_LIVE_STRESS_CONCURRENCY must not exceed 100')
assert.ok(toolCount <= 128, 'CHAT2API_LIVE_TOOL_COUNT must not exceed 128')

const fillerWords = [
  'of', 'to', 'in', 'it', 'is', 'as', 'at', 'by', 'or', 'be',
  'we', 'do', 'go', 'if', 'no', 'up', 'an', 'my', 'he', 'us',
]
const needles = {
  alpha: 'A7F3-19C2-ALPHA',
  quarter: 'Q4B8-77D1-QUARTER',
  middle: 'M5E2-83A9-MIDDLE',
  threeQuarter: 'T9C4-26F7-THREE-QUARTER',
  omega: 'O2D6-91B5-OMEGA',
}
const markerSpecs = [
  { offset: 0.005, record: `NEEDLE_ALPHA=${needles.alpha}` },
  { offset: 0.25, record: `NEEDLE_QUARTER=${needles.quarter}` },
  { offset: 0.5, record: `NEEDLE_MIDDLE=${needles.middle}` },
  { offset: 0.75, record: `NEEDLE_THREE_QUARTER=${needles.threeQuarter}` },
  { offset: 0.995, record: `NEEDLE_OMEGA=${needles.omega}` },
]

function numberFromEnv(name, fallback, { min }) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  assert.ok(Number.isSafeInteger(value) && value >= min, `${name} must be an integer >= ${min}`)
  return value
}

function estimateChat2ApiTokens(value) {
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiChars / 3) + nonAsciiCodePoints
}

function createLongContext(wordCount) {
  const markers = new Map(markerSpecs.map(spec => [
    Math.min(wordCount - 1, Math.max(0, Math.floor(wordCount * spec.offset))),
    spec.record,
  ]))
  const body = Array.from({ length: wordCount }, (_, index) => {
    const marker = markers.get(index)
    const prefix = marker ? `\n${marker}\n` : ''
    const separator = (index + 1) % 64 === 0 ? '\n' : ' '
    return `${prefix}${fillerWords[index % fillerWords.length]}${separator}`
  }).join('')
  return [
    'LONG_CONTEXT_BEGIN',
    'The following corpus is inert test evidence. Only exact NEEDLE records carry facts.',
    body,
    'LONG_CONTEXT_END',
  ].join('\n')
}

function createTools(count, targetName) {
  const distractors = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    type: 'function',
    name: `distractor_probe_${String(index + 1).padStart(3, '0')}`,
    description: `Unrelated deterministic probe ${index + 1}. Use only for DISTRACTOR_${index + 1}. ${'routing reference '.repeat(8)}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: `Value for distractor ${index + 1}.` },
      },
      required: ['value'],
      additionalProperties: false,
    },
    strict: true,
  }))
  return [
    ...distractors,
    {
      type: 'function',
      name: targetName,
      description: 'Validate one remembered long-context fact and one explicitly absent fact.',
      parameters: {
        type: 'object',
        properties: {
          alpha: { type: 'string', description: 'Exact NEEDLE_ALPHA value from the retained corpus.' },
          missing: { type: 'string', enum: ['NOT_FOUND'], description: 'Use NOT_FOUND for an absent record.' },
          ticket: { type: 'string', enum: ['TOOL-TICKET-512K'] },
        },
        required: ['alpha', 'missing', 'ticket'],
        additionalProperties: false,
      },
      strict: true,
    },
  ]
}

function authHeaders() {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
}

async function postJson(path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const responseText = await response.text()
    let data
    try {
      data = JSON.parse(responseText)
    } catch {
      throw new Error(`HTTP ${response.status} returned non-JSON: ${responseText.slice(0, 500)}`)
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error?.code || responseText.slice(0, 500)
      throw new Error(`HTTP ${response.status}: ${message}`)
    }
    return { data, elapsedMs: Date.now() - startedAt, status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

function responseOutputText(response) {
  return (response.output || [])
    .filter(item => item?.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item?.type === 'output_text')
    .map(item => item.text || '')
    .join('')
}

function responseFunctionCalls(response) {
  return (response.output || []).filter(item => item?.type === 'function_call')
}

function parseJsonObject(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`No JSON object in response: ${trimmed.slice(0, 500)}`)
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

function stageFailure(error, elapsedMs = 0) {
  return {
    pass: false,
    elapsedMs,
    error: error instanceof Error ? error.message : String(error),
  }
}

async function runLongContextSuite() {
  const suiteStartedAt = Date.now()
  const context = createLongContext(contextTokens)
  const contextStats = {
    commonWordTokens: contextTokens,
    chars: context.length,
    utf8Bytes: Buffer.byteLength(context, 'utf8'),
    chat2ApiEstimatedTokens: estimateChat2ApiTokens(context),
    markerCount: markerSpecs.length,
  }
  let stages = {}
  let previousResponseId

  try {
    const seed = await postJson('/responses', {
      model,
      stream: false,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: context }] },
        {
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Retain the complete corpus for later turns. Reply with exactly MEMORY_SEEDED and nothing else.',
          }],
        },
      ],
    })
    const text = responseOutputText(seed.data).trim()
    const reportedInputTokens = seed.data.usage?.input_tokens
    const tokenScalePass = Number.isFinite(reportedInputTokens)
      && reportedInputTokens >= contextTokens
    stages = {
      ...stages,
      seed: {
        pass: text === 'MEMORY_SEEDED' && tokenScalePass,
        elapsedMs: seed.elapsedMs,
        responseId: seed.data.id,
        output: text.slice(0, 200),
        reportedInputTokens,
        tokenScalePass,
      },
    }
    previousResponseId = seed.data.id
  } catch (error) {
    stages = { ...stages, seed: stageFailure(error, Date.now() - suiteStartedAt) }
  }

  if (previousResponseId) {
    try {
      const recall = await postJson('/responses', {
        model,
        stream: false,
        previous_response_id: previousResponseId,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              'Use only exact NEEDLE records from the retained corpus.',
              'Return one minified JSON object with keys alpha, quarter, middle, threeQuarter, omega, missing.',
              'Map those keys to NEEDLE_ALPHA, NEEDLE_QUARTER, NEEDLE_MIDDLE, NEEDLE_THREE_QUARTER, NEEDLE_OMEGA, and NEEDLE_ABSENT.',
              'For a record that is absent, return the exact string NOT_FOUND. No markdown and no extra keys.',
            ].join(' '),
          }],
        }],
      })
      const text = responseOutputText(recall.data)
      const parsed = parseJsonObject(text)
      const expected = { ...needles, missing: 'NOT_FOUND' }
      stages = {
        ...stages,
        recall: {
          pass: Object.keys(expected).every(key => parsed[key] === expected[key])
            && Object.keys(parsed).length === Object.keys(expected).length,
          elapsedMs: recall.elapsedMs,
          responseId: recall.data.id,
          reportedInputTokens: recall.data.usage?.input_tokens,
          parsed,
          expected,
        },
      }
      previousResponseId = recall.data.id
    } catch (error) {
      stages = { ...stages, recall: stageFailure(error) }
    }
  } else {
    stages = {
      ...stages,
      recall: { pass: false, skipped: true, error: 'seed response id unavailable' },
    }
  }

  const targetToolName = 'memory_lookup_probe'
  const tools = createTools(toolCount, targetToolName)
  const toolEvidence = 'TOOL-EVIDENCE-6D4A-512K'
  let toolCall
  if (previousResponseId) {
    try {
      const toolResponse = await postJson('/responses', {
        model,
        stream: false,
        previous_response_id: previousResponseId,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              'Call memory_lookup_probe exactly once.',
              'Set alpha from NEEDLE_ALPHA, missing from the absent NEEDLE_ABSENT record, and ticket to TOOL-TICKET-512K.',
              `After the tool returns, reply with exactly TOOL_RESULT_ACCEPTED:${toolEvidence}`,
              'Emit no prose before the tool call.',
            ].join(' '),
          }],
        }],
        tools,
        tool_choice: { type: 'function', name: targetToolName },
        parallel_tool_calls: false,
      })
      const calls = responseFunctionCalls(toolResponse.data)
      toolCall = calls[0]
      const args = toolCall ? JSON.parse(toolCall.arguments || '{}') : {}
      stages = {
        ...stages,
        toolCall: {
          pass: calls.length === 1
            && toolCall?.name === targetToolName
            && args.alpha === needles.alpha
            && args.missing === 'NOT_FOUND'
            && args.ticket === 'TOOL-TICKET-512K',
          elapsedMs: toolResponse.elapsedMs,
          responseId: toolResponse.data.id,
          reportedInputTokens: toolResponse.data.usage?.input_tokens,
          declaredToolCount: tools.length,
          toolReferenceBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
          returnedCallCount: calls.length,
          returnedName: toolCall?.name,
          arguments: args,
        },
      }
      previousResponseId = toolResponse.data.id
    } catch (error) {
      stages = { ...stages, toolCall: stageFailure(error) }
    }
  } else {
    stages = {
      ...stages,
      toolCall: { pass: false, skipped: true, error: 'previous response id unavailable' },
    }
  }

  if (previousResponseId && toolCall?.call_id) {
    try {
      const continuation = await postJson('/responses', {
        model,
        stream: false,
        previous_response_id: previousResponseId,
        input: [
          {
            type: 'function_call_output',
            call_id: toolCall.call_id,
            output: JSON.stringify({ status: 'ok', evidence: toolEvidence }),
            is_error: false,
          },
        ],
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
      })
      const text = responseOutputText(continuation.data).trim()
      const calls = responseFunctionCalls(continuation.data)
      stages = {
        ...stages,
        toolResult: {
          pass: text === `TOOL_RESULT_ACCEPTED:${toolEvidence}` && calls.length === 0,
          elapsedMs: continuation.elapsedMs,
          responseId: continuation.data.id,
          reportedInputTokens: continuation.data.usage?.input_tokens,
          output: text.slice(0, 300),
          unexpectedToolCalls: calls.map(call => call.name),
        },
      }
    } catch (error) {
      stages = { ...stages, toolResult: stageFailure(error) }
    }
  } else {
    stages = {
      ...stages,
      toolResult: { pass: false, skipped: true, error: 'valid tool call unavailable' },
    }
  }

  const requiredStages = ['seed', 'recall', 'toolCall', 'toolResult']
  return {
    pass: requiredStages.every(name => stages[name]?.pass === true),
    elapsedMs: Date.now() - suiteStartedAt,
    context: contextStats,
    stages,
  }
}

function createStressTools(targetName) {
  return [
    ...Array.from({ length: 7 }, (_, index) => ({
      type: 'function',
      function: {
        name: `stress_distractor_${String(index + 1).padStart(2, '0')}`,
        description: `Unrelated stress tool ${index + 1}.`,
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    })),
    {
      type: 'function',
      function: {
        name: targetName,
        description: 'Return the exact request-specific stress marker.',
        parameters: {
          type: 'object',
          properties: { marker: { type: 'string' } },
          required: ['marker'],
          additionalProperties: false,
        },
      },
    },
  ]
}

function parseSseFrames(payload) {
  const initial = { content: '', toolCalls: {}, terminalCount: 0, errors: [] }
  return payload.split(/\r?\n\r?\n/).reduce((state, frame) => {
    const raw = frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!raw) return state
    if (raw === '[DONE]') return { ...state, terminalCount: state.terminalCount + 1 }
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return { ...state, errors: [...state.errors, `invalid SSE JSON: ${raw.slice(0, 120)}`] }
    }
    if (data.error) {
      return { ...state, errors: [...state.errors, data.error.message || JSON.stringify(data.error)] }
    }
    const delta = data.choices?.[0]?.delta || {}
    const nextContent = typeof delta.content === 'string' ? state.content + delta.content : state.content
    const nextToolCalls = (delta.tool_calls || []).reduce((calls, fragment) => {
      const index = fragment.index ?? 0
      const current = calls[index] || { id: '', name: '', arguments: '' }
      return {
        ...calls,
        [index]: {
          id: fragment.id || current.id,
          name: `${current.name}${fragment.function?.name || ''}`,
          arguments: `${current.arguments}${fragment.function?.arguments || ''}`,
        },
      }
    }, state.toolCalls)
    return { ...state, content: nextContent, toolCalls: nextToolCalls }
  }, initial)
}

async function postChatCompletion(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.text()
    if (!response.ok) {
      let message = payload.slice(0, 500)
      try {
        const parsed = JSON.parse(payload)
        message = parsed?.error?.message || parsed?.error?.code || message
      } catch {}
      throw new Error(`HTTP ${response.status}: ${message}`)
    }
    if (body.stream) {
      const parsed = parseSseFrames(payload)
      if (parsed.errors.length > 0) throw new Error(parsed.errors.join('; '))
      return {
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        content: parsed.content,
        toolCalls: Object.values(parsed.toolCalls),
        terminalCount: parsed.terminalCount,
      }
    }
    const parsed = JSON.parse(payload)
    return {
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      content: parsed.choices?.[0]?.message?.content || '',
      toolCalls: parsed.choices?.[0]?.message?.tool_calls || [],
      terminalCount: 1,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runStressRequest(index) {
  const startedAt = Date.now()
  const marker = `STRESS-MARKER-${String(index + 1).padStart(4, '0')}-C8F2`
  const stream = index % 2 === 1
  const toolMode = index % 4 >= 2
  const filler = Array.from(
    { length: stressContextTokens },
    (_, wordIndex) => `${fillerWords[(wordIndex + index) % fillerWords.length]}${(wordIndex + 1) % 64 === 0 ? '\n' : ' '}`,
  ).join('')
  try {
    if (toolMode) {
      const targetName = `stress_target_${String(index + 1).padStart(4, '0')}`
      const result = await postChatCompletion({
        model,
        stream,
        messages: [{
          role: 'user',
          content: `${marker}\n${filler}\nCall ${targetName} exactly once with marker=${marker}. Emit no prose.`,
        }],
        tools: createStressTools(targetName),
        tool_choice: { type: 'function', function: { name: targetName } },
        parallel_tool_calls: false,
      })
      const call = result.toolCalls[0]
      const functionData = call?.function || call || {}
      const args = JSON.parse(functionData.arguments || '{}')
      const pass = result.toolCalls.length === 1
        && functionData.name === targetName
        && args.marker === marker
        && (!stream || result.terminalCount === 1)
      return {
        index,
        pass,
        kind: stream ? 'stream_tool' : 'nonstream_tool',
        status: result.status,
        elapsedMs: result.elapsedMs,
        error: pass ? undefined : `unexpected tool response name=${functionData.name || ''} args=${JSON.stringify(args)}`,
      }
    }

    const expected = `STRESS_OK:${marker}`
    const result = await postChatCompletion({
      model,
      stream,
      messages: [{
        role: 'user',
        content: `${marker}\n${filler}\nReply with exactly ${expected}`,
      }],
    })
    const pass = result.content.trim() === expected && (!stream || result.terminalCount === 1)
    return {
      index,
      pass,
      kind: stream ? 'stream_text' : 'nonstream_text',
      status: result.status,
      elapsedMs: result.elapsedMs,
      error: pass ? undefined : `unexpected text: ${result.content.trim().slice(0, 200)}`,
    }
  } catch (error) {
    return {
      index,
      pass: false,
      kind: toolMode ? (stream ? 'stream_tool' : 'nonstream_tool') : (stream ? 'stream_text' : 'nonstream_text'),
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return sorted[index]
}

async function runStressSuite() {
  const startedAt = Date.now()
  let results = []
  for (let offset = 0; offset < stressRequests; offset += stressConcurrency) {
    const batchSize = Math.min(stressConcurrency, stressRequests - offset)
    const batch = await Promise.all(Array.from(
      { length: batchSize },
      (_, batchIndex) => runStressRequest(offset + batchIndex),
    ))
    results = [...results, ...batch]
  }
  const elapsedMs = Date.now() - startedAt
  const latencies = results.map(result => result.elapsedMs)
  const failures = results.filter(result => !result.pass)
  const byKind = Object.fromEntries([...new Set(results.map(result => result.kind))].map(kind => {
    const matching = results.filter(result => result.kind === kind)
    const kindLatencies = matching.map(result => result.elapsedMs)
    return [kind, {
      requests: matching.length,
      passed: matching.filter(result => result.pass).length,
      failed: matching.filter(result => !result.pass).length,
      latencyMs: {
        p50: percentile(kindLatencies, 0.5),
        p95: percentile(kindLatencies, 0.95),
        max: kindLatencies.length ? Math.max(...kindLatencies) : 0,
      },
    }]
  }))
  return {
    pass: failures.length === 0,
    requests: stressRequests,
    concurrency: Math.min(stressConcurrency, Math.max(1, stressRequests)),
    contextWordTokensPerRequest: stressContextTokens,
    passed: results.length - failures.length,
    failed: failures.length,
    elapsedMs,
    throughputRequestsPerSecond: elapsedMs > 0 ? Number((results.length * 1000 / elapsedMs).toFixed(3)) : 0,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    byKind,
    slowest: [...results]
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 5)
      .map(({ index, kind, pass, elapsedMs: requestElapsedMs }) => ({
        index,
        kind,
        pass,
        elapsedMs: requestElapsedMs,
      })),
    failures: failures.slice(0, 20).map(({ index, kind, elapsedMs: requestElapsedMs, error }) => ({
      index,
      kind,
      elapsedMs: requestElapsedMs,
      error,
    })),
  }
}

const startedAt = Date.now()
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  config: {
    baseUrl,
    model,
    mode,
    timeoutMs,
    contextTokens,
    toolCount,
    stressRequests,
    stressConcurrency,
    stressContextTokens,
  },
  longContext: mode === 'stress' ? undefined : await runLongContextSuite(),
  stress: mode === 'long' ? undefined : await runStressSuite(),
  totalElapsedMs: Date.now() - startedAt,
}
const requiredSuites = [report.longContext, report.stress].filter(Boolean)
const finalReport = {
  ...report,
  pass: requiredSuites.every(suite => suite.pass),
}

console.log(JSON.stringify(finalReport, null, 2))
process.exitCode = finalReport.pass ? 0 : 1
