// czytnik odbić ze skrzynki nadawcy (IMAP) na bazie testowej. Skrzynka to atrapa portu `SkrzynkaImap`
// (bez sieci, bez prawdziwych skrzynek); wysyłka maila próbnego przez lokalną atrapę SMTP (tests/smtp-atrapa.ts).
// Wyłącznie dane fikcyjne (example.com / example.test).
//  1. Ustawienia karty „Odbicia”: walidacja, hasło jako sekret firmy, AuditLog bez hasła.
//  2. Przebieg: raport o wysłanym mailu → ODBITY + alert, licznik, kursor w bazie; zwykły mail nietknięty; obca firma
//     nie widzi wpisu (RLS); drugi przebieg nic nie zmienia.
//  3. Odrzucony login: komunikat, alert, czytnik wstrzymany (bez kolejnych prób) do zmiany danych; wysyłka nietknięta.
//  4. Błąd połączenia: komunikat, kursor bez zmian; wyłączony czytnik nie łączy się wcale.
//  5. Adres odbić jako nadawca koperty (MAIL FROM) w transporcie SMTP.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALERT_ODBICIA_LOGOWANIE, AUDIT_ODBICIA, czytajOdbicia, IMAP_PASSWORD, zapiszUstawieniaOdbic, type WejscieOdbic } from '@/lib/poczta/czytnik-odbic'
import { BladLogowaniaImap, type MailWSkrzynce, type OtworzSkrzynke, type SkrzynkaImap } from '@/lib/poczta/imap'
import { ALERT_ODBICIE } from '@/lib/poczta/odbicia'
import { zapiszUstawieniaPoczty } from '@/lib/poczta/ustawienia'
import { wyslijMailProbny } from '@/lib/poczta/wysylka'
import { BladUstawienPoczty } from '@/lib/poczta/ustawienia'
import { ORG_B, testDb, truncateAll } from './db'
import { seedBase } from './rdzen-fixtures'
import { uruchomAtrape, type Atrapa } from './smtp-atrapa'

const a = testDb()
const b = testDb({ organizationId: ORG_B })
const ENV = { POCZTA_WYSYLKA: '1', APP_ENCRYPTION_KEY: 'c'.repeat(64) }
const EMAIL = 'jan.kowalski@example.test'

const raport = (id: string, adresat = EMAIL) =>
  [
    'From: MAILER-DAEMON@mx.example.test',
    'Subject: Undelivered Mail Returned to Sender',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
    '',
    '--B1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.test',
    '',
    `Final-Recipient: rfc822; ${adresat}`,
    'Action: failed',
    'Status: 5.1.1',
    `Diagnostic-Code: smtp; 550 5.1.1 <${adresat}>: User unknown`,
    '',
    '--B1',
    'Content-Type: text/rfc822-headers',
    '',
    'Message-ID: <oryginal@example.com>',
    `X-Kompletor-Id: ${id}`,
    '',
    '--B1--',
    '',
  ].join('\r\n')

/** Atrapa skrzynki z licznikiem połączeń; `maile` współdzielone między przebiegami. */
function skrzynka(maile: { uid: number; tresc: string; seen?: boolean; folder?: string }[]) {
  const polaczenia: { host: string; login: string; haslo: string; folder: string }[] = []
  const otworz: OtworzSkrzynke = async (cfg, folder) => {
    polaczenia.push({ host: cfg.host, login: cfg.login, haslo: cfg.haslo, folder })
    const s: SkrzynkaImap = {
      uidValidity: '7',
      async nieprzeczytane(odUid, limit): Promise<MailWSkrzynce[]> {
        return maile.filter((m) => !m.seen && !m.folder && m.uid > odUid).slice(0, limit).map((m) => ({ uid: m.uid, rozmiar: m.tresc.length }))
      },
      async pobierz(uid) {
        const m = maile.find((x) => x.uid === uid)
        return m ? Buffer.from(m.tresc) : null
      },
      async odloz(uid) {
        const m = maile.find((x) => x.uid === uid)!
        m.seen = true
        m.folder = 'Kompletor/odbicia'
        return 'PRZENIESIONY'
      },
      async zamknij() {},
    }
    return s
  }
  return { otworz, polaczenia }
}

function wejscie(over: Partial<WejscieOdbic> = {}): WejscieOdbic {
  return { enabled: true, host: 'imap.example.com', port: '993', bezpieczenstwo: 'TLS', login: 'odbicia@example.com', haslo: 'tajne-haslo-imap', usunHaslo: false, folder: 'INBOX', adresOdbic: '', ...over }
}

