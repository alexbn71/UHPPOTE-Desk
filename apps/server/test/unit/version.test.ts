import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '../../src/routes/system.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const version = (file: string) => (JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as { version: string }).version

describe('version', () => {
  it('APP_VERSION and every package.json carry the same version', () => {
    for (const file of ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/protocol/package.json', 'packages/shared/package.json', 'tools/hwtest/package.json']) {
      expect(version(file), file).toBe(APP_VERSION)
    }
  })

  it('the changelog has an entry for the current version', () => {
    expect(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).toMatch(new RegExp(`^## \\[${APP_VERSION.replaceAll('.', '\\.')}\\]`, 'm'))
  })
})
