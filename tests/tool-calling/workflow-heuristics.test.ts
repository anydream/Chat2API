import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasActiveManagedWorkflow,
  hasTrailingMatchedToolResultBatch,
  isInitialProgressRecoveryCandidate,
  isLikelyWorkflowFollowupRequest,
  isLikelyResponseRepairRequest,
  isLikelyWorkflowContinuationRequest,
  isLikelyWorkflowProgressText,
} from '../../src/main/proxy/toolCalling/workflowHeuristics.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('workflow progress classifier recognizes actionable plans without task-specific text', () => {
  assert.equal(
    isLikelyWorkflowProgressText(
      'Now I need to integrate the component. Let me add the member and wire it up.',
    ),
    true,
  )
  assert.equal(isLikelyWorkflowProgressText("I'll inspect the folder next."), true)
  assert.equal(isLikelyWorkflowProgressText('I will inspect the folder next.'), true)
  assert.equal(isLikelyWorkflowProgressText("I'm going to inspect the folder."), true)
  assert.equal(isLikelyWorkflowProgressText("We're going to run the tests."), true)
  assert.equal(isLikelyWorkflowProgressText('I am now checking the file.'), true)
  assert.equal(isLikelyWorkflowProgressText("I'm working on the implementation."), true)
  assert.equal(isLikelyWorkflowProgressText('Starting by inspecting the file.'), true)
  assert.equal(isLikelyWorkflowProgressText('I will continue the work.'), true)
  assert.equal(isLikelyWorkflowProgressText('Let me verify the work is complete.'), true)
  assert.equal(isLikelyWorkflowProgressText('I need to check whether the implementation is complete.'), true)
  assert.equal(isLikelyWorkflowProgressText('I will run tests after the implementation is complete.'), true)
  assert.equal(
    isLikelyWorkflowProgressText('\u7ee7\u7eed\u5269\u4f59\u5de5\u4f5c\uff0c\u5148\u8bfb\u53d6\u76f8\u5173\u7c7b\u786e\u5b9a\u96c6\u6210\u70b9\u3002'),
    true,
  )
  assert.equal(isLikelyWorkflowProgressText('\u6211\u6b63\u5728\u68c0\u67e5\u76f8\u5173\u5b9e\u73b0\u3002'), true)
  assert.equal(
    isLikelyWorkflowProgressText(
      '\u6ca1\u6709\u505c\u6b62\uff0c\u7ee7\u7eed\u3002\u73b0\u5728\u628a WidgetComponent \u96c6\u6210\u5230 MainModule.cpp \u4e2d\u3002',
    ),
    true,
  )
})

