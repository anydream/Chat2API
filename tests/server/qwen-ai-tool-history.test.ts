import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactQwenAiTranscriptMessages,
  prepareQwenAiMultimodalMessage,
} from '../../src/main/proxy/adapters/qwen-ai-files.ts'

function assistantToolCall(id: string, name: string, round: number) {
  return {
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      {
        id,
        type: 'function' as const,
        function: {
          name,
          arguments: JSON.stringify({ round }),
        },
      },
    ],
  }
}

function toolResult(toolCallId: string, round: number) {
  return {
    role: 'tool' as const,
    tool_call_id: toolCallId,
    content: `result-${round}`,
  }
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]+)"`))?.[1]
}

test('Qwen AI history gives repeated tool calls local IDs and preserves call/result pairing', async () => {
  const messages = [
    { role: 'user' as const, content: 'request-1' },
    assistantToolCall('call_0', 'first_tool', 1),
    toolResult('call_0', 1),
    { role: 'user' as const, content: 'request-2' },
    assistantToolCall('call_0', 'second_tool', 2),
    toolResult('call_0', 2),
    { role: 'user' as const, content: 'request-3' },
    assistantToolCall('call_0', 'third_tool', 3),
    toolResult('call_0', 3),
    assistantToolCall('call_0__2', 'fourth_tool', 4),
    toolResult('call_0__2', 4),
    { role: 'user' as const, content: 'final request' },
  ]

  // No file parts are supplied, so the uploader is intentionally never used.
  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const invokeTags = [...prepared.content.matchAll(/<\|CHAT2API\|invoke\b[^>]*>/g)].map((match) => match[0])
  const resultTags = [...prepared.content.matchAll(/<\|CHAT2API\|tool_result\b[^>]*>[^]*?<\/\|CHAT2API\|tool_result>/g)].map((match) => match[0])

  const expectedIds = ['call_0', 'call_0__2', 'call_0__3', 'call_0__2__2']
  assert.deepEqual(
    invokeTags.map((tag) => attribute(tag, 'tool_call_id')),
    expectedIds,
    'each historical assistant invoke must expose its local tool_call_id',
  )
  assert.deepEqual(
    resultTags.map((tag) => attribute(tag, 'tool_call_id')),
    expectedIds,
    'each tool result must reference the corresponding local tool_call_id',
  )

  for (const [index, id] of expectedIds.entries()) {
    const invokePosition = prepared.content.indexOf(invokeTags[index])
    const resultPosition = prepared.content.indexOf(resultTags[index])
    assert.ok(invokePosition >= 0 && resultPosition > invokePosition, `pair ${id} must remain ordered`)
    assert.match(invokeTags[index], new RegExp(`name="${['first_tool', 'second_tool', 'third_tool', 'fourth_tool'][index]}"`))
    assert.match(resultTags[index], new RegExp(`result-${index + 1}`))
  }

  assert.match(prepared.content, /Use this result to decide the next step\./)
  assert.doesNotMatch(prepared.content, /Authoritative completed tool ledger/)
  assert.equal(prepared.files.length, 0)
})

