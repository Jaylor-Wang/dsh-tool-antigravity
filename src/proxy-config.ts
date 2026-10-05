/** Persistent proxy configuration for Antigravity tools. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultAuthStorePath } from './auth-store.ts'
import { setExplicitProxy } from './raw-http.ts'

export const PROXY_CONFIG_FILE_PATH = join(dirname(defaultAuthStorePath()), 'config.json')

let customConfigFilePath: string | undefined

export function getProxyConfigFile(): string {
  return customConfigFilePath ?? PROXY_CONFIG_FILE_PATH
}

export function setCustomProxyConfigFile(path?: string): void {
  customConfigFilePath = path
}

export function getStoredProxy(): string {
  try {
    const raw = readFileSync(getProxyConfigFile(), 'utf-8')
    const data = JSON.parse(raw) as { proxy?: unknown }
    return typeof data?.proxy === 'string' ? data.proxy.trim() : ''
  } catch {
    return ''
  }
}

export function setStoredProxy(proxy: string): void {
  try {
    const file = getProxyConfigFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ proxy }), 'utf-8')
  } catch {}
}

export function applyProxySetting(proxyValue?: string): void {
  const proxy = typeof proxyValue === 'string' && proxyValue.trim().length > 0 ? proxyValue.trim() : undefined
  setExplicitProxy(proxy)
}
