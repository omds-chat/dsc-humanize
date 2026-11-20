import type {
  DroppedFragment,
  InjectionInput,
  InjectionPosition,
  InjectionResult,
} from '../types.js'

/** 片段比较用的规范化文本:合并连续空白并去掉首尾空白 */
const normalizeFragment = (text: string): string => text.replace(/\s+/g, ' ').trim()

const joinNonEmpty = (parts: readonly string[], separator: string): string =>
  parts.filter((part) => part !== '').join(separator)

/**
 * 把注入文本与人设前缀拼成最终提示词片段。纯函数,无副作用。
 *
 * 规则:
 * 1. 片段按「人设前缀、注入文本」的顺序处理,首尾空白去掉,空串丢弃;
 * 2. 内容相同的片段只保留第一次出现的;
 * 3. 已经出现在已有提示词里的片段不再重复加入;
 * 4. prepend 放在已有提示词之前,append 放在之后,分隔符可配置。
 */
export const buildInjection = (input: InjectionInput): InjectionResult => {
  const separator = input.separator ?? '\n\n'
  const position: InjectionPosition = input.position ?? 'append'
  const existing = (input.existingPrompt ?? '').trim()
  const existingKey = normalizeFragment(existing)
  const candidates: readonly string[] = [input.personaPrefix ?? '', input.injection ?? '']

  const kept: string[] = []
  const dropped: DroppedFragment[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const text = candidate.trim()
    const key = normalizeFragment(text)

    if (key === '') {
      dropped.push({ reason: 'empty', text })
      continue
    }

    if (seen.has(key)) {
      dropped.push({ reason: 'duplicate', text })
      continue
    }
    seen.add(key)

    if (existingKey !== '' && existingKey.includes(key)) {
      dropped.push({ reason: 'already-present', text })
      continue
    }

    kept.push(text)
  }

  const fragment = kept.join(separator)
  const prompt = position === 'prepend'
    ? joinNonEmpty([fragment, existing], separator)
    : joinNonEmpty([existing, fragment], separator)

  return { prompt, added: kept.length, dropped }
}
