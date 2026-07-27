import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

function loadQwenAiStreamHandler(overrides = {}) {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const localModules = {
    '../../store/types': {},
    '../promptToolUse': {
      hasToolUse: overrides.hasToolUse || (() => false),
      parseToolUse: overrides.parseToolUse || (() => []),
    },
    './qwen-ai-token-refresh': {
      QwenAiTokenRefresher: class {},
    },
    './qwen-ai-files': {
      QwenAiFileUploader: class {},
      QWEN_AI_DOCUMENT_EVIDENCE_MARKER: '[Attached document evidence]',
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({
        id,
        model,
        object: 'chat.completion.chunk',
        created,
      }),
    },
    '../utils/errors': {
      isClientCancellationError: error => Boolean(
        error && (
          error.name === 'AbortError'
          || error.name === 'CanceledError'
          || error.code === 'ABORT_ERR'
          || error.code === 'ERR_CANCELED'
          || /client disconnected|downstream stream closed|request aborted by (?:the )?client/i.test(error.message || '')
        ),
      ),
      sanitizeForwardedErrorHeaders: () => undefined,
    },
    '../toolCalling/ToolStreamParser': {
      ToolStreamParser: overrides.ToolStreamParser || class {},
    },
    '../toolCalling/protocols': {
      getToolProtocol: overrides.getToolProtocol || (() => ({
        parse: () => ({ toolCalls: [] }),
      })),
    },
    '../toolCalling/workflowHeuristics': {
      isLikelyWorkflowProgressText: overrides.isLikelyWorkflowProgressText || (() => false),
    },
    '../toolCalling/streamValidationPolicy': {
      getToolStreamValidationFailure: overrides.getToolStreamValidationFailure || (() => undefined),
    },
    '../toolCalling/protocols/shared': {
      normalizeArguments: overrides.normalizeArguments || ((value, tool) => {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value
        const properties = tool?.parameters?.properties || {}
        const normalized = Object.fromEntries(Object.entries(parsed || {}).map(([key, item]) => [
          key,
          properties[key]?.type === 'string' && (
            (item !== null && typeof item === 'object')
            || typeof item === 'number'
            || typeof item === 'boolean'
          )
            ? (typeof item === 'object' ? JSON.stringify(item) : String(item))
            : properties[key]?.type === 'array' && item !== null && !Array.isArray(item)
              ? [item]
              : item,
        ]))
        return JSON.stringify(normalized)
      }),
      getToolArgumentValidationIssues: overrides.getToolArgumentValidationIssues || (() => ({
        missingRequired: [],
        unexpected: [],
      })),
    },
    './qwen-ai-native-tools': {
      isCompleteJsonText: overrides.isCompleteJsonText || (() => true),
      mergeNativeToolArguments: overrides.mergeNativeToolArguments || ((_current, next) => next),
      normalizeNativeFunctionCallDelta: overrides.normalizeNativeFunctionCallDelta || (() => []),
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Qwen AI stream test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

class PassthroughToolStreamParser {
  push(content, baseChunk, includeRole) {
    return [{
      ...baseChunk,
      choices: [{
        index: 0,
        delta: {
          ...(includeRole ? { role: 'assistant' } : {}),
          content,
        },
        finish_reason: null,
      }],
    }]
  }

  flush() { return [] }
  recoverFromContent() { return [] }
  hasPendingToolProtocol() { return false }
  hasEmittedToolCall() { return false }
}

function isCompleteJsonText(value) {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function strictNativeArgumentValidation(value, tool) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { missingRequired: [], unexpected: [] }
    }
  }
  if (!tool?.parameters || !value || typeof value !== 'object' || Array.isArray(value)) {
    return { missingRequired: [], unexpected: [] }
  }
  const schema = tool.parameters
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return {
    missingRequired: required.filter(name => !Object.prototype.hasOwnProperty.call(value, name)),
    unexpected: schema.additionalProperties === false
      ? Object.keys(value).filter(name => !Object.prototype.hasOwnProperty.call(properties, name))
      : [],
  }
}

test('Qwen AI stream exposes an idle failure to the proxy route', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 20,
  })
  const ended = once(output, 'end')
  output.resume()

  const failure = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream failure was not emitted')), 500)
    output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
      clearTimeout(timer)
      resolve(error)
    })
  })

  assert.match(failure.message, /idle for more than 1s/)
  assert.equal(failure.status, 504)
  assert.equal(failure.retryable, false)
  assert.equal(output.qwenAiFailure, failure)
  await ended
  upstream.destroy()
})

