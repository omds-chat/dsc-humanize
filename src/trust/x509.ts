/**
 * 零依赖的 X.509 证书链校验:只做「根 → 来源证书(EEC)」两级链。
 *
 * 设计 2.10 定的信任锚是构建内嵌的资产根证书;本文件回答的是「验签怎么做」:
 * 用自己的 DER 解析读出证书结构与待签内容,再用运行时的 WebCrypto(subtle)验签名,
 * 不引入任何第三方库。检查项与主线 DeepSeek-Chat-Enhanced 的
 * src/services/integrity/x509.ts 一致,那边用 pkijs 解析,这里受「不引第三方库」
 * 的约束自行解析 DER,只覆盖证书链校验用到的结构。
 *
 * 锚即信任:根证书是信任锚,不验证它的自签名;链校验只回答「这份来源证书
 * 是不是这把根签出来的」。失败一律以结果对象返回,不抛错。
 */

/** 证书链校验结论;reason 只用于排查,不直接展示给用户 */
export type ChainVerdict = { ok: true } | { ok: false; reason: string }

/** 解析后的证书里链校验消费的部分;字节字段都独占 ArrayBuffer,可直接交给 WebCrypto */
export type ParsedCertificate = {
  /** tbsCertificate 的完整 DER 字节,是签名的被签对象 */
  tbsBytes: Uint8Array<ArrayBuffer>
  /** signatureValue 的内容字节(不含 BIT STRING 的未用位数) */
  signatureBytes: Uint8Array<ArrayBuffer>
  /** 证书签名算法的对象标识符,如 1.2.840.10045.4.3.2(ecdsa-with-SHA256) */
  signatureAlgorithmOid: string
  /** 签发者与主体的 DER 原始字节;同一签发者两次编码一致,按字节比对即可 */
  issuerBytes: Uint8Array<ArrayBuffer>
  subjectBytes: Uint8Array<ArrayBuffer>
  /** 主体可辨识名里的 CN 值;解析不出时为 null */
  subjectCn: string | null
  notBefore: Date
  notAfter: Date
  /** basicConstraints 的 CA 标志;未声明该扩展时为 null */
  basicConstraintsCa: boolean | null
  /** keyUsage 的 digitalSignature 位(bit 0)是否为 1;未声明该扩展时为 false */
  keyUsageDigitalSignature: boolean
  /** subjectPublicKeyInfo 的 DER 字节,作为 WebCrypto 的导入材料 */
  spkiBytes: Uint8Array<ArrayBuffer>
  /** 公钥算法的对象标识符 */
  spkiAlgorithmOid: string
  /** EC 公钥的命名曲线对象标识符;非 EC 公钥时为 null */
  spkiCurveOid: string | null
}

/** 一个 DER TLV 节点:tag 字节与内容字节区间;构造类型的子节点已解析 */
type DerNode = {
  tag: number
  /** 整个 TLV 的起始下标(即 tag 字节的位置) */
  tlvStart: number
  contentStart: number
  contentEnd: number
  children: DerNode[] | null
}

/** PEM 证书的头尾标记 */
const PEM_BEGIN = '-----BEGIN CERTIFICATE-----'
const PEM_END = '-----END CERTIFICATE-----'

/** basicConstraints 的对象标识符 */
const BASIC_CONSTRAINTS_OID = '2.5.29.19'
/** keyUsage 的对象标识符 */
const KEY_USAGE_OID = '2.5.29.15'
/** commonName 的对象标识符 */
const COMMON_NAME_OID = '2.5.4.3'

/** 证书签名算法到 WebCrypto 算法名的映射 */
const SIGNATURE_ALGORITHMS: Readonly<Record<string, { name: 'ECDSA' | 'RSASSA-PKCS1-v1_5'; hash: 'SHA-256' | 'SHA-384' | 'SHA-512' }>> = {
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' },
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
}

/** EC 命名曲线的对象标识符到 WebCrypto 曲线名与其签名整数字节长度的映射 */
const EC_CURVES: Readonly<Record<string, { curve: 'P-256' | 'P-384' | 'P-521'; size: number }>> = {
  '1.2.840.10045.3.1.7': { curve: 'P-256', size: 32 },
  '1.3.132.0.34': { curve: 'P-384', size: 48 },
  '1.3.132.0.35': { curve: 'P-521', size: 66 },
}

/** EC 公钥算法的对象标识符 */
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1'