test('workflow progress classifier excludes terminal answers and questions', () => {
  assert.equal(isLikelyWorkflowProgressText('The requested work is complete.'), false)
  assert.equal(isLikelyWorkflowProgressText('\u5de5\u4f5c\u5df2\u5168\u90e8\u5b8c\u6210\u3002'), false)
  assert.equal(isLikelyWorkflowProgressText('Should I continue and inspect the next file?'), false)
  assert.equal(isLikelyWorkflowProgressText('The file now contains the requested fix.'), false)
  assert.equal(isLikelyWorkflowProgressText('The first test verifies the new behavior.'), false)
  assert.equal(isLikelyWorkflowProgressText('The implementation plan is in the file.'), false)
  assert.equal(isLikelyWorkflowProgressText('The requested work has now been completed.'), false)
  assert.equal(isLikelyWorkflowProgressText('The requested file has now been updated.'), false)
  assert.equal(isLikelyWorkflowProgressText('All work is now complete and verified.'), false)
  assert.equal(isLikelyWorkflowProgressText('I have now finished updating the file.'), false)
  assert.equal(
    isLikelyWorkflowProgressText('\u5904\u7406\u5b8c\u6210\u3002\u4e0b\u9762\u662f\u4fee\u6539\u5185\u5bb9\uff1a'),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText('\u4fee\u6539\u597d\u4e86\u3002\u4e0b\u9762\u662f\u66f4\u65b0\u540e\u7684\u4ee3\u7801\u3002'),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText('\u6587\u4ef6\u5df2\u7ecf\u66f4\u65b0\u3002\u4e0b\u9762\u68c0\u67e5\u4e00\u4e0b\u6700\u7ec8\u7ed3\u679c\u3002'),
    false,
  )
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u628a\u7ec4\u4ef6\u96c6\u6210\u5b8c\u6210\u3002'), true)
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u628a\u6587\u4ef6\u66f4\u65b0\u597d\u4e86\u3002'), false)
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u628a\u6d4b\u8bd5\u8fd0\u884c\u5b8c\u4e86\u3002'), false)
  assert.equal(
    isLikelyWorkflowProgressText('\u5904\u7406\u5b8c\u6210\u3002\u63a5\u4e0b\u6765\u662f\u4fee\u6539\u5185\u5bb9\uff1a'),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText('\u5de5\u4f5c\u505a\u5b8c\u4e86\u3002\u63a5\u4e0b\u6765\u662f\u66f4\u65b0\u5185\u5bb9\u3002'),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText('The requested work is complete. Next, inspect the file if desired.'),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText('The requested work is complete. Next I will run the tests.'),
    true,
  )
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u628a\u7ec4\u4ef6\u96c6\u6210\u5b8c\u6210\uff0c\u518d\u8fd0\u884c\u6d4b\u8bd5\u3002'), true)
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u8fd0\u884c\u6d4b\u8bd5\uff0c\u9a8c\u8bc1\u4fee\u6539\u662f\u5426\u6210\u529f\u3002'), true)
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u8fd0\u884c\u6d4b\u8bd5\uff0c\u68c0\u67e5\u6784\u5efa\u662f\u5426\u901a\u8fc7\u3002'), true)
  assert.equal(isLikelyWorkflowProgressText('\u73b0\u5728\u628a\u7ec4\u4ef6\u96c6\u6210\u5b8c\u6210\u4e86\u3002'), false)
  assert.equal(isLikelyWorkflowProgressText('\u5904\u7406\u5b8c\u6210\u3002\u63a5\u4e0b\u6765\u7684\u4fee\u6539\u5185\u5bb9\u5982\u4e0b\u3002'), false)
  assert.equal(isLikelyWorkflowProgressText('\u5148\u524d\u4fee\u6539\u5185\u5bb9\u5982\u4e0b\u3002'), false)
  assert.equal(isLikelyWorkflowProgressText('\u4fee\u6539\u5df2\u5b8c\u6210\u3002\u63a5\u4e0b\u6765\u8fd0\u884c\u6d4b\u8bd5\u3002'), true)
  assert.equal(isLikelyWorkflowProgressText('The implementation is complete. Next: run the tests.'), true)
  for (const content of [
    '\u73b0\u5728\u51c6\u5907\u7684\u4fee\u6539\u5185\u5bb9\u5982\u4e0b\u3002',
    '\u7ee7\u7eed\u7684\u4fee\u6539\u5185\u5bb9\u5982\u4e0b\u3002',
    '\u7136\u540e\u7684\u4fee\u6539\u5185\u5bb9\u5982\u4e0b\u3002',
    '\u73b0\u5728\u6d4b\u8bd5\u901a\u8fc7\u3002',
    '\u73b0\u5728\u7f16\u8bd1\u6210\u529f\u3002',
    '\u73b0\u5728\u9a8c\u8bc1\u5b8c\u6210\u3002',
    '\u73b0\u5728\u4fee\u6539\u5b8c\u6210\u3002',
    '\u73b0\u5728\u8fd0\u884c\u7ed3\u675f\u3002',
    '\u73b0\u5728\u6784\u5efa\u6210\u529f\u3002',
    '\u73b0\u5728\u6d4b\u8bd5\u5df2\u7ecf\u901a\u8fc7\u3002',
    '\u73b0\u5728\u7f16\u8bd1\u5df2\u7ecf\u6210\u529f\u3002',
    '\u6784\u5efa\u5b8c\u6210\u3002\u73b0\u5728\u6d4b\u8bd5\u901a\u8fc7\u3002',
    '\u6d4b\u8bd5\u5b8c\u6210\u3002\u73b0\u5728\u7f16\u8bd1\u6210\u529f\u3002',
    '\u5904\u7406\u7ed3\u675f\u3002\u73b0\u5728\u9a8c\u8bc1\u5b8c\u6210\u3002',
  ]) {
    assert.equal(isLikelyWorkflowProgressText(content), false, content)
  }
  for (const content of [
    '\u63a5\u4e0b\u6765\u662f\u5148\u4fee\u6539\u5b9e\u73b0\uff0c\u518d\u8fd0\u884c\u6d4b\u8bd5\u3002',
    '\u6211\u4f1a\u7ee7\u7eed\u5b8c\u6210\u5269\u4f59\u5de5\u4f5c\u3002',
    '\u6211\u4eec\u73b0\u5728\u628a\u7ec4\u4ef6\u96c6\u6210\u5230\u4e3b\u7c7b\u4e2d\u3002',
    '\u73b0\u5728\u7acb\u5373\u4fee\u6539\u5b9e\u73b0\u3002',
    '\u76ee\u524d\u6b63\u5728\u8fd0\u884c\u6d4b\u8bd5\u3002',
    '\u6ca1\u6709\u95ee\u9898\uff0c\u63a5\u4e0b\u6765\u4fee\u6539\u5b9e\u73b0\u3002',
  ]) {
    assert.equal(isLikelyWorkflowProgressText(content), true, content)
  }
})