test('Qwen AI resumable bridge continues after a transport reset', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const resumeCalls = []
  const output = createQwenAiResumableStream(initial, {
    getResponseId: () => 'response-1',
    resume: async responseId => {
      resumeCalls.push(responseId)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  output.on('error', () => {})
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  initial.write('data: partial answer\n\n')
  initial.destroy(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(resumeCalls, ['response-1'])

  resumed.end('data: resumed answer\n\ndata: [DONE]\n\n')
  await ended
  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /partial answer/)
  assert.match(serialized, /resumed answer/)
})

test('Qwen AI recovery aborts a hanging resume within the shared budget', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  initial.on('error', () => {})

  const output = createQwenAiResumableStream(initial, {
    getResponseId: () => 'response-budget',
    resume: async (_responseId, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('resume aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
    maxAttempts: 1,
    delayMs: 0,
    recoveryBudgetMs: 25,
  })
  output.on('error', () => {})
  const errorPromise = once(output, 'error')
  initial.destroy(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))

  const [error] = await errorPromise
  assert.equal(error.status, 504)
  assert.equal(error.code, 'qwen_ai_recovery_timeout')
  assert.equal(error.accountFault, false)
})

test('Qwen AI client cancellation aborts a hanging resume immediately', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const controller = new AbortController()
  const initial = new PassThrough()
  initial.on('error', () => {})
  let resumeStarted
  const started = new Promise(resolve => { resumeStarted = resolve })
  let resumeAborted = false

  const output = createQwenAiResumableStream(initial, {
    signal: controller.signal,
    getResponseId: () => 'response-client-abort',
    resume: async (_responseId, signal) => new Promise((resolve, reject) => {
      resumeStarted()
      signal?.addEventListener('abort', () => {
        resumeAborted = true
        reject(Object.assign(new Error('resume aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
    maxAttempts: 1,
    delayMs: 0,
    recoveryBudgetMs: 10_000,
  })
  output.on('error', () => {})
  const closed = new Promise(resolve => output.once('close', resolve))
  initial.destroy(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
  await started

  controller.abort()
  await closed
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(resumeAborted, true)
})

test('Qwen AI response-id resume and workflow continuation share one recovery budget', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})
  let semanticRecovery = false
  let continuationAborted = false

  const output = createQwenAiResumableStream(initial, {
    getResponseId: () => 'response-shared-budget',
    getSemanticRecoveryError: () => semanticRecovery
      ? Object.assign(new Error('managed workflow incomplete'), { code: 'qwen_ai_semantic_incomplete' })
      : undefined,
    resume: async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      semanticRecovery = true
      setImmediate(() => resumed.end())
      return { data: resumed }
    },
    continueWorkflow: async (_responseId, _error, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        continuationAborted = true
        reject(Object.assign(new Error('continuation aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
    maxAttempts: 1,
    workflowContinuationAttempts: 1,
    delayMs: 0,
    recoveryBudgetMs: 45,
  })
  output.on('error', () => {})
  const errorPromise = once(output, 'error')
  const startedAt = Date.now()

  initial.destroy(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
  const [error] = await errorPromise

  assert.equal(error.status, 504)
  assert.equal(error.code, 'qwen_ai_recovery_timeout')
  assert.equal(continuationAborted, true)
  assert.ok(Date.now() - startedAt < 250, 'recovery phases must not receive separate full budgets')
})

test('Qwen AI concurrent stream recoveries share one response-id continuation', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      await new Promise(resolve => setTimeout(resolve, 20))
      resumed.end(`data: ${JSON.stringify({
        response_id: responseId,
        choices: [{ delta: { phase: 'answer', status: 'finished', content: 'shared answer' } }],
      })}\n\ndata: [DONE]\n\n`)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    recoverFromIdle: (error, onResume) => bridge.recoverFromIdle(error, onResume),
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-concurrent-stream', response_index: 0 },
  })}\n\n`)
  await new Promise(resolve => setImmediate(resolve))

  let secondResumeNotified = false
  const firstRecovery = bridge.recoverFromIdle(new Error('synthetic idle'))
  const secondRecovery = bridge.recoverFromIdle(new Error('synthetic semantic empty'), () => {
    secondResumeNotified = true
  })
  const [firstRecovered, secondRecovered] = await Promise.all([firstRecovery, secondRecovery])
  await ended

  assert.equal(firstRecovered, true)
  assert.equal(secondRecovered, true)
  assert.equal(secondResumeNotified, true)
  assert.deepEqual(resumeCalls, ['response-concurrent-stream'])
  assert.equal(failure, undefined)
  assert.match(Buffer.concat(chunks).toString(), /shared answer/)
})

test('Qwen AI resumable bridge does not resume a completed stream', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  initial.on('error', () => {})
  const resumeCalls = []
  const output = createQwenAiResumableStream(initial, {
    getResponseId: () => 'response-complete',
    resume: async responseId => {
      resumeCalls.push(responseId)
      return new PassThrough()
    },
    maxAttempts: 2,
    delayMs: 0,
  })
  output.on('error', () => {})
  output.resume()
  const ended = once(output, 'end')

  initial.end('data: [DONE]\n\n')
  await ended
  assert.deepEqual(resumeCalls, [])
})

test('Qwen AI resumable bridge stops without retrying after client abort', async () => {
  const { createQwenAiResumableStream } = loadQwenAiStreamHandler()
  const controller = new AbortController()
  const initial = new PassThrough()
  initial.on('error', () => {})
  const resumeCalls = []
  const output = createQwenAiResumableStream(initial, {
    signal: controller.signal,
    getResponseId: () => 'response-aborted',
    resume: async responseId => {
      resumeCalls.push(responseId)
      return new PassThrough()
    },
    maxAttempts: 2,
    delayMs: 0,
  })
  output.on('error', () => {})
  const closed = new Promise(resolve => output.once('close', resolve))

  controller.abort()
  await closed
  assert.deepEqual(resumeCalls, [])
})

test('Qwen AI stream does not treat SSE heartbeats as generation progress', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 100,
    idleTimeoutMs: 20,
  })
  const ended = once(output, 'end')
  output.resume()

  const failurePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('heartbeat stream did not fail')), 300)
    output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  const heartbeat = setInterval(() => {
    upstream.write(': keep-alive\n\ndata:\n\n')
  }, 5)

  const failure = await failurePromise
  clearInterval(heartbeat)
  await ended

  assert.match(failure.message, /idle for more than/)
  assert.equal(failure.status, 504)
  upstream.destroy()
})

test('Qwen AI stream does not treat duplicate cumulative summaries as progress', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 25,
  })
  output.resume()
  const ended = once(output, 'end')
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const event = `data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'thinking_summary',
        status: 'typing',
        extra: { summary_thought: { content: ['same cumulative summary'] } },
      },
    }],
  })}\n\n`

  upstream.write(event)
  const heartbeat = setInterval(() => upstream.write(event), 5)
  const [failure] = await failurePromise
  clearInterval(heartbeat)

  assert.equal(failure.status, 504)
  assert.match(failure.message, /idle for more than 1s/)
  await ended
  upstream.destroy()
})

test('Qwen AI stream resumes the same response after duplicate summaries exhaust the idle budget', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 30,
    recoverFromIdle: error => bridge.recoverFromIdle(error),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
    failure = error
  })
  const ended = once(output, 'end')

  const created = `data: ${JSON.stringify({
    'response.created': { response_id: 'response-semantic-idle', response_index: 0 },
  })}\n\n`
  const summary = `data: ${JSON.stringify({
    response_id: 'response-semantic-idle',
    choices: [{ delta: {
      phase: 'thinking_summary',
      status: 'typing',
      extra: { summary_thought: { content: ['same cumulative summary'] } },
    } }],
  })}\n\n`
  initial.write(created)
  initial.write(summary)
  const duplicateEvents = setInterval(() => initial.write(`${created}${summary}`), 5)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error('semantic idle did not invoke response-id continuation'))
    }, 500)
    const poll = setInterval(() => {
      if (resumeCalls.length === 0) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 5)
  })
  clearInterval(duplicateEvents)

  resumed.end(`${created}${summary}data: ${JSON.stringify({
    response_id: 'response-semantic-idle',
    choices: [{ delta: {
      phase: 'thinking_summary',
      status: 'typing',
      extra: { summary_thought: { content: ['same cumulative summary and more'] } },
    } }],
  })}\n\ndata: ${JSON.stringify({
    response_id: 'response-semantic-idle',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'done' } }],
  })}\n\n`)
  await ended

  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(frame => frame.startsWith('data: {'))
    .map(frame => JSON.parse(frame.slice('data: '.length)))
  const reasoning = events
    .map(event => event.choices?.[0]?.delta?.reasoning_content)
    .filter(value => typeof value === 'string')
    .join('')
  const content = events
    .map(event => event.choices?.[0]?.delta?.content)
    .filter(value => typeof value === 'string')
    .join('')

  assert.deepEqual(resumeCalls, ['response-semantic-idle'])
  assert.equal(failure, undefined)
  assert.equal(reasoning, 'same cumulative summary and more')
  assert.equal(content, 'done')
})

test('Qwen AI stream resumes when incomplete declared native fragments are the only upstream activity', async () => {
  const {
    createQwenAiResumableStream,
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loadQwenAiStreamHandler({
    isCompleteJsonText: value => value === '{"value":1}',
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'declared-native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 30,
    recoverFromIdle: error => bridge.recoverFromIdle(error),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  const created = `data: ${JSON.stringify({
    'response.created': { response_id: 'response-native-idle', response_index: 0 },
  })}\n\n`
  const incompleteEvent = argumentsText => `data: ${JSON.stringify({
    response_id: 'response-native-idle',
    choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: argumentsText },
    } }],
  })}\n\n`
  initial.write(created)
  initial.write(incompleteEvent('{"value": '))
  let fragmentSequence = 0
  const repeatedFragments = setInterval(() => {
    const padding = ' '.repeat((fragmentSequence++ % 4) + 1)
    initial.write(incompleteEvent(`{"value":${padding}`))
  }, 5)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error('incomplete native fragments did not trigger response-id continuation'))
    }, 500)
    const poll = setInterval(() => {
      if (resumeCalls.length === 0) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 5)
  })
  clearInterval(repeatedFragments)

  resumed.write(`data: ${JSON.stringify({
    response_id: 'response-native-idle',
    choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: '{"value":1}' },
    } }],
  })}\n\n`)
  await ended

  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(resumeCalls, ['response-native-idle'])
  assert.equal(failure, undefined)
  assert.match(body, /"name":"declared_tool"/)
  assert.match(body, /"finish_reason":"tool_calls"/)
  assert.match(body, /\[DONE\]/)
})

test('Qwen AI non-stream parsing resumes on semantic idle without resubmitting the prompt', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 30,
    recoverFromIdle: error => bridge.recoverFromIdle(error),
  })

  const created = `data: ${JSON.stringify({
    'response.created': { response_id: 'response-non-stream-idle', response_index: 0 },
  })}\n\n`
  const summary = `data: ${JSON.stringify({
    response_id: 'response-non-stream-idle',
    choices: [{ delta: {
      phase: 'thinking_summary',
      status: 'typing',
      extra: { summary_thought: { content: ['summary'] } },
    } }],
  })}\n\n`
  initial.write(`${created}${summary}`)
  const duplicateEvents = setInterval(() => initial.write(`${created}${summary}`), 5)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error('non-stream semantic idle did not invoke continuation'))
    }, 500)
    const poll = setInterval(() => {
      if (resumeCalls.length === 0) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 5)
  })
  clearInterval(duplicateEvents)

  resumed.end(`${summary}data: ${JSON.stringify({
    response_id: 'response-non-stream-idle',
    choices: [{ delta: {
      phase: 'thinking_summary',
      status: 'typing',
      extra: { summary_thought: { content: ['summary continued'] } },
    } }],
  })}\n\ndata: ${JSON.stringify({
    response_id: 'response-non-stream-idle',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'complete' } }],
  })}\n\n`)

  const result = await resultPromise
  assert.deepEqual(resumeCalls, ['response-non-stream-idle'])
  assert.equal(result.choices[0].message.reasoning_content, 'summary continued')
  assert.equal(result.choices[0].message.content, 'complete')
})

test('Qwen AI concurrent non-stream recoveries share one response-id continuation', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      await new Promise(resolve => setTimeout(resolve, 20))
      resumed.end(`data: ${JSON.stringify({
        response_id: responseId,
        choices: [{ delta: { phase: 'answer', status: 'finished', content: 'shared non-stream answer' } }],
      })}\n\ndata: [DONE]\n\n`)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    recoverFromIdle: (error, onResume) => bridge.recoverFromIdle(error, onResume),
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-concurrent-non-stream', response_index: 0 },
  })}\n\n`)
  await new Promise(resolve => setImmediate(resolve))

  let secondResumeNotified = false
  const firstRecovery = bridge.recoverFromIdle(new Error('synthetic idle'))
  const secondRecovery = bridge.recoverFromIdle(new Error('synthetic semantic empty'), () => {
    secondResumeNotified = true
  })
  const [firstRecovered, secondRecovered] = await Promise.all([firstRecovery, secondRecovery])
  const result = await resultPromise

  assert.equal(firstRecovered, true)
  assert.equal(secondRecovered, true)
  assert.equal(secondResumeNotified, true)
  assert.deepEqual(resumeCalls, ['response-concurrent-non-stream'])
  assert.equal(result.choices[0].message.content, 'shared non-stream answer')
})

test('Qwen AI stream rejects a reasoning-only terminal response when continuation is unavailable', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream, { responseTimeoutMs: 1_000 })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  const reasoningEvent = JSON.stringify({
    response_id: 'response-semantic-empty',
    choices: [{ delta: { phase: 'think', status: 'typing', content: 'internal reasoning' } }],
  })
  upstream.end(`data: ${reasoningEvent}\n\ndata: [DONE]\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_semantic_empty')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /reasoning but without an answer or tool call/)
  assert.match(Buffer.concat(chunks).toString(), /qwen_ai_semantic_empty/)
})

test('Qwen AI stream resumes a reasoning-only [DONE] through the same response id', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      resumed.end(`data: ${JSON.stringify({
        response_id: 'response-semantic-resume',
        choices: [{ delta: { phase: 'answer', status: 'finished', content: 'visible answer' } }],
      })}\n\ndata: [DONE]\n\n`)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.write(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-semantic-resume', response_index: 0 },
  })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    response_id: 'response-semantic-resume',
    choices: [{ delta: { phase: 'think', status: 'typing', content: 'internal reasoning' } }],
  })}\n\ndata: [DONE]\n\n`)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('semantic-empty response was not resumed')), 500)
    const poll = setInterval(() => {
      if (resumeCalls.length === 0) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 5)
  })

  await ended

  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(resumeCalls, ['response-semantic-resume'])
  assert.equal(failure, undefined)
  assert.match(body, /internal reasoning/)
  assert.match(body, /visible answer/)
  assert.match(body, /"finish_reason":"stop"/)
  assert.match(body, /\[DONE\]/)
})

