import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareQwenAiMultimodalMessage } from '../../src/main/proxy/adapters/qwen-ai-files.ts'

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