test('workflow progress classifier recognizes bounded Chinese continuation commitments', () => {
  for (const content of [
    '\u7ee7\u7eed\u3002',
    '\u7ee7\u7eed\u5de5\u4f5c\u3002',
    '\u6211\u4f1a\u7ee7\u7eed\u3002',
    '\u6211\u4f1a\u7ee7\u7eed\u5de5\u4f5c\u3002',
    '\u73b0\u5728\u7ee7\u7eed\u3002',
    '\u63a5\u4e0b\u6765\u7ee7\u7eed\u3002',
  ]) {
    assert.equal(isLikelyWorkflowProgressText(content), true, content)
  }
})

test('workflow progress classifier handles bounded multi-thousand-character responses semantically', () => {
  const context = 'The prior inspection produced additional context. '.repeat(120)
  assert.ok(context.length > 1600)
  assert.equal(
    isLikelyWorkflowProgressText(`${context} Next I will update the implementation and run the tests.`),
    true,
  )
  assert.equal(
    isLikelyWorkflowProgressText(`${context} The requested work is complete.`),
    false,
  )
  assert.equal(
    isLikelyWorkflowProgressText(`I will inspect the implementation. ${'context '.repeat(1600)}`),
    false,
  )
})

test('response repair classifier recognizes short English and Chinese meta requests', () => {
  assert.equal(
    isLikelyResponseRepairRequest(
      '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
    ),
    true,
  )
  assert.equal(
    isLikelyResponseRepairRequest('The last reply was blank. Please retry and provide a visible answer.'),
    true,
  )
  assert.equal(isLikelyResponseRepairRequest('continue'), true)
  assert.equal(
    isLikelyResponseRepairRequest(
      '\u4f60\u4e0a\u4e00\u6b21\u56de\u590d\u6ca1\u6709\u53ef\u89c1\u8f93\u51fa\uff0c\u8bf7\u7ee7\u7eed\u5e76\u7ed9\u51fa\u53ef\u89c1\u56de\u590d\u3002',
    ),
    true,
  )
  assert.equal(
    isLikelyResponseRepairRequest(
      '\u521a\u624d\u7684\u56de\u7b54\u662f\u7a7a\u7684\uff0c\u8bf7\u91cd\u8bd5\u5e76\u8f93\u51fa\u53ef\u89c1\u5185\u5bb9\u3002',
    ),
    true,
  )
  assert.equal(isLikelyResponseRepairRequest('\u8bf7\u7ee7\u7eed'), true)
})