test('Qwen AI history preserves repeated tool results without inventing completion state', async () => {
  const messages = [
    assistantToolCall('call_x', 'single_tool', 1),
    toolResult('call_x', 1),
    toolResult('call_x', 2),
    { role: 'user' as const, content: 'continue' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const resultTags = [...prepared.content.matchAll(/<\|CHAT2API\|tool_result\b[^>]*>/g)]
  assert.equal(resultTags.length, 2)
  assert.equal((prepared.content.match(/tool_call_id="call_x"/g) ?? []).length, 3)
  assert.match(prepared.content, /result-1/)
  assert.match(prepared.content, /result-2/)
  assert.doesNotMatch(prepared.content, /Authoritative completed tool ledger/)
})

test('Qwen AI places the leading system preamble directly before the latest user turn', async () => {
  const messages = [
    { role: 'system' as const, content: 'general-system-instructions' },
    { role: 'system' as const, content: 'managed-tool-protocol' },
    { role: 'user' as const, content: 'earlier request' },
    assistantToolCall('call_position', 'position_tool', 1),
    toolResult('call_position', 1),
    { role: 'assistant' as const, content: 'earlier answer' },
    { role: 'user' as const, content: 'current request' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const earlierUserPosition = prepared.content.indexOf('User: earlier request')
  const toolCallPosition = prepared.content.indexOf('name="position_tool"')
  const toolResultPosition = prepared.content.indexOf('result-1')
  const generalSystemPosition = prepared.content.indexOf('System: general-system-instructions')
  const managedSystemPosition = prepared.content.indexOf('System: managed-tool-protocol')
  const currentUserPosition = prepared.content.indexOf('User: current request')

  assert.ok(earlierUserPosition >= 0)
  assert.ok(toolCallPosition > earlierUserPosition)
  assert.ok(toolResultPosition > toolCallPosition)
  assert.ok(generalSystemPosition > toolResultPosition)
  assert.ok(managedSystemPosition > generalSystemPosition)
  assert.ok(currentUserPosition > managedSystemPosition)
  assert.match(
    prepared.content,
    /System: general-system-instructions\n\nSystem: managed-tool-protocol\n\nUser: current request/,
  )
  assert.equal((prepared.content.match(/general-system-instructions/g) ?? []).length, 1)
  assert.equal((prepared.content.match(/managed-tool-protocol/g) ?? []).length, 1)
})

test('Qwen AI keeps the leading system preamble in place when no user turn exists', async () => {
  const messages = [
    { role: 'system' as const, content: 'system-without-user' },
    { role: 'assistant' as const, content: 'assistant-only history' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)

  assert.ok(prepared.content.indexOf('System: system-without-user') >= 0)
  assert.ok(
    prepared.content.indexOf('Assistant: assistant-only history')
      > prepared.content.indexOf('System: system-without-user'),
  )
})

test('Qwen AI places the existing system preamble after a trailing tool result', async () => {
  const messages = [
    { role: 'system' as const, content: 'general-system-instructions' },
    { role: 'system' as const, content: 'managed-tool-protocol' },
    { role: 'user' as const, content: 'complete the workflow' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        {
          id: 'call_trailing_a',
          type: 'function' as const,
          function: { name: 'workspace:inspect-a', arguments: '{"round":1}' },
        },
        {
          id: 'call_trailing_b',
          type: 'function' as const,
          function: { name: 'workspace:inspect-b', arguments: '{"round":2}' },
        },
      ],
    },
    toolResult('call_trailing_a', 1),
    toolResult('call_trailing_b', 2),
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const userPosition = prepared.content.indexOf('User: complete the workflow')
  const firstToolCallPosition = prepared.content.indexOf('name="workspace:inspect-a"')
  const secondToolCallPosition = prepared.content.indexOf('name="workspace:inspect-b"')
  const firstToolResultPosition = prepared.content.indexOf('result-1')
  const secondToolResultPosition = prepared.content.indexOf('result-2')
  const generalSystemPosition = prepared.content.indexOf('System: general-system-instructions')
  const managedSystemPosition = prepared.content.indexOf('System: managed-tool-protocol')

  assert.ok(userPosition >= 0)
  assert.ok(firstToolCallPosition > userPosition)
  assert.ok(secondToolCallPosition > firstToolCallPosition)
  assert.ok(firstToolResultPosition > secondToolCallPosition)
  assert.ok(secondToolResultPosition > firstToolResultPosition)
  assert.ok(generalSystemPosition > secondToolResultPosition)
  assert.ok(managedSystemPosition > generalSystemPosition)
  assert.equal((prepared.content.match(/general-system-instructions/g) ?? []).length, 1)
  assert.equal((prepared.content.match(/managed-tool-protocol/g) ?? []).length, 1)
  assert.doesNotMatch(prepared.content, /Continue the original request using the tool result above/)
})

test('Qwen AI keeps a generic continuation after the latest tool result', async () => {
  const messages = [
    { role: 'system' as const, content: 'tool protocol and task instructions' },
    { role: 'user' as const, content: 'Create the requested artifact.' },
    assistantToolCall('call_next', 'workspace:inspect', 1),
    toolResult('call_next', 1),
    {
      role: 'user' as const,
      content: 'Continue the original request using the tool result above. If any requested operation remains, emit the next tool call immediately. Only provide a final answer after the results have been verified by tool output.',
    },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const resultPosition = prepared.content.indexOf('result-1')
  const continuationPosition = prepared.content.indexOf('Continue the original request using the tool result above.')
  const systemPosition = prepared.content.indexOf('System: tool protocol and task instructions')

  assert.ok(resultPosition >= 0)
  assert.ok(continuationPosition > resultPosition)
  assert.ok(systemPosition > resultPosition)
  assert.ok(systemPosition < continuationPosition)
  assert.match(prepared.content, /Only provide a final answer after the results have been verified by tool output\./)
})

test('Qwen AI preserves an individual message when the complete transcript fits', () => {
  const content = `task-start ${'x'.repeat(200_000)} task-end`
  const messages = [{ role: 'user' as const, content }]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 256_000,
    toolResultMaxBytes: 24_000,
    messageMaxBytes: 128_000,
    maxFileParts: 32,
  })

  assert.equal(compacted[0].content, content)
  assert.doesNotMatch(JSON.stringify(compacted), /Earlier conversation omitted|\.\.\. truncated/)
})

test('Qwen AI aggregate budget includes message-array separators', () => {
  const messages = Array.from({ length: 1000 }, () => ({
    role: 'user' as const,
    content: 'x',
  }))
  const maxBytes = 29_500
  assert.ok(Buffer.byteLength(JSON.stringify(messages), 'utf8') > maxBytes)

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes,
    toolResultMaxBytes: 24_000,
    messageMaxBytes: 128_000,
    maxFileParts: 32,
  })

  assert.notEqual(compacted, messages)
  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= maxBytes)
})

test('Qwen AI bounds large history while retaining the task, continuation, and failed tool pair', () => {
  const oldResult = `old-result-start ${'x'.repeat(90000)} old-result-end`
  const failedResult = `failed-result-start ${'y'.repeat(70000)} failed-result-end`
  const messages = [
    { role: 'system' as const, content: 'system preamble' },
    { role: 'user' as const, content: 'Create the requested image in the active project.' },
    assistantToolCall('old-call', 'old_tool', 1),
    toolResult('old-call', 1),
    { role: 'tool' as const, tool_call_id: 'old-call', content: oldResult },
    { role: 'user' as const, content: 'An unrelated middle request.' },
    assistantToolCall('middle-call', 'middle_tool', 2),
    toolResult('middle-call', 2),
    { role: 'user' as const, content: 'Continue the active image task.' },
    assistantToolCall('failed-call', 'image_tool', 3),
    {
      role: 'tool' as const,
      tool_call_id: 'failed-call',
      is_error: true,
      content: failedResult,
    },
    { role: 'user' as const, content: 'Continue the active task using the failed result and retry the operation.' },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 12000,
    toolResultMaxBytes: 2400,
    messageMaxBytes: 3200,
    maxFileParts: 4,
  })
  const serializedBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8')

  assert.ok(serializedBytes <= 12000, `compacted transcript is ${serializedBytes} bytes`)
  assert.deepEqual(messages, snapshot, 'compaction must not mutate caller messages')

  const compactedText = JSON.stringify(compacted)
  assert.match(compactedText, /Create the requested image in the active project\./)
  assert.match(compactedText, /Continue the active task using the failed result/)
  assert.match(compactedText, /failed-call/)
  assert.match(compactedText, /"is_error":true/)
  assert.match(compactedText, /failed-result-(?:start|end)/)
  assert.match(compactedText, /Earlier conversation omitted/)

  const assistantIndex = compacted.findIndex(message => message.role === 'assistant'
    && message.tool_calls?.some(call => call.id === 'failed-call'))
  const resultIndex = compacted.findIndex(message => message.role === 'tool'
    && message.tool_call_id === 'failed-call')
  assert.ok(assistantIndex >= 0 && resultIndex > assistantIndex, 'failed tool call/result must remain paired')
})

