import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createToolWorkflowContinuationMessage,
  ToolCallingEngine,
} from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import {
  hasManagedWorkflowCompletionMarker,
  parseManagedWorkflowCompletionProof,
  requiresManagedWorkflowCompletionMarker,
  stripManagedWorkflowCompletionMarker,
  supportsManagedWorkflowCompletionMarker,
} from '../../src/main/proxy/toolCalling/workflowCompletion.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function managedPlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'qwen_hermes',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools: [{ name: 'workspace:read_file', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['workspace:read_file']),
    workflowContinuation: false,
    failedToolResultPending: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen-ai',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'qwen_hermes',
      toolCount: 1,
      injected: true,
      reason: 'test',
      workflowContinuation: false,
      failedToolResultPending: false,
    },
    ...overrides,
  }
}

test('initial Qwen managed auto turns require a workflow completion marker', () => {
  assert.equal(requiresManagedWorkflowCompletionMarker(managedPlan()), true)
})

test('successful tool-result continuations use terminal assistant text as completion', () => {
  const plan = managedPlan({ workflowContinuation: true })
  assert.equal(supportsManagedWorkflowCompletionMarker(plan), true)
  assert.equal(requiresManagedWorkflowCompletionMarker(plan), false)
  assert.deepEqual(
    parseManagedWorkflowCompletionProof(
      'The work is complete.<chat2api_workflow_complete/>',
      plan,
    ),
    { complete: true, content: 'The work is complete.' },
  )
})

test('failed-result continuations still require a completion marker', () => {
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({
      workflowContinuation: true,
      failedToolResultPending: true,
    })),
    true,
  )
})

test('Qwen required and forced tool choices require a completion marker', () => {
  for (const toolChoiceMode of ['required', 'forced'] as const) {
    assert.equal(
      requiresManagedWorkflowCompletionMarker(managedPlan({ toolChoiceMode })),
      true,
    )
  }
})

test('completion markers follow managed protocol capability instead of provider instance id', () => {
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ providerId: 'custom-qwen-instance' })),
    true,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ protocol: 'managed_xml' })),
    false,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ shouldParseResponse: false })),
    false,
  )
  assert.equal(
    requiresManagedWorkflowCompletionMarker(managedPlan({ allowedToolNames: new Set() })),
    false,
  )
})

test('completion proof is valid only as one terminal marker for the capable protocol', () => {
  const plan = managedPlan({ providerId: 'custom-provider-instance' })
  const valid = 'Work completed.\n<chat2api_workflow_complete/>   \n'
  const midAnswer = 'Progress <chat2api_workflow_complete/> still running.'
  const duplicated = 'Done.<chat2api_workflow_complete/><chat2api_workflow_complete/>'
  const separatedDuplicate = 'Example <chat2api_workflow_complete/>\nDone.<chat2api_workflow_complete/>'
  const fenced = '```xml\n<chat2api_workflow_complete/>'
  const tildeFenced = '~~~xml\n<chat2api_workflow_complete/>'
  const indentedCode = '    <chat2api_workflow_complete/>'
  const quoted = '> <chat2api_workflow_complete/>'

  assert.equal(hasManagedWorkflowCompletionMarker(valid, plan), true)
  assert.equal(stripManagedWorkflowCompletionMarker(valid, plan), 'Work completed.')
  for (const content of [
    midAnswer,
    duplicated,
    separatedDuplicate,
    fenced,
    tildeFenced,
    indentedCode,
    quoted,
  ]) {
    assert.equal(hasManagedWorkflowCompletionMarker(content, plan), false)
    assert.equal(stripManagedWorkflowCompletionMarker(content, plan), content)
  }
  assert.equal(hasManagedWorkflowCompletionMarker(valid), false)
  assert.equal(
    hasManagedWorkflowCompletionMarker(valid, managedPlan({ protocol: 'managed_xml' })),
    false,
  )
  assert.equal(
    hasManagedWorkflowCompletionMarker(
      '~~~xml\nexample\n~~~\nDone.<chat2api_workflow_complete/>',
      plan,
    ),
    true,
  )
})

test('marker-only proof remains distinguishable from a visible final answer', () => {
  assert.deepEqual(
    parseManagedWorkflowCompletionProof('<chat2api_workflow_complete/>', managedPlan()),
    { complete: true, content: '' },
  )
})

test('workflow continuation completion proof follows protocol state and capability', () => {
  const hermes = createToolWorkflowContinuationMessage({ plan: managedPlan() })
  const successfulHermes = createToolWorkflowContinuationMessage({
    plan: managedPlan({ workflowContinuation: true }),
  })
  const failedHermes = createToolWorkflowContinuationMessage({
    failedToolResultPending: true,
    plan: managedPlan({ workflowContinuation: true, failedToolResultPending: true }),
  })
  const managedXml = createToolWorkflowContinuationMessage({
    plan: managedPlan({ protocol: 'managed_xml' }),
  })

  assert.match(String(hermes.content), /chat2api_workflow_complete/)
  assert.doesNotMatch(String(successfulHermes.content), /chat2api_workflow_complete/)
  assert.match(String(failedHermes.content), /chat2api_workflow_complete/)
  assert.doesNotMatch(String(managedXml.content), /chat2api_workflow_complete/)
})

const qwenAiProvider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const declaredTools = [{
  type: 'function' as const,
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}]

test('initial Qwen auto prompt injects a private completion proof', () => {
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'read the file when needed' }],
      tools: declaredTools,
      tool_choice: 'auto',
    },
    provider: qwenAiProvider,
    actualModel: 'configured-model',
  })

  assert.match(String(transformed.messages[0].content), /chat2api_workflow_complete/)
})

test('Qwen required-tool prompt keeps the bounded completion proof', () => {
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: declaredTools,
      tool_choice: 'required',
    },
    provider: qwenAiProvider,
    actualModel: 'configured-model',
  })

  assert.match(String(transformed.messages[0].content), /chat2api_workflow_complete/)
})