test('response repair classifier rejects questions and substantive payloads', () => {
  assert.equal(isLikelyResponseRepairRequest('Was the previous response empty?'), false)
  assert.equal(
    isLikelyResponseRepairRequest('The previous response was empty. Now implement another feature.'),
    false,
  )
  assert.equal(
    isLikelyResponseRepairRequest('The previous response was empty. Continue by editing C:\\project\\file.ts.'),
    false,
  )
  assert.equal(
    isLikelyResponseRepairRequest('The previous response was empty. Continue at https://example.com.'),
    false,
  )
  assert.equal(
    isLikelyResponseRepairRequest(
      '\u4e0a\u4e00\u6b21\u56de\u590d\u662f\u7a7a\u7684\uff0c\u73b0\u5728\u8bf7\u5b9e\u73b0\u53e6\u4e00\u4e2a\u529f\u80fd\u3002',
    ),
    false,
  )
})

test('workflow continuation classifier recognizes same-work imperatives and status follow-ups', () => {
  assert.equal(isLikelyWorkflowContinuationRequest('continue'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('Please resume the current work.'), true)
  assert.equal(
    isLikelyWorkflowContinuationRequest('Are you stuck? Continue the previous step.'),
    true,
  )
  assert.equal(
    isLikelyWorkflowContinuationRequest('Did it stop? Resume where you left off.'),
    true,
  )
  assert.equal(isLikelyWorkflowContinuationRequest('\u7ee7\u7eed\u5f53\u524d\u5de5\u4f5c'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('\u3001\u7ee7\u7eed\u554a'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('\u9ebb\u70e6\u63a5\u7740\u505a\u5427'), true)
  assert.equal(
    isLikelyWorkflowContinuationRequest(
      '\u600e\u4e48\u505c\u4e86\uff1f\u8bf7\u6062\u590d\u4e4b\u524d\u7684\u5de5\u4f5c',
    ),
    true,
  )
  assert.equal(
    isLikelyWorkflowContinuationRequest('\u5361\u4f4f\u4e86\u5417\uff1f\u7ee7\u7eed stage 12'),
    true,
  )
  assert.equal(isLikelyWorkflowContinuationRequest('\u5361\u4f4f\u4e86\uff0c\u7ee7\u7eed'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('It stopped. Continue.'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('\u53c8\u5361\u4f4f\u4e86\uff0c\u7ee7\u7eed'), true)
  assert.equal(isLikelyWorkflowContinuationRequest('It stopped again. Continue.'), true)
})

test('workflow continuation classifier rejects questions, negation, new tasks, and payloads', () => {
  assert.equal(isLikelyWorkflowContinuationRequest('Are you stuck?'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Should I continue?'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('\u7ee7\u7eed\u5417'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Continue, stop.'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('\u3001\u7ee7\u7eed\u554a\uff0c\u5230\u8fd9\u91cc\u505c\u6b62'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Do not continue the current work.'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Continue a new task.'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Resume another workflow.'), false)
  assert.equal(
    isLikelyWorkflowContinuationRequest('Are you stuck? Continue the next workflow.'),
    false,
  )
  assert.equal(isLikelyWorkflowContinuationRequest('Continue the next step.'), true)
  assert.equal(
    isLikelyWorkflowContinuationRequest('Are you stuck? Continue by implementing authentication.'),
    false,
  )
  assert.equal(isLikelyWorkflowContinuationRequest('Continue C:\\project\\file.ts'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Continue at https://example.com'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('Continue with `run()`'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('\u4e0d\u8981\u7ee7\u7eed\u5f53\u524d\u5de5\u4f5c'), false)
  assert.equal(isLikelyWorkflowContinuationRequest('\u7ee7\u7eed\u53e6\u4e00\u4e2a\u4efb\u52a1'), false)
  assert.equal(
    isLikelyWorkflowContinuationRequest('\u5361\u4f4f\u4e86\u5417\uff1f\u7ee7\u7eed\u4e0b\u4e00\u4e2a\u4efb\u52a1'),
    false,
  )
  assert.equal(isLikelyWorkflowContinuationRequest('\u7ee7\u7eed\u4e0b\u4e00\u6b65'), true)
})

test('workflow follow-up classifier recognizes generic next-step status requests', () => {
  assert.equal(isLikelyWorkflowFollowupRequest('What next? I need the implementation working.'), true)
  assert.equal(isLikelyWorkflowFollowupRequest('Where do we go from here?'), true)
  assert.equal(isLikelyWorkflowFollowupRequest('What is still missing for the target?'), true)
  assert.equal(isLikelyWorkflowFollowupRequest('What do we still need to finish?'), true)
  assert.equal(
    isLikelyWorkflowFollowupRequest('\u4e0b\u4e00\u6b65\u8981\u5e72\u561b \u6211\u8981\u7684\u662f\u8fd9\u6574\u4e2a\u6e38\u620f\u80fd\u73a9'),
    true,
  )
  assert.equal(
    isLikelyWorkflowFollowupRequest('\u8981\u6309\u8fd9\u4e2a\u76ee\u6807\uff0c\u73b0\u5728\u8fd8\u5dee\u4ec0\u4e48\uff1f'),
    true,
  )
  assert.equal(isLikelyWorkflowFollowupRequest('\u73b0\u5728\u8fd8\u7f3a\u4ec0\u4e48\uff1f'), true)
  assert.equal(isLikelyWorkflowFollowupRequest('What next? Explain OAuth.'), false)
  assert.equal(isLikelyWorkflowFollowupRequest('What next for a separate task?'), false)
  assert.equal(isLikelyWorkflowFollowupRequest('What is still missing for a new goal?'), false)
  assert.equal(isLikelyWorkflowFollowupRequest('Implement another feature.'), false)
  assert.equal(isLikelyWorkflowFollowupRequest('\u65b0\u76ee\u6807\u8fd8\u5dee\u4ec0\u4e48\uff1f'), false)
  assert.equal(isLikelyWorkflowFollowupRequest('What next at C:\\project\\file.ts?'), false)
})

test('initial progress recovery requires a matched recent tool exchange and follow-up boundary', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'inspect the project' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: 'The earlier workflow is complete.' },
  ]

  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history,
      { role: 'user', content: '\u4e0b\u4e00\u6b65\u8981\u5e72\u561b' },
    ]),
    true,
  )
  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history,
      { role: 'user', content: 'start a separate task' },
    ]),
    false,
  )
  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history.slice(0, -1),
      { role: 'tool', tool_call_id: 'different-call', content: 'wrong result' },
      { role: 'assistant', content: 'The earlier workflow is complete.' },
      { role: 'user', content: 'What next?' },
    ]),
    false,
  )
  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history.slice(0, -1),
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'server-1' }] },
      { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'server-1' }] },
      { role: 'assistant', content: 'The earlier workflow is complete.' },
      { role: 'user', content: 'What next?' },
    ] as ChatMessage[]),
    false,
  )
  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history,
      { role: 'assistant', content: 'A new unrelated boundary.' },
      { role: 'user', content: 'What next?' },
    ]),
    false,
  )
})

