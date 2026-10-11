import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class DataDirError extends Error {}

function whoami(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined
  return uid === undefined ? os.userInfo().username : `uid ${uid}, gid ${gid}`
}

/**
 * Makes sure the data directory exists and is writable, and tells whether the database file
 * already exists. Throws a DataDirError with an actionable message otherwise.
 */
export function prepareDataDir(dataDir: string, dbFile: string): { created: boolean } {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (err) {
    throw new DataDirError(
      `cannot create the data directory ${dataDir} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}) as ${whoami()}. ` +
        'Create it on the host and make it writable by the container user (see PUID/PGID in docs/DOCKER.md).',
    )
  }

  const probe = path.join(dataDir, `.write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
  } catch (err) {
    throw new DataDirError(
      `the data directory ${dataDir} is not writable by the process (${whoami()}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}. ` +
        'With Docker: start the container as root (default) and set PUID/PGID to the owner you want, ' +
        `or give the user access to the host folder (e.g. chown -R ${typeof process.getuid === 'function' ? process.getuid() : 1000}:${typeof process.getgid === 'function' ? process.getgid() : 1000} <host folder>).`,
    )
  }

  const exists = fs.existsSync(dbFile)
  if (exists) {
    try {
      fs.accessSync(dbFile, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      throw new DataDirError(`the database ${dbFile} exists but is not readable/writable by the process (${whoami()}). Fix its ownership (see PUID/PGID in docs/DOCKER.md).`)
    }
  }
  return { created: !exists }
}
