// karta zamówienia w trybie odczytu z „Edytuj”. Render sekcji na serwerze (bez DOM):
// - pozycje w odczycie nie mają pól ilości, „usuń”, ceny ani VAT; „Edytuj” w pasku nagłówka prowadzi do `?edytuj=pozycje`;
// - w edycji są te same pola co dotąd i „Anuluj” / „Zakończ edycję” wracają do odczytu; zapis przekierowuje bez parametru;
// - decyzja o braku jest dostępna od razu, bez wchodzenia w edycję (zapis samych decyzji);
// - konto w podglądzie widzi „Edytuj” nieaktywne z powodem;
// - dane klienta zamówienia ręcznego: karty w odczycie, „Edytuj” = ten sam formularz (`wpiszKlienta`).
// Dane fikcyjne, zero połączeń zewnętrznych.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h, type ReactElement } from 'react'
import { permissionsOf } from '@/lib/auth/uprawnienia'
import { daneKarty, type DaneKarty } from '@/lib/karta/dane'
import { adresKarty } from '@/lib/karta/komunikaty'
import { adresOdczytu } from '@/lib/karta/uklad'
import { ingestOrder } from '@/lib/rdzen/zamowienia'
import { testDb, truncateAll } from './db'
import { order, product, seedBase, T0 } from './rdzen-fixtures'

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }), headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// (E2): karta danych klienta z kanału czyta dokumenty sprzedaży (blokada danych do faktury) z bazy sesji
const sesja = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/panel/kontekst', () => ({
  requireSession: async () => ({ permissions: new Set(['klienci.dane', 'zamowienia.edycja_pozycji']), user: { id: 'u-test' }, db: sesja.db }),
  requirePermission: async () => {
    throw new Error('akcja nie powinna się wykonać w teście renderu')
  },
}))

const { Pozycje } = await import('@/app/(panel)/zamowienia/[id]/pozycje')
const { KartyKlienta } = await import('@/app/(panel)/zamowienia/[id]/klient')

const db = testDb()
sesja.db = db
afterAll(async () => {
  await db.$disconnect()
})

const ENV = { EKRANY_PRACA: '1' }
const WLASCICIEL = permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })
const html = (el: ReactElement) => renderToStaticMarkup(el)

async function praca(): Promise<void> {
  await db.channelConfig.updateMany({ where: { channel: 'WOO', channelAccountId: 'sd' }, data: { statusMode: 'PRACA' } })
}

/** Zamówienie z jedną pozycją na stanie i jedną z brakiem (otwarty brak = decyzja o braku). */
async function zBrakiem(): Promise<DaneKarty> {
  const a = await product(db, 'A161-A', 10)
  const c = await product(db, 'A161-C', 0)
  const id = (await ingestOrder(db, order([{ productId: a, qty: 1 }, { productId: c, qty: 1 }]), { now: T0 })).orderId!
  return (await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV }))!
}

beforeEach(async () => {
  await truncateAll(db)
  await seedBase(db)
})