test('initial progress recovery crosses bounded same-work status turns', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'inspect the project' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: 'The earlier phase is complete.' },
    { role: 'user', content: '\u4e0b\u4e00\u6b65\u8981\u5e72\u561b \u6211\u8981\u7684\u662f\u8fd9\u6574\u4e2a\u5de5\u4f5c\u80fd\u7528' },
    { role: 'assistant', content: '\u8ba9\u6211\u5168\u9762\u68c0\u67e5\u5f53\u524d\u7cfb\u7edf\u7684\u5b8c\u6210\u5ea6\uff0c\u627e\u51fa\u6240\u6709\u7f3a\u53e3\u3002' },
  ]

  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history,
      { role: 'user', content: '\u8981\u6309\u8fd9\u4e2a\u76ee\u6807\uff0c\u73b0\u5728\u8fd8\u5dee\u4ec0\u4e48\uff1f' },
    ]),
    true,
  )
  assert.equal(
    isInitialProgressRecoveryCandidate([
      ...history,
      { role: 'user', content: 'implement an unrelated new feature' },
      { role: 'user', content: '\u73b0\u5728\u8fd8\u5dee\u4ec0\u4e48\uff1f' },
    ]),
    false,
  )
})

test('managed workflow remains active after OpenAI tool history and assistant progress', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: 'Next I will update the implementation and run the tests.' },
    { role: 'user', content: 'continue the work' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('managed workflow recognizes Anthropic tool-use and tool-result blocks', () => {
  const messages = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'inspect', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'inspection complete' }],
    },
    { role: 'assistant', content: '\u63a5\u4e0b\u6765\u4fee\u6539\u5b9e\u73b0\u5e76\u8fd0\u884c\u6d4b\u8bd5\u3002' },
    { role: 'user', content: '\u7ee7\u7eed' },
  ] as ChatMessage[]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('empty assistant plus a repair request preserves matched OpenAI workflow state', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: null },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('explicit repair request preserves matched workflow state when an empty assistant was omitted', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
  assert.equal(
    hasActiveManagedWorkflow([...messages.slice(0, -1), { role: 'user', content: 'continue' }]),
    true,
  )
})

