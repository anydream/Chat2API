import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:todowrite',
      description: 'Update todos',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string' },
                priority: { type: 'string' },
              },
              required: ['content', 'status', 'priority'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'read /tmp/a' }],
    tools,
    ...overrides,
  }
}

test('OpenAI tools plus DeepSeek choose managed prompt', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 4)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|tool_calls>/)
  assert.match(result.messages[0].content as string, /Every required field must appear as its own/)
  assert.match(result.messages[0].content as string, /repeat the parameter tag once per argument/)
  assert.match(result.messages[0].content as string, /Required-parameter XML templates/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|invoke name="default_api:write">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|parameter name="filePath">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|parameter name="content">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|invoke name="default_api:todowrite">/)
  assert.match(result.messages[0].content as string, /\[\{"content":"\.\.\.content\.\.\.","status":"\.\.\.status\.\.\.","priority":"\.\.\.priority\.\.\."\}\]/)
})

test('explicit Cherry Studio MCP adapter uses managed prompt and preserves tool names', () => {
  const result = new ToolCallingEngine({ clientAdapterId: 'cherry-studio-mcp' }).transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'In this environment you have access to a set of tools' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.plan.tools[0].name, 'default_api:read_file')
  assert.equal(result.plan.tools[0].source, 'mcp')
})

test('tool result history receives a generic continuation without mutating the request', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
  ]
  const originalMessages = [...messages]
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.deepEqual(messages, originalMessages)
  assert.equal(result.plan.workflowContinuation, true)
  assert.equal(result.plan.diagnostics.workflowContinuation, true)
  assert.equal(result.messages.at(-2)?.role, 'tool')
  assert.equal(result.messages.at(-1)?.role, 'user')
  assert.match(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /image2-p|Skill/)
})

test('a user retry after a progress-only tool turn receives the same generic continuation', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'assistant' as const, content: 'I will perform the next operation now.' },
    { role: 'user' as const, content: 'continue' },
  ]
  const originalMessages = [...messages]
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.deepEqual(messages, originalMessages)
  assert.equal(result.messages.at(-2)?.content, 'continue')
  assert.equal(result.messages.at(-1)?.role, 'user')
  assert.match(String(result.messages.at(-1)?.content), /Treat progress updates and plans as incomplete/)
})

test('ordinary user turns without prior tool progress are not extended', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.messages.at(-1)?.content, 'read /tmp/a')
  assert.equal(result.plan.workflowContinuation, false)
  assert.equal(result.plan.diagnostics.workflowContinuation, false)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
})

test('shape diagnostics are opt-in and omit message and tool values', () => {
  const envName = 'CHAT2API_TOOL_CALLING_SHAPE_DIAGNOSTICS'
  const previousEnv = process.env[envName]
  const originalInfo = console.info
  const output: string[] = []
  ;(console as any).info = (...args: unknown[]) => {
    output.push(args.map((arg) => String(arg)).join(' '))
  }
  process.env[envName] = 'true'

  try {
    new ToolCallingEngine().transformRequest({
      request: request({
        messages: [
          { role: 'system', content: 'TOP_SECRET_SYSTEM_BODY' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'TOP_SECRET_ASSISTANT_BODY' },
              { type: 'tool_use', id: 'uuid-secret', name: 'TOP_SECRET_TOOL', input: { path: 'C:\\secret' } },
            ] as any,
            tool_calls: [{
              id: 'uuid-secret',
              type: 'function',
              function: { name: 'TOP_SECRET_TOOL', arguments: '{"path":"C:\\secret"}' },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'uuid-secret',
            content: [{ type: 'tool_result', tool_use_id: 'uuid-secret', content: 'TOP_SECRET_RESULT_BODY' }] as any,
          },
        ],
      }),
      provider,
      actualModel: 'deepseek-chat',
    })
  } finally {
    console.info = originalInfo
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }

  assert.equal(output.length, 1)
  assert.match(output[0], /request-shape/)
  assert.match(output[0], /"messageRoles":\["system","assistant","tool"\]/)
  assert.match(output[0], /"contentPartTypes":\["text","tool_use"\]/)
  assert.match(output[0], /"contentPartTypes":\["tool_result"\]/)
  assert.match(output[0], /"rawToolCount":4/)
  assert.match(output[0], /"normalizedToolCount":4/)
  assert.match(output[0], /"workflowContinuation":true/)
  assert.doesNotMatch(output[0], /TOP_SECRET|uuid-secret|C:\\\\secret|TOP_SECRET_TOOL/)
})

test('client prompt signatures do not override selected adapter', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'You are Kilo, the best coding agent. Tool definitions:' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('No tools choose disabled', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('Store mode off chooses disabled', () => {
  const result = new ToolCallingEngine({ mode: 'off', enabled: false }).transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.tools, tools)
})

test('tool_choice none chooses disabled even when tools are present', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'none' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.toolChoiceMode, 'none')
})

test('tool_choice required preserves required policy on the plan', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file', 'default_api:todowrite', 'default_api:write'])
  assert.match(result.messages[0].content as string, /a tool call is required/)
})

test('forced function choice narrows allowed tool names to the selected function', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'forced')
  assert.equal(result.plan.forcedToolName, 'default_api:list_dir')
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir'])
  assert.match(result.messages[0].content as string, /must call `default_api:list_dir`/)
  assert.doesNotMatch(result.messages[0].content as string, /Tool `default_api:read_file`/)
})

test('non-stream parsing only accepts the selected provider protocol', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]')
})

test('non-stream parsing recovers safely from malformed but complete managed XML', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).filePath, '/tmp/a')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

test('non-stream parsing assigns request-scoped tool call IDs', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const createResult = () => ({
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  })
  const first: any = createResult()
  const second: any = createResult()

  engine.applyNonStreamResponse(first, transformed.plan)
  engine.applyNonStreamResponse(second, transformed.plan)

  const firstId = first.choices[0].message.tool_calls[0].id
  const secondId = second.choices[0].message.tool_calls[0].id
  assert.match(firstId, /^call_[a-f0-9]{32}_0$/)
  assert.match(secondId, /^call_[a-f0-9]{32}_0$/)
  assert.notEqual(firstId, secondId)
})

test('non-stream required tool call rejects malformed XML without complete parameters', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a',
      },
      finish_reason: 'stop',
    }],
  }

  assert.throws(
    () => engine.applyNonStreamResponse(result, transformed.plan),
    /malformed or empty tool call block/,
  )
  assert.equal(result.choices[0].message.tool_calls, undefined)
})

test('non-stream parsing removes malformed managed XML without fabricating optional tool calls', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'before <|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a after',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, 'before')
  assert.equal(result.choices[0].finish_reason, 'stop')
})
