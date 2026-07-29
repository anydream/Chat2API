import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import Router from '@koa/router'
import type { Context } from 'koa'
import { requestForwarder } from '../forwarder'
import { loadBalancer } from '../loadbalancer'
import { forwardWithAccountFailover } from '../accountFailover'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import { QwenAiAdapter } from '../adapters/qwen-ai'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { streamHandler } from '../stream'
import type { AccountSelection, ChatMessage, ProxyContext } from '../types'
import { storeManager } from '../../store/store'
import { sanitizeForwardedErrorHeaders } from '../utils/errors'
import {
  chatCompletionToResponse,
  responseOutputToChatMessages,
  responsesRequestToChatCompletion,
  ResponsesCompatibilityError,
  type ResponseCreateRequest,
} from '../responses/compat'
import { responsesConversationStore } from '../responses/store'
import { createResponsesStreamTransform } from '../responses/stream'
import {
  createResponseImageResolver,
  ResponseImageResolutionError,
} from '../responses/image'

const router = new Router({ prefix: '/v1' })

function createResponseId(): string {
  return `resp_${Date.now().toString(36)}${randomUUID().replace(/-/g, '')}`
}

function createClientAbortController(ctx: Context): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  const onClose = () => {
    if (!ctx.res.writableEnded) abort()
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', onClose)
  return {
    controller,
    cleanup: () => {
      ctx.req.removeListener('aborted', abort)
      ctx.res.removeListener('close', onClose)
    },
  }
}

function clientIp(ctx: Context): string {
  const forwarded = ctx.headers['x-forwarded-for']
  return (ctx.headers['x-real-ip'] as string | undefined)
    ?? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?? ctx.ip
    ?? 'unknown'
}

function writeInvalidRequest(
  ctx: Context,
  message: string,
  param: string | null,
  code: string | null,
): void {
  ctx.status = 400
  ctx.body = {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  }
}

function destroyStream(stream: NodeJS.ReadableStream | undefined, error?: Error): void {
  const destroy = (stream as Readable | undefined)?.destroy
  if (typeof destroy === 'function' && !(stream as Readable).destroyed) {
    destroy.call(stream, error)
  }
}