let atrapa: Atrapa
beforeAll(async () => {
  atrapa = await uruchomAtrape({ login: 'kompletor', haslo: 'tajne-haslo-smtp' })
})
afterAll(async () => {
  await atrapa.zamknij()
  await a.$disconnect()
  await b.$disconnect()
})
beforeEach(async () => {
  await truncateAll()
  await seedBase(a)
  await seedBase(b)
  atrapa.maile.length = 0
})

describe('1. ustawienia karty „Odbicia”', () => {
  it('walidacja po polsku; hasło jako sekret firmy; AuditLog bez hasła', async () => {
    await expect(zapiszUstawieniaOdbic(a, wejscie({ haslo: '' }), 'osoba', ENV)).rejects.toThrow(/Do włączenia czytnika odbić uzupełnij: hasło skrzynki/)
    await expect(zapiszUstawieniaOdbic(a, wejscie({ adresOdbic: 'zly@' }), 'osoba', ENV)).rejects.toThrow(BladUstawienPoczty)
    await expect(zapiszUstawieniaOdbic(a, wejscie({ host: '10.0.0.5' }), 'osoba', { ...ENV, APP_MODE: 'hosted' })).rejects.toThrow(/dostępny z internetu/)
    await zapiszUstawieniaOdbic(a, wejscie({ adresOdbic: 'Odbicia@Example.com' }), 'osoba', ENV)
    const s = await a.mailSettings.findFirstOrThrow()
    expect(s).toMatchObject({ bounceEnabled: true, imapHost: 'imap.example.com', imapPort: 993, imapUsername: 'odbicia@example.com', imapFolder: 'INBOX', bounceAddress: 'odbicia@example.com', enabled: false })
    const sekret = await a.integrationSecret.findFirstOrThrow({ where: { name: IMAP_PASSWORD } })
    expect(JSON.stringify(sekret)).not.toContain('tajne-haslo-imap')
    const log = await a.auditLog.findFirstOrThrow({ where: { entity: AUDIT_ODBICIA } })
    expect(JSON.stringify(log)).not.toContain('tajne-haslo-imap')
    expect(log.after).toMatchObject({ haslo: 'zmienione', host: 'imap.example.com' })
  })
})