test('Qwen AI stream resumes a dangling managed-tool answer through the same response id', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      resumed.end(`data: ${JSON.stringify({
        response_id: responseId,
        choices: [{ delta: {
          phase: 'answer',
          status: 'typing',
          function_call: { name: 'declared_tool', arguments: '{}' },
        } }],
      })}\n\n`)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.write(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-dangling-tool', response_index: 0 },
  })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    response_id: 'response-dangling-tool',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Starting the next operation:' } }],
  })}\n\n`)

  await ended

  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(resumeCalls, ['response-dangling-tool'])
  assert.equal(failure, undefined)
  assert.doesNotMatch(body, /Starting the next operation:/)
  assert.match(body, /\"name\":\"declared_tool\"/)
  assert.match(body, /\"finish_reason\":\"tool_calls\"/)
  assert.match(body, /\[DONE\]/)
})

test('Qwen AI starts a same-chat workflow continuation after a failed tool result and progress-only answer', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-continuation-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      throw new Error('semantic recovery must not replay the old response')
    },
    continueWorkflow: async parentResponseId => {
      continuationParents.push(parentResponseId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 3,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.write(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-stalled', response_index: 0 },
  })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    response_id: 'response-stalled',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Starting the next operation now' } }],
  })}\n\ndata: [DONE]\n\n`)

  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'response-continued', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'response-continued',
      choices: [{ delta: {
        phase: 'answer',
        status: 'typing',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\ndata: [DONE]\n\n`)
  })

  await ended
  assert.deepEqual(continuationParents, ['response-stalled'])
  assert.deepEqual(resumeCalls, [])
  assert.equal(failure, undefined)
  const body = Buffer.concat(chunks).toString()
  assert.doesNotMatch(body, /Starting the next operation now/)
  assert.match(body, /response-continued/)
  assert.match(body, /"name":"declared_tool"/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI non-stream uses same-chat continuation after a failed tool result and progress-only answer', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-non-stream-continuation-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  handler.setChatId('test-chat')
  const parents = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('non-stream semantic recovery must not GET the old branch')
    },
    continueWorkflow: async parentId => {
      parents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })

  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-non-stream-stalled', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'response-non-stream-stalled',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Starting the next operation now' } }],
  })}\n\ndata: [DONE]\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'response-non-stream-continued', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'response-non-stream-continued',
      choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\ndata: [DONE]\n\n`)
  })

  const result = await resultPromise
  assert.deepEqual(parents, ['response-non-stream-stalled'])
  assert.equal(resumeCalls, 0)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'declared_tool')
})

test('Qwen AI continues after a successful tool result produces progress-only text', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isLikelyWorkflowProgressText: content => content.includes('inspect the folder'),
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-workflow-retry-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: true,
    failedToolResultPending: false,
    managedWorkflowActive: false,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const parents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'workflow-text-only', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'workflow-text-only',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'I will inspect the folder and continue.' } }],
  })}\n\ndata: [DONE]\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'workflow-tool-call', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'workflow-tool-call',
      choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\ndata: [DONE]\n\n`)
  })
  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(parents, ['workflow-text-only'])
  assert.equal(failure, undefined)
  assert.doesNotMatch(body, /I will inspect the folder and continue\./)
  assert.match(body, /"name":"declared_tool"/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI preserves a terminal final answer after a successful tool result', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  initial.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: true,
    failedToolResultPending: false,
    managedWorkflowActive: false,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const parents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      throw new Error('a successful tool result must not require a generic retry')
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'workflow-final-text-first', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'workflow-final-text-first',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'The requested work is complete.' } }],
  })}\n\ndata: [DONE]\n\n`)
  const result = await resultPromise
  assert.deepEqual(parents, [])
  assert.equal(result.choices[0].message.content, 'The requested work is complete.')
})

test('Qwen AI non-stream continues an active managed workflow after progress-only text', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isLikelyWorkflowProgressText: content => content.includes('integrate the component'),
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-active-workflow-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: false,
    failedToolResultPending: false,
    managedWorkflowActive: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const parents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'active-progress-first', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'active-progress-first',
    choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'Next I will integrate the component into the application.',
    } }],
  })}\n\ndata: [DONE]\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'active-progress-tool', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'active-progress-tool',
      choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\ndata: [DONE]\n\n`)
  })

  const result = await resultPromise
  assert.deepEqual(parents, ['active-progress-first'])
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'declared_tool')
})

test('Qwen AI limits progress-only workflow continuation to the configured attempt count', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isLikelyWorkflowProgressText: () => true,
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: true,
    failedToolResultPending: false,
    managedWorkflowActive: false,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const parents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')
  output.resume()

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'bounded-progress-first', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'bounded-progress-first',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Next I will inspect the module.' } }],
  })}\n\ndata: [DONE]\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'bounded-progress-second', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'bounded-progress-second',
      choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Then I will update the module.' } }],
    })}\n\ndata: [DONE]\n\n`)
  })

  const [failure] = await failurePromise
  await ended
  assert.deepEqual(parents, ['bounded-progress-first'])
  assert.equal(failure.code, 'qwen_ai_semantic_incomplete')
})

test('Qwen AI does not start a workflow continuation for an initial auto request', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isLikelyWorkflowProgressText: () => true,
  })
  const initial = new PassThrough()
  initial.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: false,
    failedToolResultPending: false,
    managedWorkflowActive: false,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  const parents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      throw new Error('initial auto request must not continue')
    },
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, { responseTimeoutMs: 1_000 })
  initial.end(`data: ${JSON.stringify({
    response_id: 'initial-auto-answer',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'A normal answer is valid here.' } }],
  })}\n\ndata: [DONE]\n\n`)

  const result = await resultPromise
  assert.deepEqual(parents, [])
  assert.equal(result.choices[0].message.content, 'A normal answer is valid here.')
})

test('Qwen AI recovers one initial progress-only answer for an eligible next-step follow-up', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isLikelyWorkflowProgressText: content => content.includes('inspect the folder'),
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-initial-followup-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    workflowContinuation: false,
    failedToolResultPending: false,
    managedWorkflowActive: false,
    initialProgressRecoveryEligible: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const parents = []
  let failure
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      parents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    workflowContinuationAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'initial-followup-progress', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'initial-followup-progress',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'I will inspect the folder next.' } }],
  })}\n\ndata: [DONE]\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'initial-followup-tool', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'initial-followup-tool',
      choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\ndata: [DONE]\n\n`)
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(parents, ['initial-followup-progress'])
  assert.equal(failure, undefined)
  assert.doesNotMatch(body, /I will inspect the folder next\./)
  assert.match(body, /"name":"declared_tool"/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI stream rejects a dangling managed-tool answer when continuation is unavailable', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, { responseTimeoutMs: 1_000 })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({
    response_id: 'response-dangling-unavailable',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Next step:\n\n' } }],
  })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_semantic_incomplete')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(Buffer.concat(chunks).toString(), /qwen_ai_semantic_incomplete/)
})

test('Qwen AI stream accepts a complete managed-tool answer without semantic recovery', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'The requested work is complete.' } }],
  })}\n\n`)

  await ended
  assert.equal(failure, undefined)
  assert.match(Buffer.concat(chunks).toString(), /The requested work is complete\./)
})

test('Qwen AI stream preserves a continuation endpoint failure after semantic recovery', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  initial.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      throw Object.assign(new Error('continuation quota exhausted'), {
        status: 429,
        code: 'qwen_ai_capacity_limit',
        retryable: false,
      })
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')
  output.resume()

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-semantic-failure', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'response-semantic-failure',
    choices: [{ delta: { phase: 'think', status: 'typing', content: 'internal reasoning' } }],
  })}\n\ndata: [DONE]\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 429)
  assert.equal(failure.code, 'qwen_ai_capacity_limit')
  assert.equal(failure.accountFault, undefined)
  assert.match(failure.message, /continuation quota exhausted/)
})

