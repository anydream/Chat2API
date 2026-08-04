import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function loadTypeScriptModule(path) {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', output)(require, loaded, loaded.exports)
  return loaded.exports
}

test('Qwen built-in fallback advertises only the current website catalogue', () => {
  const { qwenAiConfig } = loadTypeScriptModule('src/main/providers/builtin/qwen-ai.ts')

  assert.deepEqual(qwenAiConfig.supportedModels, [
    'Qwen3.8-Max',
    'Qwen3.7-Plus',
    'Qwen3.7-Max',
  ])
  assert.equal(qwenAiConfig.modelMappings['Qwen3.8-Max'], 'qwen3.8-max')
  assert.equal(
    qwenAiConfig.modelMappings['Qwen3.8-Max-Preview'],
    'qwen3.8-max-preview',
    'the old request name remains a compatibility mapping without being advertised',
  )
})

test('Qwen live catalogue keeps distinct capabilities for Max and Preview', () => {
  const { parseProviderModelsResponse } = loadTypeScriptModule('src/main/providers/modelSync.ts')
  const parsed = parseProviderModelsResponse({
    data: [
      {
        id: 'qwen3.8-max',
        name: 'Qwen3.8-Max',
        info: {
          meta: {
            think_skip: { enable: true },
            max_context_length: 1_000_000,
            max_summary_generation_length: 131_072,
          },
        },
      },
      {
        id: 'qwen3.8-max-preview',
        name: 'Qwen3.8-Max-Preview',
        info: {
          meta: {
            think_skip: { enable: false },
            max_context_length: 1_000_000,
            max_summary_generation_length: 65_536,
          },
        },
      },
    ],
  })

  assert.deepEqual(parsed.supportedModels, ['Qwen3.8-Max', 'Qwen3.8-Max-Preview'])
  assert.equal(parsed.modelMappings['Qwen3.8-Max'], 'qwen3.8-max')
  assert.deepEqual(parsed.modelCapabilities['qwen3.8-max'], {
    thinkingSkippable: true,
    maxContextLength: 1_000_000,
    maxSummaryGenerationLength: 131_072,
  })
  assert.deepEqual(parsed.modelCapabilities['qwen3.8-max-preview'], {
    thinkingSkippable: false,
    maxContextLength: 1_000_000,
    maxSummaryGenerationLength: 65_536,
  })
})

test('server startup refreshes dynamic model catalogues before accepting traffic', () => {
  const serverSource = fs.readFileSync('src/server/index.ts', 'utf8')
  const initializeAt = serverSource.indexOf('await storeManager.initialize()')
  const syncAt = serverSource.indexOf('await storeManager.syncDynamicBuiltinProviderModels()')
  const startAt = serverSource.indexOf('await proxyServer.start(')

  assert.ok(initializeAt >= 0)
  assert.ok(syncAt > initializeAt)
  assert.ok(startAt > syncAt)
})

test('dynamic catalogue startup preserves persisted models until refresh succeeds', () => {
  const storeSource = fs.readFileSync('src/main/store/store.ts', 'utf8')

  assert.match(storeSource, /preservesDynamicModelCatalogue/)
  assert.match(storeSource, /\.\.\.\(p\.supportedModels \|\| \[\]\)/)
  assert.match(storeSource, /sync failed; keeping persisted models/)
})
