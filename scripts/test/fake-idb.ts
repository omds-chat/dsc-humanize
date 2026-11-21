/**
 * 测试用的假 IndexedDB:只实现快照封装用到的最小事件面。
 * 事件用 queueMicrotask 异步派发,与真实 IndexedDB 的异步回调一致。
 */

export interface FakeIdbOptions {
  /** open 调用时同步抛错 */
  throwOnOpen?: boolean
  /** 打开失败(onerror) */
  failOpen?: boolean
  /** 打开后永不回调,用于验证超时降级 */
  hangOpen?: boolean
  /** 读请求失败 */
  failRead?: boolean
  /** 写请求失败 */
  failWrite?: boolean
  /** 打开时触发 onupgradeneeded,模拟首次建库 */
  needsUpgrade?: boolean
}

export interface FakeIdb {
  factory: IDBFactory
  /** 仓库数据,可直接预置快照记录(键 active)或在断言里检查写入结果 */
  data: Map<string, unknown>
}

interface FakeRequest {
  result: unknown
  error: Error | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

export const createFakeIdb = (options: FakeIdbOptions = {}): FakeIdb => {
  const data = new Map<string, unknown>()

  const db = {
    objectStoreNames: {
      contains: (name: string): boolean => name === 'snapshot' && !options.needsUpgrade,
    },
    createObjectStore: (): void => {
      // 假仓库始终由同一份 data 承载,建仓库不需要做别的事
    },
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null as Error | null,
        objectStore: () => ({
          get: (key: string) =>
            makeRequest(transaction, () => {
              if (options.failRead) throw new Error('read failed')
              return data.get(key)
            }),
          put: (value: unknown, key: string) =>
            makeRequest(transaction, () => {
              if (options.failWrite) throw new Error('write failed')
              data.set(key, value)
              return undefined
            }),
        }),
      }
      return transaction
    },
    close: (): void => undefined,
    onversionchange: null as (() => void) | null,
  }

  const makeRequest = (transaction: { oncomplete: (() => void) | null; onabort: (() => void) | null }, compute: () => unknown): FakeRequest => {
    const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    queueMicrotask(() => {
      try {
        request.result = compute()
        request.onsuccess?.()
        transaction.oncomplete?.()
      } catch (error) {
        request.error = error as Error
        transaction.error = error as Error
        request.onerror?.()
        transaction.onabort?.()
      }
    })
    return request
  }

  const factory = {
    open: (): FakeOpenRequestShape => {
      if (options.throwOnOpen) throw new Error('open rejected')
      const request = {
        result: null as unknown,
        error: null as Error | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      }
      if (options.hangOpen) return request
      queueMicrotask(() => {
        if (options.failOpen) {
          request.error = new Error('open failed')
          request.onerror?.()
          return
        }
        request.result = db
        if (options.needsUpgrade) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }

  return { factory: factory as unknown as IDBFactory, data }
}

interface FakeOpenRequestShape {
  result: unknown
  error: Error | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded: (() => void) | null
  onblocked: (() => void) | null
}