test('Qwen AI non-stream resumes a reasoning-only terminal response through the same response id', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const resumeCalls = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      resumed.end(`data: ${JSON.stringify({
        response_id: 'response-semantic-non-stream',
        choices: [{ delta: { phase: 'answer', status: 'finished', content: 'visible answer' } }],
      })}\n\ndata: [DONE]\n\n`)
      return { data: resumed }
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.write(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-semantic-non-stream', response_index: 0 },
  })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    response_id: 'response-semantic-non-stream',
    choices: [{ delta: { phase: 'think', status: 'typing', content: 'internal reasoning' } }],
  })}\n\ndata: [DONE]\n\n`)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('non-stream semantic-empty response was not resumed')), 500)
    const poll = setInterval(() => {
      if (resumeCalls.length === 0) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 5)
  })

  const result = await resultPromise
  assert.deepEqual(resumeCalls, ['response-semantic-non-stream'])
  assert.equal(result.choices[0].message.content, 'visible answer')
  assert.equal(result.choices[0].message.reasoning_content, 'internal reasoning')
})

test('Qwen AI non-stream rejects a dangling managed-tool answer when continuation is unavailable', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.end(`data: ${JSON.stringify({
    response_id: 'response-dangling-non-stream',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'Starting work:\uFF1A' } }],
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.code === 'qwen_ai_semantic_incomplete'
    && error.retryable === false
    && error.accountFault === false
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream preserves a continuation endpoint failure after semantic recovery', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const initial = new PassThrough()
  initial.on('error', () => {})

  const handler = new QwenAiStreamHandler('test-model')
  handler.setChatId('test-chat')
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      throw Object.assign(new Error('non-stream continuation quota exhausted'), {
        status: 429,
        code: 'qwen_ai_capacity_limit',
        retryable: false,
      })
    },
    maxAttempts: 1,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-semantic-non-stream-failure', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'response-semantic-non-stream-failure',
    choices: [{ delta: { phase: 'think', status: 'typing', content: 'internal reasoning' } }],
  })}\n\ndata: [DONE]\n\n`)

  await assert.rejects(resultPromise, error => {
    assert.equal(error.status, 429)
    assert.equal(error.code, 'qwen_ai_capacity_limit')
    assert.equal(error.accountFault, undefined)
    assert.match(error.message, /non-stream continuation quota exhausted/)
    return true
  })
})

test('Qwen AI response timeout zero disables the absolute deadline for stream and non-stream parsing', async () => {
  const previousResponseTimeout = process.env.QWEN_AI_RESPONSE_TIMEOUT_MS
  const previousRequestTimeout = process.env.QWEN_AI_REQUEST_TIMEOUT_MS
  process.env.QWEN_AI_RESPONSE_TIMEOUT_MS = '0'
  // The old parser rejected zero and fell back to this positive request limit.
  process.env.QWEN_AI_REQUEST_TIMEOUT_MS = '20'
  let loaded
  try {
    loaded = loadQwenAiStreamHandler()
  } finally {
    if (previousResponseTimeout === undefined) delete process.env.QWEN_AI_RESPONSE_TIMEOUT_MS
    else process.env.QWEN_AI_RESPONSE_TIMEOUT_MS = previousResponseTimeout
    if (previousRequestTimeout === undefined) delete process.env.QWEN_AI_REQUEST_TIMEOUT_MS
    else process.env.QWEN_AI_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }

  const {
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loaded
  const streamingUpstream = new PassThrough()
  streamingUpstream.on('error', () => {})
  const streamingHandler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await streamingHandler.handleStream(streamingUpstream, {
    idleTimeoutMs: 1_000,
  })
  const chunks = []
  let streamFailure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => {
    streamFailure = error
  })
  const ended = once(output, 'end')

  streamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'thinking_summary',
    status: 'typing',
    extra: { summary_thought: { content: ['still working'] } },
  } }] })}\n\n`)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(streamFailure, undefined)

  streamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'stream complete',
  } }] })}\n\n`)
  await ended
  assert.match(Buffer.concat(chunks).toString(), /stream complete/)

  const nonStreamingUpstream = new PassThrough()
  nonStreamingUpstream.on('error', () => {})
  const nonStreamingHandler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const resultPromise = nonStreamingHandler.handleNonStream(nonStreamingUpstream, {
    idleTimeoutMs: 1_000,
  })
  nonStreamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'thinking_summary',
    status: 'typing',
    extra: { summary_thought: { content: ['still working'] } },
  } }] })}\n\n`)
  await new Promise(resolve => setTimeout(resolve, 50))
  nonStreamingUpstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'non-stream complete',
  } }] })}\n\n`)

  const result = await resultPromise
  assert.equal(result.choices[0].message.content, 'non-stream complete')
})

test('Qwen AI stream waits for terminal output before rejecting an undeclared native tool call', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        function_call: {
          name: 'provider_internal_tool',
          arguments: '{}',
        },
      },
    }],
  })}\n\n`)

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(output.qwenAiFailure, undefined)

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'finished',
        function_call: {
          name: 'provider_internal_tool',
          arguments: '{}',
        },
      },
    }],
  })}\n\n`)

  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'upstream_tool_error')
  assert.equal(failure.param, 'tool_calls')
  assert.equal(failure.code, 'undeclared_native_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /undeclared native tool call: provider_internal_tool/)
  assert.match(Buffer.concat(chunks).toString(), /"accountFault":false/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream does not let undeclared native tool events reset the idle timer', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 300,
    idleTimeoutMs: 25,
  })
  const ended = once(output, 'end')
  output.resume()
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const event = `data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        function_call: { name: 'provider_internal_tool', arguments: '{}' },
      },
    }],
  })}\n\n`
  const interval = setInterval(() => upstream.write(event), 5)

  const [failure] = await failurePromise
  clearInterval(interval)
  await ended

  assert.equal(failure.status, 504)
  assert.match(failure.message, /idle for more than/)
  assert.equal(failure.accountFault, undefined)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects usable answer text after a complete undeclared native tool event', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'usable answer',
    } }] })}\n\n`,
  ].join(''))

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure?.code, 'undeclared_native_tool_call')
  assert.equal(failure?.accountFault, false)
  assert.doesNotMatch(body, /usable answer/)
  assert.match(body, /event: error/)
  assert.doesNotMatch(body, /"finish_reason":"stop"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream tolerates incomplete undeclared native noise when usable answer text follows', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.end([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{"partial":' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'usable answer',
    } }] })}\n\n`,
  ].join(''))

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure, undefined)
  assert.match(body, /usable answer/)
  assert.match(body, /\[DONE\]/)
})

test('Qwen AI stream allows a declared native tool after an undeclared fragment on the same call', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: '{"value":1}' },
    } }] })}\n\n`,
  ].join(''))

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure, undefined)
  assert.match(body, /declared_tool/)
  assert.match(body, /tool_calls/)
  assert.match(body, /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream normalizes complete native arguments against the declared schema', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write']),
    toolChoiceMode: 'auto',
    tools: [{
      name: 'Write',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
          todos: { type: 'array', items: { type: 'object' } },
        },
      },
      source: 'openai',
    }],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: {
      name: 'Write',
      arguments: JSON.stringify({
        file_path: 'src/example.ts',
        content: { enabled: true },
        todos: { subject: 'verify', status: 'pending' },
      }),
    },
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCall = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])[0]
  assert.ok(toolCall)
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    file_path: 'src/example.ts',
    content: '{"enabled":true}',
    todos: [{ subject: 'verify', status: 'pending' }],
  })
  assert.match(Buffer.concat(chunks).toString(), /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream completes a managed tool call without waiting for upstream DONE', async () => {
  class CompletedManagedToolStreamParser {
    constructor() {
      this.emitted = false
    }

    push(content, baseChunk, includeRole) {
      if (!content || this.emitted) return []
      this.emitted = true
      return [{
        ...baseChunk,
        choices: [{
          index: 0,
          delta: {
            ...(includeRole ? { role: 'assistant' } : {}),
            tool_calls: [{
              index: 0,
              id: 'call-managed-0',
              type: 'function',
              function: { name: 'Write', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
      }]
    }

    flush() { return [] }
    recoverFromContent() { return [] }
    hasPendingToolProtocol() { return false }
    hasEmittedToolCall() { return this.emitted }
  }

  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: CompletedManagedToolStreamParser,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 2_000,
    idleTimeoutMs: 1_000,
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    content: 'complete managed tool call',
  } }] })}\n\n`)

  await Promise.race([
    ended,
    new Promise((_, reject) => setTimeout(() => reject(new Error('managed tool call did not finish without upstream DONE')), 500)),
  ])

  const body = Buffer.concat(chunks).toString()
  assert.equal(failure, undefined)
  assert.match(body, /"name":"Write"/)
  assert.match(body, /"finish_reason":"tool_calls"/)
  assert.match(body, /\[DONE\]/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream normalizes legacy tool_use arguments against the declared schema', async () => {
  const legacyArguments = JSON.stringify({
    taskId: 1,
    content: { enabled: true },
  })
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    hasToolUse: content => content.includes('<tool_use>'),
    parseToolUse: () => [{
      id: 'legacy-call',
      type: 'function',
      function: {
        name: 'Write',
        arguments: legacyArguments,
      },
    }],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write']),
    toolChoiceMode: 'auto',
    tools: [{
      name: 'Write',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          content: { type: 'string' },
        },
      },
      source: 'openai',
    }],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: `<tool_use><name>Write</name><arguments>${legacyArguments}</arguments></tool_use>`,
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCall = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])[0]
  assert.ok(toolCall)
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    taskId: '1',
    content: '{"enabled":true}',
  })
})

test('Qwen AI stream applies each declared schema to parallel native tool calls', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['Write', 'TodoWrite']),
    toolChoiceMode: 'auto',
    tools: [
      {
        name: 'Write',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string' } },
        },
        source: 'openai',
      },
      {
        name: 'TodoWrite',
        parameters: {
          type: 'object',
          properties: { todos: { type: 'array', items: { type: 'object' } } },
        },
        source: 'openai',
      },
    ],
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    tool_calls: [
      {
        id: 'write-call',
        function: {
          name: 'Write',
          arguments: JSON.stringify({ content: { enabled: true } }),
        },
      },
      {
        id: 'todo-call',
        function: {
          name: 'TodoWrite',
          arguments: JSON.stringify({ todos: { content: 'verify', status: 'pending' } }),
        },
      },
    ],
  } }] })}\n\n`)

  await ended
  const events = Buffer.concat(chunks).toString().split('\n\n')
    .filter(block => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(block => JSON.parse(block.slice('data: '.length)))
  const toolCalls = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || [])
  assert.equal(toolCalls.length, 2)
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    content: '{"enabled":true}',
  })
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), {
    todos: [{ content: 'verify', status: 'pending' }],
  })
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects incomplete declared native tool arguments only at terminal output', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })
  const chunks = []
  let observedFailure
  output.on('data', chunk => chunks.push(chunk))
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, error => { observedFailure = error })
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'think',
      status: 'typing',
      content: 'planning',
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'declared_tool', arguments: '{"value":' },
    } }] })}\n\n`,
  ].join(''))

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(observedFailure, undefined)
  assert.equal(upstream.destroyed, false)

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: { name: 'declared_tool', arguments: '{"value":' },
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'tool_call_parse_error')
  assert.equal(failure.param, 'tool_calls')
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: declared_tool/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /"finish_reason":"tool_calls"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects an empty declared native tool argument block', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-empty',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    function_call: { name: 'declared_tool', arguments: '' },
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 502)
  assert.equal(failure.type, 'tool_call_parse_error')
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: declared_tool/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /"finish_reason":"tool_calls"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream rejects an incomplete declared call before complete calls or answer text can finish', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['complete_tool', 'incomplete_tool']),
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'I will use the available tools.',
    tool_calls: [{
      id: 'native-complete',
      function: { name: 'complete_tool', arguments: '{"value":1}' },
    }, {
      id: 'native-incomplete',
      function: { name: 'incomplete_tool', arguments: '{"value":' },
    }],
  } }] })}\n\n`)

  const [failure] = await failurePromise
  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'malformed_tool_call')
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.match(failure.message, /incomplete JSON arguments: incomplete_tool/)
  assert.doesNotMatch(body, /I will use the available tools/)
  assert.doesNotMatch(body, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(body, /"finish_reason":"stop"/)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing rejects an undeclared native tool only at terminal output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'another_provider_tool',
            arguments: '{}',
          },
        }],
      },
    }],
  })}\n\n`)

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'finished',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'another_provider_tool',
            arguments: '{}',
          },
        }],
      },
    }],
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'upstream_tool_error'
    && error.param === 'tool_calls'
    && error.code === 'undeclared_native_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /another_provider_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing rejects answer text after a complete undeclared native tool event', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      function_call: { name: 'provider_internal_tool', arguments: '{}' },
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'usable answer',
    } }] })}\n\n`,
  ].join(''))

  await assert.rejects(result, error => (
    error.code === 'undeclared_native_tool_call'
    && error.accountFault === false
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing rejects terminal incomplete declared native tool arguments', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write([
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'think',
      status: 'typing',
      content: 'planning',
    } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      function_call: { name: 'declared_tool', arguments: '{"value":' },
    } }] })}\n\n`,
  ].join(''))

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'tool_call_parse_error'
    && error.param === 'tool_calls'
    && error.code === 'malformed_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /incomplete JSON arguments: declared_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream rejects an incomplete declared call before complete calls or answer text can finish', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['complete_tool', 'incomplete_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'I will use the available tools.',
    tool_calls: [{
      id: 'native-complete',
      function: { name: 'complete_tool', arguments: '{"value":1}' },
    }, {
      id: 'native-incomplete',
      function: { name: 'incomplete_tool', arguments: '{"value":' },
    }],
  } }] })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.type === 'tool_call_parse_error'
    && error.code === 'malformed_tool_call'
    && error.retryable === false
    && error.accountFault === false
    && /incomplete JSON arguments: incomplete_tool/.test(error.message)
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI non-stream parsing does not accept a native tool after truncated upstream output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    toolChoiceMode: 'auto',
  })
  const result = handler.handleNonStream(upstream, {
    responseTimeoutMs: 500,
    idleTimeoutMs: 100,
  })

  upstream.end(`data: ${JSON.stringify({
    choices: [{
      delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'native-call-1',
          function: {
            name: 'declared_tool',
            arguments: '{"value":',
          },
        }],
      },
    }],
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 502
    && error.code === 'qwen_ai_stream_incomplete'
    && error.retryable === false
  ))
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream classifies an in-band captcha envelope as risk control', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::captcha required'],
    data: { url: 'https://chat.qwen.ai/punish?action=captcha&x5secdata=secret' },
  })}\n\n`)

  const [failure] = await failurePromise
  assert.equal(failure.status, 403)
  assert.equal(failure.code, 'qwen_ai_risk_control')
  assert.match(failure.message, /FAIL_SYS_USER_VALIDATE/)
  assert.doesNotMatch(failure.message, /x5secdata=secret/)
  await ended
  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"status":403/)
  assert.match(serialized, /"retryable":false/)
})

test('Qwen AI stream does not confuse token usage 429 with an HTTP rate limit', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const chunks = []
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        role: 'assistant',
        content: 'normal answer',
        phase: 'answer',
        status: 'typing',
      },
    }],
    usage: {
      output_tokens_details: {
        reasoning_tokens: 10_954,
        text_tokens: 429,
      },
    },
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
  assert.match(Buffer.concat(chunks).toString(), /normal answer/)
})

test('Qwen AI stream preserves an explicit 429 error envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    status: 429,
    error: { message: 'too many requests' },
  })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 429)
  assert.equal(failure.retryable, false)
  assert.match(Buffer.concat(chunks).toString(), /"status":429/)
})

test('Qwen AI stream classifies a structured quota-limit envelope as 429', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    error: {
      code: 'quota_limit',
      details: 'The service is busy. Please try again later.',
    },
    response_id: 'provider-response-id',
    response_index: 0,
  })}\n\n`)

  const [failure] = await failurePromise
  await ended
  assert.equal(failure.status, 429)
  assert.equal(failure.code, 'qwen_ai_capacity_limit')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /service is busy/i)
  assert.match(Buffer.concat(chunks).toString(), /"status":429/)
})