test('Qwen AI bounds structural tool arguments when text compaction is exhausted', () => {
  const oversizedArguments = JSON.stringify({ payload: 'x'.repeat(200_000) })
  const messages = [
    { role: 'user' as const, content: 'Keep this task active.' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{
        id: 'oversized-call',
        type: 'function' as const,
        function: {
          name: 'write_image',
          arguments: oversizedArguments,
        },
      }],
    },
    { role: 'tool' as const, tool_call_id: 'oversized-call', content: 'done' },
    { role: 'user' as const, content: 'Continue the task.' },
  ]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 1000,
    toolResultMaxBytes: 100,
    messageMaxBytes: 100,
    maxFileParts: 1,
  })

  const serializedBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8')
  assert.ok(serializedBytes <= 1000, `compacted transcript is ${serializedBytes} bytes`)
  const call = compacted.find(message => message.role === 'assistant')?.tool_calls?.[0]
  assert.ok(call, 'the active tool call metadata should remain available')
  assert.ok(call.function.arguments.length <= 100)
  assert.deepEqual(messages[1].tool_calls?.[0].function.arguments, oversizedArguments)
})

test('Qwen AI drops an oversized tool call and its result together under a strict budget', () => {
  const messages = [
    { role: 'user' as const, content: 'Keep the workflow active.' },
    {
      role: 'assistant' as const,
      content: 'x'.repeat(5000),
      tool_calls: [{
        id: 'pair-that-cannot-fit',
        type: 'function' as const,
        function: {
          name: 'declared_tool',
          arguments: JSON.stringify({ payload: 'y'.repeat(5000) }),
        },
      }],
    },
    { role: 'tool' as const, tool_call_id: 'pair-that-cannot-fit', content: 'tool result' },
    { role: 'user' as const, content: 'Continue.' },
  ]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 300,
    messageMaxBytes: 80,
    toolResultMaxBytes: 80,
    maxFileParts: 1,
  })

  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= 300)
  const retainedCallIds = compacted
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls || [])
    .map(call => call.id)
  const retainedResultIds = compacted
    .filter(message => message.role === 'tool')
    .map(message => message.tool_call_id)
  assert.deepEqual(retainedResultIds, [], 'an omitted call must not leave an orphan result')
  assert.deepEqual(retainedCallIds, [], 'the oversized call is omitted as a structural unit')
})

