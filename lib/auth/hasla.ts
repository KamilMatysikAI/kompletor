// Hasła użytkowników: argon2id (parametry OWASP 2024: 19 MiB, 2 iteracje). Hasło nigdy nie trafia do logów.
import { randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { Semaphore } from './limiter'

const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const
export const MIN_PASSWORD_LENGTH = 12
/** Najwyżej 4 obliczenia argon2 naraz w procesie (≈ 76 MiB), reszta czeka w kolejce. */
export const argonGate = new Semaphore(4)

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Hasło musi mieć co najmniej ${MIN_PASSWORD_LENGTH} znaków`)
  return argonGate.run(() => hash(password, OPTS)) // domyślnie Argon2id
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await argonGate.run(() => verify(stored, password))
  } catch {
    return false
  }
}

// Hash do porównania, gdy konta nie ma — czas odpowiedzi nie zdradza, czy e-mail istnieje.
let dummy: Promise<string> | null = null
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'))
  return dummy
}

/** Hasło startowe: 20 znaków bez mylących (0/O, 1/l/I), wypisywane tylko w terminalu przez CLI. */
export function generatePassword(length = 20): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(length * 2)
  let out = ''
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const b = bytes[i]!
    if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length]
  }
  if (out.length < length) return generatePassword(length)
  return out
}