const utf8Decoder = new TextDecoder('utf-8')

/**
 * 解析一段 DER 的单个 TLV;构造类型递归解析子节点。
 * 结构不符时抛错,由调用方决定如何处理。
 */
const parseDerNode = (bytes: Uint8Array, start: number, end: number): DerNode => {
  if (start + 2 > end) throw new Error('DER 过短')
  const tag = bytes[start]!
  let cursor = start + 1
  let length = bytes[cursor]!
  cursor += 1
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f
    if (count === 0 || count > 4 || cursor + count > end) throw new Error('DER 长度不合法')
    length = 0
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[cursor]!
      cursor += 1
    }
  }
  const contentStart = cursor
  const contentEnd = contentStart + length
  if (contentEnd > end) throw new Error('DER 内容越界')

  if ((tag & 0x20) === 0) {
    return { tag, tlvStart: start, contentStart, contentEnd, children: null }
  }

  const children: DerNode[] = []
  let inner = contentStart
  while (inner < contentEnd) {
    const child = parseDerNode(bytes, inner, contentEnd)
    children.push(child)
    inner = child.contentEnd
  }
  return { tag, tlvStart: start, contentStart, contentEnd, children }
}

const childAt = (node: DerNode, index: number): DerNode => {
  const child = node.children?.[index]
  if (child === undefined) throw new Error('DER 子节点缺失')
  return child
}