test('Qwen AI keeps exact tool IDs when a bounded call/result pair is retained', () => {
  const id = `call-${'z'.repeat(180)}`
  const toolName = `declared_tool_${'n'.repeat(180)}`
  const messages = [
    { role: 'user' as const, content: 'Run the operation.' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{
        id,
        type: 'function' as const,
        function: { name: toolName, arguments: JSON.stringify({ value: 'x'.repeat(1200) }) },
      }],
    },
    { role: 'tool' as const, tool_call_id: id, content: 'done' },
    { role: 'user' as const, content: 'Continue.' },
  ]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 3000,
    messageMaxBytes: 256,
    toolResultMaxBytes: 128,
    maxFileParts: 1,
  })
  const retainedCall = compacted.find(message => message.role === 'assistant')?.tool_calls?.[0]
  const retainedResult = compacted.find(message => message.role === 'tool')

  assert.ok(retainedCall)
  assert.ok(retainedResult)
  assert.equal(retainedCall.id, id)
  assert.equal(retainedCall.function.name, toolName)
  assert.equal(retainedResult.tool_call_id, id)
  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= 3000)
})

test('Qwen AI never retains more duplicate-ID results than retained calls', () => {
  const duplicateId = 'call-reused-by-client'
  const messages = [
    { role: 'user' as const, content: 'Run both operations.' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: Array.from({ length: 8 }, (_, index) => ({
        id: duplicateId,
        type: 'function' as const,
        function: {
          name: 'declared_tool',
          arguments: JSON.stringify({ index, payload: 'x'.repeat(400) }),
        },
      })),
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      role: 'tool' as const,
      tool_call_id: duplicateId,
      content: `result-${index}`,
    })),
    { role: 'user' as const, content: 'Continue.' },
  ]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 1200,
    messageMaxBytes: 120,
    toolResultMaxBytes: 80,
    maxFileParts: 1,
  })
  const retainedCallCount = compacted
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls || [])
    .filter(call => call.id === duplicateId)
    .length
  const retainedResultCount = compacted
    .filter(message => message.role === 'tool' && message.tool_call_id === duplicateId)
    .length

  assert.ok(retainedCallCount < 8, 'the strict budget should remove at least one duplicate call')
  assert.equal(retainedResultCount, retainedCallCount)
  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= 1200)
})

