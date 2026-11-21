import assert from 'node:assert/strict'
import test from 'node:test'

import { buildInjection } from '../../src/humanize/injection/builder.ts'
import { buildContrastText } from '../../src/humanize/injection/examples.ts'

test('buildInjection: 没有片段也没有已有提示词时结果为空', () => {
  const result = buildInjection({})
  assert.equal(result.prompt, '')
  assert.equal(result.added, 0)
  assert.deepEqual(result.dropped, [
    { reason: 'empty', text: '' },
    { reason: 'empty', text: '' },
  ])
})

test('buildInjection: 只有人设前缀时只输出前缀', () => {
  const result = buildInjection({ personaPrefix: '  You are calm.  ' })
  assert.equal(result.prompt, 'You are calm.')
  assert.equal(result.added, 1)
  assert.deepEqual(result.dropped, [{ reason: 'empty', text: '' }])
})

test('buildInjection: 缺省位置为追加', () => {
  const result = buildInjection({ injection: 'Be brief.', existingPrompt: 'Existing.' })
  assert.equal(result.prompt, 'Existing.\n\nBe brief.')
  assert.equal(result.added, 1)
})

test('buildInjection: prepend 放在已有提示词之前', () => {
  const result = buildInjection({
    injection: 'Be brief.',
    existingPrompt: 'Existing.',
    position: 'prepend',
  })
  assert.equal(result.prompt, 'Be brief.\n\nExisting.')
})

test('buildInjection: 分隔符可配置', () => {
  const result = buildInjection({
    injection: 'Be brief.',
    existingPrompt: 'Existing.',
    separator: '---',
  })
  assert.equal(result.prompt, 'Existing.---Be brief.')
})

test('buildInjection: 人设前缀排在注入文本之前', () => {
  const result = buildInjection({
    personaPrefix: 'You are calm.',
    injection: 'Be brief.',
    existingPrompt: 'Existing.',
  })
  assert.equal(result.prompt, 'Existing.\n\nYou are calm.\n\nBe brief.')
  assert.equal(result.added, 2)
})

test('buildInjection: 内容相同的片段只保留第一次出现的', () => {
  const result = buildInjection({ personaPrefix: 'Same text.', injection: '  Same text. ' })
  assert.equal(result.prompt, 'Same text.')
  assert.equal(result.added, 1)
  assert.deepEqual(result.dropped, [{ reason: 'duplicate', text: 'Same text.' }])
})

test('buildInjection: 忽略空白差异后相同的片段也算重复', () => {
  const result = buildInjection({ personaPrefix: 'a  b', injection: 'a b' })
  assert.equal(result.added, 1)
  assert.equal(result.dropped.length, 1)
  assert.equal(result.dropped[0]?.reason, 'duplicate')
})

test('buildInjection: 已出现在已有提示词里的片段不再重复加入', () => {
  const result = buildInjection({ injection: 'Be brief.', existingPrompt: 'Rules: Be brief.' })
  assert.equal(result.prompt, 'Rules: Be brief.')
  assert.equal(result.added, 0)
  assert.deepEqual(result.dropped, [
    { reason: 'empty', text: '' },
    { reason: 'already-present', text: 'Be brief.' },
  ])
})

test('buildInjection: 人设前缀已存在时只加入注入文本', () => {
  const result = buildInjection({
    personaPrefix: 'You are calm.',
    injection: 'Be brief.',
    existingPrompt: 'You are calm.',
  })
  assert.equal(result.prompt, 'You are calm.\n\nBe brief.')
  assert.equal(result.added, 1)
  assert.deepEqual(result.dropped, [{ reason: 'already-present', text: 'You are calm.' }])
})

test('buildInjection: 已有提示词首尾空白被去掉', () => {
  const result = buildInjection({ existingPrompt: '  Existing.  ' })
  assert.equal(result.prompt, 'Existing.')
  assert.equal(result.added, 0)
})

test('buildInjection: prepend 时没有已有提示词就只输出片段', () => {
  const result = buildInjection({ injection: 'Be brief.', position: 'prepend' })
  assert.equal(result.prompt, 'Be brief.')
})

test('buildInjection: 丢弃记录按处理顺序排列', () => {
  const result = buildInjection({
    personaPrefix: '',
    injection: 'Same.',
    existingPrompt: 'Same.',
  })
  assert.deepEqual(result.dropped.map((item) => item.reason), ['empty', 'already-present'])
})

test('buildInjection: 注入类型的片段接在策略注入文本之后', () => {
  const result = buildInjection({
    personaPrefix: 'You are calm.',
    injection: 'Be polite.',
    fragments: ['Be brief.', 'Ask first.'],
    existingPrompt: 'Existing.',
  })
  assert.equal(result.prompt, 'Existing.\n\nYou are calm.\n\nBe polite.\n\nBe brief.\n\nAsk first.')
  assert.equal(result.added, 4)
})

test('buildInjection: 片段集合为空时只拼接前面的内容', () => {
  const result = buildInjection({
    injection: 'Be polite.',
    fragments: [],
    existingPrompt: 'Existing.',
  })
  assert.equal(result.prompt, 'Existing.\n\nBe polite.')
  assert.equal(result.added, 1)
})

test('buildInjection: 与人设前缀相同的片段被丢弃', () => {
  const result = buildInjection({ personaPrefix: 'Be calm.', fragments: ['Be calm.', 'Be brief.'] })
  assert.equal(result.prompt, 'Be calm.\n\nBe brief.')
  assert.deepEqual(result.dropped, [
    { reason: 'empty', text: '' },
    { reason: 'duplicate', text: 'Be calm.' },
  ])
})

/* ---------- 对比示例文本(1.1.0,规范 7.5) ---------- */


test('buildContrastText: 场景在最前,正例在前、反例紧随', () => {
  const text = buildContrastText([{
    id: 'a',
    name: 'A',
    cases: [{ scene: '事实问题', negative: '过长的回答', positive: '简短的回答' }],
  }])
  assert.equal(text, '场景:事实问题\n正例:简短的回答\n反例:过长的回答')
})

test('buildContrastText: 没有场景时省略该行', () => {
  const text = buildContrastText([{
    id: 'a',
    name: 'A',
    cases: [{ negative: '过长的回答', positive: '简短的回答' }],
  }])
  assert.equal(text, '正例:简短的回答\n反例:过长的回答')
})

test('buildContrastText: 多个条目之间空一行分隔', () => {
  const text = buildContrastText([{
    id: 'a',
    name: 'A',
    cases: [
      { scene: 's1', negative: 'n1', positive: 'p1' },
      { scene: 's2', negative: 'n2', positive: 'p2' },
    ],
  }])
  assert.equal(text, '场景:s1\n正例:p1\n反例:n1\n\n场景:s2\n正例:p2\n反例:n2')
})

test('buildContrastText: 多个示例项依次拼接', () => {
  const text = buildContrastText([
    { id: 'a', name: 'A', cases: [{ negative: 'n1', positive: 'p1' }] },
    { id: 'b', name: 'B', cases: [{ negative: 'n2', positive: 'p2' }] },
  ])
  assert.equal(text, '正例:p1\n反例:n1\n\n正例:p2\n反例:n2')
})

test('buildContrastText: 没有示例时返回空串', () => {
  assert.equal(buildContrastText([]), '')
  assert.equal(buildContrastText([{ id: 'a', name: 'A', cases: [] }]), '')
})
