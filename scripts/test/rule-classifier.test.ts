import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRuleClassifier,
  ruleClassifier,
  scoreLabels,
} from '../../src/humanize/intent/rule-classifier.ts'
import { detectLanguage } from '../../src/humanize/intent/lang.ts'
import type { LabelDefinition } from '../../src/humanize/types.ts'

/** 置信度按公式计算,浮点比较留一点余量 */
const closeTo = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    '期望 ' + String(expected) + ',实际 ' + String(actual),
  )
}

const label = (id: string, keywords: readonly string[], weight?: number): LabelDefinition =>
  weight === undefined ? { id, keywords } : { id, keywords, weight }

test('scoreLabels: 未命中任何关键词的标签不返回', () => {
  assert.deepEqual(scoreLabels('hello there', [label('tone', ['polite'])]), [])
})

test('scoreLabels: 标签没有 keywords 时被跳过', () => {
  assert.deepEqual(scoreLabels('hello', [{ id: 'bare' }]), [])
})

test('scoreLabels: 命中 1 个关键词得 0.5', () => {
  const scored = scoreLabels('please help', [label('tone', ['please'])])
  assert.equal(scored.length, 1)
  assert.equal(scored[0]?.label, 'tone')
  closeTo(scored[0]?.confidence ?? 0, 0.5)
})

test('scoreLabels: 命中 2 个与 3 个关键词时置信度递增', () => {
  const two = scoreLabels('please help me', [label('tone', ['please', 'help'])])
  const three = scoreLabels('please help me', [label('tone', ['please', 'help', 'me'])])
  closeTo(two[0]?.confidence ?? 0, 2 / 3)
  closeTo(three[0]?.confidence ?? 0, 0.75)
})

test('scoreLabels: 标签权重乘进置信度', () => {
  const scored = scoreLabels('please', [label('tone', ['please'], 0.5)])
  closeTo(scored[0]?.confidence ?? 0, 0.25)
})

test('scoreLabels: 权重放大后置信度收敛到 1', () => {
  const scored = scoreLabels('please', [label('tone', ['please'], 4)])
  assert.equal(scored[0]?.confidence, 1)
})

test('scoreLabels: 关键词匹配忽略大小写与首尾空白', () => {
  const scored = scoreLabels('It is RAINING outside', [label('tone', ['  rain  '])])
  assert.equal(scored.length, 1)
  closeTo(scored[0]?.confidence ?? 0, 0.5)
})

test('scoreLabels: 重复关键词只计一次', () => {
  const once = scoreLabels('hi', [label('tone', ['hi'])])
  const twice = scoreLabels('hi', [label('tone', ['hi', 'hi', ' HI '])])
  closeTo(twice[0]?.confidence ?? 0, once[0]?.confidence ?? 0)
})

test('scoreLabels: 空白关键词被忽略', () => {
  assert.deepEqual(scoreLabels('anything', [label('tone', ['', '   '])]), [])
})

test('scoreLabels: 按置信度降序排列', () => {
  const scored = scoreLabels('alpha beta', [
    label('low', ['alpha']),
    label('high', ['alpha', 'beta']),
  ])
  assert.deepEqual(scored.map((item) => item.label), ['high', 'low'])
})

test('scoreLabels: 同分时按标签 id 升序排列', () => {
  const scored = scoreLabels('key', [label('zeta', ['key']), label('alpha', ['key'])])
  assert.deepEqual(scored.map((item) => item.label), ['alpha', 'zeta'])
})

test('scoreLabels: 未声明权重的标签按 1 计算', () => {
  const withWeight = scoreLabels('key', [label('tone', ['key'], 1)])
  const withoutWeight = scoreLabels('key', [label('tone', ['key'])])
  closeTo(
    withoutWeight[0]?.confidence ?? 0,
    withWeight[0]?.confidence ?? 0,
  )
})

