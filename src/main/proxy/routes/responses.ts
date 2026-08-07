import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import Router from '@koa/router'
import type { Context } from 'koa'
import {
  requestForwarder,
  shouldDeferQwenAiManagedStreamCommit,
} from '../forwarder'
import { loadBalancer } from '../loadbalancer'
import { forwardWithAccountFailover, resolveAccountFailoverLimit } from '../accountFailover'
import { createDeferredQwenAiFailoverStream } from '../qwenAiDeferredStream'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import {
  QwenAiAdapter,
  QWEN_AI_STREAM_FAILURE_EVENT,
  type QwenAiOutputStream,
} from '../adapters/qwen-ai'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { streamHandler } from '../stream'
import type { AccountSelection, ChatMessage, ProxyContext } from '../types'
import { storeManager } from '../../store/store'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { SseKeepAliveStream } from '../utils/sseKeepAlive'
import {
  chatCompletionToResponse,
  responseOutputToChatMessages,
  responsesRequestToChatCompletion,
  ResponsesCompatibilityError,
  type ResponseCreateRequest,
} from '../responses/compat'
import { responsesConversationStore } from '../responses/store'
import { createResponsesStreamTransform } from '../responses/stream'
import { classifyChatRequest } from '../requestIntent'
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

function streamFailureStatus(
  error: (Error & { status?: unknown }) | undefined,
  clientAborted = false,
): number {
  if (clientAborted || isClientCancellationError(error)) return 499
  if (typeof error?.status === 'number') return error.status
  if (/timed out|timeout|idle for more than/i.test(error?.message || '')) return 504
  return 502
}

