import { randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'
import { deduplicateEquivalentToolCalls } from './toolCallDeduplication.ts'

const TOOL_CALLING_SHAPE_DIAGNOSTICS_ENV = 'CHAT2API_TOOL_CALLING_SHAPE_DIAGNOSTICS'

/**
 * Generic instruction used when a managed-tool turn needs another model
 * generation. Keep this provider/client agnostic: the provider adapter may
 * submit it as a new user turn without replaying the original request.
 */
export const TOOL_WORKFLOW_CONTINUATION_PROMPT = [
  'Complete the active user request using the available context and tool results.',
  'Use only the client-declared tools in the managed tool list; never invoke or rely on undeclared provider-side tools or capabilities.',
  'If any requested operation remains, respond only with the next appropriate available tool call; do not describe, promise, or announce the operation instead.',
  'If a previous tool call was rejected or had schema validation errors, discard that malformed call and retry it using the declared JSON Schema exactly: include every required field, use only declared properties when the schema is strict, and preserve the declared value types.',
  'Treat progress updates and plans as incomplete.',
  'Return a final answer only after all requested operations are complete and verified by tool results.',
].join(' ')

const FAILED_TOOL_RESULT_CONTINUATION_PROMPT = [
  'A previous tool result reported failure, so that operation is not complete.',
  'Retry it with an appropriate declared tool or use another declared tool to complete and verify the operation.',
].join(' ')

export function createToolWorkflowContinuationMessage(options: {
  failedToolResultPending?: boolean
} = {}): ChatMessage {
  return {
    role: 'user',
    content: options.failedToolResultPending
      ? `${TOOL_WORKFLOW_CONTINUATION_PROMPT} ${FAILED_TOOL_RESULT_CONTINUATION_PROMPT}`
      : TOOL_WORKFLOW_CONTINUATION_PROMPT,
  }
}

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt
    const failedToolResultPending = hasUnresolvedFailedToolResult(request.messages)
    const workflow = shouldInjectPrompt
      ? appendToolWorkflowContinuation(request.messages, failedToolResultPending)
      : { messages: request.messages, appended: false }
    const planWithWorkflow = withWorkflowState(plan, {
      workflowContinuation: workflow.appended,
      failedToolResultPending,
    })

    emitToolCallingShapeDiagnostics({
      messages: request.messages,
      rawToolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      normalizedToolCount: clientRequest.tools.length,
      workflowContinuation: workflow.appended,
      failedToolResultPending,
    })

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: planWithWorkflow.mode === 'disabled' ? request.tools : undefined,
        plan: planWithWorkflow,
      }
    }

    return {
      messages: injectPrompt(workflow.messages, renderPrompt(planWithWorkflow, this.config)),
      tools: undefined,
      plan: planWithWorkflow,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const parseResult = parseSelectedProtocol(message.content, plan, { allowPartial: true })
    const deduplicated = deduplicateEquivalentToolCalls(parseResult.toolCalls)
    if (deduplicated.duplicateCount > 0) {
      console.warn(`[ToolCalling] Suppressed ${deduplicated.duplicateCount} duplicate tool call(s) in one non-stream response`)
    }
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = deduplicated.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    if (deduplicated.toolCalls.length === 0) {
      if (
        parseResult.rawMatches.length > 0 &&
        (plan.toolChoiceMode === 'forced' || plan.toolChoiceMode === 'required')
      ) {
        throw new Error('Provider returned a malformed or empty tool call block for a required tool call')
      }
      if (parseResult.rawMatches.length > 0) {
        message.content = parseResult.content || null
      }
      return
    }

    const callIdPrefix = `call_${randomUUID().replace(/-/g, '')}`
    message.content = parseResult.content || null
    message.tool_calls = deduplicated.toolCalls.map((toolCall, index) => ({
      ...toolCall,
      id: `${callIdPrefix}_${index}`,
    }))

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

/**
 * Keep managed tool workflows moving after a tool result, including a client
 * retry after the model returned only a progress update. The directive stays
 * conditional so completed workflows and ordinary answers can still finish.
 */
function appendToolWorkflowContinuation(
  messages: ChatMessage[],
  failedToolResultPending: boolean,
): { messages: ChatMessage[]; appended: boolean } {
  const lastMessage = messages.at(-1)
  if (!lastMessage) return { messages, appended: false }

  const followsToolResult = lastMessage.role === 'tool'
  let lastToolResultIndex = -1
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    if (messages[index].role === 'tool') {
      lastToolResultIndex = index
      break
    }
  }
  const resumesAfterToolResult = lastMessage.role === 'user'
    && lastToolResultIndex >= 0
    && messages
      .slice(lastToolResultIndex + 1, -1)
      .some(candidate => candidate.role === 'assistant')

  if (!followsToolResult && !resumesAfterToolResult) {
    return { messages, appended: false }
  }

  return {
    messages: [
      ...messages,
      createToolWorkflowContinuationMessage({ failedToolResultPending }),
    ],
    appended: true,
  }
}

