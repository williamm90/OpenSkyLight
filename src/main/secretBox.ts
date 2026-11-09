import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Encrypts small secrets at rest (OAuth secrets, refresh tokens, camera URLs).
 * The desktop app backs this with Electron safeStorage (OS keychain/DPAPI);
 * the headless server uses AES-256-GCM with a key file in its data directory.
 * Both keep reading the legacy `plain:` fallback format.
 */
export interface SecretBox {
  encrypt(plain: string): Buffer
  decrypt(buf: Buffer): string
}

const PLAIN_PREFIX = 'plain:'
const AES_PREFIX = Buffer.from('osl1:', 'utf8')

function decodePlain(buf: Buffer): string | null {
  const asString = buf.toString('utf8')
  return asString.startsWith(PLAIN_PREFIX) ? asString.slice(PLAIN_PREFIX.length) : null
}

/** AES-256-GCM box keyed by a 32-byte file, created (mode 0600) on first use. */
export function createFileKeySecretBox(keyPath: string): SecretBox {
  let key: Buffer
  if (existsSync(keyPath)) {
    key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (key.length !== 32) throw new Error(`Secret key at ${keyPath} is corrupt`)
  } else {
    key = randomBytes(32)
    writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 })
  }

  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([AES_PREFIX, iv, cipher.getAuthTag(), body])
    },
    decrypt(buf) {
      const plain = decodePlain(buf)
      if (plain !== null) return plain
      if (!buf.subarray(0, AES_PREFIX.length).equals(AES_PREFIX)) {
        throw new Error('Secret was encrypted by a different runtime')
      }
      const iv = buf.subarray(AES_PREFIX.length, AES_PREFIX.length + 12)
      const tag = buf.subarray(AES_PREFIX.length + 12, AES_PREFIX.length + 28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(buf.subarray(AES_PREFIX.length + 28)), decipher.final()]).toString('utf8')
    }
  }
}

/** Adapter for Electron's safeStorage (passed in so this module stays Electron-free). */
export function createSafeStorageSecretBox(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}): SecretBox {
  return {
    encrypt(plain) {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(plain)
        : Buffer.from(`${PLAIN_PREFIX}${plain}`, 'utf8')
    },
    decrypt(buf) {
      return decodePlain(buf) ?? safeStorage.decryptString(buf)
    }
  }
}
