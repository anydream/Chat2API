import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { forwardWithAccountFailover } from '../../src/main/proxy/accountFailover.ts'
import { createDeferredQwenAiFailoverStream } from '../../src/main/proxy/qwenAiDeferredStream.ts'
import type { AccountSelection, ForwardResult } from '../../src/main/proxy/types.ts'
import { SseKeepAliveStream } from '../../src/main/proxy/utils/sseKeepAlive.ts'
import { bufferValidatedSseStream } from '../../src/main/proxy/utils/validatedSseStream.ts'

const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

function selection(id: string): AccountSelection {
  return {
    account: { id, providerId: 'qwen-ai', status: 'active' } as AccountSelection['account'],
    provider: {
      id: 'qwen-ai',
      apiEndpoint: 'https://chat.qwen.ai',
    } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max',
  }
}

function completeSse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}

test('deferred managed stream drops a partial 429 branch and exposes only the next account', async () => {
  const first = selection('account-a')
  const second = selection('account-b')
  const attempts: string[] = []
  const failedAccounts: string[] = []
  const progress = new PassThrough()
  let outcomeSettled = false

  const outcomePromise = forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }): Promise<ForwardResult> => {
      attempts.push(current.account.id)
      if (current.account.id === first.account.id) {
        progress.write(`data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'REAL_QWEN_PROGRESS' }, finish_reason: null }],
        })}\n\n`)
        const upstream = new PassThrough()
        const capacityError = Object.assign(new Error('Qwen AI capacity limit after partial output'), {
          status: 429,
          code: 'qwen_ai_capacity_limit',
          retryable: false,
          accountFault: true,
          retryScope: 'next-account' as const,
        })
        setTimeout(() => {
          upstream.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: 'BAD_PARTIAL' }, finish_reason: null }],
          })}\n\n`)
          upstream.destroy(capacityError)
        }, 5)

        try {
          const stream = await bufferValidatedSseStream(upstream)
          return { success: true, status: 200, stream, skipTransform: true }
        } catch (error) {
          const failure = error as typeof capacityError
          return {
            success: false,
            status: failure.status,
            error: failure.message,
            errorCode: failure.code,
            retryable: failure.retryable,
            accountFault: failure.accountFault,
            retryScope: failure.retryScope,
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 35))
      const stream = await bufferValidatedSseStream(Readable.from([completeSse('GOOD_FINAL')]))
      return { success: true, status: 200, stream, skipTransform: true }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
    onFailedAttempt: ({ selection: failed }) => {
      failedAccounts.push(failed.account.id)
    },
  })
  void outcomePromise.finally(() => { outcomeSettled = true })

  const deferred = createDeferredQwenAiFailoverStream(outcomePromise, undefined, progress)
  const clientStream = new SseKeepAliveStream({ intervalMs: 10 })
  const chunks: Buffer[] = []
  clientStream.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const earlyProgress = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('real Qwen progress was not forwarded')), 250)
    clientStream.on('data', chunk => {
      if (!chunk.toString().includes('REAL_QWEN_PROGRESS')) return
      clearTimeout(timer)
      resolve()
    })
  })
  deferred.pipe(clientStream)

  await earlyProgress
  assert.equal(outcomeSettled, false)
  await once(clientStream, 'end')
  const output = Buffer.concat(chunks).toString('utf8')

  assert.deepEqual(attempts, ['account-a', 'account-b'])
  assert.deepEqual(failedAccounts, ['account-a'])
  assert.match(output, /: keep-alive/)
  assert.match(output, /REAL_QWEN_PROGRESS/)
  assert.match(output, /GOOD_FINAL/)
  assert.doesNotMatch(output, /BAD_PARTIAL/)
  assert.equal(deferred.qwenAiEffectiveAccountId, 'account-b')
  assert.equal(deferred.qwenAiFailure, undefined)
})

test('deferred managed stream preserves the final failure classification', async () => {
  const finalSelection = selection('account-final')
  const outcome = Promise.resolve({
    selection: finalSelection,
    result: {
      success: false,
      status: 429,
      error: 'all accounts capacity limited',
      errorCode: 'qwen_ai_capacity_limit',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account' as const,
    },
    failoverCount: 3,
    excludedAccountIds: new Set<string>(),
  })
  const deferred = createDeferredQwenAiFailoverStream(outcome)
  const failureEvent = once(deferred, QWEN_AI_STREAM_FAILURE_EVENT)
  const streamError = once(deferred, 'error')

  const [[failure], [error]] = await Promise.all([failureEvent, streamError])
  assert.equal((failure as Error & { status?: number }).status, 429)
  assert.equal((failure as Error & { code?: string }).code, 'qwen_ai_capacity_limit')
  assert.equal(error, failure)
  assert.equal(deferred.qwenAiFailure, failure)
  assert.equal(deferred.qwenAiEffectiveAccountId, 'account-final')
})