router.post('/responses', async (ctx: Context) => {
  const startedAt = Date.now()
  const createdAt = Math.floor(startedAt / 1000)
  const responseId = createResponseId()
  const abort = createClientAbortController(ctx)
  const request = ctx.request.body as ResponseCreateRequest

  let previousMessages: ChatMessage[] = []
  if (typeof request?.previous_response_id === 'string' && request.previous_response_id) {
    const stored = responsesConversationStore.get(request.previous_response_id)
    if (!stored) {
      abort.cleanup()
      writeInvalidRequest(
        ctx,
        `Previous response context is unavailable: ${request.previous_response_id}`,
        'previous_response_id',
        'response_context_unavailable',
      )
      return
    }
    previousMessages = stored
  }

  let translated: ReturnType<typeof responsesRequestToChatCompletion>
  try {
    translated = responsesRequestToChatCompletion(request, previousMessages)
  } catch (error) {
    abort.cleanup()
    if (error instanceof ResponsesCompatibilityError) {
      writeInvalidRequest(ctx, error.message, error.param, error.code)
      return
    }
    writeInvalidRequest(ctx, error instanceof Error ? error.message : 'Invalid request body', null, null)
    return
  }

  const chatRequest = {
    ...translated.chatRequest,
    signal: abort.controller.signal,
  }
  const imageResolver = createResponseImageResolver({ signal: abort.controller.signal })
  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(chatRequest.model)
  const preferredAccountId = modelMapper.getPreferredAccount(chatRequest.model)
  const initialSelection = loadBalancer.selectAccount(
    chatRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId,
  )
  if (!initialSelection) {
    abort.cleanup()
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${chatRequest.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  const createProxyContext = (selection: AccountSelection): ProxyContext => ({
    requestId: responseId,
    providerId: selection.provider.id,
    accountId: selection.account.id,
    model: chatRequest.model,
    actualModel: selection.actualModel,
    startTime: startedAt,
    isStream: chatRequest.stream === true,
    clientIP: clientIp(ctx),
    signal: abort.controller.signal,
  })
  let { account, provider, actualModel } = initialSelection
  proxyStatusManager.recordRequestStart(chatRequest.model, provider.id, account.id)

  let outcomeRecorded = false
  const recordSuccess = () => {
    if (outcomeRecorded) return
    outcomeRecorded = true
    const latency = Date.now() - startedAt
    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)
    storeManager.incrementAccountUsage(account.id)
    storeManager.recordRequestInStats(true, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog('debug', 'Responses request completed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      latency,
      isStream: chatRequest.stream === true,
    })
  }
  const recordFailure = (error: Error, status = 502, penalizeAccount = true) => {
    if (outcomeRecorded) return
    outcomeRecorded = true
    const latency = Date.now() - startedAt
    proxyStatusManager.recordRequestFailure(latency)
    if (penalizeAccount && status !== 429 && status !== 499) loadBalancer.markAccountFailed(account.id)
    storeManager.recordRequestInStats(false, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog(status === 499 ? 'debug' : 'error', 'Responses request failed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      latency,
      error: error.message,
      data: { status },
    })
  }
  const storeConversation = (output: Array<Record<string, any>>) => {
    const transcript = [
      ...translated.conversationMessages,
      ...responseOutputToChatMessages(output),
    ]
    const stored = responsesConversationStore.set(responseId, transcript)
    if (!stored) {
      storeManager.addLog('warn', 'Responses context exceeded the bounded previous_response store', {
        requestId: responseId,
        model: chatRequest.model,
      })
    }
  }

  try {
    const outcome = await forwardWithAccountFailover({
      initialSelection,
      maxFailovers: config.retryCount,
      signal: abort.controller.signal,
      forward: async ({ selection }) => requestForwarder.forwardChatCompletion(
        chatRequest,
        selection.account,
        selection.provider,
        selection.actualModel,
        createProxyContext(selection),
      ),
      selectNext: excludedAccountIds => loadBalancer.selectAccount(
        chatRequest.model,
        config.loadBalanceStrategy,
        preferredProviderId,
        preferredAccountId,
        excludedAccountIds,
      ),
      onFailedAttempt: ({ selection, attempt }, result) => {
        if (QwenAiAdapter.isQwenAiProvider(selection.provider)) {
          qwenAiRequestGovernor.reportAccountFailover(selection.account.id, {
            requestId: responseId,
            status: result.status,
            errorCode: result.errorCode,
            attempt,
            accountFault: result.accountFault,
          })
        }
        if (result.accountFault !== false) {
          loadBalancer.markAccountFailed(selection.account.id)
        }
        storeManager.addLog('warn', 'Retrying Responses request with another account after upstream failure', {
          requestId: responseId,
          providerId: selection.provider.id,
          accountId: selection.account.id,
          model: chatRequest.model,
          errorCode: result.errorCode,
          data: {
            attempt,
            status: result.status,
            accountFault: result.accountFault,
          },
        })
      },
    })
    account = outcome.selection.account
    provider = outcome.selection.provider
    actualModel = outcome.selection.actualModel
    const result = outcome.result

    if (!result.success) {
      abort.cleanup()
      const status = abort.controller.signal.aborted ? 499 : result.status ?? 500
      recordFailure(
        new Error(result.error ?? 'Request failed'),
        status,
        result.accountFault !== false,
      )
      const safeHeaders = sanitizeForwardedErrorHeaders(result.headers)
      if (safeHeaders) {
        Object.entries(safeHeaders).forEach(([name, value]) => ctx.set(name, value))
      }
      ctx.status = status
      ctx.body = {
        error: {
          message: result.error ?? 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }
      return
    }

    if (chatRequest.stream === true) {
      if (!result.stream) {
        abort.cleanup()
        const error = new Error('Upstream returned no stream for a streaming Responses request.')
        recordFailure(error)
        ctx.status = 502
        ctx.body = {
          error: { message: error.message, type: 'api_error', param: null, code: 'missing_stream' },
        }
        return
      }

      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const rawStream = result.stream
      const chatStream = result.skipTransform
        ? rawStream
        : rawStream.pipe(streamHandler.createTransformStream(
          actualModel,
          `chatcmpl-${responseId.slice(5)}`,
          undefined,
          { requireDoneMarker: true },
        ))
      const responsesStream = createResponsesStreamTransform({
        request,
        responseId,
        model: actualModel,
        createdAt,
        imageResolver,
        onComplete: (response) => {
          storeConversation(response.output)
          recordSuccess()
        },
        onIncomplete: (response) => {
          storeConversation(response.output)
          recordSuccess()
        },
        onFailure: (error) => {
          const status = abort.controller.signal.aborted
            ? 499
            : error instanceof ResponseImageResolutionError
              ? error.status
              : 502
          recordFailure(error, status, !(error instanceof ResponseImageResolutionError))
        },
      }).start()

      const sourceError = (error: Error) => {
        const status = abort.controller.signal.aborted ? 499 : 502
        if (!abort.controller.signal.aborted) {
          responsesStream.fail(error)
          responsesStream.end()
        } else {
          recordFailure(error, status)
        }
      }
      rawStream.once('error', sourceError)
      if (chatStream !== rawStream) chatStream.once('error', sourceError)
      responsesStream.once('error', (error: Error) => {
        recordFailure(error, abort.controller.signal.aborted ? 499 : 502)
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
      })
      responsesStream.once('end', abort.cleanup)
      abort.controller.signal.addEventListener('abort', () => {
        const cancellation = new Error('Client disconnected from Responses stream.')
        recordFailure(cancellation, 499)
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(responsesStream)
      }, { once: true })

      chatStream.pipe(responsesStream)
      ctx.body = responsesStream
      return
    }

    const fallbackCompletion = {
      id: `chatcmpl-${responseId.slice(5)}`,
      object: 'chat.completion',
      created: createdAt,
      model: actualModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    const response = await chatCompletionToResponse(result.body ?? fallbackCompletion, request, {
      id: responseId,
      model: actualModel,
      createdAt,
      imageResolver,
    })
    storeConversation(response.output)
    recordSuccess()
    abort.cleanup()
    ctx.set('Content-Type', 'application/json')
    ctx.body = response
  } catch (error) {
    abort.cleanup()
    const caught = error instanceof Error ? error : new Error('Unknown Responses proxy error')
    const status = abort.controller.signal.aborted
      ? 499
      : caught instanceof ResponseImageResolutionError
        ? caught.status
        : 500
    recordFailure(caught, status, !(caught instanceof ResponseImageResolutionError))
    ctx.status = status
    ctx.body = {
      error: {
        message: caught.message,
        type: 'api_error',
        param: null,
        code: abort.controller.signal.aborted
          ? 'request_cancelled'
          : caught instanceof ResponseImageResolutionError
            ? caught.code
            : null,
      },
    }
  }
})

export default router
