import { readAssetContents } from '../humanize/assets/loader.js'
import type { AssetContents } from '../humanize/types.js'

/**
 * 过渡快照在插件存储里的旧键名,仅用于一次性迁移。
 *
 * 快照的常规读写已改走 IndexedDB(见 4.6 的已定结论与初版实现);
 * 激活时 IndexedDB 里没有记录时读这个旧键,搬进 IndexedDB 后删除,
 * 之后插件存储不再是快照的常规读写通道。
 */
export const SNAPSHOT_STORAGE_KEY = 'dsc-humanize/snapshot/v1'

/** 快照的格式版本;形状变化时递增,读到其他版本按不支持处理 */
export const SNAPSHOT_VERSION = 1

/** 当前使用快照:当时实际参与装配的内容本身 */
export interface ActiveSnapshot {
  snapshotVersion: number
  contents: AssetContents
}

/** 快照读取失败的原因 */
export type SnapshotErrorCode = 'unsupported-version' | 'invalid-snapshot'

/** 快照读取错误 */
export interface SnapshotError {
  code: SnapshotErrorCode
  message: string
  /** 快照内的字段路径,校验失败时给出 */
  path?: string
}

/** 快照读取结果;不抛错,由调用方决定是否保持空内容 */
export type SnapshotReadResult =
  | { ok: true; snapshot: ActiveSnapshot }
  | { ok: false; error: SnapshotError }

const fail = (code: SnapshotErrorCode, message: string, path?: string): SnapshotReadResult =>
  path === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, path } }

/** 把已装配的内容包成一份快照,写法固定为一个键值,便于整份替换 */
export const createSnapshot = (contents: AssetContents): ActiveSnapshot => ({
  snapshotVersion: SNAPSHOT_VERSION,
  contents,
})

/**
 * 读取一份快照记录(来自 IndexedDB 或迁移前的插件存储)。
 *
 * 记录可能来自旧版本或被外部改写,这里只接受约定的版本与形状:
 * 版本不支持、内容不合法都整份拒绝,调用方据此保持空内容,不做部分保留。
 */
export const readActiveSnapshot = (value: unknown): SnapshotReadResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid-snapshot', '快照必须是对象')
  }

  const record = value as Record<string, unknown>
  if (record.snapshotVersion !== SNAPSHOT_VERSION) {
    return fail('unsupported-version', '快照版本必须是 ' + String(SNAPSHOT_VERSION))
  }

  const read = readAssetContents(record.contents)
  if (!read.ok) return fail('invalid-snapshot', read.error.message, read.error.path)

  return { ok: true, snapshot: { snapshotVersion: SNAPSHOT_VERSION, contents: read.contents } }
}