test('Qwen AI non-stream parsing classifies a structured quota-limit envelope as 429', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const result = handler.handleNonStream(upstream)

  upstream.end(`data: ${JSON.stringify({
    error: {
      code: 'quota_limit',
      details: 'The service is busy. Please try again later.',
    },
  })}\n\n`)

  await assert.rejects(result, error => (
    error.status === 429
    && error.code === 'qwen_ai_capacity_limit'
    && error.retryable === false
  ))
})

test('Qwen AI stream classifies a code-only risk envelope as 403', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.resume()

  upstream.end(`data: ${JSON.stringify({ error: { code: 'FAIL_SYS_USER_VALIDATE' } })}\n\n`)
  const [failure] = await failurePromise

  assert.equal(failure.status, 403)
  assert.equal(failure.code, 'qwen_ai_risk_control')
})

test('Qwen AI stream preserves generic structured error metadata', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({
    error: {
      status: 503,
      message: 'upstream unavailable',
      type: 'provider_error',
      param: 'model',
      code: 'upstream_unavailable',
      retryable: true,
    },
  })}\n\n`)
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 503)
  assert.equal(failure.type, 'provider_error')
  assert.equal(failure.param, 'model')
  assert.equal(failure.code, 'upstream_unavailable')
  assert.equal(failure.retryable, true)

  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"status":503/)
  assert.match(serialized, /"type":"provider_error"/)
  assert.match(serialized, /"param":"model"/)
  assert.match(serialized, /"code":"upstream_unavailable"/)
  assert.match(serialized, /"retryable":true/)
})

test('Qwen AI stream classifies string and array error envelopes', async () => {
  const cases = [
    { envelope: { error: 'too many requests' }, expectedStatus: 429 },
    { envelope: { errors: ['captcha required'] }, expectedStatus: 403 },
    {
      envelope: {
        choices: [{ delta: { content: 'partial answer' } }],
        error: 'rate limit exceeded',
      },
      expectedStatus: 429,
    },
  ]

  for (const { envelope, expectedStatus } of cases) {
    const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
    const output = await handler.handleStream(upstream)
    const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
    output.resume()
    const ended = once(output, 'end')

    upstream.write(`data: ${JSON.stringify(envelope)}\n\n`)

    const [failure] = await failurePromise
    await ended
    assert.equal(failure.status, expectedStatus)
  }
})

test('Qwen AI stream ignores rate-limit words on an ordinary completion envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        content: 'normal answer',
        phase: 'answer',
        status: 'typing',
      },
    }],
    message: 'rate limit documentation example',
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
})

test('Qwen AI stream ignores numeric 429 metadata on an ordinary completion envelope', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  let failureCount = 0
  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  const ended = once(output, 'end')

  upstream.write(`data: ${JSON.stringify({
    code: 429,
    choices: [{ delta: { phase: 'answer', status: 'typing', content: 'normal' } }],
    usage: { output_tokens_details: { text_tokens: 429 } },
  })}\n\n`)
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.equal(failureCount, 0)
  assert.equal(output.qwenAiFailure, undefined)
})

test('Qwen AI stream classifies a plain-text error event', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.resume()
  const ended = once(output, 'end')

  upstream.end('event: error\ndata: too many requests\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 429)
  assert.equal(failure.retryable, false)
})

test('Qwen AI stream maps malformed JSON and upstream transport aborts to 502', async () => {
  for (const failUpstream of [
    upstream => upstream.end('data: {not-json}\n\n'),
    upstream => upstream.destroy(new Error('aborted')),
  ]) {
    const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('test-model')
    const output = await handler.handleStream(upstream)
    const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
    output.resume()

    failUpstream(upstream)
    const [failure] = await failurePromise

    assert.equal(failure.status, 502)
    assert.equal(failure.retryable, false)
  }
})

test('Qwen AI non-stream parsing maps malformed JSON and upstream transport aborts to 502', async () => {
  for (const failUpstream of [
    upstream => upstream.end('data: {not-json}\n\n'),
    upstream => upstream.destroy(new Error('aborted')),
  ]) {
    const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
    const upstream = new PassThrough()
    upstream.on('error', () => {})
    const handler = new QwenAiStreamHandler('test-model')
    const result = handler.handleNonStream(upstream)

    failUpstream(upstream)

    await assert.rejects(result, error => (
      error.status === 502
      && error.retryable === false
    ))
  }
})

test('Qwen AI invalid HTTP 200 non-SSE responses never become successful HTTP statuses', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: {} },
  )

  const genericError = await adapter.createInvalidStreamError({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ success: false, message: 'upstream rejected the request' }),
  }, 'returned a non-stream response instead of a chat event stream')
  assert.equal(genericError.status, 502)
  assert.equal(genericError.retryable, false)

  const quotaError = await adapter.createInvalidStreamError({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ error: { code: 'quota_limit', details: 'service busy' } }),
  }, 'returned a non-stream response instead of a chat event stream')
  assert.equal(quotaError.status, 429)
  assert.equal(quotaError.code, 'qwen_ai_capacity_limit')
  assert.equal(quotaError.retryable, false)
})

test('Qwen AI workflow continuation posts only a new parented user turn', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: { token: 'test-token' } },
  )
  const calls = []
  const responseStream = new PassThrough()
  adapter.refreshTokenIfNeeded = async () => {}
  adapter.assertChatCompletionStreamResponse = async () => {}
  adapter.postWithRefreshRetry = async (url, payload, createOptions) => {
    calls.push({ url, payload, options: createOptions() })
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: responseStream }
  }

  const response = await adapter.continueChatCompletion({
    chatId: 'chat-123',
    parentId: 'assistant-response-456',
    model: 'qwen3.8-max-preview',
    originalModel: 'Qwen3.8-Max-Preview',
    content: 'generic workflow continuation',
  })

  assert.equal(response.data, responseStream)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-123')
  const payload = calls[0].payload
  assert.equal(payload.parent_id, 'assistant-response-456')
  assert.equal(payload.messages.length, 1)
  const message = payload.messages[0]
  assert.equal(message.parentId, 'assistant-response-456')
  assert.equal(message.parent_id, 'assistant-response-456')
  assert.equal(message.content, 'generic workflow continuation')
  assert.equal(message.role, 'user')
  assert.equal(Array.isArray(message.files), true)
  assert.deepEqual(message.files, [])
  assert.match(message.fid, /^[0-9a-f-]{36}$/)
  assert.equal(Array.isArray(message.childrenIds), true)
  assert.equal(message.childrenIds.length, 1)
  assert.match(message.childrenIds[0], /^[0-9a-f-]{36}$/)
  assert.notEqual(message.fid, message.childrenIds[0])
  assert.equal(payload.messages.some(item => item.content === 'original request'), false)
})

test('Qwen AI retries a rejected workflow continuation with the same payload', async () => {
  const {
    QwenAiAdapter,
    isQwenAiChatInProgressEnvelope,
  } = loadQwenAiStreamHandler()
  assert.equal(isQwenAiChatInProgressEnvelope({
    code: 'CHAT_IN_PROGRESS',
    message: 'The chat is in progress!',
  }), true)
  assert.equal(isQwenAiChatInProgressEnvelope({
    message: 'The chat is in progress!',
  }), false)

  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = '2'
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '0'

  const busy = new PassThrough()
  const accepted = new PassThrough()
  const calls = []
  busy.end(JSON.stringify({
    code: 'CHAT_IN_PROGRESS',
    message: 'The chat is in progress!',
  }))
  accepted.end('data: {"response.created":{"response_id":"accepted-response"}}\n\n')

  try {
    const adapter = new QwenAiAdapter(
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      { id: 'account-1', credentials: { token: 'test-token' } },
    )
    adapter.refreshTokenIfNeeded = async () => {}
    adapter.postWithRefreshRetry = async (url, payload, createOptions) => {
      calls.push({ url, payload, options: createOptions() })
      return calls.length === 1
        ? { status: 200, headers: { 'content-type': 'application/json' }, data: busy }
        : { status: 200, headers: { 'content-type': 'text/event-stream' }, data: accepted }
    }

    const response = await adapter.continueChatCompletion({
      chatId: 'chat-busy',
      parentId: 'parent-response',
      model: 'qwen3.8-max-preview',
      content: 'continue the workflow',
    })

    assert.equal(response.data, accepted)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].payload.messages[0].fid, calls[1].payload.messages[0].fid)
    assert.deepEqual(calls[0].payload.messages[0].childrenIds, calls[1].payload.messages[0].childrenIds)
    assert.equal(calls[0].payload.parent_id, 'parent-response')
    assert.equal(calls[1].payload.parent_id, 'parent-response')
  } finally {
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
    busy.destroy()
    accepted.destroy()
  }
})

test('Qwen AI busy-chat budget continues past the legacy five-attempt budget', async () => {
  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  const previousBudget = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
  const previousRequestTimeout = process.env.QWEN_AI_REQUEST_TIMEOUT_MS
  delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '0'
  process.env.QWEN_AI_REQUEST_TIMEOUT_MS = '5000'

  const calls = []
  let accepted
  try {
    const { QwenAiAdapter } = loadQwenAiStreamHandler()
    const adapter = new QwenAiAdapter(
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      { id: 'account-1', credentials: { token: 'test-token' } },
    )
    adapter.refreshTokenIfNeeded = async () => {}
    adapter.postWithRefreshRetry = async (url, payload, createOptions) => {
      calls.push({ url, payload, options: createOptions() })
      if (calls.length <= 6) {
        const busy = new PassThrough()
        busy.end(JSON.stringify({
          code: 'CHAT_IN_PROGRESS',
          message: 'The chat is in progress!',
        }))
        return { status: 200, headers: { 'content-type': 'application/json' }, data: busy }
      }
      accepted = new PassThrough()
      accepted.end('data: {"response.created":{"response_id":"accepted-response"}}\n\n')
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: accepted }
    }

    const response = await adapter.continueChatCompletion({
      chatId: 'chat-busy',
      parentId: 'parent-response',
      model: 'qwen3.8-max-preview',
      content: 'continue the workflow',
    })

    assert.equal(response.data, accepted)
    assert.equal(calls.length, 7)
    assert.equal(calls[0].options.timeout, calls.at(-1).options.timeout)
    assert.equal(calls[0].payload.messages[0].fid, calls.at(-1).payload.messages[0].fid)
  } finally {
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
    if (previousBudget === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS = previousBudget
    if (previousRequestTimeout === undefined) delete process.env.QWEN_AI_REQUEST_TIMEOUT_MS
    else process.env.QWEN_AI_REQUEST_TIMEOUT_MS = previousRequestTimeout
    accepted?.destroy()
  }
})

test('Qwen AI busy-chat retry budget is independent from the request timeout', () => {
  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  const previousBudget = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
  const previousRequestTimeout = process.env.QWEN_AI_REQUEST_TIMEOUT_MS

  try {
    delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
    process.env.QWEN_AI_REQUEST_TIMEOUT_MS = '120000'
    const {
      qwenAiChatInProgressRetryAttemptsFromEnv,
      qwenAiChatInProgressRetryDelayMsFromEnv,
      qwenAiChatInProgressRetryBudgetMsFromEnv,
    } = loadQwenAiStreamHandler()

    assert.equal(qwenAiChatInProgressRetryAttemptsFromEnv(), undefined)
    assert.equal(qwenAiChatInProgressRetryDelayMsFromEnv(), 1_000)
    assert.equal(qwenAiChatInProgressRetryBudgetMsFromEnv(), 120_000)

    process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS = '45000'
    assert.equal(qwenAiChatInProgressRetryBudgetMsFromEnv(), 45_000)

    process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = '999'
    process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '999999'
    assert.equal(qwenAiChatInProgressRetryAttemptsFromEnv(), 999)
    assert.equal(qwenAiChatInProgressRetryDelayMsFromEnv(), 60_000)
    assert.equal(qwenAiChatInProgressRetryBudgetMsFromEnv(), 45_000)
  } finally {
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
    if (previousBudget === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS = previousBudget
    if (previousRequestTimeout === undefined) delete process.env.QWEN_AI_REQUEST_TIMEOUT_MS
    else process.env.QWEN_AI_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }
})

test('Qwen AI bounds a trickling busy-chat preview by the admission budget', async () => {
  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  const previousBudget = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
  const previousRequestTimeout = process.env.QWEN_AI_REQUEST_TIMEOUT_MS
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = ''
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '0'
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS = '25'
  process.env.QWEN_AI_REQUEST_TIMEOUT_MS = '1000'

  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: { token: 'test-token' } },
  )
  adapter.refreshTokenIfNeeded = async () => {}
  const hanging = new PassThrough()
  hanging.write(JSON.stringify({
    code: 'CHAT_IN_PROGRESS',
    message: 'The chat is in progress!',
  }))
  adapter.postWithRefreshRetry = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: hanging,
  })

  try {
    const startedAt = Date.now()
    await assert.rejects(
      adapter.continueChatCompletion({
        chatId: 'chat-trickle',
        parentId: 'parent-response',
        model: 'qwen3.8-max-preview',
        content: 'continue the workflow',
      }),
      error => error.code === 'CHAT_IN_PROGRESS' && error.accountFault === false,
    )
    assert.ok(Date.now() - startedAt < 500, 'trickling preview must not wait for the generation timeout')
  } finally {
    hanging.destroy()
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
    if (previousBudget === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS = previousBudget
    if (previousRequestTimeout === undefined) delete process.env.QWEN_AI_REQUEST_TIMEOUT_MS
    else process.env.QWEN_AI_REQUEST_TIMEOUT_MS = previousRequestTimeout
  }
})

test('Qwen AI bounds CHAT_IN_PROGRESS continuation retries and keeps ordinary JSON failures non-retryable', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = '1'
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '0'

  try {
    const adapter = new QwenAiAdapter(
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      { id: 'account-1', credentials: { token: 'test-token' } },
    )
    adapter.refreshTokenIfNeeded = async () => {}
    const calls = []
    adapter.postWithRefreshRetry = async (url, payload, createOptions) => {
      calls.push({ url, payload, options: createOptions() })
      const busy = new PassThrough()
      busy.end(JSON.stringify({
        code: 'CHAT_IN_PROGRESS',
        message: 'The chat is in progress!',
      }))
      return { status: 200, headers: { 'content-type': 'application/json' }, data: busy }
    }

    await assert.rejects(
      adapter.continueChatCompletion({
        chatId: 'chat-busy',
        parentId: 'parent-response',
        model: 'qwen3.8-max-preview',
        content: 'continue the workflow',
      }),
      error => error.status === 502
        && error.code === 'CHAT_IN_PROGRESS'
        && error.retryable === false
        && error.accountFault === false,
    )
    assert.equal(calls.length, 2, 'one initial submission plus one bounded retry')

    const ordinary = new PassThrough()
    ordinary.end(JSON.stringify({ success: false, message: 'ordinary upstream rejection' }))
    calls.length = 0
    adapter.postWithRefreshRetry = async () => {
      calls.push({ ordinary: true })
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: ordinary,
      }
    }

    await assert.rejects(
      adapter.continueChatCompletion({
        chatId: 'chat-ordinary',
        parentId: 'parent-response',
        model: 'qwen3.8-max-preview',
        content: 'continue the workflow',
      }),
      error => error.status === 502 && error.retryable === false,
    )
    assert.equal(calls.length, 1, 'ordinary JSON must not enter the busy-chat retry loop')
    ordinary.destroy()
  } finally {
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
  }
})

test('Qwen AI cancels a CHAT_IN_PROGRESS wait without issuing another retry', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const previousAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  const previousDelay = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = '3'
  process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = '10000'

  const controller = new AbortController()
  const firstCall = new Promise(resolve => {
    const busy = new PassThrough()
    busy.end(JSON.stringify({ code: 'CHAT_IN_PROGRESS', message: 'The chat is in progress!' }))
    resolve(busy)
  })

  try {
    const adapter = new QwenAiAdapter(
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      { id: 'account-1', credentials: { token: 'test-token' } },
    )
    adapter.refreshTokenIfNeeded = async () => {}
    let calls = 0
    let firstResponseReady
    const firstResponse = new Promise(resolve => { firstResponseReady = resolve })
    adapter.postWithRefreshRetry = async () => {
      calls += 1
      const busy = await firstCall
      firstResponseReady()
      return { status: 200, headers: { 'content-type': 'application/json' }, data: busy }
    }

    const continuation = adapter.continueChatCompletion({
      chatId: 'chat-abort',
      parentId: 'parent-response',
      model: 'qwen3.8-max-preview',
      content: 'continue the workflow',
      signal: controller.signal,
    })
    await firstResponse
    controller.abort()

    await assert.rejects(continuation, error => error.status === 499)
    assert.equal(calls, 1)
  } finally {
    if (previousAttempts === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS = previousAttempts
    if (previousDelay === undefined) delete process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS
    else process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS = previousDelay
  }
})

test('Qwen AI keeps response-id resume separate from busy-chat workflow retries', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: { token: 'test-token' } },
  )
  adapter.refreshTokenIfNeeded = async () => {}
  let getCalls = 0
  const busy = new PassThrough()
  busy.end(JSON.stringify({
    code: 'CHAT_IN_PROGRESS',
    message: 'The chat is in progress!',
  }))
  adapter.getWithRefreshRetry = async () => {
    getCalls += 1
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: busy,
    }
  }

  await assert.rejects(
    adapter.resumeChatCompletion('chat-resume', 'response-parent'),
    error => error.status === 502 && error.code === 'CHAT_IN_PROGRESS',
  )
  assert.equal(getCalls, 1)
  busy.destroy()
})

test('Qwen AI response-id resume cancels an open JSON preview', async () => {
  const { QwenAiAdapter } = loadQwenAiStreamHandler()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: { token: 'test-token' } },
  )
  adapter.refreshTokenIfNeeded = async () => {}
  const hanging = new PassThrough()
  hanging.write('{"error":{"message":"partial')
  adapter.getWithRefreshRetry = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: hanging,
  })
  const controller = new AbortController()
  const startedAt = Date.now()
  const resume = adapter.resumeChatCompletion(
    'chat-open-json',
    'response-open-json',
    controller.signal,
  )
  setTimeout(() => controller.abort(), 25)

  try {
    await assert.rejects(resume, error => error.status === 499 && error.code === 'qwen_ai_client_cancelled')
    assert.ok(Date.now() - startedAt < 500, 'JSON preview must obey the caller cancellation budget')
  } finally {
    hanging.destroy()
  }
})

test('Qwen AI stream ignores a transport cancellation after terminal output', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const loggedErrors = []
  const originalConsoleError = console.error
  let failureCount = 0

  output.on(QWEN_AI_STREAM_FAILURE_EVENT, () => {
    failureCount += 1
  })
  output.resume()
  console.error = (...args) => {
    loggedErrors.push(args)
  }

  try {
    const ended = once(output, 'end')
    upstream.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: 'ok',
          finish_reason: 'stop',
        },
      }],
    })}\n\n`)
    await ended

    assert.equal(upstream.destroyed, true)

    const cancellation = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
      code: 'ERR_CANCELED',
    })
    upstream.emit('error', cancellation)
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(failureCount, 0)
    assert.equal(output.qwenAiFailure, undefined)
    assert.equal(
      loggedErrors.some(args => args[0] === '[QwenAI] Stream error:'),
      false,
    )
  } finally {
    console.error = originalConsoleError
    upstream.destroy()
  }
})

