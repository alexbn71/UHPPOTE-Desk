import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, webBuild } from '../../src/routes/system.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const version = (file: string) =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as { version: string }).version

describe('version', () => {
  it('APP_VERSION and every package.json carry the same version', () => {
    for (const file of [
      'package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'packages/protocol/package.json',
      'packages/shared/package.json',
      'tools/hwtest/package.json',
    ]) {
      expect(version(file), file).toBe(APP_VERSION)
    }
  })

  it('the Home Assistant add-on is at the same version', () => {
    const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
    expect(read('homeassistant-addon/config.yaml')).toMatch(
      new RegExp(`^version: "${APP_VERSION.replaceAll('.', '\\.')}"$`, 'm'),
    )
    for (const line of read('homeassistant-addon/build.yaml')
      .split('\n')
      .filter((l) => l.includes('uhppote-desk:'))) {
      expect(line).toMatch(new RegExp(`:${APP_VERSION.replaceAll('.', '\\.')}$`))
    }
    expect(read('homeassistant-addon/CHANGELOG.md')).toContain(`## ${APP_VERSION}`)
  })

  it('the changelog has an entry for the current version', () => {
    expect(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).toMatch(
      new RegExp(`^## \\[${APP_VERSION.replaceAll('.', '\\.')}\\]`, 'm'),
    )
  })
})

describe('web build id', () => {
  it('is the entry bundle referenced by index.html, null without a build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-web-'))
    try {
      expect(webBuild(dir)).toBeNull()
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        '<script type="module" crossorigin src="/assets/index-Dj_MWMRy.js"></script>',
      )
      expect(webBuild(dir)).toBe('index-Dj_MWMRy.js')
      expect(webBuild(null)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