test('explicit repair remains transparent to a later progress continuation turn', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
    { role: 'assistant', content: 'Next I will update the implementation and run the tests.' },
    { role: 'user', content: 'continue the work' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('repair and status continuation boundaries remain transparent to the next turn', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'user', content: '\u5361\u4f4f\u4e86\u5417\uff1f\u7ee7\u7eed stage 12' },
    { role: 'assistant', content: 'Next I will run the verification.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('strict progress and continuation chains remain transparent without a retry-count assumption', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'Next I will run the verification.' },
    { role: 'user', content: 'resume the current work' },
    { role: 'assistant', content: 'Then I will inspect the remaining work.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('thinking-only assistant plus a repair request preserves matched Anthropic workflow state', () => {
  const messages = [
    { role: 'user', content: 'implement the requested changes' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'inspect', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'inspection complete' }],
    },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'continue internally' }] },
    {
      role: 'user',
      content: '\u4e0a\u4e00\u6b21\u56de\u590d\u6ca1\u6709\u53ef\u89c1\u8f93\u51fa\uff0c\u8bf7\u7ee7\u7eed\u5e76\u7ed9\u51fa\u53ef\u89c1\u56de\u590d\u3002',
    },
  ] as ChatMessage[]

  assert.equal(hasActiveManagedWorkflow(messages), true)
})

test('independent user content beside an Anthropic tool result closes prior workflow state', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'inspect', input: {} }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'inspection complete' },
        { type: 'text', text: 'start a separate task' },
      ],
    },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'user', content: 'continue' },
  ] as ChatMessage[]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('empty assistant repair does not revive unrelated or unmatched workflow history', () => {
  const repairMessage: ChatMessage = { role: 'user', content: 'Please continue.' }
  const noToolHistory: ChatMessage[] = [
    { role: 'assistant', content: null },
    repairMessage,
  ]
  const mismatchedHistory: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'different-call', content: 'inspection complete' },
    { role: 'assistant', content: null },
    repairMessage,
  ]
  const serverToolHistory = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'old-call', name: 'inspect', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'old inspection' }],
    },
    { role: 'assistant', content: [{ type: 'server_tool_use', id: 'server-call' }] },
    { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'server-call' }] },
    { role: 'assistant', content: null },
    repairMessage,
  ] as ChatMessage[]
  const ordinaryBoundary: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'user', content: 'start another task' },
    { role: 'assistant', content: null },
    repairMessage,
  ]

  assert.equal(hasActiveManagedWorkflow(noToolHistory), false)
  assert.equal(hasActiveManagedWorkflow(mismatchedHistory), false)
  assert.equal(hasActiveManagedWorkflow(serverToolHistory), false)
  assert.equal(hasActiveManagedWorkflow(ordinaryBoundary), false)
})

test('empty assistant followed by a real new task or question is inactive', () => {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: null },
  ]

  assert.equal(
    hasActiveManagedWorkflow([...history, { role: 'user', content: 'implement another feature' }]),
    false,
  )
  assert.equal(
    hasActiveManagedWorkflow([...history, { role: 'user', content: 'Should we continue?' }]),
    false,
  )
})

