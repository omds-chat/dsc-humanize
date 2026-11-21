/**
 * 证书链校验与导入两轴结论的测试。
 *
 * 链校验用例直接用仓库 certs/ 里的公开证书做真实校验:
 * 根 + 两张合集 EEC 是正例;反例不生成任何证书,只用既有材料构造——
 * 把 EEC 当根用(签发者不匹配)、把校验时刻推到有效期之外(未生效与过期)、
 * 翻转 tbsCertificate 与签名值里的字节(签名不匹配)、给出非法 PEM。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

/** 仓库根目录:测试文件在 scripts/test/ 下 */
const REPO_HREF = new URL('../../', import.meta.url).href

const CERT_PATHS = {
  root: 'certs/dsc-humanize/dsc-humanize-root-ca.crt',
  inner: 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt',
  awesome: 'certs/awesome-dsc-humanize-asset/awesome-dsc-humanize-asset-eec.crt',
}

// 源码直接运行时没有构建注入的锚,EMBEDDED_ROOT_CA_PEM 为空串。
// 两轴结论的用例要走到真实的链校验,这里先模拟构建的行为:把仓库根证书 PEM
// 写进 __ROOT_CA_PEM__ 全局,再动态加载依赖 root-ca 的模块,让测试与产物同锚。
const rootPem = await readFile(new URL(CERT_PATHS.root, REPO_HREF), 'utf8')
;(globalThis as { __ROOT_CA_PEM__?: string }).__ROOT_CA_PEM__ = rootPem

const { importAssetPackage } = await import('../../src/index.ts')
const { verifySourceTrust } = await import('../../src/trust/source-verdict.ts')
const {
  parseCertificatePem,
  verifyCertificateChain,
  verifyCertificateChainParsed,
} = await import('../../src/trust/x509.ts')

/** 证书内容按需读一次,缓存给全部用例复用 */
let cachedPems: { root: string; inner: string; awesome: string } | null = null

const readCertPems = async (): Promise<{ root: string; inner: string; awesome: string }> => {
  if (cachedPems !== null) return cachedPems
  cachedPems = {
    root: await readFile(new URL(CERT_PATHS.root, REPO_HREF), 'utf8'),
    inner: await readFile(new URL(CERT_PATHS.inner, REPO_HREF), 'utf8'),
    awesome: await readFile(new URL(CERT_PATHS.awesome, REPO_HREF), 'utf8'),
  }
  return cachedPems
}

/** 把来源证书主题 CN 与包标识对齐的加载期资产包文档,内容只带一类人物设定 */
const packageDocument = (id: string): Record<string, unknown> => ({
  metadata: {
    formatVersion: '1.0.0',
    id,
    name: '链校验测试包',
    version: '0.1.0',
    types: ['persona'],
  },
  contents: {
    persona: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
  },
})

test('chain: 内置与社区两张 EEC 都能用内嵌根校验通过', async () => {
  const pems = await readCertPems()

  const inner = await verifyCertificateChain(pems.root, pems.inner)
  assert.deepEqual(inner, { ok: true })

  const awesome = await verifyCertificateChain(pems.root, pems.awesome)
  assert.deepEqual(awesome, { ok: true })
})

test('chain: 解析结果带校验消费的字段', async () => {
  const pems = await readCertPems()
  const root = parseCertificatePem(pems.root)
  const inner = parseCertificatePem(pems.inner)
  assert.ok(root !== null)
  assert.ok(inner !== null)

  assert.equal(root.subjectCn, 'dsc-humanize ROOT CA')
  assert.equal(inner.subjectCn, 'dsc-humanize-inner-asset')
  assert.equal(root.basicConstraintsCa, true)
  assert.equal(inner.basicConstraintsCa, false)
  assert.equal(root.keyUsageDigitalSignature, false)
  assert.equal(inner.keyUsageDigitalSignature, true)
  assert.equal(root.signatureAlgorithmOid, '1.2.840.10045.4.3.2')
  assert.equal(inner.spkiCurveOid, '1.2.840.10045.3.1.7')
})

test('chain: 用 EEC 当根时签发者与主体不一致', async () => {
  const pems = await readCertPems()
  const verdict = await verifyCertificateChain(pems.inner, pems.awesome)
  assert.deepEqual(verdict, { ok: false, reason: '来源证书的签发者与根证书主体不一致' })
})

test('chain: 校验时刻早于有效期时判未生效', async () => {
  const pems = await readCertPems()
  // 根证书 2026-11-20 14:24 起生效,时刻取生效前
  const verdict = await verifyCertificateChain(pems.root, pems.inner, new Date('2026-11-19T00:00:00Z'))
  assert.deepEqual(verdict, { ok: false, reason: '根证书不在有效期内' })
})

test('chain: 校验时刻落在根有效期外时判过期', async () => {
  const pems = await readCertPems()
  // 根证书 2036-11-17 到期,时刻取其后
  const verdict = await verifyCertificateChain(pems.root, pems.inner, new Date('2037-02-01T00:00:00Z'))
  assert.deepEqual(verdict, { ok: false, reason: '根证书不在有效期内' })
})

test('chain: 根已生效但 EEC 尚未生效时判来源证书不在有效期内', async () => {
  const pems = await readCertPems()
  // 根 14:24 生效,内置 EEC 14:29 生效,时刻取两者之间
  const verdict = await verifyCertificateChain(pems.root, pems.inner, new Date('2026-11-20T14:27:00Z'))
  assert.deepEqual(verdict, { ok: false, reason: '来源证书不在有效期内' })
})