test('Qwen AI stream destroys upstream and ignores events after terminal output', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.write([
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: 'done',
          finish_reason: 'stop',
        },
      }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'typing',
          content: 'late content',
        },
      }],
    })}\n\n`,
  ].join(''))

  await ended

  assert.equal(upstream.destroyed, true)
  assert.match(Buffer.concat(chunks).toString(), /done/)
  assert.doesNotMatch(Buffer.concat(chunks).toString(), /late content/)
})

test('Qwen AI stream exposes a downstream close before upstream completion', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)

  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  output.destroy()
  const [failure] = await failurePromise

  assert.match(failure.message, /downstream stream closed before upstream completed/)
  assert.equal(failure.status, 499)
  assert.equal(failure.retryable, false)
  assert.equal(output.qwenAiFailure, failure)
  assert.equal(upstream.destroyed, true)
})

test('Qwen AI stream classifies an upstream truncation as a non-retryable 502', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_stream_incomplete')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /ended before an upstream completion signal/)
  assert.match(Buffer.concat(chunks).toString(), /"code":"qwen_ai_stream_incomplete"/)
})

test('Qwen AI stream classifies a terminal stream without output as an empty 502', async () => {
  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler()
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('qwen3.8-max-preview')
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: [DONE]\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.code, 'qwen_ai_empty_stream')
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /empty response stream/)
  assert.match(Buffer.concat(chunks).toString(), /"code":"qwen_ai_empty_stream"/)
})

test('Qwen AI stream reports a managed tool validation failure through its failure channel', async () => {
  const validationFailure = {
    message: 'Provider returned a malformed enforced tool call',
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'malformed_tool_call',
  }
  class PendingToolStreamParser {
    push() { return [] }
    flush() { return [] }
    recoverFromContent() { return [] }
    hasPendingToolProtocol() { return true }
    hasEmittedToolCall() { return false }
  }
  const {
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loadQwenAiStreamHandler({
    ToolStreamParser: PendingToolStreamParser,
    getToolStreamValidationFailure: () => validationFailure,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler(
    'qwen3.8-max-preview',
    undefined,
    { shouldParseResponse: true, toolChoiceMode: 'required' },
  )
  const output = await handler.handleStream(upstream)
  const failurePromise = once(output, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end('data: [DONE]\n\n')
  const [failure] = await failurePromise
  await ended

  assert.equal(failure.status, 502)
  assert.equal(failure.type, validationFailure.type)
  assert.equal(failure.code, validationFailure.code)
  assert.equal(failure.retryable, false)
  assert.equal(failure.accountFault, false)
  assert.equal(output.qwenAiFailure, failure)

  const serialized = Buffer.concat(chunks).toString()
  assert.match(serialized, /"type":"tool_call_parse_error"/)
  assert.match(serialized, /"param":"tool_calls"/)
  assert.match(serialized, /"code":"malformed_tool_call"/)
  assert.match(serialized, /"accountFault":false/)
  assert.match(serialized, /"status":502/)
  assert.match(serialized, /"retryable":false/)
})

test('Qwen AI stream corrects a schema-invalid native tool call through same-chat continuation', async () => {
  const {
    createQwenAiResumableStream,
    QwenAiStreamHandler,
    QWEN_AI_STREAM_FAILURE_EVENT,
  } = loadQwenAiStreamHandler({
    getToolArgumentValidationIssues: strictNativeArgumentValidation,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-invalid-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['arbitrary_tool']),
    tools: [{
      name: 'arbitrary_tool',
      source: 'openai',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  const continuationErrorCodes = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('schema-invalid native call must not replay the old branch')
    },
    continueWorkflow: async (parentId, recoveryError) => {
      continuationParents.push(parentId)
      continuationErrorCodes.push(recoveryError?.code)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end([
    `data: ${JSON.stringify({ 'response.created': { response_id: 'response-invalid', response_index: 0 } })}\n\n`,
    `data: ${JSON.stringify({ response_id: 'response-invalid', choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      function_call: { name: 'arbitrary_tool', arguments: JSON.stringify({ prompt: 'wrong field' }) },
    } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''))

  setImmediate(() => {
    continued.end([
      `data: ${JSON.stringify({ 'response.created': { response_id: 'response-corrected', response_index: 0 } })}\n\n`,
      `data: ${JSON.stringify({ response_id: 'response-corrected', choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'arbitrary_tool', arguments: JSON.stringify({ command: 'Write-Output ok' }) },
      } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(continuationParents, ['response-invalid'])
  assert.deepEqual(continuationErrorCodes, ['qwen_ai_invalid_tool_arguments'])
  assert.equal(resumeCalls, 0)
  assert.equal(failure, undefined)
  assert.doesNotMatch(body, /wrong field/)
  assert.match(body, /"name":"arbitrary_tool"/)
  assert.match(body, /Write-Output ok/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI non-stream corrects a schema-invalid native tool call through same-chat continuation', async () => {
  const {
    createQwenAiResumableStream,
    QwenAiStreamHandler,
  } = loadQwenAiStreamHandler({
    getToolArgumentValidationIssues: strictNativeArgumentValidation,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'native-invalid-non-stream-0',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['arbitrary_tool']),
    tools: [{
      name: 'arbitrary_tool',
      source: 'openai',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  const continuationErrorCodes = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('schema-invalid native call must not replay the old branch')
    },
    continueWorkflow: async (parentId, recoveryError) => {
      continuationParents.push(parentId)
      continuationErrorCodes.push(recoveryError?.code)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end([
    `data: ${JSON.stringify({ 'response.created': { response_id: 'response-invalid-non-stream', response_index: 0 } })}\n\n`,
    `data: ${JSON.stringify({ response_id: 'response-invalid-non-stream', choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      function_call: { name: 'arbitrary_tool', arguments: JSON.stringify({ prompt: 'wrong field' }) },
    } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''))

  setImmediate(() => {
    continued.end([
      `data: ${JSON.stringify({ 'response.created': { response_id: 'response-corrected-non-stream', response_index: 0 } })}\n\n`,
      `data: ${JSON.stringify({ response_id: 'response-corrected-non-stream', choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        function_call: { name: 'arbitrary_tool', arguments: JSON.stringify({ command: 'Write-Output ok' }) },
      } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))
  })

  const result = await resultPromise
  assert.deepEqual(continuationParents, ['response-invalid-non-stream'])
  assert.deepEqual(continuationErrorCodes, ['qwen_ai_invalid_tool_arguments'])
  assert.equal(resumeCalls, 0)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'arbitrary_tool')
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), {
    command: 'Write-Output ok',
  })
})

test('Qwen AI stream isolates a complete undeclared native call through same-chat continuation', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  const continuationErrorCodes = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('undeclared native calls must not replay the old branch')
    },
    continueWorkflow: async (parentId, recoveryError) => {
      continuationParents.push(parentId)
      continuationErrorCodes.push(recoveryError?.code)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end([
    `data: ${JSON.stringify({ 'response.created': { response_id: 'response-undeclared', response_index: 0 } })}\n\n`,
    `data: ${JSON.stringify({ response_id: 'response-undeclared', choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'provider-side result is ready',
      tool_calls: [{
        id: 'provider-call',
        function: { name: 'provider_internal_tool', arguments: '{}' },
      }, {
        id: 'declared-call-before-recovery',
        function: { name: 'declared_tool', arguments: '{"stale":true}' },
      }],
    } }] })}\n\ndata: [DONE]\n\n`,
  ].join(''))

  setImmediate(() => {
    continued.end([
      `data: ${JSON.stringify({ 'response.created': { response_id: 'response-declared', response_index: 0 } })}\n\n`,
      `data: ${JSON.stringify({ response_id: 'response-declared', choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        tool_calls: [{
          id: 'declared-call-after-recovery',
          function: { name: 'declared_tool', arguments: '{"verified":true}' },
        }],
      } }] })}\n\ndata: [DONE]\n\n`,
    ].join(''))
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(continuationParents, ['response-undeclared'])
  assert.deepEqual(continuationErrorCodes, ['undeclared_native_tool_call'])
  assert.equal(resumeCalls, 0)
  assert.equal(failure, undefined)
  assert.doesNotMatch(body, /provider_internal_tool|stale/)
  assert.match(body, /declared_tool/)
  assert.match(body, /verified/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI non-stream isolates a complete undeclared native call through same-chat continuation', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('undeclared native calls must not replay the old branch')
    },
    continueWorkflow: async parentId => {
      continuationParents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.end([
    `data: ${JSON.stringify({ 'response.created': { response_id: 'response-undeclared-non-stream', response_index: 0 } })}\n\n`,
    `data: ${JSON.stringify({ response_id: 'response-undeclared-non-stream', choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'provider-side result is ready',
      tool_calls: [{
        id: 'provider-call',
        function: { name: 'provider_internal_tool', arguments: '{}' },
      }, {
        id: 'declared-call-before-recovery',
        function: { name: 'declared_tool', arguments: '{"stale":true}' },
      }],
    } }] })}\n\ndata: [DONE]\n\n`,
  ].join(''))

  setImmediate(() => {
    continued.end([
      `data: ${JSON.stringify({ 'response.created': { response_id: 'response-declared-non-stream', response_index: 0 } })}\n\n`,
      `data: ${JSON.stringify({ response_id: 'response-declared-non-stream', choices: [{ delta: {
        phase: 'answer',
        status: 'finished',
        tool_calls: [{
          id: 'declared-call-after-recovery',
          function: { name: 'declared_tool', arguments: '{"verified":true}' },
        }],
      } }] })}\n\ndata: [DONE]\n\n`,
    ].join(''))
  })

  const result = await resultPromise
  assert.deepEqual(continuationParents, ['response-undeclared-non-stream'])
  assert.equal(resumeCalls, 0)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'declared_tool')
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), {
    verified: true,
  })
})

test('Qwen AI stream discards a terminal-less undeclared branch once its response id arrives', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    getSemanticRecoveryError: () => handler.getPendingSemanticRecoveryError(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('semantic recovery must not replay the undeclared branch')
    },
    continueWorkflow: async parentId => {
      continuationParents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 2,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  initial.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    content: 'old provider progress must be discarded',
    tool_calls: [{
      id: 'provider-call-before-id',
      function: { name: 'provider_internal_tool', arguments: '{}' },
    }],
  } }] })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-after-tool', response_index: 0 },
  })}\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      response_id: 'response-declared-after-close',
      choices: [{ delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'declared-after-close',
          function: { name: 'declared_tool', arguments: '{"verified":true}' },
        }],
      } }],
    })}\n\n`)
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(continuationParents, ['response-after-tool'])
  assert.equal(resumeCalls, 0)
  assert.doesNotMatch(body, /old provider progress|provider_internal_tool/)
  assert.match(body, /declared_tool/)
  assert.match(body, /verified/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})