test('createRuleClassifier: 默认 id 为 rule-keyword,kind 为 rule', async () => {
  const classifier = createRuleClassifier()
  assert.equal(classifier.id, 'rule-keyword')
  assert.equal(classifier.kind, 'rule')

  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.equal(result.classifier, 'rule-keyword')
  assert.equal(result.text, 'please')
  assert.equal(result.primary?.label, 'tone')
})

test('createRuleClassifier: 可自定义分类器 id', async () => {
  const classifier = createRuleClassifier({ id: 'rule-custom' })
  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.equal(result.classifier, 'rule-custom')
})

test('createRuleClassifier: 默认阈值 0.3 过滤掉低置信度标签', async () => {
  const classifier = createRuleClassifier()
  const result = await classifier.classify({
    text: 'please',
    labels: [label('low', ['please'], 0.4), label('weak', ['please'], 0.8), label('strong', ['please'], 1)],
  })
  // low 折算 0.2 未达阈值被丢弃,weak 0.4 与 strong 0.5 保留
  assert.deepEqual(result.labels.map((item) => item.label), ['strong', 'weak'])
  assert.equal(result.primary?.label, 'strong')
})

test('createRuleClassifier: 配置阈值高于全部置信度时结果为空', async () => {
  const classifier = createRuleClassifier({ minConfidence: 0.9 })
  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.deepEqual(result.labels, [])
  assert.equal(result.primary, null)
})

test('createRuleClassifier: 调用参数里的 minConfidence 覆盖装配时的缺省值', async () => {
  const classifier = createRuleClassifier({ minConfidence: 0.9 })
  const result = await classifier.classify({
    text: 'please help',
    labels: [label('tone', ['please', 'help'])],
    minConfidence: 0.6,
  })
  assert.equal(result.labels.length, 1)
  assert.equal(result.primary?.label, 'tone')
})

test('ruleClassifier: 默认实例可直接使用', async () => {
  const result = await ruleClassifier.classify({
    text: 'please',
    labels: [label('tone', ['please'])],
  })
  assert.equal(ruleClassifier.id, 'rule-keyword')
  assert.equal(result.primary?.label, 'tone')
})

/* ---------- 排除词(1.1.0,规范 7.2) ---------- */

test('scoreLabels: 命中排除词的标签直接不计分', () => {
  const scored = scoreLabels('帮我安装依赖', [
    { id: 'code-help', keywords: ['依赖'], exclude_keywords: ['安装依赖'] },
    { id: 'env-setup', keywords: ['安装'] },
  ])
  // code-help 被「安装依赖」排除,只剩 env-setup
  assert.deepEqual(scored.map((item) => item.label), ['env-setup'])
})

test('scoreLabels: 排除词命中时关键词再多也不计分', () => {
  const scored = scoreLabels('帮我安装依赖,代码报错了', [
    { id: 'code-help', keywords: ['代码', '报错', '依赖'], exclude_keywords: ['安装依赖'] },
  ])
  assert.deepEqual(scored, [])
})

test('scoreLabels: 未命中排除词时照常计分', () => {
  const scored = scoreLabels('这段代码有报错', [
    { id: 'code-help', keywords: ['代码', '报错'], exclude_keywords: ['安装依赖'] },
  ])
  assert.equal(scored.length, 1)
  closeTo(scored[0]?.confidence ?? 0, 2 / 3)
})

test('scoreLabels: 排除词匹配忽略大小写与首尾空白', () => {
  const scored = scoreLabels('please uninstall deps', [
    { id: 'tone', keywords: ['please'], exclude_keywords: ['  UNINSTALL DEPS  '] },
  ])
  assert.deepEqual(scored, [])
})

test('scoreLabels: 空白排除词被忽略', () => {
  const scored = scoreLabels('please', [{ id: 'tone', keywords: ['please'], exclude_keywords: ['', '   '] }])
  assert.equal(scored.length, 1)
})

/* ---------- 锚定短语模式(1.1.0,规范 7.2) ---------- */