test('chain: 篡改 tbsCertificate 后签名验证失败', async () => {
  const pems = await readCertPems()
  const root = parseCertificatePem(pems.root)
  const inner = parseCertificatePem(pems.inner)
  assert.ok(root !== null)
  assert.ok(inner !== null)

  const tamperedTbs = inner.tbsBytes.slice()
  const at = Math.floor(tamperedTbs.length / 2)
  tamperedTbs[at] = tamperedTbs[at]! ^ 0x01
  const verdict = await verifyCertificateChainParsed(root, { ...inner, tbsBytes: tamperedTbs })
  assert.deepEqual(verdict, { ok: false, reason: '来源证书的签名无法用根证书公钥验证' })
})

test('chain: 篡改签名值后签名验证失败', async () => {
  const pems = await readCertPems()
  const root = parseCertificatePem(pems.root)
  const inner = parseCertificatePem(pems.inner)
  assert.ok(root !== null)
  assert.ok(inner !== null)

  const tamperedSignature = inner.signatureBytes.slice()
  const at = tamperedSignature.length - 1
  tamperedSignature[at] = tamperedSignature[at]! ^ 0x01
  const verdict = await verifyCertificateChainParsed(root, { ...inner, signatureBytes: tamperedSignature })
  assert.deepEqual(verdict, { ok: false, reason: '来源证书的签名无法用根证书公钥验证' })
})

test('chain: 非法 PEM 与截断 PEM 都解析不出证书', async () => {
  const garbage = '-----BEGIN CERTIFICATE-----\n%%%不是base64%%%\n-----END CERTIFICATE-----'
  assert.equal(parseCertificatePem(garbage), null)
  assert.equal(parseCertificatePem('-----BEGIN CERTIFICATE-----\nAAAA'), null)
  assert.equal(parseCertificatePem('not a pem at all'), null)

  const pems = await readCertPems()
  const verdict = await verifyCertificateChain(pems.root, garbage)
  assert.deepEqual(verdict, { ok: false, reason: '来源证书不是合法的 PEM 证书' })
})

test('trust: 不带来源证书时按本地导入处理', async () => {
  const verdict = await verifySourceTrust('dsc-example-asset')
  assert.deepEqual(verdict, { signature: 'unverified', source: 'local' })

  const blank = await verifySourceTrust('dsc-example-asset', { sourceCertPem: '   ' })
  assert.deepEqual(blank, { signature: 'unverified', source: 'local' })
})

test('trust: 证书与包标识一致时来源结论为已确认', async () => {
  const pems = await readCertPems()
  const verdict = await verifySourceTrust('dsc-humanize-inner-asset', { sourceCertPem: pems.inner })
  assert.deepEqual(verdict, { signature: 'unverified', source: 'confirmed' })
})

test('trust: 证书与包标识不一致时来源结论降级为未通过', async () => {
  const pems = await readCertPems()
  const verdict = await verifySourceTrust('dsc-humanize-inner-asset', { sourceCertPem: pems.awesome })
  assert.equal(verdict.signature, 'unverified')
  assert.equal(verdict.source, 'rejected')
  assert.ok((verdict.sourceReason ?? '').includes('来源证书主题与包标识不一致'))
  assert.ok((verdict.sourceReason ?? '').includes('awesome-dsc-humanize-asset'))
})

test('trust: 链不通过时来源结论未通过,原因可排查', async () => {
  const pems = await readCertPems()
  const expired = await verifySourceTrust('dsc-humanize-inner-asset', {
    sourceCertPem: pems.inner,
    now: new Date('2037-02-01T00:00:00Z'),
  })
  assert.equal(expired.source, 'rejected')
  assert.equal(expired.sourceReason, '根证书不在有效期内')

  const broken = await verifySourceTrust('dsc-humanize-inner-asset', { sourceCertPem: '%%%' })
  assert.equal(broken.source, 'rejected')
  assert.equal(broken.sourceReason, '来源证书不是合法的 PEM 证书')
})

test('import: 带匹配来源证书导入时来源结论已确认,导入照常完成', async () => {
  const pems = await readCertPems()
  // 未激活,只装配到内存;persisted 为 false 不影响信任结论
  const result = await importAssetPackage(JSON.stringify(packageDocument('dsc-humanize-inner-asset')), {
    sourceCertPem: pems.inner,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trust.signature, 'unverified')
  assert.equal(result.trust.source, 'confirmed')
  assert.equal(result.asset.source.id, 'dsc-humanize-inner-asset')
  assert.equal(result.persisted, false)
})

test('import: 来源结论未通过时不阻断导入', async () => {
  const pems = await readCertPems()
  // 证书与包标识不一致,也照常装配并给出结论
  const mismatched = await importAssetPackage(JSON.stringify(packageDocument('dsc-humanize-inner-asset')), {
    sourceCertPem: pems.awesome,
  })
  assert.equal(mismatched.ok, true)
  if (!mismatched.ok) return
  assert.equal(mismatched.trust.source, 'rejected')
  assert.ok((mismatched.trust.sourceReason ?? '').includes('不一致'))

  // 链不过(证书解析失败)同样不阻断
  const broken = await importAssetPackage(JSON.stringify(packageDocument('dsc-humanize-inner-asset')), {
    sourceCertPem: '%%%',
  })
  assert.equal(broken.ok, true)
  if (!broken.ok) return
  assert.equal(broken.trust.source, 'rejected')
  assert.equal(broken.trust.sourceReason, '来源证书不是合法的 PEM 证书')
})

test('import: 不带来源证书时来源结论为本地', async () => {
  const result = await importAssetPackage(JSON.stringify(packageDocument('dsc-example-asset')))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.trust, { signature: 'unverified', source: 'local' })
})