function withWorkflowState(
  plan: ToolCallingPlan,
  state: Pick<ToolCallingPlan, 'workflowContinuation' | 'failedToolResultPending'>,
): ToolCallingPlan {
  return {
    ...plan,
    ...state,
    diagnostics: {
      ...plan.diagnostics,
      ...state,
    },
  }
}

function hasUnresolvedFailedToolResult(messages: ChatMessage[]): boolean {
  let lastToolResultIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'tool') {
      lastToolResultIndex = index
      break
    }
  }
  if (lastToolResultIndex < 0) return false

  let batchStartIndex = lastToolResultIndex
  while (batchStartIndex > 0 && messages[batchStartIndex - 1].role === 'tool') {
    batchStartIndex -= 1
  }

  return messages
    .slice(batchStartIndex, lastToolResultIndex + 1)
    .some(message => message.is_error === true)
}

type ToolCallingShapeDiagnosticsInput = {
  messages: ChatMessage[]
  rawToolCount: number
  normalizedToolCount: number
  workflowContinuation: boolean
  failedToolResultPending: boolean
}

/**
 * Emit a protocol-shape-only snapshot when explicitly enabled. The snapshot
 * intentionally contains no values from message content, tool definitions, or
 * tool-call identifiers so it can be enabled while investigating a live
 * client/proxy bridge without exposing the request payload.
 */
function emitToolCallingShapeDiagnostics(input: ToolCallingShapeDiagnosticsInput): void {
  if (!isToolCallingShapeDiagnosticsEnabled()) return

  const messageShapes = input.messages.map((message) => ({
    role: safeRole(message.role),
    contentPartTypes: safeContentPartTypes(message.content),
    hasToolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.length > 0
      : Boolean(message.tool_calls),
    hasToolCallId: typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0,
  }))

  console.info('[ToolCalling] request-shape', JSON.stringify({
    messageRoles: messageShapes.map((message) => message.role),
    messageShapes,
    rawToolCount: input.rawToolCount,
    normalizedToolCount: input.normalizedToolCount,
    workflowContinuation: input.workflowContinuation,
    failedToolResultPending: input.failedToolResultPending,
  }))
}

function isToolCallingShapeDiagnosticsEnabled(): boolean {
  const value = process.env[TOOL_CALLING_SHAPE_DIAGNOSTICS_ENV]
  return value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim())
}

const SAFE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function safeRole(role: unknown): string {
  return typeof role === 'string' && SAFE_ROLES.has(role) ? role : 'other'
}

const SAFE_CONTENT_PART_TYPES = new Set([
  'string',
  'null',
  'text',
  'image',
  'image_url',
  'document',
  'file',
  'file_url',
  'input_audio',
  'video',
  'video_url',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
  'web_search_result',
  'thinking',
  'redacted_thinking',
  'computer_screenshot',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'code_execution_tool_result',
])

function safeContentPartTypes(content: ChatMessage['content']): string[] {
  if (content === null) return ['null']
  if (typeof content === 'string') return ['string']
  if (!Array.isArray(content)) return ['other']

  return content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return 'other'
    const type = (part as { type?: unknown }).type
    return typeof type === 'string' && SAFE_CONTENT_PART_TYPES.has(type) ? type : 'other'
  })
}

function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
): string {
  const protocolPrompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const policyPrompt = renderToolChoicePolicyPrompt(plan)
  const prompt = policyPrompt ? `${protocolPrompt}\n\n${policyPrompt}` : protocolPrompt
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return prompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, prompt)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}

function renderToolChoicePolicyPrompt(plan: ToolCallingPlan): string {
  if (plan.toolChoiceMode === 'required') {
    return [
      'Tool choice policy: a tool call is required for this request.',
      'Respond with one or more tool calls using only the listed tool names and the required protocol block.',
      'Do not answer in natural language instead of calling a tool.',
    ].join('\n')
  }

  if (plan.toolChoiceMode === 'forced' && plan.forcedToolName) {
    return [
      `Tool choice policy: you must call \`${plan.forcedToolName}\` for this request.`,
      'Use only that tool name and the required protocol block.',
      'Do not answer in natural language instead of calling the tool.',
    ].join('\n')
  }

  return ''
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(
  content: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: options.allowPartial,
  })
}
