import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { transform } from 'lightningcss'

const PACKAGE_ID = 'dsh-workflow-studio'
const CSS_PREFIX = '\0workflow-studio-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-typert-protocol',
])

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: specifier => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: specifier => !CLIENT_EXTERNALS.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'process.env.DSH_CLIENT_TITLE': process.env.DSH_CLIENT_TITLE === undefined
        ? 'undefined'
        : JSON.stringify(process.env.DSH_CLIENT_TITLE),
    },
    plugins: [{
      name: 'workflow-studio-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_PREFIX)) return null
        const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(file)
        const source = await readFile(file)
        const { code, exports } = transform({
          filename: file,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(exports ?? {})) classes[local] = value.name
        const tagId = `${PACKAGE_ID}/${basename(file)}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
          '  const tag = document.createElement("style");',
          `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
