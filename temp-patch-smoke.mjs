import { readFileSync, writeFileSync } from 'node:fs'
const file = 'scripts/smoke-market.mjs'
let s = readFileSync(file, 'utf8')

// 1) 两个服务各自一份映射
s = s.replace(
  '/* ---------- 两个静态服务:路径 -> 文本的内存映射 ---------- */',
  '/* ---------- 两个静态服务:各自一份 路径 -> 文本 的内存映射 ---------- */'
)
s = s.replace("const claimed = new Map()", "const claimed = new Map()\nconst claimedAwesome = new Map()")
s = s.replace(
  "const listen = (port) => new Promise((resolve, reject) => {\n  const server = createServer((req, res) => {\n    const key = new URL(req.url, 'http://x').pathname.slice(1)\n    const body = claimed.get(key)",
  "const listen = (port, table) => new Promise((resolve, reject) => {\n  const server = createServer((req, res) => {\n    const key = new URL(req.url, 'http://x').pathname.slice(1)\n    const body = table.get(key)"
)

// 2) awesome 侧改写到自己的映射,meta.json 键名回到统一形状
s = s.replace("put('meta-flat.json',", "putAwesome('meta.json',")
s = s.replace("put('certs/awesome-dsc-humanize-asset-eec.crt', awesomeCert)", "putAwesome('certs/awesome-dsc-humanize-asset-eec.crt', awesomeCert)")
s = s.replace("put('assets-flat.json',", "putAwesome('assets.json',")
for (const key of ['manifest.json', 'versions.json', AWESOME_KEY_REPLACEMENT()]) {}
function AWESOME_KEY_REPLACEMENT() { return '' }

// 3) 启动处分别传映射
s = s.replace("await listen(PORT_INNER).catch", "await listen(PORT_INNER, claimed).catch")
s = s.replace("await listen(PORT_AWESOME).catch", "await listen(PORT_AWESOME, claimedAwesome).catch")

writeFileSync(file, s)
console.log('patched stage 1')
