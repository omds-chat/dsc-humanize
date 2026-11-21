import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SNAPSHOT_MAX_BYTES,
  measureSnapshotBytes,
  openSnapshotStore,
  snapshotExceedsLimit,
} from '../../src/host/snapshot-db.ts'
import { createFakeIdb } from './fake-idb.ts'

test('measureSnapshotBytes 与 snapshotExceedsLimit 按序列化后的字节数判断', () => {
  const small = { snapshotVersion: 1, contents: {} }
  assert.equal(measureSnapshotBytes(small), JSON.stringify(small).length)
  assert.equal(snapshotExceedsLimit(small), false)
  // JSON 序列化后含引号:两个引号 2 字节加两个中文 6 字节,按字节而不是按字符计数
  assert.equal(measureSnapshotBytes('中文'), 8)
  // JSON 序列化后含引号:'x'.repeat(10) 占 12 字节(10 个 x 加两个引号)
  assert.equal(snapshotExceedsLimit('x'.repeat(10), 12), false)
  assert.equal(snapshotExceedsLimit('x'.repeat(10), 11), true)
})

test('openSnapshotStore: 环境没有 indexedDB 时解析为 null', async () => {
  assert.equal(await openSnapshotStore(null), null)
})

test('openSnapshotStore: open 抛错时解析为 null', async () => {
  const fake = createFakeIdb({ throwOnOpen: true })
  assert.equal(await openSnapshotStore(fake.factory), null)
})

test('openSnapshotStore: 打开失败时解析为 null', async () => {
  const fake = createFakeIdb({ failOpen: true })
  assert.equal(await openSnapshotStore(fake.factory), null)
})

test('openSnapshotStore: 打开超时按不可用降级', async () => {
  const fake = createFakeIdb({ hangOpen: true })
  const started = Date.now()
  assert.equal(await openSnapshotStore(fake.factory, 30), null)
  // 超时由传入的时限兜底,而不是无限等待
  assert.ok(Date.now() - started < 5000)
})

test('openSnapshotStore: 首次建库时创建对象仓库后可读写', async () => {
  const fake = createFakeIdb({ needsUpgrade: true })
  const store = await openSnapshotStore(fake.factory)
  assert.ok(store !== null)

  await store.write({ snapshotVersion: 1, contents: {} })
  assert.deepEqual(fake.data.get('active'), { snapshotVersion: 1, contents: {} })
  assert.deepEqual(await store.read(), { snapshotVersion: 1, contents: {} })

  store.close()
})

test('openSnapshotStore: 没有记录时 read 解析为 undefined', async () => {
  const fake = createFakeIdb()
  const store = await openSnapshotStore(fake.factory)
  assert.ok(store !== null)
  assert.equal(await store.read(), undefined)
})

test('openSnapshotStore: 写入失败时 write 拒绝,仓库数据不变', async () => {
  const fake = createFakeIdb({ failWrite: true })
  const store = await openSnapshotStore(fake.factory)
  assert.ok(store !== null)

  await assert.rejects(store.write({ snapshotVersion: 1, contents: {} }), /write failed/)
  assert.equal(fake.data.size, 0)
})

test('openSnapshotStore: 读取失败时 read 拒绝', async () => {
  const fake = createFakeIdb({ failRead: true })
  const store = await openSnapshotStore(fake.factory)
  assert.ok(store !== null)

  await assert.rejects(store.read(), /read failed/)
})

test('openSnapshotStore: 超过体积上限时拒绝写入,不触及仓库', async () => {
  const fake = createFakeIdb()
  const store = await openSnapshotStore(fake.factory)
  assert.ok(store !== null)

  const oversized = { snapshotVersion: 1, contents: { persona: 'x'.repeat(SNAPSHOT_MAX_BYTES + 1) } }
  await assert.rejects(store.write(oversized), /字节上限/)
  assert.equal(fake.data.size, 0)
})