/** 对象标识符解码成点分十进制文本 */
const decodeOid = (node: DerNode, bytes: Uint8Array): string => {
  if (node.contentEnd - node.contentStart < 1) throw new Error('OID 为空')
  // 首个子标识符按 40*第一弧 + 第二弧编码;2.x 弧的第二弧可超过 39,首字节可到 80 以上
  const first = bytes[node.contentStart]!
  const parts: number[] =
    first < 40 ? [0, first]
    : first < 80 ? [1, first - 40]
    : [2, first - 80]
  let value = 0
  for (let index = node.contentStart + 1; index < node.contentEnd; index += 1) {
    const byte = bytes[index]!
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

/** 按可读字符串标签解码文本:UTF8String、PrintableString 与 IA5String 都按 UTF-8 读 */
const decodeText = (node: DerNode, bytes: Uint8Array): string =>
  utf8Decoder.decode(bytes.subarray(node.contentStart, node.contentEnd))

/**
 * 解析 UTCTime(YYMMDDHHMMSSZ)与 GeneralizedTime(YYYYMMDDHHMMSSZ)。
 * 证书里的时间都是 UTC,带小数秒或时区偏移的取值不支持。
 */
const parseAsn1Time = (node: DerNode, bytes: Uint8Array): Date => {
  const text = decodeText(node, bytes)
  const utcTime = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
  const generalTime = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
  const matched = utcTime ?? generalTime
  if (matched === null) throw new Error('时间格式不支持: ' + text)
  const year = utcTime !== null
    ? (Number(matched[1]) >= 50 ? 1900 : 2000) + Number(matched[1])
    : Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = Number(matched[6])
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (Number.isNaN(date.getTime())) throw new Error('时间取值不合法: ' + text)
  return date
}

/** 可辨识名(issuer/subject)里的 CN 值;一个都没有时返回 null */
const findCommonName = (name: DerNode, bytes: Uint8Array): string | null => {
  for (const set of name.children ?? []) {
    for (const rdn of set.children ?? []) {
      const fields = rdn.children ?? []
      const oidNode = fields[0]
      const valueNode = fields[1]
      if (oidNode === undefined || valueNode === undefined) continue
      if (decodeOid(oidNode, bytes) !== COMMON_NAME_OID) continue
      return decodeText(valueNode, bytes)
    }
  }
  return null
}

/** 从扩展值里读 basicConstraints 的 CA 标志;结构不符时返回 null */
const readBasicConstraintsCa = (octet: DerNode, bytes: Uint8Array): boolean | null => {
  try {
    const sequence = parseDerNode(bytes, octet.contentStart, octet.contentEnd)
    if (sequence.tag !== 0x30) return null
    const first = sequence.children?.[0]
    if (first === undefined) return false
    if (first.tag !== 0x01) return null
    return bytes[first.contentStart] !== 0
  } catch {
    return null
  }
}

/** 从扩展值里读 keyUsage 的 digitalSignature 位;BIT STRING 首个内容字节的最高位是 bit 0 */
const readKeyUsageDigitalSignature = (octet: DerNode, bytes: Uint8Array): boolean => {
  try {
    const bitString = parseDerNode(bytes, octet.contentStart, octet.contentEnd)
    if (bitString.tag !== 0x03) return false
    const unusedBits = bytes[bitString.contentStart] ?? 8
    const dataStart = bitString.contentStart + 1
    if (unusedBits >= 8 || dataStart >= bitString.contentEnd) return false
    return (bytes[dataStart]! & 0x80) !== 0
  } catch {
    return false
  }
}

/** 证书是三级序列:SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue } */
const parseCertificateBytes = (der: Uint8Array<ArrayBuffer>): ParsedCertificate | null => {
  try {
    const certificate = parseDerNode(der, 0, der.length)
    if (certificate.tag !== 0x30) return null
    const top = certificate.children ?? []
    if (top.length !== 3) return null
    const tbs = top[0]!
    const signatureAlgorithm = top[1]!
    const signatureValue = top[2]!
    if (tbs.tag !== 0x30 || signatureAlgorithm.tag !== 0x30 || signatureValue.tag !== 0x03) {
      return null
    }
    if (signatureValue.contentEnd - signatureValue.contentStart < 1) return null

    // TBSCertificate 的字段:可选的 [0] 版本之后依次是序列号、签名算法、
    // 签发者、有效期、主体、公钥,可选的 [3] 扩展在最后
    const tbsChildren = tbs.children ?? []
    let index = 0
    if (tbsChildren[0]?.tag === 0xa0) index = 1
    const serialNumber = tbsChildren[index]
    const tbsSignature = tbsChildren[index + 1]
    const issuer = tbsChildren[index + 2]
    const validity = tbsChildren[index + 3]
    const subject = tbsChildren[index + 4]
    const spki = tbsChildren[index + 5]
    const extensions = tbsChildren[index + 6]
    if (
      serialNumber === undefined || serialNumber.tag !== 0x02 ||
      tbsSignature === undefined || tbsSignature.tag !== 0x30 ||
      issuer === undefined || issuer.tag !== 0x30 ||
      validity === undefined || validity.tag !== 0x30 ||
      subject === undefined || subject.tag !== 0x30 ||
      spki === undefined || spki.tag !== 0x30
    ) {
      return null
    }
    const validityTimes = validity.children ?? []
    const notBeforeNode = validityTimes[0]
    const notAfterNode = validityTimes[1]
    if (notBeforeNode === undefined || notAfterNode === undefined) return null

    let basicConstraintsCa: boolean | null = null
    let keyUsageDigitalSignature = false
    if (extensions !== undefined && extensions.tag === 0xa3) {
      // [3] EXPLICIT 里是一层 SEQUENCE,再往下逐条 Extension
      try {
        const extensionList = childAt(extensions, 0)
        for (const extension of extensionList.children ?? []) {
          const fields = extension.children ?? []
          const oidNode = fields[0]
          if (oidNode === undefined) continue
          let cursor = 1
          if (fields[cursor]?.tag === 0x01) cursor += 1
          const valueNode = fields[cursor]
          if (valueNode === undefined || valueNode.tag !== 0x04) continue
          const oid = decodeOid(oidNode, der)
          if (oid === BASIC_CONSTRAINTS_OID && basicConstraintsCa === null) {
            basicConstraintsCa = readBasicConstraintsCa(valueNode, der)
          }
          if (oid === KEY_USAGE_OID) {
            keyUsageDigitalSignature = readKeyUsageDigitalSignature(valueNode, der)
          }
        }
      } catch {
        // 扩展解析失败不掩盖前面已读到的结果
      }
    }

    const spkiChildren = spki.children ?? []
    const spkiAlgorithm = spkiChildren[0]
    const spkiKey = spkiChildren[1]
    if (spkiAlgorithm === undefined || spkiAlgorithm.tag !== 0x30 || spkiKey === undefined || spkiKey.tag !== 0x03) {
      return null
    }
    const algorithmFields = spkiAlgorithm.children ?? []
    const algorithmOidNode = algorithmFields[0]
    const curveNode = algorithmFields[1]
    if (algorithmOidNode === undefined) return null
    const spkiAlgorithmOid = decodeOid(algorithmOidNode, der)

    return {
      // 被签对象是 tbsCertificate 的完整 DER 编码,含它自己的 TLV 头
      tbsBytes: der.slice(tbs.tlvStart, tbs.contentEnd),
      signatureBytes: der.slice(signatureValue.contentStart + 1, signatureValue.contentEnd),
      // AlgorithmIdentifier 的第一个子节点才是算法 OID
      signatureAlgorithmOid: decodeOid(childAt(signatureAlgorithm, 0), der),
      issuerBytes: der.slice(issuer.contentStart, issuer.contentEnd),
      subjectBytes: der.slice(subject.contentStart, subject.contentEnd),
      subjectCn: findCommonName(subject, der),
      notBefore: parseAsn1Time(notBeforeNode, der),
      notAfter: parseAsn1Time(notAfterNode, der),
      basicConstraintsCa,
      keyUsageDigitalSignature,
      // SPKI 的 DER 编码同样要含外层 SEQUENCE 头,WebCrypto 的 spki 导入按整段解析
      spkiBytes: der.slice(spki.tlvStart, spki.contentEnd),
      spkiAlgorithmOid,
      spkiCurveOid:
        spkiAlgorithmOid === EC_PUBLIC_KEY_OID && curveNode !== undefined && curveNode.tag === 0x06
          ? decodeOid(curveNode, der)
          : null,
    }
  } catch {
    return null
  }
}

/** PEM 里的证书体:去掉头尾标记与全部空白后的 base64 文本;缺头尾时返回 null */
const extractPemBody = (pem: string): string | null => {
  const begin = pem.indexOf(PEM_BEGIN)
  const end = pem.indexOf(PEM_END)
  if (begin < 0 || end < 0 || end <= begin) return null
  const body = pem.slice(begin + PEM_BEGIN.length, end).replace(/\s+/g, '')
  return body === '' ? null : body
}

const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 解析 PEM 证书;头尾缺失、base64 不合法或 DER 结构不符时返回 null。
 */
export const parseCertificatePem = (pem: string): ParsedCertificate | null => {
  const body = extractPemBody(pem)
  if (body === null) return null
  let der: Uint8Array<ArrayBuffer>
  try {
    der = base64ToBytes(body)
  } catch {
    return null
  }
  return parseCertificateBytes(der)
}

/** 两个字节序列是否逐字节相同;签发者与主体的比对用 */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/** 证书在给定时刻是否处于有效期内 */
const withinValidity = (certificate: ParsedCertificate, now: Date): boolean =>
  certificate.notBefore.getTime() <= now.getTime() &&
  now.getTime() <= certificate.notAfter.getTime()

/** 运行时的 WebCrypto;没有可用的 subtle 时返回 null,调用方按链不通过降级 */
const getSubtle = (): SubtleCrypto | null => {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) return null
  return crypto.subtle
}

/**
 * ECDSA 签名从 DER 编码(r、s 两个 INTEGER)转成 WebCrypto 要的原始 r||s。
 * 每个整数左侧补零到曲线字节长度;超出该长度说明签名不是这张证书的曲线,返回 null。
 */
const ecdsaDerToRaw = (signature: Uint8Array, size: number): Uint8Array<ArrayBuffer> | null => {
  try {
    const sequence = parseDerNode(signature, 0, signature.length)
    if (sequence.tag !== 0x30) return null
    const rNode = sequence.children?.[0]
    const sNode = sequence.children?.[1]
    if (rNode === undefined || sNode === undefined || rNode.tag !== 0x02 || sNode.tag !== 0x02) {
      return null
    }
    const parts = [rNode, sNode].map((node) => {
      let start = node.contentStart
      let end = node.contentEnd
      while (start < end - 1 && signature[start] === 0) start += 1
      const value = signature.slice(start, end)
      if (value.length > size) return null
      const padded = new Uint8Array(size)
      padded.set(value, size - value.length)
      return padded
    })
    const r = parts[0]
    const s = parts[1]
    if (r === null || s === null || r === undefined || s === undefined) return null
    const raw = new Uint8Array(size * 2)
    raw.set(r, 0)
    raw.set(s, size)
    return raw
  } catch {
    return null
  }
}

/** 用根证书的公钥验证来源证书的签名;失败给出原因,不抛错 */
const verifySignature = async (root: ParsedCertificate, eec: ParsedCertificate): Promise<ChainVerdict> => {
  const algorithm = SIGNATURE_ALGORITHMS[eec.signatureAlgorithmOid]
  if (algorithm === undefined) {
    return { ok: false, reason: '签名算法不受支持: ' + eec.signatureAlgorithmOid }
  }
  const subtle = getSubtle()
  if (subtle === null) {
    return { ok: false, reason: '运行时没有可用的 WebCrypto,无法验证证书签名' }
  }

  // 验签密钥是根证书的公钥:来源证书的签名由根的私钥做出
  let key: CryptoKey
  if (algorithm.name === 'ECDSA') {
    const curve = root.spkiCurveOid === null ? undefined : EC_CURVES[root.spkiCurveOid]
    if (curve === undefined) {
      return { ok: false, reason: '根证书公钥曲线不受支持: ' + (root.spkiCurveOid ?? '未知') }
    }
    try {
      key = await subtle.importKey(
        'spki',
        root.spkiBytes,
        { name: 'ECDSA', namedCurve: curve.curve },
        false,
        ['verify'],
      )
    } catch {
      return { ok: false, reason: '根证书公钥无法导入 WebCrypto' }
    }
    const raw = ecdsaDerToRaw(eec.signatureBytes, curve.size)
    if (raw === null) {
      return { ok: false, reason: '证书签名的 DER 编码无法解析' }
    }
    try {
      const signed = await subtle.verify(
        { name: 'ECDSA', hash: algorithm.hash },
        key,
        raw,
        eec.tbsBytes,
      )
      if (!signed) return { ok: false, reason: '来源证书的签名无法用根证书公钥验证' }
    } catch {
      return { ok: false, reason: '来源证书的签名无法用根证书公钥验证' }
    }
    return { ok: true }
  }

  try {
    key = await subtle.importKey('spki', eec.spkiBytes, { name: 'RSASSA-PKCS1-v1_5' }, false, ['verify'])
  } catch {
    return { ok: false, reason: '根证书公钥无法导入 WebCrypto' }
  }
  try {
    const signed = await subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5', hash: algorithm.hash },
      key,
      eec.signatureBytes,
      eec.tbsBytes,
    )
    if (!signed) return { ok: false, reason: '来源证书的签名无法用根证书公钥验证' }
  } catch {
    return { ok: false, reason: '来源证书的签名无法用根证书公钥验证' }
  }
  return { ok: true }
}