describe('2–4. przebieg czytnika', () => {
  it('raport o wysłanym mailu → ODBITY z alertem; zwykły mail nietknięty; kursor i licznik w bazie; drugi przebieg bez zmian', async () => {
    await zapiszUstawieniaOdbic(a, wejscie(), 'osoba', ENV)
    const d = await a.mailDelivery.create({ data: { dedupeKey: 'plan:a155', kind: 'odbior', state: 'SENT', attempts: 1, lastAttemptAt: new Date(), recipient: 'j***@example.test' } })
    const maile: { uid: number; tresc: string; seen?: boolean; folder?: string }[] = [
      { uid: 1, tresc: raport('plan:a155') },
      { uid: 2, tresc: 'From: klient@example.test\r\nSubject: Pytanie\r\n\r\nDzień dobry' },
      { uid: 3, tresc: raport('plan:innej-firmy') },
    ]
    const { otworz, polaczenia } = skrzynka(maile)
    const w = await czytajOdbicia(a, ENV, { otworz })
    expect(w).toMatchObject({ przejrzane: 3, zapisane: 1, inne: 1, obce: 1, bledy: [] })
    expect(polaczenia[0]).toEqual({ host: 'imap.example.com', login: 'odbicia@example.com', haslo: 'tajne-haslo-imap', folder: 'INBOX' })
    expect(await a.mailDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ state: 'ODBITY' })
    expect(await a.alert.count({ where: { kind: ALERT_ODBICIE } })).toBe(1)
    expect(maile.map((m) => m.folder ?? null)).toEqual(['Kompletor/odbicia', null, null])
    const s = await a.mailSettings.findFirstOrThrow()
    expect(s).toMatchObject({ bounceCount: 1, bounceLastError: null, bounceState: { uidValidity: '7', lastUid: 3 } })
    expect(s.bounceLastRunAt).not.toBeNull()
    // obca firma nie ma tego wpisu (RLS)
    await zapiszUstawieniaOdbic(b, wejscie(), 'osoba', ENV)
    const obca = skrzynka([{ uid: 1, tresc: raport('plan:a155') }])
    expect(await czytajOdbicia(b, ENV, { otworz: obca.otworz })).toMatchObject({ zapisane: 0, obce: 1 })
    // drugi przebieg firmy A: nic nowego
    expect(await czytajOdbicia(a, ENV, { otworz })).toMatchObject({ przejrzane: 0 })
    expect((await a.mailSettings.findFirstOrThrow()).bounceCount).toBe(1)
  })

  it('odrzucony login: komunikat i alert, kolejne przebiegi bez łączenia; zapis nowego hasła wznawia; wysyłka maili nietknięta', async () => {
    await zapiszUstawieniaPoczty(a, { enabled: true, host: '127.0.0.1', port: String(atrapa.port), bezpieczenstwo: 'BRAK', login: 'kompletor', haslo: 'tajne-haslo-smtp', usunHaslo: false, fromEmail: 'poczta@example.com', fromName: 'Firma', officeEmail: 'biuro@example.com', nadawcy: {} }, 'osoba', ENV)
    await zapiszUstawieniaOdbic(a, wejscie(), 'osoba', ENV)
    const otworz = vi.fn<OtworzSkrzynke>(async () => {
      throw new BladLogowaniaImap('Authentication failed')
    })
    expect(await czytajOdbicia(a, ENV, { otworz })).toBeNull()
    const s = await a.mailSettings.findFirstOrThrow()
    expect(s.bounceLoginRejectedAt).not.toBeNull()
    expect(s.bounceLastError).toMatch(/odrzucił login albo hasło skrzynki odbić/)
    expect(s).toMatchObject({ enabled: true, loginRejectedAt: null }) // wysyłka maili działa dalej
    expect(await a.alert.count({ where: { kind: ALERT_ODBICIA_LOGOWANIE } })).toBe(1)
    await czytajOdbicia(a, ENV, { otworz })
    expect(otworz).toHaveBeenCalledTimes(1)
    await zapiszUstawieniaOdbic(a, wejscie({ haslo: 'nowe-haslo-imap' }), 'osoba', ENV)
    expect(await a.mailSettings.findFirstOrThrow()).toMatchObject({ bounceLoginRejectedAt: null, bounceLastError: null })
    const ok = skrzynka([])
    expect(await czytajOdbicia(a, ENV, { otworz: ok.otworz })).toMatchObject({ przejrzane: 0 })
    expect(ok.polaczenia[0]!.haslo).toBe('nowe-haslo-imap')
  })

  it('błąd połączenia: komunikat bez hasła, kursor bez zmian; wyłączony czytnik i brak hasła nie łączą się', async () => {
    await zapiszUstawieniaOdbic(a, wejscie(), 'osoba', ENV)
    await a.mailSettings.updateMany({ data: { bounceState: { uidValidity: '7', lastUid: 40 } } })
    const otworz = vi.fn<OtworzSkrzynke>(async () => {
      throw new Error('connect ETIMEDOUT tajne-haslo-imap')
    })
    expect(await czytajOdbicia(a, ENV, { otworz })).toBeNull()
    const s = await a.mailSettings.findFirstOrThrow()
    expect(s.bounceLastError).toMatch(/Nie udało się połączyć ze skrzynką odbić/)
    expect(s.bounceLastError).not.toContain('tajne-haslo-imap')
    expect(s.bounceState).toEqual({ uidValidity: '7', lastUid: 40 })
    expect(s.bounceLoginRejectedAt).toBeNull()

    await zapiszUstawieniaOdbic(a, wejscie({ enabled: false }), 'osoba', ENV)
    await czytajOdbicia(a, ENV, { otworz })
    await zapiszUstawieniaOdbic(a, wejscie({ enabled: false, usunHaslo: true, haslo: '' }), 'osoba', ENV)
    await a.mailSettings.updateMany({ data: { bounceEnabled: true } }) // np. hasło usunięte później
    await czytajOdbicia(a, ENV, { otworz })
    expect(otworz).toHaveBeenCalledTimes(1)
    expect((await a.mailSettings.findFirstOrThrow()).bounceLastError).toMatch(/brak hasło skrzynki/)
  })
})

