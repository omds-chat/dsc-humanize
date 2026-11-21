/**
 * 当前使用快照的 IndexedDB 封装。
 *
 * 按 docs/design/kernel-and-assets.md 4.6 的已定结论,快照介质是 IndexedDB。
 * 这里是本仓内不引依赖的最小封装:一个库、一个对象仓库、一条快照记录,读写均为 Promise。
 * 库名、数据库版本与对象仓库的划分标注为初版,可调整,见 4.6。
 *
 * 打不开(环境没有 indexedDB、open 抛错、打开失败或超时)时解析为 null,由调用方降级;
 * 读写本身的失败不在这里吞掉,由调用方决定降级方式。
 */

/** 库名,初版取值 */
export const SNAPSHOT_DB_NAME = 'dsc-humanize'

/** 数据库 schema 版本,记录形状或仓库划分变化时递增;初版为 1 */
export const SNAPSHOT_DB_VERSION = 1

/** 对象仓库名:只存「最后一次使用的组合结果」这一条记录 */
export const SNAPSHOT_STORE_NAME = 'snapshot'

/** 快照记录的固定键,写入即整体替换 */
export const SNAPSHOT_RECORD_KEY = 'active'

/** 快照体积上限:JSON 序列化后的 UTF-8 字节数,本插件自定的保护值,不是介质的配额限制 */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024

/** 打开数据库的超时;宿主给 activate 的预算是 5 秒,这里只留 3 秒 */
export const SNAPSHOT_OPEN_TIMEOUT_MS = 3000

/** 可用的快照仓库;null 表示 IndexedDB 不可用,调用方按降级处理 */
export interface SnapshotStore {
  /** 读快照记录;记录不存在时解析为 undefined */
  read(): Promise<unknown>
  /** 整份写入快照记录;超过体积上限时拒绝,不写入 */
  write(value: unknown): Promise<void>
  /** 关闭连接,停用时调用 */
  close(): void
}

/** 计算快照 JSON 序列化后的 UTF-8 字节数,用于体积上限判断 */
export const measureSnapshotBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length

/** 快照是否超过体积上限 */
export const snapshotExceedsLimit = (value: unknown, limit: number = SNAPSHOT_MAX_BYTES): boolean =>
  measureSnapshotBytes(value) > limit

/** 在一个事务里执行单条请求,事务完成时给出结果,中止或出错时拒绝 */
const runTransaction = <T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = db.transaction(SNAPSHOT_STORE_NAME, mode)
    } catch (error) {
      reject(error)
      return
    }
    const request = action(transaction.objectStore(SNAPSHOT_STORE_NAME))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(request.error ?? transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务中止'))
  })

/**
 * 打开快照仓库。
 *
 * 环境没有 indexedDB、open 抛错、打开失败或超过超时,都解析为 null,
 * 让「IndexedDB 不可用」与「快照读不到」走同一条降级路径;
 * 正常打开后返回读写为 Promise 的仓库,写入时先做体积上限检查。
 */
export const openSnapshotStore = (
  factory?: IDBFactory | null,
  timeoutMs: number = SNAPSHOT_OPEN_TIMEOUT_MS,
): Promise<SnapshotStore | null> => {
  const indexedDB: IDBFactory | undefined = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (indexedDB === undefined) return Promise.resolve(null)

  return new Promise<SnapshotStore | null>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (value: SnapshotStore | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }

    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(SNAPSHOT_DB_NAME, SNAPSHOT_DB_VERSION)
    } catch {
      settle(null)
      return
    }

    timer = setTimeout(() => settle(null), timeoutMs)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(SNAPSHOT_STORE_NAME)
      }
    }
    request.onerror = () => settle(null)
    request.onblocked = () => {
      // 等待既有连接关闭,由超时兜底
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      settle({
        read: () => runTransaction(db, 'readonly', (store) => store.get(SNAPSHOT_RECORD_KEY)),
        write: (value) => {
          if (snapshotExceedsLimit(value)) {
            return Promise.reject(new Error('快照超过 ' + String(SNAPSHOT_MAX_BYTES) + ' 字节上限,拒绝写入'))
          }
          return runTransaction(db, 'readwrite', (store) => store.put(value, SNAPSHOT_RECORD_KEY)).then(
            () => undefined,
          )
        },
        close: () => db.close(),
      })
    }
  })
}
