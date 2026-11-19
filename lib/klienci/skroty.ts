// Skróty do wyszukiwania klienta: HMAC-SHA256 kluczem CUSTOMER_LOOKUP_KEY (osobny sekret z env, poza
// bazą). Zwykły SHA bez klucza dałby się odwrócić słownikiem wszystkich numerów telefonów w Polsce; z kluczem bez
// niego nie. Do HMAC wchodzi też firma, więc ten sam telefon w dwóch firmach ma różne skróty (bez korelacji między
// firmami nawet przy wycieku bazy). Wyszukiwanie tylko po pełnej wartości: e-mail, telefon, NIP — nigdy po nazwisku.
import { createHmac } from 'node:crypto'
import { NonRetryableError } from '../bledy'
import type { Env } from '../sekrety'
import type { RekordKlienta } from './rekord'

export class BrakKluczaSkrotow extends NonRetryableError {
  constructor() {
    super('Brak CUSTOMER_LOOKUP_KEY (32 bajty base64 albo 64 znaki hex): skróty do wyszukiwania klientów są niedostępne')
    this.name = 'BrakKluczaSkrotow'
  }
}

/** Klucz HMAC z env; brak = null (zapis wtedy odmawia, wyszukiwanie mówi, że jest wyłączone). Zły format = błąd. */
export function kluczSkrotowZEnv(env: Env): Buffer | null {
  const raw = env['CUSTOMER_LOOKUP_KEY']?.trim()
  if (!raw) return null
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new NonRetryableError('CUSTOMER_LOOKUP_KEY musi mieć dokładnie 32 bajty')
  return key
}

/** E-mail: małe litery i bez spacji na brzegach; część lokalna bez innych zmian (bez usuwania kropek Gmaila). */
export function normalizujEmail(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase()
  return s.includes('@') ? s : null
}

/**
 * Telefon: same cyfry; „0048…” i „+48…” to to samo co „48…”, a 9 cyfr (numer krajowy) dostaje prefiks 48. Inne kraje
 * zostają z prefiksem, jaki podał kanał („+49…” → „49…”). Mniej niż 9 cyfr = null (to nie jest numer).
 */
export function normalizujTelefon(v: string | null | undefined): string | null {
  let d = (v ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 9) d = `48${d}`
  return d.length >= 9 && d.length <= 15 ? d : null
}

/** NIP: same cyfry (bez „PL”, myślników i spacji); inna długość niż 10 = null. */
export function normalizujNip(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '')
  return d.length === 10 ? d : null
}

export type RodzajSkrotu = 'email' | 'telefon' | 'nip'

/** Skrót znormalizowanej wartości; null wartości = null skrótu. */
export function skrot(key: Buffer, organizationId: string, rodzaj: RodzajSkrotu, znormalizowana: string | null): string | null {
  if (!znormalizowana) return null
  return createHmac('sha256', key).update(`${organizationId}\u0000${rodzaj}\u0000${znormalizowana}`, 'utf8').digest('hex')
}

export interface SkrotyKlienta {
  emailHash: string | null
  phoneHash: string | null
  nipHash: string | null
}

/** Skróty rekordu (e-mail i telefon kontaktu, NIP z danych do faktury). */
export function skrotyRekordu(key: Buffer, organizationId: string, k: RekordKlienta): SkrotyKlienta {
  return {
    emailHash: skrot(key, organizationId, 'email', normalizujEmail(k.email)),
    phoneHash: skrot(key, organizationId, 'telefon', normalizujTelefon(k.telefon)),
    nipHash: skrot(key, organizationId, 'nip', normalizujNip(k.faktura?.nip)),
  }
}

/** jawny kod kraju dostawy (filtr „Kraj” listy zamówień): z adresu dostawy, inaczej z danych do faktury. */
export function krajDostawy(k: RekordKlienta): string | null {
  const v = (k.dostawa?.kraj ?? k.faktura?.kraj ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(v) ? v : null
}

export type FrazaWyszukiwania = { rodzaj: 'email' | 'telefon'; wartosc: string } | { rodzaj: 'inna' }

/**
 * Co wpisano w pole „Szukaj po e-mailu lub telefonie”: e-mail (ze „@”), telefon (same cyfry, spacje, „+”, „-”, nawiasy;
 * 9–15 cyfr) albo coś innego (nazwisko, ulica) — tego nie przeszukujemy, bo leży tylko w szyfrogramie.
 */
export function rozpoznajFraze(fraza: string): FrazaWyszukiwania {
  const s = fraza.trim()
  if (s.includes('@')) {
    const e = normalizujEmail(s)
    return e && /^[^\s@]+@[^\s@]+$/.test(e) ? { rodzaj: 'email', wartosc: e } : { rodzaj: 'inna' }
  }
  if (/^[+\d\s()-]+$/.test(s)) {
    const t = normalizujTelefon(s)
    if (t) return { rodzaj: 'telefon', wartosc: t }
  }
  return { rodzaj: 'inna' }
}

/**
 * (jedno pole szukania na liście zamówień): wszystkie odczytania frazy jako pełna wartość klienta. E-mail
 * (ze „@”), telefon (jak `rozpoznajFraze`) i NIP (10 cyfr, z „PL”, myślnikami albo spacjami). 10 cyfr bez „+” pasuje
 * i do NIP-u, i do numeru telefonu bez kierunkowego, więc szukamy po obu skrótach.
 */
export function odczytaniaFrazy(fraza: string): { rodzaj: RodzajSkrotu; wartosc: string }[] {
  const s = fraza.trim()
  const out: { rodzaj: RodzajSkrotu; wartosc: string }[] = []
  const f = rozpoznajFraze(s)
  if (f.rodzaj !== 'inna') out.push(f)
  if (/^(PL)?[\d\s-]+$/i.test(s)) {
    const nip = normalizujNip(s)
    if (nip) out.push({ rodzaj: 'nip', wartosc: nip })
  }
  return out
}
