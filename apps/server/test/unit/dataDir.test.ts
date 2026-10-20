import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../../src/db/database.js'
import { DataDirError, prepareDataDir } from '../../src/db/dataDir.js'

const tmp: string[] = []
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-datadir-'))
  tmp.push(d)
  return d
}

afterEach(() => {
  for (const d of tmp.splice(0)) {
    fs.chmodSync(d, 0o755)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('prepareDataDir', () => {
  it('creates a missing (nested) data folder and a new database', () => {
    const dir = path.join(mkTmp(), 'not', 'yet', 'there')
    const file = path.join(dir, 'uhppote-desk.sqlite')
    expect(prepareDataDir(dir, file)).toEqual({ created: true })
    const db = new Db(file)
    expect(db.migrate().length).toBeGreaterThan(0)
    db.close()
    expect(fs.existsSync(file)).toBe(true)
    // second start: the existing database is reused and not migrated again
    expect(prepareDataDir(dir, file)).toEqual({ created: false })
    const again = new Db(file)
    expect(again.migrate()).toEqual([])
    again.close()
  })

  const canTestPermissions =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

  it.skipIf(!canTestPermissions)('reports a clear error when the folder is not writable', () => {
    const dir = mkTmp()
    fs.chmodSync(dir, 0o555)
    expect(() => prepareDataDir(dir, path.join(dir, 'uhppote-desk.sqlite'))).toThrow(DataDirError)
    expect(() => prepareDataDir(dir, path.join(dir, 'uhppote-desk.sqlite'))).toThrow(/not writable by the process/)
  })
})
