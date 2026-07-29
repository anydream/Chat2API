import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  forwardWithAccountFailover,
  isNextAccountFailoverEligible,
} from '../../src/main/proxy/accountFailover.ts'
import type { AccountSelection, ForwardResult } from '../../src/main/proxy/types.ts'

function selection(accountId: string): AccountSelection {
  return {
    account: { id: accountId } as AccountSelection['account'],
    provider: { id: 'qwen-ai' } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max-preview',
  }
}

const nextAccountFailure: ForwardResult = {
  success: false,
  status: 503,
  error: 'account credentials need replacement',
  errorCode: 'qwen_ai_token_refresh_failed',
  retryable: false,
  accountFault: true,
  retryScope: 'next-account',
}

test('preflight account failures switch accounts inside the same request', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const attempted: string[] = []
  const failed: string[] = []
  const exclusions: string[][] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 3,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? nextAccountFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => {
      exclusions.push([...excluded])
      return excluded.has(first.account.id) ? second : null
    },
    onFailedAttempt: ({ selection: current }) => {
      failed.push(current.account.id)
    },
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(failed, ['account-1'])
  assert.deepEqual(exclusions, [['account-1']])
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('only explicit preflight replay scopes are replayed', async () => {
  const controller = new AbortController()
  const ineligible: ForwardResult[] = [
    { ...nextAccountFailure, retryScope: undefined },
    { ...nextAccountFailure, status: 499 },
  ]

  for (const result of ineligible) {
    let selections = 0
    const outcome = await forwardWithAccountFailover({
      initialSelection: selection('account-1'),
      maxFailovers: 3,
      forward: async () => result,
      selectNext: () => {
        selections += 1
        return selection('account-2')
      },
    })
    assert.equal(outcome.failoverCount, 0)
    assert.equal(selections, 0)
  }

  controller.abort()
  assert.equal(isNextAccountFailoverEligible(nextAccountFailure, controller.signal), false)
})

test('account-neutral preflight failures replay independently of account fault', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const replayableUpstreamFailure: ForwardResult = {
    success: false,
    status: 502,
    error: 'upstream service rejected the request',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []
  const reportedFailures: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? replayableUpstreamFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
    onFailedAttempt: ({ selection: current }) => {
      reportedFailures.push(current.account.id)
    },
  })

  assert.equal(isNextAccountFailoverEligible(replayableUpstreamFailure), true)
  assert.equal(isNextAccountFailoverEligible({
    ...replayableUpstreamFailure,
    accountFault: undefined,
  }), true)
  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(reportedFailures, ['account-1'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('account failover is bounded and never reselects an excluded account', async () => {
  const accounts = [selection('account-1'), selection('account-2'), selection('account-3')]
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return nextAccountFailure
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.failoverCount, 1)
  assert.equal(outcome.result.success, false)

  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  assert.match(loadBalancerSource, /excludedAccountIds: ReadonlySet<string>/)
  assert.match(loadBalancerSource, /!excludedAccountIds\.has\(account\.id\)/)
})

test('both OpenAI-compatible generation routes use the shared account failover policy', () => {
  for (const routePath of [
    'src/main/proxy/routes/chat.ts',
    'src/main/proxy/routes/responses.ts',
  ]) {
    const source = fs.readFileSync(routePath, 'utf8')
    assert.match(source, /forwardWithAccountFailover\(\{/)
    assert.match(source, /maxFailovers:\s*config\.retryCount/)
    assert.match(source, /excludedAccountIds\s*=>\s*loadBalancer\.selectAccount\(/)
    assert.match(source, /reportAccountFailover\(selection\.account\.id/)
    assert.match(source, /if \(result\.accountFault !== false\) \{\s*loadBalancer\.markAccountFailed/)
    assert.match(source, /data:\s*\{\s*attempt,\s*status:\s*result\.status,\s*accountFault:\s*result\.accountFault/)
  }
})