describe('pozycje: odczyt i „Edytuj”', () => {
  it('odczyt nie renderuje pól ilości, „usuń”, ceny ani VAT; „Edytuj” prowadzi do trybu edycji', async () => {
    await praca()
    const a = await product(db, 'A161-B', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })).orderId!
    const d = (await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV }))!
    expect(d.edycja.mozna).toBe(true)
    const s = html(h(Pozycje, { d, uprawnienia: WLASCICIEL }))
    expect(s).not.toMatch(/name="ilosc_/)
    expect(s).not.toMatch(/name="usun_/)
    expect(s).not.toMatch(/name="cena_/)
    expect(s).not.toMatch(/name="vat_/)
    expect(s).not.toContain('aria-label="Zmiany pozycji"')
    expect(s).toContain(`href="/zamowienia/${id}?edytuj=pozycje#pozycje"`)
    expect(s).toContain('>Edytuj<')
    // nagłówek sekcji w pasku, małymi wersalikami (klasa wspólnego komponentu)
    expect(s).toContain('class="ui-sekcja-glowa"')
    // podsumowanie netto / VAT / brutto
    expect(s).toContain('Razem netto')
    expect(s).toContain('Razem brutto')
  })

  it('„Edytuj” włącza pola; „Zakończ edycję” i „Anuluj” wracają do odczytu, zapis przekierowuje bez trybu edycji', async () => {
    await praca()
    const a = await product(db, 'A161-B', 10)
    const id = (await ingestOrder(db, order([{ productId: a, qty: 2 }]), { now: T0 })).orderId!
    const d = (await daneKarty(db, id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV }))!
    const s = html(h(Pozycje, { d, uprawnienia: WLASCICIEL, edytuj: true }))
    const linia = d.o.lines[0]!.id
    expect(s).toContain(`name="ilosc_${linia}"`)
    expect(s).toContain(`name="usun_${linia}"`)
    expect(s).toContain('aria-label="Zmiany pozycji"')
    expect(s).toContain('Zapisz pozycje')
    expect(s).toContain('Zakończ edycję')
    const odczyt = adresOdczytu(id, 'pozycje')
    expect(s).toMatch(new RegExp(`<a class="btn[^"]*" href="${odczyt}">Anuluj</a>`))
    expect(s).toContain(`href="${odczyt}">Zakończ edycję`)
    // akcje zapisu kończą się przekierowaniem na kartę bez `edytuj` (lib/karta/komunikaty.ts adresKarty)
    expect(adresKarty(id, { ok: 'zapisano', n: 1 })).not.toContain('edytuj')
    expect(adresKarty(id, { blad: 'BLAD' })).not.toContain('edytuj')
  })

  it('decyzja o braku dostępna od razu w odczycie, bez pól edycji (zapis samych decyzji)', async () => {
    await praca()
    const d = await zBrakiem()
    const s = html(h(Pozycje, { d, uprawnienia: WLASCICIEL }))
    expect(s).toMatch(/name="decyzja_/)
    expect(s).not.toMatch(/name="ilosc_/)
    expect(s).toContain('aria-label="Zmiany pozycji"')
    expect(s).toContain('>Zapisz decyzje</button>')
    expect(s).not.toContain('>Zapisz pozycje</button>')
    // w edycji decyzja dalej jest i zapisuje się razem z pozycjami
    const e = html(h(Pozycje, { d, uprawnienia: WLASCICIEL, edytuj: true }))
    expect(e).toMatch(/name="decyzja_/)
    expect(e).toMatch(/name="ilosc_/)
    expect(e).toContain('>Zapisz pozycje</button>')
  })

  it('konto w podglądzie: „Edytuj” widoczne i nieaktywne z powodem; parametr edycji niczego nie włącza', async () => {
    const d = await zBrakiem()
    expect(d.praca).toBe(false)
    for (const edytuj of [false, true]) {
      const s = html(h(Pozycje, { d, uprawnienia: WLASCICIEL, edytuj }))
      expect(s).toMatch(/<span class="ui-sekcja-edytuj is-disabled" aria-disabled="true" title="[^"]+" data-powod="[^"]+"( aria-describedby="poz-podglad")?>Edytuj/)
      expect(s).not.toMatch(/name="ilosc_/)
      expect(s).not.toContain('?edytuj=pozycje')
    }
  })

  // blokada edycji (tu: zamówienie anulowane) w PRACA i w podglądzie — „Edytuj” nieaktywne,
  // powód widocznym tekstem raz (akapit `poz-powod`), czytnik dostaje go przez opis, bez drugiej kopii w „Edytuj”
  it('blokada edycji w PRACA i w podglądzie: „Edytuj” nieaktywne, powód raz', async () => {
    const POWOD = 'Zamówienie anulowane: pozycji nie da się zmienić'
    for (const tryb of ['praca', 'podglad'] as const) {
      await truncateAll(db)
      await seedBase(db)
      if (tryb === 'praca') await praca()
      const d0 = await zBrakiem()
      await db.order.update({ where: { id: d0.o.id }, data: { status: 'ANULOWANE' } })
      const d = (await daneKarty(db, d0.o.id, { userId: 'u-test', uprawnienia: WLASCICIEL }, { env: ENV }))!
      expect(d.praca).toBe(tryb === 'praca')
      expect(d.edycja.powod).toBe(POWOD)
      const s = html(h(Pozycje, { d, uprawnienia: WLASCICIEL, edytuj: true }))
      expect(s).toContain(`aria-disabled="true" title="${POWOD}" data-powod="${POWOD}" aria-describedby="poz-powod">Edytuj</span>`)
      expect(s).toContain(`<p id="poz-powod" class="muted small">${POWOD}.</p>`)
      expect(s.split(`>${POWOD}`).length - 1).toBe(1)
      expect(s).not.toContain(`(${POWOD})`)
      expect(s).not.toMatch(/name="ilosc_/)
    }
  })
})

describe('dane klienta: karty w odczycie, „Edytuj” = formularz zamówienia ręcznego', () => {
  const rekord = {
    v: 1 as const,
    nabywca: { imieNazwisko: 'Jan Testowy', firma: null },
    dostawa: { imieNazwisko: 'Jan Testowy', firma: null, ulica: 'Testowa', numerDomu: '1', numerLokalu: null, kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' },
    punktOdbioru: null,
    faktura: { nazwa: 'Firma Testowa', nip: '0000000000', ulica: 'Testowa 1', kodPocztowy: '00-001', miasto: 'Testowo', kraj: 'PL' },
    telefon: '500000000',
    email: 'jan@example.invalid',
    uwagiKlienta: null,
    problemy: [],
  }
  const klient = { stan: 'PELNY' as const, rekord, zrodlo: 'RECZNE' as const, odczytano: T0, rewizja: 1 }
  const d = (kanal: string) => ({ o: { id: 'o161', channel: kanal, deliveryMethod: 'Kurier', carrier: null, shippingCostGross: null } }) as unknown as DaneKarty

  it('zamówienie ręczne w odczycie: dwie karty bez pól, „Edytuj” do `?edytuj=klient`', async () => {
    const s = html(await KartyKlienta({ d: d('RECZNE'), klient: klient as never, powod: null, pelne: true, edytuj: null }))
    expect(s).toContain('id="wysylka"')
    expect(s).toContain('id="dane-faktury"')
    expect(s).toContain('Firma Testowa')
    expect(s).not.toMatch(/<input[^>]*name="imie"/)
    expect(s).toContain('href="/zamowienia/o161?edytuj=klient#klient"')
  })

  it('w edycji ten sam formularz (pola i zapis), „Anuluj” wraca do odczytu', async () => {
    const s = html(await KartyKlienta({ d: d('RECZNE'), klient: klient as never, powod: null, pelne: true, edytuj: 'klient' }))
    for (const pole of ['imie', 'firma', 'telefon', 'email', 'uwagi', 'ulica', 'dom', 'lokal', 'kod', 'miasto', 'punkt', 'f_nazwa', 'f_nip', 'f_ulica', 'f_kod', 'f_miasto']) expect(s).toContain(`name="${pole}"`)
    expect(s).toContain('Zapisz dane klienta')
    expect(s).toMatch(/<a class="btn[^"]*" href="\/zamowienia\/o161#wysylka">Anuluj<\/a>/)
  })

  it('zamówienie z kanału: bez formularza zamówienia ręcznego, także z parametrem edycji', async () => {
    const s = html(await KartyKlienta({ d: d('WOO'), klient: { ...klient, zrodlo: 'KANAL' } as never, powod: null, pelne: true, edytuj: 'klient' }))
    expect(s).not.toContain('?edytuj=klient')
    expect(s).not.toMatch(/name="imie"/)
    expect(s).toContain('Odbiorca')
  })

  // (E2): kupujący i dane do faktury zamówienia z kanału
  const kanal = { ...klient, zrodlo: 'KANAL' } as never
  it('zamówienie z kanału w pracy: „Edytuj kupującego” i „Edytuj” danych do faktury w odczycie', async () => {
    const s = html(await KartyKlienta({ d: d('WOO'), klient: kanal, powod: null, pelne: true, edytuj: null }))
    expect(s).toContain('href="/zamowienia/o161?edytuj=kupujacy#wysylka">Edytuj kupującego</a>')
    expect(s).toContain('href="/zamowienia/o161?edytuj=faktura#dane-faktury">Edytuj</a>')
    expect(s).not.toMatch(/name="(imie|f_nip)"/)
  })

  it('„Edytuj kupującego”: cztery pola z etykietami, wersja rekordu, adres zostaje w odczycie', async () => {
    const s = html(await KartyKlienta({ d: d('WOO'), klient: kanal, powod: null, pelne: true, edytuj: 'kupujacy' }))
    for (const [pole, etykieta] of [['imie', 'Imię i nazwisko'], ['firma', 'Firma'], ['telefon', 'Telefon'], ['email', 'E-mail']]) {
      expect(s).toContain(`name="${pole}"`)
      expect(s).toMatch(new RegExp(`<label[^>]*for="kup-${pole}"[^>]*>${etykieta}`))
    }
    expect(s).toContain('name="wersja" value="1"')
    expect(s).toContain('Zapisz dane kupującego')
    expect(s).toContain('Nazwisko na etykiecie i na fakturze osoby prywatnej pochodzi z adresu dostawy')
    expect(s).not.toMatch(/name="(ulica|f_nip|uwagi)"/)
    expect(s).toContain('Odbiorca')
    expect(s).toContain('href="/zamowienia/o161#wysylka">Zakończ edycję</a>')
  })

  it('„Edytuj” danych do faktury: trzy stany, z NIP-em zaznaczona faktura na firmę, pola z danymi z rekordu, potwierdzenie usunięcia', async () => {
    const s = html(await KartyKlienta({ d: d('WOO'), klient: kanal, powod: null, pelne: true, edytuj: 'faktura' }))
    expect(s).toMatch(/<input type="radio" name="f_rodzaj" checked="" value="firma"/)
    expect(s).toMatch(/<input type="radio" name="f_rodzaj" value="imienna"\/>/)
    expect(s).toMatch(/<input type="radio" name="f_rodzaj" value="brak"\/>/)
    expect(s).toContain('Faktura imienna (bez NIP-u)')
    expect(s).toMatch(/<input type="checkbox"[^>]*name="f_usun" value="tak"/)
    for (const pole of ['f_nazwa', 'f_nip', 'f_ulica', 'f_kod', 'f_miasto']) expect(s).toContain(`name="${pole}"`)
    expect(s).toContain('value="Firma Testowa"')
    expect(s).toContain('Zapisz dane do faktury')
    expect(s).not.toMatch(/name="imie"/)
    expect(s).not.toContain('name="f_firma"')
  })

  it('faktura imienna z kanału (bez NIP-u): zaznaczona „Faktura imienna”; bez danych i bez prośby: „Bez danych”, bez potwierdzenia usunięcia', async () => {
    const imienna = { ...klient, zrodlo: 'KANAL', rekord: { ...rekord, faktura: { ...rekord.faktura, nip: null } } } as never
    const s = html(await KartyKlienta({ d: d('WOO'), klient: imienna, powod: null, pelne: true, edytuj: 'faktura' }))
    expect(s).toMatch(/<input type="radio" name="f_rodzaj" checked="" value="imienna"/)
    const pusta = { ...klient, zrodlo: 'KANAL', rekord: { ...rekord, faktura: null } } as never
    const p = html(await KartyKlienta({ d: d('WOO'), klient: pusta, powod: null, pelne: true, edytuj: 'faktura' }))
    expect(p).toMatch(/<input type="radio" name="f_rodzaj" checked="" value="brak"/)
    expect(p).not.toContain('name="f_usun"')
  })

  it('brak rekordu przy kanale z danymi: oba „Edytuj” nieaktywne z „Najpierw Odśwież z kanału”, formularzy nie ma także z parametrem', async () => {
    for (const edytuj of [null, 'kupujacy', 'faktura'] as const) {
      const s = html(await KartyKlienta({ d: d('WOO'), klient: { stan: 'BRAK' } as never, powod: 'NIE_ZAPISANO', pelne: true, edytuj }))
      expect(s).toMatch(/aria-disabled="true" title="Najpierw „Odśwież z kanału”[^"]*"[^>]*>Edytuj kupującego/)
      expect(s).toMatch(/aria-disabled="true" title="Najpierw „Odśwież z kanału”[^"]*"[^>]*>Edytuj</)
      expect(s).not.toContain('?edytuj=')
      expect(s).not.toMatch(/name="(imie|f_nip)"/)
    }
    // E3: powód widoczny tekstem także bez najechania (telefon), przycisk odsyła do akapitu
    const s0 = html(await KartyKlienta({ d: d('WOO'), klient: { stan: 'BRAK' } as never, powod: 'NIE_ZAPISANO', pelne: true, edytuj: null }))
    expect(s0).toMatch(/aria-describedby="kl-blokada">Edytuj kupującego/)
    // akapit raz (karta „Wysyłka”), „Edytuj” danych do faktury odsyła do niego
    expect(s0).toMatch(/aria-describedby="kl-blokada">Edytuj</)
    expect(s0).toMatch(/<p id="kl-blokada" class="ui-akcja-powod">Najpierw „Odśwież z kanału”/)
    expect(s0).not.toContain('id="df-blokada"')
    expect(s0).not.toContain('Popraw adres albo punkt odbioru')
    // R2-5: zapis wyłączony albo trwały błąd odczytu: odświeżenie nie pomoże, karta podpowiada poprawkę adresu
    for (const powod of ['ZAPIS_WYLACZONY', 'BLAD_ODCZYTU'] as const) {
      const s = html(await KartyKlienta({ d: d('WOO'), klient: { stan: 'BRAK' } as never, powod, pelne: true, edytuj: null }))
      expect(s).toMatch(/<p id="kl-blokada" class="ui-akcja-powod">Kompletor nie ma jeszcze danych klienta[^<]*„Odśwież z kanału” teraz nie pomoże[^<]*Wpisz adres w „Popraw adres albo punkt odbioru”/)
      expect(s).not.toContain('id="df-blokada"')
    }
    // kanał bez źródła danych: wpisanie od zera dalej możliwe
    const bez = html(await KartyKlienta({ d: d('WOO'), klient: { stan: 'BRAK' } as never, powod: 'KANAL_BEZ_ZRODLA', pelne: true, edytuj: null }))
    expect(bez).toContain('?edytuj=kupujacy#wysylka">Edytuj kupującego</a>')
  })

  it('paczka dodatkowa: oba „Edytuj” nieaktywne, odsyłacz do karty zamówienia głównego', async () => {
    const dp = { ...d('WOO'), o: { ...d('WOO').o, parentOrderId: 'glowne161' } } as unknown as DaneKarty
    for (const edytuj of [null, 'kupujacy', 'faktura'] as const) {
      const s = html(await KartyKlienta({ d: dp, klient: kanal, powod: null, pelne: true, edytuj }))
      expect(s).toMatch(/aria-disabled="true" title="To paczka dodatkowa[^"]*"[^>]*aria-describedby="kl-paczka">Edytuj kupującego/)
      expect(s).toMatch(/aria-disabled="true" title="To paczka dodatkowa[^"]*"[^>]*aria-describedby="df-paczka">Edytuj</)
      expect(s).toContain('href="/zamowienia/glowne161#wysylka">przejdź do zamówienia głównego</a>')
      expect(s).toContain('href="/zamowienia/glowne161#dane-faktury">przejdź do zamówienia głównego</a>')
      expect(s).not.toContain('?edytuj=')
    }
  })

  it('„Tylko podgląd”: oba „Edytuj” nieaktywne z powodem trybu, formularzy nie ma także z parametrem', async () => {
    const POWOD = 'Zmiany zamówienia robisz w podglądzie'
    const dp = { ...d('WOO'), podglad: { powody: { status: POWOD, platnosc: POWOD, pozycje: POWOD }, coDalej: null } } as unknown as DaneKarty
    for (const edytuj of [null, 'kupujacy', 'faktura'] as const) {
      const s = html(await KartyKlienta({ d: dp, klient: kanal, powod: null, pelne: true, edytuj }))
      expect(s).toContain(`aria-disabled="true" title="${POWOD}" data-powod="${POWOD}" aria-describedby="kl-blokada">Edytuj kupującego`)
      expect(s).toContain(`aria-disabled="true" title="${POWOD}" data-powod="${POWOD}" aria-describedby="df-blokada">Edytuj`)
      // E3: powód widoczny bez najechania myszą (telefon), raz w każdej karcie
      expect(s).toContain(`<p id="kl-blokada" class="ui-akcja-powod">${POWOD}</p>`)
      expect(s).toContain(`<p id="df-blokada" class="ui-akcja-powod">${POWOD}</p>`)
      expect(s).not.toContain('?edytuj=')
      expect(s).not.toMatch(/name="(imie|f_nip)"/)
    }
  })

  it('po fakturze: „Edytuj” danych do faktury nieaktywne z wyjaśnieniem widocznym raz, kupujący dalej edytowalny', async () => {
    const id = (await ingestOrder(db, order([{ productId: await product(db, 'A288-F', 5), qty: 1 }]), { now: T0 })).orderId!
    await db.invoiceAttempt.create({ data: { orderId: id, packageNo: 1, attemptNo: 1, idExternal: `${id}/1/1`, state: 'ISSUED' } })
    const df = { o: { id, channel: 'WOO', deliveryMethod: 'Kurier', carrier: null, shippingCostGross: null, wantInvoiceNip: true } } as unknown as DaneKarty
    const s = html(await KartyKlienta({ d: df, klient: kanal, powod: null, pelne: true, edytuj: 'faktura' }))
    expect(s).toContain('aria-describedby="df-powod">Edytuj</span>')
    expect(s).toMatch(/<p id="df-powod" class="muted small">Faktura do tego zamówienia jest już wystawiona w wFirmie/)
    expect(s.split('Faktura do tego zamówienia jest już wystawiona').length - 1).toBe(3) // title, data-powod i akapit, bez kopii dla czytnika
    expect(s).not.toMatch(/name="f_nip"/)
    expect(s).toContain(`href="/zamowienia/${id}?edytuj=kupujacy#wysylka">Edytuj kupującego</a>`)
  })
})