test('Qwen AI caps the rendered prompt after tool XML expansion', async () => {
  const envNames = [
    'CHAT2API_QWEN_AI_TRANSCRIPT_MAX_BYTES',
    'CHAT2API_QWEN_AI_TRANSCRIPT_MESSAGE_MAX_BYTES',
    'CHAT2API_QWEN_AI_TRANSCRIPT_TOOL_RESULT_MAX_BYTES',
  ]
  const previous = new Map(envNames.map(name => [name, process.env[name]]))
  process.env.CHAT2API_QWEN_AI_TRANSCRIPT_MAX_BYTES = '5000'
  process.env.CHAT2API_QWEN_AI_TRANSCRIPT_MESSAGE_MAX_BYTES = '10000'
  process.env.CHAT2API_QWEN_AI_TRANSCRIPT_TOOL_RESULT_MAX_BYTES = '10000'

  try {
    // The query string loads a fresh module instance so the environment is
    // sampled before its deployment constants are initialized.
    const moduleUrl = new URL('../../src/main/proxy/adapters/qwen-ai-files.ts', import.meta.url).href
      + `?render-budget-${Date.now()}`
    const { prepareQwenAiMultimodalMessage } = await import(moduleUrl)
    const toolCalls = Array.from({ length: 20 }, (_, index) => ({
      id: `render-call-${index}`,
      type: 'function' as const,
      function: {
        name: 'declared_tool',
        arguments: JSON.stringify({ index, payload: 'x'.repeat(50) }),
      },
    }))
    const prepared = await prepareQwenAiMultimodalMessage([
      { role: 'user', content: 'Run the batch.' },
      { role: 'assistant', content: null, tool_calls: toolCalls },
      { role: 'user', content: 'Continue after the batch.' },
    ], {} as any)

    assert.ok(Buffer.byteLength(prepared.content, 'utf8') <= 5000)
    if (prepared.content.includes('<|CHAT2API|tool_calls>')) {
      assert.equal(
        (prepared.content.match(/<\|CHAT2API\|tool_calls>/g) || []).length,
        (prepared.content.match(/<\/\|CHAT2API\|tool_calls>/g) || []).length,
      )
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('Qwen AI bounds oversized parallel tool-call arrays by the same transcript budget', () => {
  const toolCalls = Array.from({ length: 1000 }, (_, index) => ({
    id: `parallel-${index}`,
    type: 'function' as const,
    function: {
      name: 'declared_tool',
      arguments: JSON.stringify({ index, payload: 'x'.repeat(500) }),
    },
  }))
  const messages = [
    { role: 'user' as const, content: 'Run the active batch.' },
    { role: 'assistant' as const, content: null, tool_calls: toolCalls },
    { role: 'user' as const, content: 'Continue after the batch.' },
  ]

  const compacted = compactQwenAiTranscriptMessages(messages, {
    maxBytes: 10_000,
    toolResultMaxBytes: 100,
    messageMaxBytes: 100,
    maxFileParts: 1,
  })

  const serializedBytes = Buffer.byteLength(JSON.stringify(compacted), 'utf8')
  assert.ok(serializedBytes <= 10_000, `compacted transcript is ${serializedBytes} bytes`)
  const retainedCalls = compacted.find(message => message.role === 'assistant')?.tool_calls ?? []
  assert.ok(retainedCalls.length < toolCalls.length, 'oversized arrays must be bounded')
  assert.ok(retainedCalls.length > 0, 'retain at least one active call when the budget allows it')
  assert.equal(toolCalls.length, 1000, 'caller tool-call array must not be mutated')
})

test('Qwen AI deduplicates and bounds attachment uploads without mutating content', async () => {
  const parts = [
    { type: 'image_url' as const, image_url: { url: 'https://example.test/repeated.png' } },
    { type: 'image_url' as const, image_url: { url: 'https://example.test/repeated.png' } },
    ...Array.from({ length: 35 }, (_, index) => ({
      type: 'image_url' as const,
      image_url: { url: `https://example.test/image-${index}.png` },
    })),
  ]
  const messages = [{ role: 'user' as const, content: parts }]
  const snapshot = JSON.parse(JSON.stringify(messages))
  const uploadedSources: string[] = []
  const uploader = {
    uploadPart: async (part: any) => {
      uploadedSources.push(part.image_url.url)
      return { file: { id: part.image_url.url } }
    },
  }

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as any)

  assert.deepEqual(messages, snapshot, 'attachment preparation must not mutate caller messages')
  assert.ok(uploadedSources.length <= 32)
  assert.equal(new Set(uploadedSources).size, uploadedSources.length)
  assert.equal(prepared.files.length, uploadedSources.length)
  assert.equal(uploadedSources.at(-1), 'https://example.test/image-34.png')
})

test('Qwen AI keeps Anthropic-style user tool_result blocks in the active turn', async () => {
  const messages = [
    { role: 'user' as const, content: 'Run the declared operation.' },
    assistantToolCall('nested-call', 'declared_tool', 1),
    {
      role: 'user' as const,
      content: [{
        type: 'tool_result',
        tool_use_id: 'nested-call',
        is_error: true,
        content: [{ type: 'text', text: 'nested failure' }],
      }],
    } as any,
    { role: 'user' as const, content: 'Retry after the failure.' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const invokePosition = prepared.content.indexOf('tool_call_id="nested-call"')
  const resultPosition = prepared.content.indexOf('nested failure')

  assert.ok(invokePosition >= 0)
  assert.ok(resultPosition > invokePosition)
  assert.match(prepared.content, /Tool execution failed \(is_error=true\)/)
})