test('scoreLabels: 模式整条匹配计一次,与关键词同一计分口径', () => {
  const scored = scoreLabels('帮我写个排序代码', [
    { id: 'code-help', keywords: ['代码'], patterns: ['^帮我(写|改|看).*(代码|脚本)$'] },
  ])
  assert.equal(scored.length, 1)
  // 关键词 1 次 + 模式 1 次 = 2 次命中
  closeTo(scored[0]?.confidence ?? 0, 2 / 3)
})

test('scoreLabels: 顺带提到关键词的整句不命中锚定模式', () => {
  const scored = scoreLabels('我想看看那篇讲代码风格的文章', [
    { id: 'code-help', patterns: ['^帮我(写|改|看).*(代码|脚本)$'] },
  ])
  assert.deepEqual(scored, [])
})

test('scoreLabels: 只有模式命中时也返回标签', () => {
  const scored = scoreLabels('帮我改脚本', [{ id: 'code-help', patterns: ['^帮我(写|改|看).*(代码|脚本)$'] }])
  assert.equal(scored.length, 1)
  closeTo(scored[0]?.confidence ?? 0, 0.5)
})

test('scoreLabels: 模式匹配忽略大小写', () => {
  const scored = scoreLabels('Help me write some CODE', [{ id: 'code-help', patterns: ['^help me write.*code$'] }])
  assert.equal(scored.length, 1)
})

test('scoreLabels: 无法编译的模式被跳过而不是抛错', () => {
  const scored = scoreLabels('帮我写代码', [{ id: 'code-help', patterns: ['^帮我写[代码$'] }])
  assert.deepEqual(scored, [])
})

test('scoreLabels: 重复的模式只计一次', () => {
  const once = scoreLabels('帮我写代码', [{ id: 'a', patterns: ['^帮我写.*$'] }])
  const twice = scoreLabels('帮我写代码', [{ id: 'a', patterns: ['^帮我写.*$', '^帮我写.*$'] }])
  closeTo(once[0]?.confidence ?? 0, 0.5)
  closeTo(twice[0]?.confidence ?? 0, 0.5)
})

/* ---------- 语言判定分量(1.1.0,规范 3.3) ---------- */

test('detectLanguage: 纯中文判 zh', () => {
  assert.equal(detectLanguage('帮我写个脚本'), 'zh')
})

test('detectLanguage: 纯英文判 en', () => {
  assert.equal(detectLanguage('please help me write a script'), 'en')
})

test('detectLanguage: 以中文为主的混合文本判 zh', () => {
  assert.equal(detectLanguage('帮我写个 script 处理这份数据'), 'zh')
})

test('detectLanguage: 以英文为主的混合文本判 en', () => {
  assert.equal(detectLanguage('explain how this 术语 works'), 'en')
})

test('detectLanguage: 没有可判定字符时缺省判 zh', () => {
  assert.equal(detectLanguage('123?!'), 'zh')
  assert.equal(detectLanguage(''), 'zh')
})

test('classifyIntent: 输出带语言判定分量', async () => {
  const classifier = createRuleClassifier()
  const zh = await classifier.classify({ text: '请帮我看看', labels: [label('tone', ['请'])] })
  assert.equal(zh.lang, 'zh')
  const en = await classifier.classify({ text: 'please take a look', labels: [label('tone', ['please'])] })
  assert.equal(en.lang, 'en')
})

test('classifyIntent: 语言与形状解耦,同一标签集在中英文输入下命中一致而 lang 不同', async () => {
  const classifier = createRuleClassifier()
  const labels = [label('brief', ['short', '短'])]
  const en = await classifier.classify({ text: 'please keep it short', labels })
  const zh = await classifier.classify({ text: '请保持简短', labels })
  assert.deepEqual(en.labels.map((item) => item.label), ['brief'])
  assert.deepEqual(zh.labels.map((item) => item.label), ['brief'])
  assert.equal(en.lang, 'en')
  assert.equal(zh.lang, 'zh')
})