test('terminal assistant blocks a later explicit repair from reviving tool history', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: 'The requested work is complete.' },
    {
      role: 'user',
      content: 'The previous response had no visible output. Please continue with a visible response.',
    },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('direct explicit repair still requires matched client-managed tool history', () => {
  const repair: ChatMessage = {
    role: 'user',
    content: 'The previous response had no visible output. Please continue with a visible response.',
  }
  const noToolHistory: ChatMessage[] = [
    { role: 'user', content: 'start the work' },
    repair,
  ]
  const mismatchedHistory: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'different-call', content: 'inspection complete' },
    repair,
  ]

  assert.equal(hasActiveManagedWorkflow(noToolHistory), false)
  assert.equal(hasActiveManagedWorkflow(mismatchedHistory), false)
})

test('attachments and legacy calls are not treated as an empty-response repair boundary', () => {
  const matchedHistory: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
  ]
  const mixedRepair = [
    ...matchedHistory,
    { role: 'assistant', content: null },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'continue' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    },
  ] as ChatMessage[]
  const mediaAssistant = [
    ...matchedHistory,
    {
      role: 'assistant',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    },
    { role: 'user', content: 'continue' },
  ] as ChatMessage[]
  const legacyFunctionCall = [
    ...matchedHistory,
    { role: 'assistant', content: null, function_call: { name: 'inspect', arguments: '{}' } },
    { role: 'user', content: 'continue' },
  ] as ChatMessage[]

  assert.equal(hasActiveManagedWorkflow(mixedRepair), false)
  assert.equal(hasActiveManagedWorkflow(mediaAssistant), false)
  assert.equal(hasActiveManagedWorkflow(legacyFunctionCall), false)
})

