/**
 * 语言判定分量(资产包格式规范 3.3)。
 *
 * 一次分类的输出是 (lang, shape) 二元组:shape 来自标签命中,lang 由这里判定。
 * 这里只立一个简单启发,不追求精度:语言维的注入按此口径与输入对齐(见策略引擎)。
 */

/** 语言分量的取值:zh 表示输入以中文为主,en 表示以英文为主 */
export type LanguageTag = 'zh' | 'en'

/** CJK 统一表意字符,含扩展 A 区 */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF]/g
/** 拉丁字母 */
const LATIN_PATTERN = /[A-Za-z]/g

/**
 * 判定一段文本的语言分量。
 *
 * 口径:统计 CJK 字符与拉丁字母的数量,CJK 占比不低于 0.3 判为中文;
 * 两类字符都没有时缺省判中文(本插件面向中文场景,缺省按中文口径对待)。
 * 判定只用于对齐语言维注入,不改变形状侧的命中与计分。
 */
export const detectLanguage = (text: string): LanguageTag => {
  const cjk = (text.match(CJK_PATTERN) ?? []).length
  const latin = (text.match(LATIN_PATTERN) ?? []).length
  if (cjk + latin === 0) return 'zh'
  return cjk / (cjk + latin) >= 0.3 ? 'zh' : 'en'
}
