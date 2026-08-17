/**
 * 客户端 bundle 构建：client/index.ts → dist/client.js。
 * 产物为 dsh client-modules 的闭包工厂格式——脚本执行仅注册
 * window.__ModuleLoader__.load({id, factory})，全部模块副作用（含
 * 对平台外部依赖的 require）发生在 factory 物化时（首require）。
 * 平台外部依赖（react/@deepseek-ai/*）经 loader 模块表解析，不打进包。
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const result = await build({
  entryPoints: [resolve(root, 'client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  write: false,
  minify: true,
  sourcemap: false,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  logLevel: 'info',
})

const body = result.outputFiles[0].text
const out = `;(function () {
window.__ModuleLoader__.load({ id: 'novel-harness', factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
${body}
return module.exports;
} });
})();
`
const outPath = resolve(root, 'dist/client.js')
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, out, 'utf-8')
console.log(`client bundle -> ${outPath} (${out.length} bytes)`)