test('terminal or tool-free history does not leak workflow state into a new turn', () => {
  const completedMessages: ChatMessage[] = [
    { role: 'user', content: 'inspect the project' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'assistant', content: 'The requested work is complete.' },
    { role: 'user', content: 'start a separate task' },
  ]
  const toolFreeMessages: ChatMessage[] = [
    { role: 'assistant', content: 'Next I will inspect the implementation.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(completedMessages), false)
  assert.equal(hasActiveManagedWorkflow(toolFreeMessages), false)
})

test('an unrelated user-turn boundary prevents older tools from activating progress text', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'inspect the original project' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'old-call',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'old-call', content: 'inspection complete' },
    { role: 'assistant', content: 'The requested work is complete.' },
    { role: 'user', content: 'start an unrelated task' },
    { role: 'assistant', content: 'Next I will inspect the unrelated implementation.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('a later system boundary prevents older tools from activating progress text', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'old-call',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'old-call', content: 'inspection complete' },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'system', content: 'Start a separate unrelated task now.' },
    { role: 'assistant', content: 'Next I will inspect the new task.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('unmatched tool call and result identifiers do not activate workflow state', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'inspect the project' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'different-call', content: 'inspection complete' },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('a matched result cannot hide an unknown result identifier in workflow history', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'inspection complete' },
    { role: 'tool', tool_call_id: 'unknown-call', content: 'unexpected result' },
    { role: 'assistant', content: 'Next I will update the implementation.' },
    { role: 'user', content: 'continue' },
  ]

  assert.equal(hasActiveManagedWorkflow(messages), false)
})

test('managed tool-result batches require complete unique client-managed id sets', () => {
  const openAiParallelCall = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' } },
      { id: 'call-b', type: 'function', function: { name: 'inspect', arguments: '{}' } },
    ],
  }
  const anthropicCall = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-a', name: 'inspect', input: {} }],
  }
  const malformedBatches = [
    [
      openAiParallelCall,
      { role: 'tool', tool_call_id: 'call-a', content: 'partial result' },
    ],
    [
      openAiParallelCall,
      { role: 'tool', tool_call_id: 'call-a', content: 'first result' },
      { role: 'tool', tool_call_id: 'call-a', content: 'duplicate result' },
    ],
    [
      {
        ...openAiParallelCall,
        tool_calls: [openAiParallelCall.tool_calls[0]],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'valid result' },
      { role: 'tool', content: 'missing id' },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-a', content: 'valid result' },
          { type: 'tool_result', content: 'missing id' },
        ],
      },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-a', content: 'valid result' },
          { type: 'web_search_tool_result', tool_use_id: 'server-call', content: 'server result' },
        ],
      },
    ],
    [
      {
        ...openAiParallelCall,
        tool_calls: [openAiParallelCall.tool_calls[0]],
      },
      { role: 'user', tool_call_id: 'call-a', content: 'start a separate task' },
    ],
    [
      {
        ...openAiParallelCall,
        tool_calls: [openAiParallelCall.tool_calls[0], openAiParallelCall.tool_calls[0]],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'duplicate call id' },
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-a', type: 'function' }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'missing function object' },
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-a',
          type: 'function',
          function: { name: '', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'blank function name' },
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-a',
          type: 'function',
          function: { name: 'inspect', arguments: 42 },
        }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'non-string arguments' },
    ],
    [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-a', input: {} }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'missing Anthropic name' },
    ],
    [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-a', name: 'inspect', input: {} },
          { type: 'server_tool_use', id: 'server-call' },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'mixed server call' },
    ],
    [
      {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'server-call' }],
        tool_calls: [openAiParallelCall.tool_calls[0]],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'mixed server call' },
    ],
    [
      {
        role: 'assistant',
        content: [{ type: 'bash_code_execution', id: 'server-call' }],
        tool_calls: [openAiParallelCall.tool_calls[0]],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'mixed server execution' },
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [openAiParallelCall.tool_calls[0]],
        function_call: { name: 'inspect', arguments: '{}' },
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'mixed legacy call' },
    ],
    [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-a', name: 'inspect', input: {} }, null],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'primitive assistant content' },
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: ' ',
          type: 'function',
          function: { name: 'inspect', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: ' ', content: 'blank ids' },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
        tool_calls: [openAiParallelCall.tool_calls[0]],
      },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
        function_call: { name: 'inspect', arguments: '{}' },
      },
    ],
    [
      {
        ...anthropicCall,
        tool_calls: { bad: true },
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
      },
    ],
    [
      {
        ...anthropicCall,
        tool_calls: 'bad',
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
      },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
        tool_calls: { bad: true },
      },
    ],
    [
      anthropicCall,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
        tool_calls: 'bad',
      },
    ],
  ] as ChatMessage[][]

  for (const batch of malformedBatches) {
    assert.equal(hasTrailingMatchedToolResultBatch(batch), false)
    assert.equal(
      hasActiveManagedWorkflow([
        ...batch,
        { role: 'assistant', content: 'Next I will run the tests.' },
        { role: 'user', content: 'continue' },
      ]),
      false,
    )
  }
})

test('complete managed parallel result batches allow result reordering', () => {
  const openAiBatch = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' } },
        { id: 'call-b', type: 'function', function: { name: 'inspect', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-b', content: 'second result' },
    { role: 'tool', tool_call_id: 'call-a', content: 'first result' },
  ] as ChatMessage[]
  const anthropicBatch = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call-a', name: 'inspect', input: {} },
        { type: 'tool_use', id: 'call-b', name: 'inspect', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-b', content: 'second result' },
        { type: 'tool_result', tool_use_id: 'call-a', content: 'first result' },
      ],
    },
  ] as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(openAiBatch), true)
  assert.equal(hasTrailingMatchedToolResultBatch(anthropicBatch), true)
})

test('accepts OpenAI assistant tool calls whose content field is omitted', () => {
  const toolCallId = 'call-omitted-content'
  const messages = [
    {
      role: 'assistant',
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: toolCallId, content: 'inspection complete' },
  ] as unknown as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(messages), true)
  assert.equal(
    hasActiveManagedWorkflow([
      ...messages,
      { role: 'assistant', content: 'I will inspect the next file.' },
      { role: 'user', content: 'Continue' },
    ]),
    true,
  )
})
