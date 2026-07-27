import type { ChatMessage } from '../types.ts'

const TOOL_CALL_CONTENT_TYPES = new Set([
  'tool_use',
  'server_tool_use',
  'bash_code_execution',
  'text_editor_code_execution',
  'computer_use',
])

const TOOL_RESULT_CONTENT_TYPES = new Set([
  'tool_result',
  'web_search_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'code_execution_tool_result',
])

/**
 * Return true when a message contains a client-managed tool invocation.
 * Anthropic-compatible bridges can represent the same block either as an
 * OpenAI tool_calls array or as a content part, so inspect both shapes.
 */
export function isToolCallMessage(message: ChatMessage): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  if (legacyFunctionCall && typeof legacyFunctionCall === 'object') return true
  if (!Array.isArray(message.content)) return false

  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    return TOOL_CALL_CONTENT_TYPES.has(String((part as { type?: unknown }).type || ''))
  })
}

/** Return true for OpenAI and Anthropic-style tool result messages. */
export function isToolResultMessage(message: ChatMessage): boolean {
  if (message.role === 'tool' || Boolean(message.tool_call_id)) return true
  if (!Array.isArray(message.content)) return false

  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    return TOOL_RESULT_CONTENT_TYPES.has(String((part as { type?: unknown }).type || ''))
  })
}

/** Extract only visible text from a message without retaining tool payloads. */
export function extractMessageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''

  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n')
}

const ENGLISH_REPAIR_WORDS = new Set([
  'a',
  'again',
  'an',
  'and',
  'answer',
  'any',
  'anything',
  'appear',
  'appeared',
  'be',
  'been',
  'blank',
  'came',
  'can',
  'complete',
  'contain',
  'contained',
  'content',
  'continue',
  'could',
  'did',
  'display',
  'displayed',
  'do',
  'does',
  'earlier',
  'empty',
  'failed',
  'failure',
  'from',
  'get',
  'give',
  'got',
  'had',
  'has',
  'have',
  'i',
  'invisible',
  'is',
  'it',
  'last',
  'message',
  'missing',
  'my',
  'no',
  'not',
  'nothing',
  'omitted',
  'output',
  'please',
  'preceding',
  'previous',
  'prior',
  'produce',
  'produced',
  'provide',
  'provided',
  'reply',
  'respond',
  'response',
  'resume',
  'retry',
  'return',
  'returned',
  'send',
  'show',
  'shown',
  'silent',
  'some',
  'text',
  'that',
  'the',
  'there',
  'this',
  'through',
  'to',
  'try',
  'turn',
  'up',
  'user',
  'user-visible',
  'visible',
  'was',
  'we',
  'were',
  'with',
  'without',
  'would',
  'you',
  'your',
])

const CHINESE_REPAIR_CHARACTERS = new Set(
  '\u4f60\u60a8\u6211\u4eec\u4e0a\u4e00\u6b21\u6761\u8f6e\u4e2a\u4e4b\u524d\u521a\u624d\u9762\u5148\u6b64\u7684\u56de\u590d\u7b54\u54cd\u5e94\u6d88\u606f\u8f93\u51fa\u5185\u5bb9\u7ed3\u679c\u6ca1\u6709\u4efb\u4f55\u53ef\u89c1\u7528\u6237\u662f\u4e3a\u7a7a\u767d\u7f3a\u5931\u4e22\u770b\u4e0d\u672a\u663e\u793a\u8fd4\u56de\u4ea7\u751f\u63d0\u4f9b\u4e2d\u65ad\u5931\u8d25\u8bf7\u9ebb\u70e6\u7ee7\u7eed\u91cd\u8bd5\u518d\u6062\u590d\u65b0\u7ed9\u51fa\u751f\u6210\u6b63\u5e38\u5b8c\u6574\u6587\u5b57\u672c\u5e76\u548c\u7136\u540e\u8ba9\u80fd\u53ef\u4ee5\u8fd9\u90a3\u51fa\u6765\u4e00\u4e0b',
)

/**
 * Identify a short, meta-level request to repair an empty prior response.
 * The vocabulary is intentionally narrow so a new task cannot inherit stale
 * managed-tool state merely because it also contains a continuation verb.
 */
type ResponseRepairKind = 'bare' | 'explicit'

