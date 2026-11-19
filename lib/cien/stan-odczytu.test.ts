import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { hasValidBasicAuth } from '../basic-auth'
import { fillMissingSettings } from '../organizacje'
import { overallStatus } from '../zdrowie'
import {
  HEALTH_CACHE_MS,
  NOT_READING_AFTER_MS,
  resetShadowHealthCache,
  shadowEnabled,
  shadowReadingForHealth,
  shadowReadingState,
  type ShadowAccount,
  type ShadowCursor,
} from './stan-odczytu'

const NOW = new Date('2026-10-26T12:00:00.000Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000)
const acc = (id: string, org = 'acme'): ShadowAccount => ({ organizationId: org, channel: 'WOO', channelAccountId: id, name: `Sklep ${id}`, adapterKey: 'woo.rest.v1' })
const cur = (id: string, c: Partial<ShadowCursor>, org = 'acme'): ShadowCursor => ({
  organizationId: org,
  channel: 'WOO',
  channelAccountId: id,
  firstPollAt: null,
  lastOkAt: null,
  failingSince: null,
  lastError: null,
  ...c,
})

describe('cień: czy konto czyta (3b)', () => {
  it('udany odczyt młodszy niż 15 min = czyta; starszy, otwarty alert albo brak kursora = nie czyta', () => {
    const s = shadowReadingState({
      enabled: true,
      now: NOW,
      accounts: [acc('ok'), acc('stary'), acc('alert'), acc('bez-kursora'), acc('nowy'), acc('nigdy')],
      cursors: [
        cur('ok', { lastOkAt: ago(2) }),
        cur('stary', { lastOkAt: ago(16) }),
        cur('alert', { lastOkAt: ago(1), failingSince: ago(1), lastError: 'konfiguracja: brak baseUrl' }),
        cur('nowy', { firstPollAt: ago(3) }), // pierwszy odczyt w toku / z problemami — jeszcze w oknie 15 min
        cur('nigdy', { failingSince: ago(20), lastError: 'konfiguracja: brak WOO_CONSUMER_KEY' }),
      ],
      openAlerts: [{ organizationId: 'acme', ref: 'WOO/alert' }],
    })
    expect(s.status).toBe('degraded')
    expect(s.accounts).toBe(6)
    expect(s.openAlerts).toBe(1)
    expect(Object.fromEntries(s.details.map((d) => [d.channelAccountId, d.reason]))).toEqual({
      ok: null,
      stary: 'brak-udanego-odczytu',
      alert: 'alert',
      'bez-kursora': 'nigdy-nie-czytane',
      nowy: null,
      nigdy: 'nigdy-nie-czytane',
    })
    expect(s.notReading).toBe(4)
  })

  it('granica: dokładnie 15 min jeszcze czyta, minutę dłużej już nie', () => {
    const at = (lastOkAt: Date) => shadowReadingState({ enabled: true, now: NOW, accounts: [acc('a')], cursors: [cur('a', { lastOkAt })], openAlerts: [] })
    expect(at(new Date(NOW.getTime() - NOT_READING_AFTER_MS)).status).toBe('ok')
    expect(at(ago(16)).status).toBe('degraded')
  })

  it('alert albo kursor innej firmy o tym samym koncie nie liczy się do konta tej firmy', () => {
    const s = shadowReadingState({
      enabled: true,
      now: NOW,
      accounts: [acc('sd', 'a')],
      cursors: [cur('sd', { lastOkAt: ago(1) }, 'a'), cur('sd', { lastOkAt: ago(60) }, 'b')],
      openAlerts: [{ organizationId: 'b', ref: 'WOO/sd' }],
    })
    expect(s).toMatchObject({ status: 'ok', notReading: 0, openAlerts: 0 })
  })

  it('otwarty alert konta spoza cienia (wyłączone w trakcie awarii) nie liczy się do openAlerts; withoutAdapter', () => {
    const s = shadowReadingState({
      enabled: true,
      now: NOW,
      accounts: [acc('sd')],
      cursors: [cur('sd', { lastOkAt: ago(1) })],
      openAlerts: [{ organizationId: 'acme', ref: 'WOO/km' }],
      withoutAdapter: 1,
    })
    expect(s).toMatchObject({ status: 'ok', notReading: 0, openAlerts: 0, withoutAdapter: 1 })
    expect(shadowReadingState({ enabled: true, now: NOW, accounts: [], cursors: [], openAlerts: [] }).withoutAdapter).toBe(0)
  })

  it('CIEN_ODCZYT=0: nic nie jest „nie czyta”, status off; bez kont z adapterem = ok', () => {
    const off = shadowReadingState({ enabled: false, now: NOW, accounts: [acc('a')], cursors: [], openAlerts: [] })
    expect(off).toMatchObject({ status: 'off', notReading: 0, accounts: 1 })
    expect(off.details[0]).toMatchObject({ reading: true, reason: null })
    expect(shadowReadingState({ enabled: true, now: NOW, accounts: [], cursors: [], openAlerts: [] }).status).toBe('ok')
  })

  it('włączenie z env jak w workerze; zła wartość = włączony (health ma krzyczeć, worker i tak nie wstanie)', () => {
    expect(shadowEnabled({})).toBe(true)
    expect(shadowEnabled({ CIEN_ODCZYT: '1' })).toBe(true)
    expect(shadowEnabled({ CIEN_ODCZYT: '0' })).toBe(false)
    expect(shadowEnabled({ CIEN_ODCZYT: 'tak' })).toBe(true)
  })
})

describe('health: degraded przy cieniu, który nie czyta', () => {
  it('cień degraded → status degraded; off i ok nie zmieniają statusu; brak bazy dalej error', () => {
    const migrations = { last: 'a', pending: 0, failed: 0 }
    expect(overallStatus({ db: true, migrations, cien: 'degraded' })).toBe('degraded')
    expect(overallStatus({ db: true, migrations, cien: 'off' })).toBe('ok')
    expect(overallStatus({ db: true, migrations, cien: 'ok' })).toBe('ok')
    expect(overallStatus({ db: false, migrations: null, cien: 'degraded' })).toBe('error')
  })

  it('szczegóły kont tylko z poprawnym hasłem Basic Auth i tylko przy włączonej bramce', () => {
    const env = { BASIC_AUTH_USER: 'jan', BASIC_AUTH_PASSWORD: 'tajne-testowe' }
    const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')
    expect(hasValidBasicAuth(basic('jan', 'tajne-testowe'), env)).toBe(true)
    expect(hasValidBasicAuth(basic('jan', 'zle'), env)).toBe(false)
    expect(hasValidBasicAuth(null, env)).toBe(false)
    // bez bramki (lokalnie, self-host) bramka przepuszcza wszystko — szczegółów i tak nie ma
    expect(hasValidBasicAuth(basic('jan', 'tajne-testowe'), {})).toBe(false)
    expect(hasValidBasicAuth(basic('jan', 'tajne-testowe'), { BASIC_AUTH_USER: 'jan' })).toBe(false)
  })
})

describe('seed: ustawienia konta tylko w puste klucze (krok 1)', () => {
  const preset = { baseUrl: 'https://sklep.example', envPrefix: 'SD_WC' }
  it('puste konto dostaje komplet; brak, null i pusty tekst to „puste”', () => {
    expect(fillMissingSettings({}, preset)).toEqual(preset)
    expect(fillMissingSettings(null, preset)).toEqual(preset)
    expect(fillMissingSettings({ baseUrl: '  ', envPrefix: null }, preset)).toEqual(preset)
  })
  it('wartość zmieniona ręcznie zostaje, inne klucze konta też; nic do uzupełnienia = null (idempotentnie)', () => {
    expect(fillMissingSettings({ baseUrl: 'https://inny.example', holdStockMinutes: 60 }, preset)).toEqual({ baseUrl: 'https://inny.example', holdStockMinutes: 60, envPrefix: 'SD_WC' })
    expect(fillMissingSettings({ ...preset, pollIntervalSec: 120 }, preset)).toBeNull()
    expect(fillMissingSettings({ baseUrl: 0 }, { baseUrl: 'x' })).toBeNull() // 0 to wartość, nie „puste”
  })
})

describe('bufor stanu cienia w /api/health', () => {
  it('trwa HEALTH_CACHE_MS — tyle, ile mówi README (10 s); po nim stan liczony od nowa', async () => {
    const readme = readFileSync(path.join(__dirname, '../../README.md'), 'utf8')
    expect(readme).toContain(`najwyżej raz na ${HEALTH_CACHE_MS / 1000} s`)
    let loads = 0
    const fake = {
      channelConfig: {
        findMany: async () => {
          loads++
          return []
        },
      },
      channelCursor: { findMany: async () => [] },
      alert: { findMany: async () => [] },
    } as unknown as PrismaClient
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      resetShadowHealthCache()
      await shadowReadingForHealth(() => fake, true)
      vi.setSystemTime(NOW.getTime() + HEALTH_CACHE_MS - 1)
      await shadowReadingForHealth(() => fake, true)
      expect(loads).toBe(1)
      vi.setSystemTime(NOW.getTime() + HEALTH_CACHE_MS)
      await shadowReadingForHealth(() => fake, true)
      expect(loads).toBe(2)
    } finally {
      vi.useRealTimers()
      resetShadowHealthCache()
    }
  })
})
