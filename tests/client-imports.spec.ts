/**
 * The client bundle's runtime imports.
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Packages the client build leaves external although the Web host's module table serves no runtime copy of them, so
 * the browser can only use their types; a value import fails the whole bundle at load.
 */
const TYPE_ONLY_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-typert-protocol',
]

/** Every source file the client bundle can reach: the client folder and the shared folder. */
async function clientSources(): Promise<string[]> {
  const folders = ['src/client', 'src/shared']
  const files = await Promise.all(folders.map(async folder =>
    (await readdir(folder)).filter(file => /\.tsx?$/.test(file)).map(file => join(folder, file))))
  return files.flat()
}

describe('client bundle', () => {
  it('imports only the types of the externals the Web host does not serve', async () => {
    const offenders: string[] = []
    for (const file of await clientSources()) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
        // `import type {} from` and named imports that are all types are fine; a bare `{}` import loads nothing.
        if (TYPE_ONLY_EXTERNALS.includes(match[1]!) && !/^import\s+\{\s*\}\s+from/.test(match[0])) {
          offenders.push(`${file}: ${match[0].replace(/\s+/g, ' ')}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })
})