/**
 * 校验已解析的两级链:来源证书由根证书签发。
 * 检查项为签发者与主体一致(按 DER 字节比对)、两端都在有效期内、根证书声明 CA:TRUE、
 * 来源证书声明 CA:FALSE 且 keyUsage 含 digitalSignature、签名可用根证书公钥验证。
 * 根证书是信任锚,不验证它的自签名(2.10)。
 */
export const verifyCertificateChainParsed = async (
  root: ParsedCertificate,
  eec: ParsedCertificate,
  now: Date = new Date(),
): Promise<ChainVerdict> => {
  if (!sameBytes(eec.issuerBytes, root.subjectBytes)) {
    return { ok: false, reason: '来源证书的签发者与根证书主体不一致' }
  }
  if (!withinValidity(root, now)) {
    return { ok: false, reason: '根证书不在有效期内' }
  }
  if (!withinValidity(eec, now)) {
    return { ok: false, reason: '来源证书不在有效期内' }
  }
  if (root.basicConstraintsCa !== true) {
    return { ok: false, reason: '根证书未声明 basicConstraints CA:TRUE' }
  }
  if (eec.basicConstraintsCa !== false) {
    return { ok: false, reason: '来源证书必须是终端证书,不能声明 CA:TRUE' }
  }
  if (!eec.keyUsageDigitalSignature) {
    return { ok: false, reason: '来源证书的 keyUsage 不含 digitalSignature' }
  }
  return verifySignature(root, eec)
}

/**
 * 校验两级链的 PEM 入口:先解析两张证书,再做链校验。
 * 任何一张解析失败都返回失败原因,不抛错。
 */
export const verifyCertificateChain = async (
  rootPem: string,
  eecPem: string,
  now: Date = new Date(),
): Promise<ChainVerdict> => {
  const root = parseCertificatePem(rootPem)
  if (root === null) return { ok: false, reason: '根证书不是合法的 PEM 证书' }
  const eec = parseCertificatePem(eecPem)
  if (eec === null) return { ok: false, reason: '来源证书不是合法的 PEM 证书' }
  return verifyCertificateChainParsed(root, eec, now)
}
