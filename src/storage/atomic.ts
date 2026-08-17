import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = dirname(absPath)
  const tmpPath = join(dir, `.${randomUUID()}.tmp`)
  await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' })
  try {
    await rename(tmpPath, absPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

export async function atomicWriteJson(absPath: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2)
  JSON.parse(text)
  await atomicWriteFile(absPath, text)
}

export interface ReadJsonResult<T> {
  ok: boolean
  value: T | null
}

export async function readJsonValidated<T>(
  absPath: string,
  isShape?: (raw: unknown) => raw is T,
): Promise<T | null> {
  let text: string
  try {
    text = await readFile(absPath, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (isShape && !isShape(parsed)) return null
  return parsed as T
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath)
    return true
  } catch {
    return false
  }
}

export async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf-8')
  } catch {
    return null
  }
}

export async function backupFile(absPath: string, suffix = '.bak'): Promise<string | null> {
  const backupPath = `${absPath}${suffix}`
  try {
    await copyFile(absPath, backupPath)
    return backupPath
  } catch {
    return null
  }
}