test('Qwen AI non-stream recovers a terminal-less undeclared branch through same-chat continuation', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    isCompleteJsonText,
    normalizeNativeFunctionCallDelta: delta => delta.tool_calls?.map((toolCall, index) => ({
      key: toolCall.id || String(index),
      id: toolCall.id,
      index,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })) || [],
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  handler.setChatId('test-chat')
  const continuationParents = []
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    getSemanticRecoveryError: () => handler.getPendingSemanticRecoveryError(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async parentId => {
      continuationParents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 0,
    delayMs: 0,
  })
  const resultPromise = handler.handleNonStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })

  initial.write(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    content: 'stale non-stream progress',
    tool_calls: [{
      id: 'provider-call-before-id-non-stream',
      function: { name: 'provider_internal_tool', arguments: '{}' },
    }],
  } }] })}\n\n`)
  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'response-after-tool-non-stream', response_index: 0 },
  })}\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      response_id: 'response-declared-after-close-non-stream',
      choices: [{ delta: {
        phase: 'answer',
        status: 'typing',
        tool_calls: [{
          id: 'declared-after-close-non-stream',
          function: { name: 'declared_tool', arguments: '{"verified":true}' },
        }],
      } }],
    })}\n\n`)
  })

  const result = await resultPromise
  assert.deepEqual(continuationParents, ['response-after-tool-non-stream'])
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'declared_tool')
})

