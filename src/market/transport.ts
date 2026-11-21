/**
 * 宿主资产读取通道与内核 transport 接口的接合层。
 *
 * 内核约定:URL 资产一律经注入的 AssetTextTransport 读取,内核自己不发请求
 * (见 src/humanize/assets/loader.ts 的装配参数)。宿主侧对应的通道是 assets:read:
 * 只 GET、只 https 与回环 http、不带凭证、上限 512KB、超时 10 秒,结果三态原样返回。
 *
 * 三态到内核失败口径的映射(任务口径,与设计 3.x、6.1 对齐):
 * - content:取件成功,直接透传文本;
 * - status:对方返回了明确的 HTTP 状态码,说明跨域已放行但该地址取不到内容,
 *   按 3.x 口径降级——该地址视为不可用,来源级取件切下一个 base_url,包级取件整包拒绝;
 * - no-status:连状态码都没有,可能是地址无效也可能是对方未放行跨域,
 *   以 transport-failed 结束,文案按 6.3 不把「无法判定」说成地址无效。
 * 通道本身拒绝的调用(地址、协议、体积、超时)同样以 transport-failed 结束,
 * 原因取自宿主错误消息,供日志排查。
 */
import type { AssetCallOptions, AssetTextTransport } from '../humanize/types.js'
import type { PluginAssetTextResult, PluginAssetsApi } from '../types.js'

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 把宿主三态结果收敛成内核 transport 的文本或失败。
 * 抛出的错误由 createAssetLoader 统一包装成 transport-failed,这里只负责给出可排查的原因。
 */
const readThrough = async (
  assets: PluginAssetsApi,
  url: string,
  options?: AssetCallOptions,
): Promise<string> => {
  let result: PluginAssetTextResult
  try {
    result = await assets.readText(url, options)
  } catch (error) {
    throw new Error('资产读取通道拒绝了本次调用: ' + describeError(error))
  }
  if (result.kind === 'content') return result.text
  if (result.kind === 'status') {
    throw new Error('远端返回状态码 ' + String(result.status) + ',该地址不可用: ' + result.url)
  }
  throw new Error('该链接无效或对方未开启跨域访问,无法判定: ' + result.url)
}

/** 判断一个对象是不是宿主的 assets 能力成员:老宿主没有这个成员,或形态不符时都按缺失处理 */
const isAssetsApi = (value: unknown): value is PluginAssetsApi =>
  typeof value === 'object' && value !== null && typeof (value as PluginAssetsApi).readText === 'function'

/**
 * 从激活上下文取 assets 能力成员。
 * 清单申请了 assets:read 且宿主具备该成员时返回它,否则返回 null;
 * 调用方据此保持 transport-missing 的现状,本地资产不受影响。
 */
export const pickHostAssets = (context: unknown): PluginAssetsApi | null => {
  if (typeof context !== 'object' || context === null) return null
  const candidate = (context as { assets?: unknown }).assets
  return isAssetsApi(candidate) ? candidate : null
}

/**
 * 把宿主 assets:read 包装成内核的 transport。
 * 结果不缓存、不改写地址,内核按 URL 逐文件取件;限流(20 次 / 10 秒)由宿主落实,
 * 目录层对同一来源的重复拉取在市场侧自行做内存缓存,不挤占通道预算。
 */
export const createHostAssetTransport = (assets: PluginAssetsApi): AssetTextTransport => ({
  readText: (url, options) => readThrough(assets, url, options),
})
