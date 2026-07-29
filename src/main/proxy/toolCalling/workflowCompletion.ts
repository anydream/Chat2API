import type { ToolCallingPlan } from './types.ts'

export const MANAGED_WORKFLOW_COMPLETE_MARKER = '<chat2api_workflow_complete/>'

export function hasManagedWorkflowCompletionMarker(content: string): boolean {
  return content.includes(MANAGED_WORKFLOW_COMPLETE_MARKER)
}

export function stripManagedWorkflowCompletionMarker(content: string): string {
  return content.replaceAll(MANAGED_WORKFLOW_COMPLETE_MARKER, '').trimEnd()
}

export function requiresManagedWorkflowCompletionMarker(plan?: ToolCallingPlan): boolean {
  return Boolean(
    plan?.shouldParseResponse
    && plan.providerId === 'qwen-ai'
    && plan.allowedToolNames.size > 0,
  )
}