test('Qwen AI managed stream flushes a legal ordinary answer only after validation', async () => {
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, { responseTimeoutMs: 1_000 })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'finished',
    content: 'validated ordinary answer',
  } }] })}\n\ndata: [DONE]\n\n`)

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.match(body, /validated ordinary answer/)
  assert.match(body, /"finish_reason":"stop"/)
  assert.match(body, /\[DONE\]/)
})

test('Qwen AI managed branch buffer fails with 502 instead of releasing an oversized prefix', async () => {
  const previousLimit = process.env.CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES
  process.env.CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES = '256'
  let loaded
  try {
    loaded = loadQwenAiStreamHandler({ ToolStreamParser: PassthroughToolStreamParser })
  } finally {
    if (previousLimit === undefined) delete process.env.CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES
    else process.env.CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES = previousLimit
  }

  const { QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loaded
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
  })
  const output = await handler.handleStream(upstream, { responseTimeoutMs: 1_000 })
  const chunks = []
  let failure
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  upstream.end(`data: ${JSON.stringify({ choices: [{ delta: {
    phase: 'answer',
    status: 'typing',
    content: 'x'.repeat(512),
  } }] })}\n\n`)

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(failure?.status, 502)
  assert.doesNotMatch(body, /x{64}/)
  assert.match(body, /event: error/)
})

test('Qwen AI failed-result final answer fails without retry when workflow attempts are zero', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const initial = new PassThrough()
  initial.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  let continuationCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    getSemanticRecoveryError: () => handler.getPendingSemanticRecoveryError(),
    isComplete: () => handler.isComplete(),
    continueWorkflow: async () => {
      continuationCalls += 1
      throw new Error('workflow continuation must not run with a zero budget')
    },
    workflowContinuationAttempts: 0,
    maxAttempts: 0,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  let failure
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'failed-result-zero-budget', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'failed-result-zero-budget',
    choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: 'I am done without retrying the failed operation.',
    } }],
  })}\n\n`)

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.equal(continuationCalls, 0)
  assert.equal(failure?.code, 'qwen_ai_semantic_incomplete')
  assert.equal(failure?.status, 502)
  assert.doesNotMatch(body, /I am done without retrying/)
  assert.match(body, /event: error/)
})

test('Qwen AI non-stream accepts a parseable managed tool call after a failed result', async () => {
  const managedToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="declared_tool"></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const { QwenAiStreamHandler } = loadQwenAiStreamHandler({
    getToolProtocol: () => ({
      parse: content => ({
        toolCalls: content === managedToolCall
          ? [{ function: { name: 'declared_tool', arguments: '{}' } }]
          : [],
      }),
    }),
  })
  const upstream = new PassThrough()
  upstream.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    protocol: 'managed_xml',
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  let recoveryCalls = 0
  const resultPromise = handler.handleNonStream(upstream, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: async () => {
      recoveryCalls += 1
      return false
    },
  })

  upstream.end(`data: ${JSON.stringify({
    response_id: 'failed-result-managed-tool',
    choices: [{ delta: {
      phase: 'answer',
      status: 'finished',
      content: managedToolCall,
    } }],
  })}\n\ndata: [DONE]\n\n`)

  const result = await resultPromise
  assert.equal(recoveryCalls, 0)
  assert.equal(result.choices[0].message.content, managedToolCall)
})

test('Qwen AI failed-result continuation exhaustion is bounded to one fresh branch', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler, QWEN_AI_STREAM_FAILURE_EVENT } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
  })
  const initial = new PassThrough()
  const continued = new PassThrough()
  initial.on('error', () => {})
  continued.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  const continuationParents = []
  let resumeCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    getSemanticRecoveryError: () => handler.getPendingSemanticRecoveryError(),
    isComplete: () => handler.isComplete(),
    resume: async () => {
      resumeCalls += 1
      throw new Error('failed-result semantic recovery must not replay a branch')
    },
    continueWorkflow: async parentId => {
      continuationParents.push(parentId)
      return { data: continued }
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    workflowContinuationAttempts: 1,
    maxAttempts: 3,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  let failure
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  output.once(QWEN_AI_STREAM_FAILURE_EVENT, error => { failure = error })
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'failed-result-first-branch', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'failed-result-first-branch',
    choices: [{ delta: { phase: 'answer', status: 'finished', content: 'first false completion' } }],
  })}\n\n`)
  setImmediate(() => {
    continued.end(`data: ${JSON.stringify({
      'response.created': { response_id: 'failed-result-second-branch', response_index: 0 },
    })}\n\ndata: ${JSON.stringify({
      response_id: 'failed-result-second-branch',
      choices: [{ delta: { phase: 'answer', status: 'finished', content: 'second false completion' } }],
    })}\n\n`)
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(continuationParents, ['failed-result-first-branch'])
  assert.equal(resumeCalls, 0)
  assert.equal(failure?.code, 'qwen_ai_semantic_incomplete')
  assert.doesNotMatch(body, /first false completion|second false completion/)
  assert.match(body, /event: error/)
})

test('Qwen AI failed-result partial socket close uses response-id transport resume', async () => {
  const { createQwenAiResumableStream, QwenAiStreamHandler } = loadQwenAiStreamHandler({
    ToolStreamParser: PassthroughToolStreamParser,
    normalizeNativeFunctionCallDelta: delta => delta.function_call
      ? [{
          key: 'failed-result-resumed-tool',
          index: 0,
          name: delta.function_call.name,
          arguments: delta.function_call.arguments,
        }]
      : [],
  })
  const initial = new PassThrough()
  const resumed = new PassThrough()
  initial.on('error', () => {})
  resumed.on('error', () => {})
  const handler = new QwenAiStreamHandler('test-model', undefined, {
    shouldParseResponse: true,
    allowedToolNames: new Set(['declared_tool']),
    tools: [{ name: 'declared_tool', parameters: {}, source: 'openai' }],
    toolChoiceMode: 'auto',
    failedToolResultPending: true,
  })
  const resumeCalls = []
  let continuationCalls = 0
  const bridge = createQwenAiResumableStream(initial, {
    getResponseId: () => handler.getResponseId(),
    getSemanticRecoveryError: () => handler.getPendingSemanticRecoveryError(),
    isComplete: () => handler.isComplete(),
    resume: async responseId => {
      resumeCalls.push(responseId)
      return { data: resumed }
    },
    continueWorkflow: async () => {
      continuationCalls += 1
      throw new Error('a transport truncation must not start a fresh user turn')
    },
    onWorkflowContinuation: () => handler.prepareForWorkflowContinuation(),
    maxAttempts: 1,
    delayMs: 0,
  })
  const output = await handler.handleStream(bridge, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 100,
    recoverFromSemanticEmpty: (error, onResume) => bridge.recoverFromIdle(error, onResume),
  })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')

  initial.end(`data: ${JSON.stringify({
    'response.created': { response_id: 'failed-result-truncated', response_index: 0 },
  })}\n\ndata: ${JSON.stringify({
    response_id: 'failed-result-truncated',
    choices: [{ delta: {
      phase: 'answer',
      status: 'typing',
      content: 'partial provider response',
    } }],
  })}\n\n`)
  setImmediate(() => {
    resumed.end(`data: ${JSON.stringify({
      response_id: 'failed-result-truncated',
      choices: [{ delta: {
        phase: 'answer',
        status: 'typing',
        function_call: { name: 'declared_tool', arguments: '{}' },
      } }],
    })}\n\n`)
  })

  await ended
  const body = Buffer.concat(chunks).toString()
  assert.deepEqual(resumeCalls, ['failed-result-truncated'])
  assert.equal(continuationCalls, 0)
  assert.match(body, /declared_tool/)
  assert.match(body, /"finish_reason":"tool_calls"/)
})