describe('6. Zapis karty w trakcie przebiegu', () => {
  it('zmiana skrzynki w trakcie przebiegu: stary kursor nie trafia do nowej skrzynki, licznik odbić zostaje', async () => {
    await zapiszUstawieniaOdbic(a, wejscie(), 'osoba', ENV)
    await a.mailDelivery.create({ data: { dedupeKey: 'plan:a155w1', kind: 'odbior', state: 'SENT', attempts: 1, lastAttemptAt: new Date(), recipient: 'j***@example.test' } })
    const { otworz: stara } = skrzynka([
      { uid: 30, tresc: raport('plan:a155w1') },
      { uid: 31, tresc: 'From: klient@example.test\r\nSubject: Pytanie\r\n\r\nDzień dobry' },
    ])
    const otworz: OtworzSkrzynke = async (cfg, folder) => {
      const s = await stara(cfg, folder)
      const nieprzeczytane = s.nieprzeczytane.bind(s)
      return {
        ...s,
        uidValidity: s.uidValidity,
        async nieprzeczytane(odUid, limit) {
          // użytkownik zapisuje nową skrzynkę, gdy przebieg na starej już trwa
          await zapiszUstawieniaOdbic(a, wejscie({ host: 'imap2.example.com', login: 'nowa@example.com' }), 'osoba', ENV)
          return nieprzeczytane(odUid, limit)
        },
      }
    }
    expect(await czytajOdbicia(a, ENV, { otworz })).toMatchObject({ zapisane: 1 })
    const s = await a.mailSettings.findFirstOrThrow()
    expect(s.bounceState).toEqual({}) // kursor starej skrzynki (lastUid 31) wyrzucony
    expect(s).toMatchObject({ imapHost: 'imap2.example.com', bounceCount: 1, bounceLastError: null })
    // następny przebieg czyta nową skrzynkę od początku
    const nowa = skrzynka([{ uid: 5, tresc: 'From: x@example.test\r\nSubject: a\r\n\r\nb' }])
    expect(await czytajOdbicia(a, ENV, { otworz: nowa.otworz })).toMatchObject({ przejrzane: 1 })
    expect(nowa.polaczenia[0]).toMatchObject({ host: 'imap2.example.com', login: 'nowa@example.com' })
    expect((await a.mailSettings.findFirstOrThrow()).bounceState).toEqual({ uidValidity: '7', lastUid: 5 })
  })

  it('hasło poprawione w trakcie nieudanego logowania: czytnik nie zostaje wstrzymany i bez alertu; skasowany błąd nie wraca', async () => {
    await zapiszUstawieniaOdbic(a, wejscie(), 'osoba', ENV)
    const odrzucony = vi.fn<OtworzSkrzynke>(async () => {
      await zapiszUstawieniaOdbic(a, wejscie({ haslo: 'poprawione-haslo' }), 'osoba', ENV)
      throw new BladLogowaniaImap('Authentication failed')
    })
    expect(await czytajOdbicia(a, ENV, { otworz: odrzucony })).toBeNull()
    let s = await a.mailSettings.findFirstOrThrow()
    expect(s).toMatchObject({ bounceLoginRejectedAt: null, bounceLastError: null })
    expect(await a.alert.count({ where: { kind: ALERT_ODBICIA_LOGOWANIE } })).toBe(0)

    const zerwane = vi.fn<OtworzSkrzynke>(async () => {
      await zapiszUstawieniaOdbic(a, wejscie({ host: 'imap3.example.com' }), 'osoba', ENV)
      throw new Error('connect ECONNRESET')
    })
    expect(await czytajOdbicia(a, ENV, { otworz: zerwane })).toBeNull()
    s = await a.mailSettings.findFirstOrThrow()
    expect(s).toMatchObject({ imapHost: 'imap3.example.com', bounceLastError: null, bounceLastErrorAt: null })
    // bez zmiany karty zapis przebiegu działa jak dotąd (ta sama wersja)
    expect(await czytajOdbicia(a, ENV, { otworz: async () => { throw new Error('connect ECONNRESET') } })).toBeNull()
    expect((await a.mailSettings.findFirstOrThrow()).bounceLastError).toMatch(/Nie udało się połączyć/)
  })
})

describe('5. adres odbić jako nadawca koperty', () => {
  it('MAIL FROM = adres odbić, nagłówek From bez zmian; bez adresu odbić MAIL FROM = nadawca', async () => {
    await zapiszUstawieniaPoczty(a, { enabled: true, host: '127.0.0.1', port: String(atrapa.port), bezpieczenstwo: 'BRAK', login: 'kompletor', haslo: 'tajne-haslo-smtp', usunHaslo: false, fromEmail: 'poczta@example.com', fromName: 'Firma', officeEmail: 'biuro@example.com', nadawcy: {} }, 'osoba', ENV)
    expect(await wyslijMailProbny(a, ENV, 'ktos@example.com', 'osoba')).toMatchObject({ ok: true })
    expect(atrapa.maile[0]!.od).toBe('poczta@example.com')
    await zapiszUstawieniaOdbic(a, wejscie({ enabled: false, adresOdbic: 'odbicia@example.com' }), 'osoba', ENV)
    // limit maila próbnego: najwyżej jeden na minutę
    expect(await wyslijMailProbny(a, ENV, 'ktos@example.com', 'osoba', { now: () => new Date(Date.now() + 120_000) })).toMatchObject({ ok: true })
    expect(atrapa.maile[1]!.od).toBe('odbicia@example.com')
    expect(atrapa.maile[1]!.surowy).toMatch(/^From: .*poczta@example\.com/m)
  })
})
