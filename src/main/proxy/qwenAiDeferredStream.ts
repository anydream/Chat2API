import { PassThrough } from 'node:stream'
import type { AccountFailoverOutcome } from './accountFailover'
import type { QwenAiOutputStream } from './adapters/qwen-ai'
import type { ForwardResult } from './types'

const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

type QwenAiFailure = Error & {
  status?: number
  code?: string
  headers?: Record<string, string>
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
}

function failureFromResult(result: ForwardResult): QwenAiFailure {
  return Object.assign(new Error(result.error || 'Qwen AI account failover exhausted'), {
    status: result.status,
    code: result.errorCode,
    headers: result.headers,
    retryable: result.retryable,
    accountFault: result.accountFault,
    retryScope: result.retryScope,
  })
}

function missingStreamFailure(): QwenAiFailure {
  return Object.assign(new Error('Qwen AI returned no stream after account failover'), {
    status: 502,
    code: 'qwen_ai_missing_stream',
    accountFault: false,
  })
}

/**
 * Expose a stable stream immediately while account attempts run in the
 * background. Genuine reasoning progress can pass through immediately, while
 * answer/tool frames come only from the first fully validated Qwen result.
 */
export function createDeferredQwenAiFailoverStream(
  outcomePromise: Promise<AccountFailoverOutcome>,
  signal?: AbortSignal,
  progressStream?: NodeJS.ReadableStream,
): QwenAiOutputStream {
  const output = new PassThrough() as QwenAiOutputStream
  let source: NodeJS.ReadableStream | undefined
  let settled = false

  // The route installs its own error listener synchronously. Keep one local
  // listener as a guard for callers that close before route wiring completes.
  output.on('error', () => undefined)

  const onProgress = (chunk: Buffer | string) => {
    if (!settled) output.write(chunk)
  }
  const detachProgress = (destroy = false) => {
    progressStream?.removeListener('data', onProgress)
    if (destroy) {
      const destroyable = progressStream as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined
      destroyable?.destroy?.()
    }
  }
  const detachAbort = () => signal?.removeEventListener('abort', onAbort)
  const setEffectiveSelection = (outcome: AccountFailoverOutcome) => {
    const result = outcome.result
    const qwenSource = result.stream as QwenAiOutputStream | undefined
    output.qwenAiEffectiveAccountId = qwenSource?.qwenAiEffectiveAccountId
      || result.effectiveAccountId
      || outcome.selection.account.id
    output.qwenAiEffectiveProviderId = qwenSource?.qwenAiEffectiveProviderId
      || result.effectiveProviderId
      || outcome.selection.provider.id
    output.qwenAiEffectiveActualModel = qwenSource?.qwenAiEffectiveActualModel
      || result.effectiveActualModel
      || outcome.selection.actualModel
  }
  const fail = (error: Error) => {
    if (settled) return
    settled = true
    detachProgress(true)
    detachAbort()
    output.qwenAiFailure = error
    output.emit(QWEN_AI_STREAM_FAILURE_EVENT, error)
    output.destroy(error)
  }
  const complete = () => {
    if (settled) return
    settled = true
    detachProgress(true)
    detachAbort()
    output.end()
  }
  const destroySource = () => {
    const destroyable = source as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined
    destroyable?.destroy?.()
  }
  function onAbort() {
    const error = Object.assign(new Error('Qwen AI account failover aborted because the client disconnected.'), {
      status: 499,
      code: 'ERR_CANCELED',
      accountFault: false,
    })
    destroySource()
    fail(error)
  }

  output.once('close', () => {
    if (!settled) destroySource()
    detachProgress(true)
    detachAbort()
  })

  if (signal?.aborted) {
    queueMicrotask(onAbort)
    return output
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  progressStream?.on('data', onProgress)

  void outcomePromise.then(outcome => {
    if (settled) return
    detachProgress(true)
    setEffectiveSelection(outcome)

    if (!outcome.result.success) {
      fail(failureFromResult(outcome.result))
      return
    }
    if (!outcome.result.stream) {
      fail(missingStreamFailure())
      return
    }

    source = outcome.result.stream
    const qwenSource = source as QwenAiOutputStream
    const sourceFailure = qwenSource.qwenAiFailure
    if (sourceFailure) {
      fail(sourceFailure)
      return
    }

    qwenSource.once(QWEN_AI_STREAM_FAILURE_EVENT, fail)
    source.once('error', fail)
    source.once('end', () => {
      if (qwenSource.qwenAiFailure) fail(qwenSource.qwenAiFailure)
      else complete()
    })
    source.once('close', () => {
      const readable = source as NodeJS.ReadableStream & { readableEnded?: boolean }
      if (!settled && !readable.readableEnded) {
        fail(Object.assign(new Error('Validated Qwen AI stream closed before completion'), {
          status: 502,
          code: 'qwen_ai_stream_incomplete',
          accountFault: false,
        }))
      }
    })
    source.pipe(output, { end: false })
  }).catch(error => {
    fail(error instanceof Error ? error : new Error(String(error)))
  })

  return output
}