function streamFailureCode(error: Error | undefined): string | undefined {
  const code = (error as (Error & { code?: unknown }) | undefined)?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

function streamFailureAccountFault(error: Error | undefined): boolean | undefined {
  const accountFault = (error as (Error & { accountFault?: unknown }) | undefined)?.accountFault
  return typeof accountFault === 'boolean' ? accountFault : undefined
}

function streamFailureHeaders(error: Error | undefined): Record<string, string> | undefined {
  const headers = (error as (Error & { headers?: unknown }) | undefined)?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

router.post('/responses', async (ctx: Context) => {
  const startedAt = Date.now()
  const createdAt = Math.floor(startedAt / 1000)
  const responseId = createResponseId()
  const abort = createClientAbortController(ctx)
  const request = ctx.request.body as ResponseCreateRequest

  const responseInputItems = Array.isArray(request?.input) ? request.input : []
  const toolResultItems = responseInputItems.filter((item): item is Record<string, any> => (
    Boolean(item)
    && typeof item === 'object'
    && !Array.isArray(item)
    && (
      (item as Record<string, any>).type === 'function_call_output'
      || (item as Record<string, any>).type === 'custom_tool_call_output'
    )
  ))
  if (toolResultItems.length > 0) {
    console.info('[Responses] tool-result ingress', JSON.stringify({
      requestId: responseId,
      toolResultCount: toolResultItems.length,
      isErrorTrueCount: toolResultItems.filter(item => item.is_error === true).length,
      isErrorFalseCount: toolResultItems.filter(item => item.is_error === false).length,
      isErrorMissingCount: toolResultItems.filter(item => typeof item.is_error !== 'boolean').length,
    }))
  }

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
  const translatedToolResults = chatRequest.messages.filter(message => message.role === 'tool')
  if (translatedToolResults.length > 0) {
    console.info('[Responses] tool-result translated', JSON.stringify({
      requestId: responseId,
      toolResultCount: translatedToolResults.length,
      isErrorTrueCount: translatedToolResults.filter(message => message.is_error === true).length,
      isErrorFalseCount: translatedToolResults.filter(message => message.is_error === false).length,
      isErrorMissingCount: translatedToolResults.filter(message => typeof message.is_error !== 'boolean').length,
    }))
  }
  const requestIntent = classifyChatRequest(chatRequest)
  console.info('[Responses] request-intent', JSON.stringify({
    requestId: responseId,
    intent: requestIntent.intent,
    reason: requestIntent.reason,
    signals: requestIntent.signals,
    messageCount: requestIntent.messageCount,
    toolCount: requestIntent.toolCount,
    toolResultCount: requestIntent.toolResultCount,
    textChars: requestIntent.textChars,
  }))
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

  const createProxyContext = (
    selection: AccountSelection,
    deferManagedStreamCommit = false,
    onQwenAiProgressFrame?: (frame: string) => void,
  ): ProxyContext => ({
    requestId: responseId,
    providerId: selection.provider.id,
    accountId: selection.account.id,
    model: chatRequest.model,
    actualModel: selection.actualModel,
    startTime: startedAt,
    isStream: chatRequest.stream === true,
    clientIP: clientIp(ctx),
    signal: abort.controller.signal,
    requestIntent: requestIntent.intent,
    ...(deferManagedStreamCommit ? { deferManagedStreamCommit: true } : {}),
    ...(onQwenAiProgressFrame ? { onQwenAiProgressFrame } : {}),
  })
  let { account, provider, actualModel } = initialSelection
  let qwenAiStream: QwenAiOutputStream | undefined
  proxyStatusManager.recordRequestStart(chatRequest.model, provider.id, account.id)

  const initialProviderIsQwenAi = QwenAiAdapter.isQwenAiProvider(initialSelection.provider)
  const failoverSelectionConstraints = initialProviderIsQwenAi
    && loadBalancer.hasCompleteQwenAiWebSession(initialSelection)
    ? { qwenAiWebSessionTier: 'complete' as const }
    : undefined
  const activeAccountCount = initialProviderIsQwenAi
    ? storeManager.getAccountsByProviderId(initialSelection.provider.id)
      .filter(candidate => candidate.status === 'active')
      .length
    : 0
  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: config.retryCount,
    qwenAiProvider: initialProviderIsQwenAi,
    activeAccountCount,
    qwenAiMaxAccountFailovers: process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS,
  })
  const deferManagedStreamCommit = initialProviderIsQwenAi
    && shouldDeferQwenAiManagedStreamCommit(chatRequest)
  const qwenAiProgressStream = deferManagedStreamCommit ? new PassThrough() : undefined
  const onQwenAiProgressFrame = qwenAiProgressStream
    ? (frame: string) => { qwenAiProgressStream.write(frame) }
    : undefined

  const applyEffectiveSelection = (
    effectiveAccountId?: string,
    effectiveProviderId?: string,
    effectiveActualModel?: string,
  ) => {
    if (!effectiveAccountId) return
    const effectiveAccount = storeManager.getAccountById(effectiveAccountId)
    const effectiveProvider = storeManager.getProviderById(
      effectiveProviderId || effectiveAccount?.providerId || provider.id,
    )
    if (
      !effectiveAccount
      || !effectiveProvider
      || effectiveAccount.providerId !== effectiveProvider.id
    ) {
      return
    }

    account = effectiveAccount
    provider = effectiveProvider
    actualModel = effectiveActualModel || actualModel
  }
  const refreshEffectiveStreamSelection = () => {
    if (!qwenAiStream) return
    applyEffectiveSelection(
      qwenAiStream.qwenAiEffectiveAccountId,
      qwenAiStream.qwenAiEffectiveProviderId,
      qwenAiStream.qwenAiEffectiveActualModel,
    )
  }

  let responsesChunkCount = 0
  let lastResponsesChunkAt = 0
  let clientChunkCount = 0
  let lastClientChunkAt = 0
  let streamDeliveryLogged = false
  const logStreamDelivery = (outcome: 'completed' | 'failed', status: number, error?: Error) => {
    if (streamDeliveryLogged || chatRequest.stream !== true) return
    streamDeliveryLogged = true
    console.info('[Responses] stream-delivery', JSON.stringify({
      requestId: responseId,
      outcome,
      status,
      errorCode: streamFailureCode(error),
      elapsedMs: Date.now() - startedAt,
      responsesChunkCount,
      lastResponsesChunkAt,
      clientChunkCount,
      lastClientChunkAt,
    }))
  }

  let outcomeRecorded = false
  const recordSuccess = () => {
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('completed', 200)
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
      actualModel,
      latency,
      isStream: chatRequest.stream === true,
    })
  }
  const recordFailure = (
    error: Error,
    status = 502,
    penalizeAccount = true,
    deferredStreamFailure = false,
  ) => {
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('failed', status, error)
    const latency = Date.now() - startedAt
    const accountFault = streamFailureAccountFault(error)
    const shouldPenalizeAccount = penalizeAccount && accountFault !== false
    if (deferredStreamFailure && QwenAiAdapter.isQwenAiProvider(provider)) {
      qwenAiRequestGovernor.reportDeferredFailure(account.id, {
        success: false,
        status,
        headers: streamFailureHeaders(error),
        error: error.message,
        errorCode: streamFailureCode(error),
        retryable: false,
        accountFault: accountFault ?? shouldPenalizeAccount,
      }, requestIntent.intent)
    }
    proxyStatusManager.recordRequestFailure(latency)
    if (shouldPenalizeAccount && status !== 429 && status !== 499) {
      loadBalancer.markAccountFailed(account.id)
    }
    storeManager.recordRequestInStats(false, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog(status === 499 ? 'debug' : 'error', 'Responses request failed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      actualModel,
      latency,
      error: error.message,
      errorCode: streamFailureCode(error),
      data: { status, accountFault },
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
    const failoverPromise = forwardWithAccountFailover({
      initialSelection,
      maxFailovers,
      signal: abort.controller.signal,
      forward: async ({ selection }) => requestForwarder.forwardChatCompletion(
        chatRequest,
        selection.account,
        selection.provider,
        selection.actualModel,
        createProxyContext(
          selection,
          deferManagedStreamCommit,
          onQwenAiProgressFrame,
        ),
      ),
      selectNext: excludedAccountIds => loadBalancer.selectAccount(
        chatRequest.model,
        config.loadBalanceStrategy,
        preferredProviderId,
        preferredAccountId,
        excludedAccountIds,
        failoverSelectionConstraints,
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
    const outcome = deferManagedStreamCommit
      ? {
          selection: initialSelection,
          result: {
            success: true,
            status: 200,
            stream: createDeferredQwenAiFailoverStream(
              failoverPromise,
              abort.controller.signal,
              qwenAiProgressStream,
            ),
            skipTransform: true,
          },
          failoverCount: 0,
          excludedAccountIds: new Set<string>(),
        }
      : await failoverPromise
    account = outcome.selection.account
    provider = outcome.selection.provider
    actualModel = outcome.selection.actualModel
    const result = outcome.result
    applyEffectiveSelection(
      result.effectiveAccountId,
      result.effectiveProviderId,
      result.effectiveActualModel,
    )

    if (!result.success) {
      abort.cleanup()
      const status = abort.controller.signal.aborted ? 499 : result.status ?? 500
      const failure = Object.assign(new Error(result.error ?? 'Request failed'), {
        status,
        code: result.errorCode,
        headers: result.headers,
        accountFault: result.accountFault,
      })
      recordFailure(
        failure,
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
      qwenAiStream = QwenAiAdapter.isQwenAiProvider(provider)
        ? rawStream as QwenAiOutputStream
        : undefined
      if (qwenAiStream) {
        qwenAiStream.once(QWEN_AI_STREAM_FAILURE_EVENT, (error: Error) => {
          recordFailure(
            error,
            streamFailureStatus(error, abort.controller.signal.aborted),
            true,
            true,
          )
        })
        if (qwenAiStream.qwenAiFailure) {
          recordFailure(
            qwenAiStream.qwenAiFailure,
            streamFailureStatus(qwenAiStream.qwenAiFailure, abort.controller.signal.aborted),
            true,
            true,
          )
        }
      }
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
          const imageResolutionFailure = error instanceof ResponseImageResolutionError
          const status = imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted)
          recordFailure(error, status, !imageResolutionFailure, !imageResolutionFailure)
        },
      }).start()
      const clientStream = new SseKeepAliveStream()

      responsesStream.on('data', () => {
        responsesChunkCount += 1
        lastResponsesChunkAt = Date.now()
      })
      clientStream.on('data', () => {
        clientChunkCount += 1
        lastClientChunkAt = Date.now()
      })

      const sourceError = (error: Error) => {
        const status = streamFailureStatus(error, abort.controller.signal.aborted)
        if (!abort.controller.signal.aborted) {
          responsesStream.fail(error)
          responsesStream.end()
        } else {
          recordFailure(error, status, true, true)
        }
      }
      rawStream.once('error', sourceError)
      if (chatStream !== rawStream) chatStream.once('error', sourceError)
      responsesStream.once('error', (error: Error) => {
        const imageResolutionFailure = error instanceof ResponseImageResolutionError
        recordFailure(
          error,
          imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted),
          !imageResolutionFailure,
          !imageResolutionFailure,
        )
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(clientStream)
      })
      responsesStream.once('end', abort.cleanup)
      abort.controller.signal.addEventListener('abort', () => {
        const cancellation = new Error('Client disconnected from Responses stream.')
        recordFailure(cancellation, 499, true, true)
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(responsesStream)
        destroyStream(clientStream)
      }, { once: true })

      responsesStream.pipe(clientStream)
      chatStream.pipe(responsesStream)
      ctx.body = clientStream
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