function classifyResponseRepairRequest(content: string): ResponseRepairKind | undefined {
  const text = content
    .replace(/\b(?:didn['\u2019]t)\b/gi, 'did not')
    .replace(/\b(?:wasn['\u2019]t)\b/gi, 'was not')
    .replace(/\b(?:isn['\u2019]t)\b/gi, 'is not')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || text.length > 320) return undefined
  if (/[?\uFF1F]/.test(text)) return undefined
  if (/https?:\/\/|www\.|```|`|(?:^|\s)[a-z]:[\\/]|(?:^|\s)\/[\w.-]/i.test(text)) {
    return undefined
  }

  const normalized = text
    .replace(/^[\s[\](){}"']+|[\s[\](){}"']+$/g, '')
    .trim()
  const lower = normalized.toLowerCase()
  const bareEnglishRepair = /^(?:please\s+)?(?:continue|retry|try\s+again|resume)(?:\s+(?:the\s+)?(?:response|reply|answer|output))?(?:\s+and\s+(?:produce|provide|return|show|send|give)\s+(?:a\s+|some\s+)?(?:user-visible\s+|visible\s+)?(?:response|reply|answer|output|content|text))?[.!]?$/
  if (bareEnglishRepair.test(lower)) return 'bare'

  const bareChineseRepair = /^(?:\u8bf7|\u9ebb\u70e6)?(?:\u7ee7\u7eed|\u91cd\u8bd5|\u518d\u8bd5(?:\u4e00\u6b21)?|\u6062\u590d)(?:\u56de\u590d|\u56de\u7b54|\u54cd\u5e94|\u8f93\u51fa)?[\u3002\uFF01!]?$/
  if (bareChineseRepair.test(normalized)) return 'bare'

  const englishWords = lower.match(/[a-z]+(?:-[a-z]+)?/g) || []
  if (englishWords.length > 0) {
    if (/[^\u0000-\u007f]/.test(lower)) return undefined
    if (englishWords.some(word => !ENGLISH_REPAIR_WORDS.has(word))) return undefined

    const prior = /\b(?:previous|prior|last|earlier|preceding)\b/.exec(lower)
    const responseNoun = /\b(?:response|reply|message|answer|turn|output|content)\b/.exec(lower)
    const absence = /\b(?:empty|blank|missing|invisible|silent|omitted)\b|\bno(?:\s+(?:visible|user-visible|actual|any))?\s+(?:output|content|response|reply|answer|message|text)\b|\bnothing(?:\s+(?:was|is))?\s+(?:visible|shown|displayed|returned|produced|provided|appeared)\b|\bnot\s+(?:visible|shown|displayed|returned|produced|provided)\b|\bdid\s+not\s+(?:show|display|return|produce|provide|output|contain|appear)\b|\bfailed\s+to\s+(?:show|display|return|produce|provide|output)\b/.exec(lower)
    if (!prior || !responseNoun || !absence) return undefined

    const repairTail = lower.slice(absence.index + absence[0].length)
    return /\b(?:continue|retry|resume|respond|answer|reply|produce|provide|return|show|send|output)\b|\btry\s+again\b/.test(repairTail)
      ? 'explicit'
      : undefined
  }

  const chineseCharacters = normalized.match(/[\u3400-\u9fff]/g) || []
  if (chineseCharacters.length === 0) return undefined
  if (/[a-z0-9]/i.test(normalized)) return undefined
  if (chineseCharacters.some(character => !CHINESE_REPAIR_CHARACTERS.has(character))) {
    return undefined
  }

  const prior = /\u4e0a(?:\u4e00(?:\u6b21|\u6761|\u8f6e)?|\u4e2a)|\u524d(?:\u4e00(?:\u6b21|\u6761|\u8f6e)?|\u9762)|\u4e4b\u524d|\u521a\u624d|\u521a\u521a|\u5148\u524d|\u6b64\u524d/.exec(normalized)
  const responseNoun = /\u56de\u590d|\u56de\u7b54|\u54cd\u5e94|\u6d88\u606f|\u8f93\u51fa|\u5185\u5bb9|\u7ed3\u679c/.exec(normalized)
  const absence = /\u6ca1\u6709(?:\u4efb\u4f55)?(?:\u7528\u6237)?(?:\u53ef\u89c1)?(?:\u56de\u590d|\u56de\u7b54|\u54cd\u5e94|\u6d88\u606f|\u8f93\u51fa|\u5185\u5bb9|\u7ed3\u679c)|\u6ca1(?:\u663e\u793a|\u8f93\u51fa|\u8fd4\u56de|\u4ea7\u751f)|\u672a(?:\u663e\u793a|\u8f93\u51fa|\u8fd4\u56de|\u4ea7\u751f|\u63d0\u4f9b)|\u4e3a\u7a7a|\u662f\u7a7a\u7684?|\u7a7a\u767d|\u7f3a\u5931|\u4e22\u5931|\u770b\u4e0d\u89c1|\u4e0d\u53ef\u89c1|\u4e2d\u65ad/.exec(normalized)
  if (!prior || !responseNoun || !absence) return undefined

  const repairTail = normalized.slice(absence.index + absence[0].length)
  return /\u7ee7\u7eed|\u91cd\u8bd5|\u518d\u8bd5|\u6062\u590d|\u91cd\u65b0(?:\u56de\u590d|\u56de\u7b54|\u8f93\u51fa|\u751f\u6210)|\u7ed9\u51fa|\u63d0\u4f9b|\u751f\u6210|\u663e\u793a|\u8fd4\u56de|\u8f93\u51fa/.test(repairTail)
    ? 'explicit'
    : undefined
}

/**
 * Recognize a status/next-step follow-up that keeps an established tool
 * workflow in scope. This is intentionally separate from the strict
 * continuation classifier: a user may ask a question such as "what next?"
 * while still expecting the agent to keep working. The surrounding request
 * must independently prove a recent, matched client-tool exchange before
 * this signal can enable recovery.
 */
export function isLikelyWorkflowFollowupRequest(content: string): boolean {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 320) return false
  if (/https?:\/\/|www\.|```|`|(?:^|\s)[a-z]:[\\/]|(?:^|\s)\/[\w.-]/i.test(text)) {
    return false
  }

  const lower = text.toLowerCase()
  if (
    /\b(?:another|new|unrelated|separate|different|other)\b|\bnext\s+(?:task|work|workflow|request)\b/i.test(lower)
    || /\bnew\s+(?:goal|objective)\b/i.test(lower)
    || /\u65b0(?:\u7684)?(?:\u4efb\u52a1|\u5de5\u4f5c|\u8bf7\u6c42|\u76ee\u6807)|\u53e6(?:\u4e00\u4e2a)?|\u5176\u4ed6|\u4e0d\u76f8\u5173|\u4e0d\u540c|\u72ec\u7acb/.test(text)
  ) {
    return false
  }
  if (
    /\b(?:explain|describe|tell\s+me|what\s+does|why\s+does|how\s+does)\b/i.test(lower)
    || /\u8bf7(?:\u89e3\u91ca|\u544a\u8bc9)|\u544a\u8bc9\u6211/.test(text)
  ) {
    return false
  }

  const statusMarker = /\b(?:what(?:['\u2019]s|\s+is)?\s+(?:the\s+)?next|what\s+should\s+(?:i|we|you)\s+do\s+next|where\s+do\s+(?:i|we)\s+go\s+from\s+here|what\s+remains|what(?:['\u2019]s|\s+is)?\s+(?:still\s+)?missing|what\s+is\s+(?:still\s+)?left|what\s+do\s+(?:i|we)\s+still\s+need|what\s+now|how\s+do\s+(?:i|we)\s+proceed)\b/i
    .test(lower)
    || /\u4e0b\u4e00\u6b65(?:\u8981)?(?:\u505a\u4ec0\u4e48|\u5e72\u4ec0\u4e48|\u600e\u4e48\u529e|\u662f\u4ec0\u4e48)?|\u63a5\u4e0b\u6765(?:\u8981)?(?:\u505a\u4ec0\u4e48|\u5e72\u4ec0\u4e48|\u600e\u4e48\u529e|\u600e\u4e48\u7ee7\u7eed)?|\u8fd8(?:\u5269|\u5dee|\u7f3a)\u4ec0\u4e48|\u8fd8\u9700\u8981\u4ec0\u4e48|\u76ee\u524d(?:\u8fd8)?(?:\u5dee|\u7f3a)\u4ec0\u4e48|\u73b0\u5728(?:\u8fd8)?(?:\u5dee|\u7f3a)\u4ec0\u4e48|\u73b0\u5728(?:\u600e\u4e48\u529e|\u8981\u5e72\u561b|\u8981\u505a\u4ec0\u4e48)/.test(text)
  if (!statusMarker) return false

  // A status question followed by an explicit imperative/goal remains a
  // workflow follow-up; a pure request for an explanation does not.
  return true
}

export function isLikelyResponseRepairRequest(content: string): boolean {
  return classifyResponseRepairRequest(content) !== undefined
}

function isExplicitResponseRepairRequest(content: string): boolean {
  return classifyResponseRepairRequest(content) === 'explicit'
}

const ENGLISH_CONTINUATION_WORDS = new Set([
  'after',
  'again',
  'are',
  'at',
  'before',
  'continue',
  'current',
  'did',
  'do',
  'earlier',
  'from',
  'frozen',
  'get',
  'going',
  'got',
  'happened',
  'has',
  'interrupted',
  'is',
  'issue',
  'it',
  'keep',
  'last',
  'left',
  'my',
  'next',
  'no',
  'now',
  'off',
  'on',
  'original',
  'our',
  'part',
  'paused',
  'phase',
  'please',
  'point',
  'previous',
  'prior',
  'problem',
  'proceed',
  'progress',
  'remaining',
  'request',
  'resume',
  'running',
  'same',
  'section',
  'stage',
  'stalled',
  'step',
  'still',
  'stop',
  'stopped',
  'stuck',
  'task',
  'that',
  'the',
  'there',
  'this',
  'unfinished',
  'waiting',
  'was',
  'we',
  'were',
  'what',
  'where',
  'why',
  'with',
  'work',
  'workflow',
  'working',
  'you',
  'your',
])

const CHINESE_CONTINUATION_CHARACTERS = new Set(
  '\u8bf7\u9ebb\u70e6\u7ee7\u7eed\u6062\u590d\u63a5\u7740\u5f80\u4e0b\u505a\u63a8\u8fdb\u53c8\u5361\u4f4f\u4e86\u5417\u662f\u5426\u600e\u4e48\u4e3a\u4f55\u505c\u6b62\u4e2d\u65ad\u6682\u505c\u51bb\u7ed3\u8fd8\u5728\u6b63\u5904\u7406\u8fd0\u884c\u7b49\u5f85\u51fa\u73b0\u6709\u6ca1\u95ee\u9898\u60c5\u51b5\u8fdb\u5c55\u539f\u6765\u5148\u4e4b\u524d\u521a\u624d\u5f53\u524d\u8fd9\u4e2a\u90a3\u540c\u4e00\u5269\u4f59\u672a\u5b8c\u6210\u5de5\u4f5c\u4efb\u52a1\u8bf7\u6c42\u5b9e\u73b0\u9636\u6bb5\u6b65\u9aa4\u90e8\u5206\u73af\u8282\u4f4d\u7f6e\u5730\u65b9\u4ece\u4e0a\u6b21\u4e0a\u4e00\u6b65\u4e0b\u4e00\u6b65\u7b2c\u5230\u5904\u8fd9\u91cc\u90a3\u91cc\u7684\u554a\u5427\u5462\u5440\u5566\u54e6',
)

/**
 * Recognize a bounded request to continue the same workflow. Status questions
 * are accepted only when followed by an imperative continuation, and the
 * narrow vocabulary prevents a new task payload from becoming transparent.
 */
export function isLikelyWorkflowContinuationRequest(content: string): boolean {
  const text = content
    .replace(/\b(?:don['\u2019]t)\b/gi, 'do not')
    .replace(/\b(?:shouldn['\u2019]t)\b/gi, 'should not')
    .replace(/\b(?:mustn['\u2019]t)\b/gi, 'must not')
    .replace(/\b(?:can['\u2019]t)\b/gi, 'cannot')
    .replace(/\b(?:won['\u2019]t)\b/gi, 'will not')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || text.length > 240) return false
  if (
    /https?:\/\/|www\.|```|`|(?:^|\s)[a-z]:[\\/]|(?:^|\s)\/[\w.-]|[\[\]{};=<>]/i.test(text)
  ) {
    return false
  }

  const lower = text.toLowerCase()
  if (
    /\b(?:do|should|must|will)\s+not\s+(?:continue|resume|proceed)\b|\bcannot\s+(?:continue|resume|proceed)\b|\bno\s+need\s+to\s+(?:continue|resume|proceed)\b|^(?:please\s+)?(?:stop|cancel)\b/i.test(lower)
    || /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u7528|\u4e0d\u5fc5)(?:\u518d)?(?:\u7ee7\u7eed|\u6062\u590d|\u63a5\u7740)|^(?:\u8bf7)?(?:\u505c\u6b62|\u53d6\u6d88)/.test(text)
  ) {
    return false
  }
  if (
    /\b(?:another|new|unrelated|separate|different|other)\b|\bnext\s+(?:task|work|workflow|request)\b/i.test(lower)
    || /\u53e6\u4e00\u4e2a|\u53e6\u5916|\u65b0(?:\u7684)?(?:\u4efb\u52a1|\u5de5\u4f5c|\u8bf7\u6c42)|\u4e0b(?:\u4e00)?\u4e2a(?:\u4efb\u52a1|\u5de5\u4f5c|\u6d41\u7a0b|\u8bf7\u6c42)|\u5176\u4ed6|\u65e0\u5173|\u4e0d\u76f8\u5173|\u4e0d\u540c|\u5355\u72ec|\u72ec\u7acb/.test(text)
  ) {
    return false
  }

  const englishWords = lower.match(/[a-z]+/g) || []
  if (englishWords.some(word => !ENGLISH_CONTINUATION_WORDS.has(word))) return false
  const chineseCharacters = text.match(/[\u3400-\u9fff]/g) || []
  if (chineseCharacters.some(character => !CHINESE_CONTINUATION_CHARACTERS.has(character))) {
    return false
  }

  const actions = [
    ...Array.from(lower.matchAll(/\b(?:continue|resume|proceed)\b|\bkeep\s+going\b/g)),
    ...Array.from(text.matchAll(/\u7ee7\u7eed|\u6062\u590d|\u63a5\u7740/g)),
  ]
    .map(match => ({ index: match.index ?? -1, text: match[0] }))
    .filter(match => match.index >= 0)
    .sort((left, right) => left.index - right.index)
  if (actions.length === 0) return false

  const lastQuestionIndex = Math.max(text.lastIndexOf('?'), text.lastIndexOf('\uFF1F'))
  const action = lastQuestionIndex >= 0
    ? actions.find(candidate => candidate.index > lastQuestionIndex)
    : actions[0]
  if (!action) return false
  if (/[?\uFF1F]/.test(text.slice(action.index))) return false

  const actionSuffix = text.slice(action.index + action.text.length).trim()
  if (/^(?:\u5417|\u4e48)(?:[.\u3002!\uFF01])?$/.test(actionSuffix)) return false
  if (
    /\b(?:stop|cancel|halt|end)\b/i.test(actionSuffix)
    || /\u505c\u6b62|\u53d6\u6d88|\u7ed3\u675f|\u5230\u6b64|\u5230\u8fd9\u91cc/.test(actionSuffix)
  ) {
    return false
  }

  if (lastQuestionIndex >= 0) {
    const statusPrefix = text.slice(0, lastQuestionIndex + 1)
    const hasStatusEvidence = /\b(?:stuck|stalled|stop|stopped|paused|frozen|interrupted|working|running|waiting|issue|problem|happened|progress)\b/i.test(statusPrefix)
      || /\u5361\u4f4f|\u505c|\u4e2d\u65ad|\u6682\u505c|\u51bb\u7ed3|\u8fd8\u5728|\u6b63\u5728|\u7b49\u5f85|\u95ee\u9898|\u60c5\u51b5|\u8fdb\u5c55|\u600e\u4e48|\u662f\u5426/.test(statusPrefix)
    if (!hasStatusEvidence) return false
  } else {
    const rawPrefix = text.slice(0, action.index)
    const hasDelimitedStatusEvidence = /[,.;:!\uFF0C\u3002\uFF1B\uFF1A\uFF01]\s*$/.test(rawPrefix)
      && (
        /\b(?:stuck|stalled|stopped|paused|frozen|interrupted)\b/i.test(rawPrefix)
        || /\u5361\u4f4f|\u505c\u4e86|\u4e2d\u65ad\u4e86|\u6682\u505c\u4e86|\u51bb\u7ed3\u4e86/.test(rawPrefix)
      )
    if (!hasDelimitedStatusEvidence) {
      const prefix = rawPrefix
        .replace(/\bplease\b/gi, '')
        .replace(/\u8bf7|\u9ebb\u70e6/g, '')
        .replace(/[\s,\uFF0C:.\uFF1A!\uFF01\u3001\u3002\u2026]/g, '')
      if (prefix) return false
    }
  }

  return true
}

function isAssistantWithoutVisibleOutput(message: ChatMessage): boolean {
  if (message.role !== 'assistant' || isToolCallMessage(message)) return false
  if (message.content === null) return true
  if (typeof message.content === 'string') return message.content.trim().length === 0
  if (!Array.isArray(message.content)) return false

  return message.content.every((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const record = part as { type?: unknown; text?: unknown }
    if (record.type === 'thinking' || record.type === 'redacted_thinking') return true
    return record.type === 'text'
      && (typeof record.text !== 'string' || record.text.trim().length === 0)
  })
}

export function extractPlainTextMessage(message: ChatMessage): string | undefined {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return undefined

  const textParts: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as { type?: unknown; text?: unknown }
    if (record.type !== 'text' || typeof record.text !== 'string') return undefined
    textParts.push(record.text)
  }
  return textParts.join('\n')
}

const ENGLISH_WORKFLOW_ACTION = '(?:read|inspect|open|look\\s+at|check|review|run|execute|create|write|modify|edit|implement|build|add|update|fix|verify|test|integrate|determine|locate|find|set\\s+up|wire|investigate|change|refactor|remove|replace|connect|configure|compile|install)'
const ENGLISH_WORKFLOW_ACTION_GERUND = '(?:reading|inspecting|opening|looking\\s+at|checking|reviewing|running|executing|creating|writing|modifying|editing|implementing|building|adding|updating|fixing|verifying|testing|integrating|determining|locating|finding|setting\\s+up|wiring|investigating|working\\s+on|changing|refactoring|removing|replacing|connecting|configuring|compiling|installing)'
const CHINESE_WORKFLOW_ACTION = '(?:\\u8bfb\\u53d6|\\u67e5\\u770b|\\u68c0\\u67e5|\\u5ba1\\u67e5|\\u6253\\u5f00|\\u8fd0\\u884c|\\u6267\\u884c|\\u521b\\u5efa|\\u5199\\u5165|\\u4fee\\u6539|\\u7f16\\u8f91|\\u5b9e\\u73b0|\\u6784\\u5efa|\\u6dfb\\u52a0|\\u66f4\\u65b0|\\u4fee\\u590d|\\u9a8c\\u8bc1|\\u6d4b\\u8bd5|\\u96c6\\u6210|\\u786e\\u5b9a|\\u67e5\\u627e|\\u5b9a\\u4f4d|\\u642d\\u5efa|\\u5904\\u7406|\\u91cd\\u6784|\\u5220\\u9664|\\u66ff\\u6362|\\u8fde\\u63a5|\\u914d\\u7f6e|\\u7f16\\u8bd1|\\u5b89\\u88c5)'

function isClearlyTerminalText(text: string): boolean {
  const chineseCurrentResult = new RegExp(
    `(?:^|[\\u3002\\uFF01\\uFF1F!?]\\s*)(?:\\u73b0\\u5728|\\u76ee\\u524d)(?![^\\u3002\\uFF01\\uFF1F!?\\uFF0C,]{0,80}(?:\\u628a|\\u5c06|\\u662f\\u5426|\\u80fd\\u5426))${CHINESE_WORKFLOW_ACTION}[^\\u3002\\uFF01\\uFF1F!?\\uFF0C,]{0,40}(?:(?:\\u5df2\\u7ecf|\\u5df2)(?:\\u5b8c\\u6210|\\u6210\\u529f|\\u901a\\u8fc7|\\u7ed3\\u675f)|(?:\\u5b8c\\u6210|\\u6210\\u529f|\\u901a\\u8fc7|\\u7ed3\\u675f))[\\u3002\\uFF01!]?$`,
  )
  if (chineseCurrentResult.test(text)) return true

  const englishTerminal = /(?:^|[.!]\s+)(?:(?:the\s+)?(?:requested\s+|all\s+)?(?:task|work|workflow|request|implementation|changes?|fix|verification)\s+(?:(?:is|are)\s+(?:now\s+)?(?:complete|finished|done|implemented|fixed|resolved|verified)|(?:has|have)\s+(?:now\s+)?been\s+(?:completed|finished|implemented|fixed|resolved|verified))|(?:i|we)\s+(?:have\s+(?:now\s+)?)?(?:completed|finished|implemented|fixed|resolved|verified)\s+(?:the\s+)?(?:requested\s+)?(?:task|work|workflow|request|implementation|changes?|fix|verification))\b/i
  const chineseTerminal = /(?:^|[\u3002\uFF01!]\s*)(?:(?:\u4efb\u52a1|\u5de5\u4f5c|\u6d41\u7a0b|\u8bf7\u6c42|\u5b9e\u73b0|\u4fee\u6539|\u4fee\u590d|\u9a8c\u8bc1)(?:\u5df2\u7ecf|\u5df2)?(?:\u5168\u90e8)?(?:\u5b8c\u6210|\u7ed3\u675f)|(?:\u5df2\u7ecf|\u5df2)(?:\u5168\u90e8)?(?:\u5b8c\u6210|\u7ed3\u675f)(?:\u4efb\u52a1|\u5de5\u4f5c|\u6d41\u7a0b|\u8bf7\u6c42|\u5b9e\u73b0|\u4fee\u6539|\u4fee\u590d|\u9a8c\u8bc1)?)/
  const terminalMatch = englishTerminal.exec(text) || chineseTerminal.exec(text)
  if (!terminalMatch) return false

  const suffix = text.slice((terminalMatch.index ?? 0) + terminalMatch[0].length)
  const actorContinuation = /\b(?:i|we)\s+(?:will|(?:need|plan|intend|want|have)\s+to|(?:am|are)\s+going\s+to)|\blet(?:\s+me|'s|\s+us)\b/i.test(suffix)
    || /(?:(?:\u6211|\u6211\u4eec)(?:\u5c06|\u4f1a|\u9700\u8981|\u51c6\u5907|\u6253\u7b97|\u6b63\u5728)|\u8ba9(?:\u6211|\u6211\u4eec))/.test(suffix)
  const sequencedContinuation = new RegExp(
    `(?:^|[.!]\\s*)(?:next|then|after\\s+that)\\s*(?:[:,]\\s*)?(?:(?:i|we)\\s+(?:will|need\\s+to)\\s+)?${ENGLISH_WORKFLOW_ACTION}\\b`,
    'i',
  ).test(suffix) || new RegExp(
    `(?:^|[\\u3002\\uFF01!]\\s*)(?:\\u63a5\\u4e0b\\u6765|\\u4e0b\\u4e00\\u6b65|\\u7136\\u540e)(?!\\s*\\u7684)\\s*(?:\\u5148)?${CHINESE_WORKFLOW_ACTION}`,
  ).test(suffix)
  const optionalSuggestion = /\b(?:if\s+(?:desired|needed|you\s+(?:want|wish|prefer))|optionally|when\s+convenient)\b/i.test(suffix)
    || /\u5982\u679c\u9700\u8981|\u5982\u6709\u9700\u8981|\u53ef\u9009|\u53ef\u4ee5\u8003\u8651|\u89c6\u9700\u8981/.test(suffix)

  return !(actorContinuation || (sequencedContinuation && !optionalSuggestion))
}

function isLikelyWorkflowSummaryText(text: string): boolean {
  if (isLikelyWorkflowProgressText(text) || isClearlyTerminalText(text)) return true

  // Some clients emit a short terminal synopsis whose wording is broader
  // than the progress classifier (for example, "the earlier workflow is
  // complete"). Only treat it as transparent when it names a workflow
  // concept and an explicit completion state; arbitrary assistant prose must
  // remain a hard boundary.
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0 || normalized.length > 2_000) return false
  const workflowNoun = /\b(?:task|work|workflow|phase|request|implementation|change|changes|fix|verification|system|game)\b/i.test(normalized)
    || /\u4efb\u52a1|\u5de5\u4f5c|\u6d41\u7a0b|\u9636\u6bb5|\u8bf7\u6c42|\u5b9e\u73b0|\u4fee\u6539|\u4fee\u590d|\u9a8c\u8bc1|\u7cfb\u7edf|\u6e38\u620f/.test(normalized)
  const completionState = /\b(?:complete|completed|finished|done|implemented|fixed|resolved|verified|ready)\b/i.test(normalized)
    || /\u5b8c\u6210|\u7ed3\u675f|\u5b8c\u6bd5|\u5b8c\u6210|\u901a\u8fc7|\u5c31\u7eea/.test(normalized)
  return workflowNoun && completionState
}

/**
 * Identify a bounded forward-looking progress update rather than a terminal
 * answer. The classifier is intentionally provider/client agnostic: it is
 * only used after a real managed-tool exchange has already occurred, and it
 * recognizes common planning/action wording in English and Chinese without
 * inspecting task names, paths, or tool identifiers.
 */
export function isLikelyWorkflowProgressText(content: string): boolean {
  const text = content
    .replace(/\b(i|we)['\u2019]ll\b/gi, '$1 will')
    .replace(/\bi['\u2019]m\b/gi, 'I am')
    .replace(/\bwe['\u2019]re\b/gi, 'we are')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || text.length > 12_000) return false
  if (/[?\uFF1F]\s*$/.test(text)) return false
  if (isClearlyTerminalText(text)) return false

  const actorIntent = new RegExp(
    `\\b(?:i|we)\\s+(?:will|(?:need|plan|intend|want|have)\\s+to|(?:am|are)\\s+going\\s+to)\\s+(?:first\\s+|now\\s+)?${ENGLISH_WORKFLOW_ACTION}\\b`,
    'i',
  )
  const letIntent = new RegExp(
    `\\blet(?:\\s+me|'s|\\s+us)\\s+(?:first\\s+|now\\s+)?${ENGLISH_WORKFLOW_ACTION}\\b`,
    'i',
  )
  const sequencedAction = new RegExp(
    `(?:^|[.!]\\s+)(?:next|then|first|after\\s+that)(?:\\s*[:,]\\s*${ENGLISH_WORKFLOW_ACTION}|\\s+(?:i|we)\\s+(?:will|need\\s+to)\\s+${ENGLISH_WORKFLOW_ACTION})\\b`,
    'i',
  )
  const continuativeAction = new RegExp(
    `\\b(?:continue|proceed|start|begin|move\\s+on)\\s+(?:by\\s+|to\\s+|with\\s+)?${ENGLISH_WORKFLOW_ACTION}\\b`,
    'i',
  )
  const actorContinuation = /\b(?:i|we)\s+(?:will\s+|(?:need|plan|intend|want|have)\s+to\s+)?(?:continue|proceed|resume)\b/i
  const ongoingAction = new RegExp(
    `\\b(?:i|we)\\s+(?:am|are)\\s+(?:now\\s+)?${ENGLISH_WORKFLOW_ACTION_GERUND}\\b|(?:^|[.!]\\s+)(?:starting|beginning|continuing)\\s+(?:by\\s+|with\\s+)?${ENGLISH_WORKFLOW_ACTION_GERUND}\\b`,
    'i',
  )
  const chineseIntent = new RegExp(
    `(?:(?:(?:\\u6211|\\u6211\\u4eec)(?:\\u5c06|\\u4f1a|\\u9700\\u8981|\\u51c6\\u5907|\\u6253\\u7b97|\\u6b63\\u5728)|\\u8ba9(?:\\u6211|\\u6211\\u4eec))[^\\u3002\\uFF01\\uFF1F!?]{0,60}|(?:^|[\\u3002\\uFF01\\uFF1F!?]\\s*)(?:(?:(?:\\u63a5\\u4e0b\\u6765|\\u4e0b\\u4e00\\u6b65)|\\u7ee7\\u7eed|\\u5148(?!\\u524d)|\\u7136\\u540e)(?!\\s*\\u7684)(?![\\s:\\uFF1A,\\uFF0C]*(?:\\u662f|\\u4e3a|\\u5982\\u4e0b|\\u5c55\\u793a|\\u7ed9\\u51fa|\\u5217\\u51fa))[^\\u3002\\uFF01\\uFF1F!?]{0,60}|(?:\\u73b0\\u5728|\\u76ee\\u524d)(?![^\\u3002\\uFF01\\uFF1F!?]{0,80}(?:(?:\\u5df2\\u7ecf|\\u73b0\\u5df2|\\u521a\\u521a|\\u5df2)[^\\u3002\\uFF01\\uFF1F!?]{0,60}${CHINESE_WORKFLOW_ACTION}|(?:\\u5b8c\\u6210|\\u7ed3\\u675f|\\u6210\\u529f|\\u901a\\u8fc7|\\u597d|\\u5b8c)(?:\\u4e86|\\u6bd5)))(?:(?:\\u7acb\\u5373|\\u5148|\\u6765|\\u5f00\\u59cb|\\u7ee7\\u7eed|\\u51c6\\u5907|\\u6253\\u7b97|\\u9700\\u8981|\\u628a|\\u5c06|\\u6b63(?:\\u5728)?)(?!\\s*\\u7684)[^\\u3002\\uFF01\\uFF1F!?]{0,60})?))${CHINESE_WORKFLOW_ACTION}(?!\\u4e86|\\u540e|\\u7684)`,
  )
  const chineseActorCurrentIntent = new RegExp(
    `(?:^|[\\u3002\\uFF01\\uFF1F!?]\\s*)(?:\\u6211|\\u6211\\u4eec)(?:\\u73b0\\u5728|\\u76ee\\u524d)(?:(?:\\u7acb\\u5373|\\u5148|\\u6765|\\u5f00\\u59cb|\\u7ee7\\u7eed|\\u51c6\\u5907|\\u6253\\u7b97|\\u9700\\u8981|\\u628a|\\u5c06|\\u6b63(?:\\u5728)?)(?!\\s*\\u7684)[^\\u3002\\uFF01\\uFF1F!?]{0,60})?${CHINESE_WORKFLOW_ACTION}(?!\\u4e86|\\u540e|\\u7684)`,
  )
  const chineseSequencedPlan = new RegExp(
    `(?:^|[\\u3002\\uFF01\\uFF1F!?]\\s*)(?:\\u63a5\\u4e0b\\u6765|\\u4e0b\\u4e00\\u6b65)\\s*\\u662f\\s*\\u5148${CHINESE_WORKFLOW_ACTION}(?!\\u4e86|\\u540e|\\u7684)`,
  )
  const chineseStatusSequence = new RegExp(
    `(?:^|[\\u3002\\uFF01\\uFF1F!?]\\s*)(?:\\u6ca1\\u6709\\u95ee\\u9898|\\u6ca1\\u95ee\\u9898|\\u4e00\\u5207\\u6b63\\u5e38)[,\\uFF0C:\\uFF1A]\\s*(?:\\u63a5\\u4e0b\\u6765|\\u4e0b\\u4e00\\u6b65|\\u7136\\u540e)${CHINESE_WORKFLOW_ACTION}(?!\\u4e86|\\u540e|\\u7684)`,
  )
  const chineseContinuation = /^(?:(?:\u6211|\u6211\u4eec)(?:\u4f1a|\u5c06)|\u73b0\u5728|\u76ee\u524d|\u63a5\u4e0b\u6765)?\s*\u7ee7\u7eed(?:\s*(?:\u5b8c\u6210)?(?:\u5269\u4f59|\u5f53\u524d|\u4e4b\u524d\u7684?)?(?:\u5de5\u4f5c|\u4efb\u52a1|\u5904\u7406|\u5b9e\u73b0))?[\u3002\uFF01!]?$/

  return actorIntent.test(text)
    || letIntent.test(text)
    || sequencedAction.test(text)
    || continuativeAction.test(text)
    || actorContinuation.test(text)
    || ongoingAction.test(text)
    || chineseIntent.test(text)
    || chineseActorCurrentIntent.test(text)
    || chineseSequencedPlan.test(text)
    || chineseStatusSequence.test(text)
    || chineseContinuation.test(text)
}

/**
 * A prior managed exchange followed by assistant progress prose or a strict
 * empty-response repair turn indicates a still-active workflow. A plain final
 * answer does not open this context.
 */
export function hasActiveManagedWorkflow(messages: ChatMessage[]): boolean {
  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.role !== 'user' || isToolResultMessage(lastMessage)) {
    return false
  }
  const lastUserText = extractPlainTextMessage(lastMessage)
  if (lastUserText === undefined) return false
  const lastUserIsExplicitRepair = isExplicitResponseRepairRequest(lastUserText)
  const lastUserIsWorkflowContinuation = isLikelyWorkflowContinuationRequest(lastUserText)
  if (!lastUserIsExplicitRepair && !lastUserIsWorkflowContinuation) return false
  if (
    (lastUserIsExplicitRepair || lastUserIsWorkflowContinuation)
    && hasRecentMatchedToolExchange(messages, messages.length - 1)
  ) {
    return true
  }

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (isToolCallMessage(message)) return false
    const activeEvidence = isLikelyWorkflowProgressText(extractMessageText(message))
      || (
        isAssistantWithoutVisibleOutput(message)
        && (isLikelyResponseRepairRequest(lastUserText) || lastUserIsWorkflowContinuation)
      )
    if (!activeEvidence) return false
    return hasRecentMatchedToolExchange(messages, index)
  }

  return false
}

/**
 * Decide whether a new user turn is eligible for one bounded recovery if the
 * provider answers with progress prose instead of a tool call. The current
 * turn must be a generic next-step/status follow-up and the immediately
 * preceding history must contain a recent, strictly matched client-tool
 * result batch. Ordinary first requests and explicit new-task turns remain
 * ineligible.
 */
export function isInitialProgressRecoveryCandidate(messages: ChatMessage[]): boolean {
  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]
  if (!lastMessage || lastMessage.role !== 'user' || isToolResultMessage(lastMessage)) {
    return false
  }

  const lastText = extractPlainTextMessage(lastMessage)
  if (!lastText || !isLikelyWorkflowFollowupRequest(lastText)) return false

  return hasRecentMatchedToolExchangeBefore(messages, lastIndex - 1)
}

function hasRecentMatchedToolExchangeBefore(messages: ChatMessage[], startIndex: number): boolean {
  // Keep this local scan bounded. A very old tool exchange must not become a
  // recovery permission merely because a later user asks a status question.
  const maxScan = 48
  let scanned = 0
  let assistantProseCount = 0
  let transparentUserCount = 0

  for (let index = startIndex; index >= 0 && scanned < maxScan; index -= 1, scanned += 1) {
    const message = messages[index]
    if (message.role === 'system') return false

    if (isToolResultMessage(message)) {
      return hasMatchedToolResultBatchEndingAt(messages, index)
    }

    // A substantive user turn is a hard semantic boundary. Short status,
    // repair, and same-work continuation turns are transparent because they
    // can legitimately sit between a tool exchange and the next status check.
    if (message.role === 'user') {
      const userText = extractPlainTextMessage(message)
      if (
        userText === undefined
        || (
          !isLikelyWorkflowFollowupRequest(userText)
          && !isExplicitResponseRepairRequest(userText)
          && !isLikelyWorkflowContinuationRequest(userText)
        )
      ) {
        return false
      }
      transparentUserCount += 1
      if (transparentUserCount > 2) return false
      continue
    }

    if (message.role !== 'assistant') return false
    if (isToolCallMessage(message)) return false

    // Assistant summaries/progress can sit between the last result batch and
    // the user's next-step question. Non-text or mixed media is not safe to
    // replay as workflow evidence.
    const assistantText = extractPlainTextMessage(message)
    if (assistantText === undefined || !isLikelyWorkflowSummaryText(assistantText)) return false
    assistantProseCount += 1
    // Permit a bounded pair of summaries: a terminal summary from the prior
    // turn and a subsequent progress acknowledgement before the current
    // status request. More prose would make the historical association too
    // ambiguous to revive safely.
    if (assistantProseCount > 2) return false
  }

  return false
}

/**
 * Validate the protocol boundary that opens a new model turn after tool
 * execution. Result ids must belong to the immediately preceding managed
 * call batch, and Anthropic-style result messages cannot carry a separate
 * user payload alongside the results.
 */
export function hasTrailingMatchedToolResultBatch(messages: ChatMessage[]): boolean {
  const lastIndex = messages.length - 1
  if (lastIndex < 1 || !isToolResultMessage(messages[lastIndex])) return false
  return hasMatchedToolResultBatchEndingAt(messages, lastIndex)
}

function hasRecentMatchedToolExchange(messages: ChatMessage[], progressIndex: number): boolean {
  for (let index = progressIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'system') break
    if (isToolResultMessage(message)) {
      return hasMatchedToolResultBatchEndingAt(messages, index)
    }
    if (message.role === 'user' && !isToolResultMessage(message)) {
      const userText = extractPlainTextMessage(message)
      if (
        userText === undefined
        || (
          !isExplicitResponseRepairRequest(userText)
          && !isLikelyWorkflowContinuationRequest(userText)
        )
      ) {
        break
      }
      continue
    }

    if (message.role === 'assistant' && !isToolCallMessage(message)) {
      const assistantText = extractMessageText(message).trim()
      if (assistantText) {
        if (!isLikelyWorkflowProgressText(assistantText)) break
      } else if (!isAssistantWithoutVisibleOutput(message)) {
        break
      }
    }
    if (isToolCallMessage(message)) {
      break
    }
  }

  return false
}

function hasMatchedToolResultBatchEndingAt(messages: ChatMessage[], batchEndIndex: number): boolean {
  let batchStartIndex = batchEndIndex
  while (batchStartIndex > 0 && isToolResultMessage(messages[batchStartIndex - 1])) {
    batchStartIndex -= 1
  }

  const callMessage = messages[batchStartIndex - 1]
  if (!callMessage) return false
  const callIds = getStrictManagedToolCallIds(callMessage)
  if (!callIds || callIds.length === 0) return false

  const resultIds: string[] = []
  const seenResultIds = new Set<string>()
  for (let index = batchStartIndex; index <= batchEndIndex; index += 1) {
    const ids = getStrictManagedToolResultIds(messages[index])
    if (!ids || ids.length === 0) return false
    for (const id of ids) {
      if (seenResultIds.has(id)) return false
      seenResultIds.add(id)
      resultIds.push(id)
    }
  }

  if (resultIds.length !== callIds.length) return false
  const callIdSet = new Set(callIds)
  return resultIds.every(resultId => callIdSet.has(resultId))
}

function getStrictManagedToolCallIds(message: ChatMessage): string[] | undefined {
  if (message.role !== 'assistant') return undefined
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  if (legacyFunctionCall !== undefined) return undefined
  const rawToolCalls = (message as ChatMessage & { tool_calls?: unknown }).tool_calls
  if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) return undefined
  const openAiIds: string[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (
        !call
        || call.type !== 'function'
        || typeof call.id !== 'string'
        || !call.id.trim()
        || !call.function
        || typeof call.function.name !== 'string'
        || !call.function.name.trim()
        || typeof call.function.arguments !== 'string'
      ) {
        return undefined
      }
      openAiIds.push(call.id)
    }
  }
  if (!hasUniqueIds(openAiIds)) return undefined

  if (!Array.isArray(message.content)) {
    // OpenAI-compatible bridges commonly omit `content` entirely when an
    // assistant message contains only tool_calls. Treat omitted content the
    // same as the wire-level `null`, while continuing to reject other values.
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
      return undefined
    }
    return openAiIds
  }
  const anthropicIds: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
    const type = String(record.type || '')
    if (type !== 'tool_use') {
      if (TOOL_CALL_CONTENT_TYPES.has(type)) return undefined
      continue
    }
    if (
      typeof record.id !== 'string'
      || !record.id.trim()
      || typeof record.name !== 'string'
      || !record.name.trim()
      || !record.input
      || typeof record.input !== 'object'
      || Array.isArray(record.input)
    ) {
      return undefined
    }
    anthropicIds.push(record.id)
  }
  if (!hasUniqueIds(anthropicIds)) return undefined
  if (openAiIds.length === 0) return anthropicIds
  if (anthropicIds.length === 0) return openAiIds
  if (openAiIds.length !== anthropicIds.length) return undefined
  const anthropicIdSet = new Set(anthropicIds)
  return openAiIds.every(id => anthropicIdSet.has(id)) ? openAiIds : undefined
}

function getStrictManagedToolResultIds(message: ChatMessage): string[] | undefined {
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  const rawToolCalls = (message as ChatMessage & { tool_calls?: unknown }).tool_calls
  if (legacyFunctionCall !== undefined || rawToolCalls !== undefined) return undefined
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim()) return undefined
    if (isToolCallMessage(message)) return undefined
    return [message.tool_call_id]
  }
  if (message.role !== 'user' || message.tool_call_id !== undefined) return undefined
  if (isToolCallMessage(message)) return undefined
  if (!Array.isArray(message.content) || message.content.length === 0) return undefined

  const ids: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as { type?: unknown; tool_use_id?: unknown }
    if (record.type !== 'tool_result') return undefined
    if (typeof record.tool_use_id !== 'string' || !record.tool_use_id.trim()) return undefined
    ids.push(record.tool_use_id)
  }
  return hasUniqueIds(ids) ? ids : undefined
}

function hasUniqueIds(ids: string[]): boolean {
  return new Set(ids).size === ids.length
}
