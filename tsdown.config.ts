import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { defineConfig, Rolldown } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { transform } from 'lightningcss'

const PACKAGE_ID = 'dsh-workflow-studio'
const CSS_PREFIX = '\0workflow-studio-css:'
const CSS_SUFFIX = '.mjs'
const STYLE_MARKER = '/*__workflow_studio_styles__*/'
/** The Web shell's platform module table (`PLATFORM_MODULES` in `@deepseek-ai/dsh-client-web`); a bundle may require only these. */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
/** Compiled CSS Modules text keyed by virtual module id; each entry's `path` is its stylesheet path within this package. */
const styles = new Map<string, { path: string; css: string }>()

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
      // zustand probes `import.meta.env`, which a CJS output cannot carry.
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
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
        styles.set(virtualId, { path: relative(import.meta.dirname, file).split(sep).join('/'), css: code.toString() })
        return { code: `export default ${JSON.stringify(classes)};`, moduleSideEffects: 'no-treeshake' }
      },
    }, {
      // The renderer installs stylesheets from the registration's `meta`; the factory never touches the DOM.
      name: 'workflow-studio-style-metadata',
      renderChunk(code, chunk) {
        const marker = code.indexOf(STYLE_MARKER)
        if (marker < 0 || code.indexOf(STYLE_MARKER, marker + 1) !== -1) {
          throw new Error(`${PACKAGE_ID}: missing or repeated style marker in ${chunk.fileName}`)
        }
        const resources = Object.keys(chunk.modules).flatMap(id => {
          const style = styles.get(id)
          return style === undefined ? [] : [`${JSON.stringify(style.path)}: { text: () => ${JSON.stringify(style.css)} }`]
        })
        const meta = resources.length === 0 ? '' : `, meta: () => ({ stylesheets: {${resources.join(',')}} })`
        const output = new Rolldown.RolldownMagicString(code)
        output.overwrite(marker, marker + STYLE_MARKER.length, meta)
        return output
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: `return module.exports; }${STYLE_MARKER} });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
