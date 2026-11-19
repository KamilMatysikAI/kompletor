// komunikaty karty w adresie jako klucze słownika, czyszczenie adresu bez drugiego renderu
// karty i potwierdzenie usunięcia pozycji. Błędy też kodem (stałe ze słownika, z treścią przez
// ciasteczko szczegółów), akcje lib/karta zwracają klucz. Bez bazy i bez przeglądarki: logika czysta + strażnik kodu.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adresBezKomunikatu, adresKarty, BLEDY_KARTY, KOMUNIKATY_KARTY, kodBledu, komunikatZAdresu, tekstKomunikatu, type KluczKomunikatu } from './komunikaty'
import { naKarte, odkodujSzczegoly, szczegolyBledu, zakodujSzczegoly } from './komunikaty-serwer'

const zAdresu = (adres: string, szczegoly?: { k: string; tresc: string } | null) => komunikatZAdresu(new URL(adres, 'http://x').searchParams, szczegoly)
const KARTA = path.resolve(__dirname, '../../app/(panel)/zamowienia/[id]')

function sloik() {
  const mapa = new Map<string, { wartosc: string; opcje: Record<string, unknown> }>()
  return {
    mapa,
    set: (n: string, wartosc: string, opcje: Record<string, unknown>) => mapa.set(n, { wartosc, opcje }),
    get: (n: string) => (mapa.has(n) ? { value: mapa.get(n)!.wartosc } : undefined),
  }
}

describe('komunikaty karty w adresie', () => {
  it('sukces jedzie kluczem, tekst wraca ze słownika; liczby w szablonach', () => {
    expect(adresKarty('o1', { ok: 'pozycje.jedna' })).toBe('/zamowienia/o1?ok=pozycje.jedna')
    expect(adresKarty('o1', { ok: 'pozycje.wiele', n: 3 })).toBe('/zamowienia/o1?ok=pozycje.wiele&n=3')
    expect(zAdresu('/zamowienia/o1?ok=pozycje.wiele&n=5')).toEqual({ rodzaj: 'sukces', tresc: 'Zapisano 5 zmian pozycji.' })
    expect(adresKarty('o1', { ok: 'pozycje.paczka', n: 2 })).toBe('/zamowienia/o1?ok=pozycje.paczka&n=2')
    expect(adresKarty('o1', { ok: 'notatka' }, '#notatki')).toBe('/zamowienia/o1?ok=notatka#notatki')
    // liczba tylko przy szablonie z liczbą
    expect(adresKarty('o1', { ok: 'notatka', n: 4 })).toBe('/zamowienia/o1?ok=notatka')
    expect(adresKarty('o1', {})).toBe('/zamowienia/o1')
  })

  it('każdy klucz słownika daje tekst (klucz → adres → tekst)', () => {
    for (const [klucz, k] of Object.entries(KOMUNIKATY_KARTY)) {
      const tekst = typeof k === 'string' ? k : k(7)
      expect(zAdresu(adresKarty('o1', { ok: klucz as KluczKomunikatu, n: 7 }))).toEqual({ rodzaj: 'sukces', tresc: tekst })
      expect(tekstKomunikatu(klucz, '7')).toBe(tekst)
    }
  })

  it('spreparowany link: dowolny tekst w ?ok= nie pokazuje komunikatu; nieznany klucz i zła liczba też nie', () => {
    expect(zAdresu('/zamowienia/o1?ok=Przelew+przyj%C4%99ty%2C+wy%C5%9Blij+towar')).toBeNull()
    expect(zAdresu('/zamowienia/o1?ok=toString')).toBeNull()
    expect(zAdresu('/zamowienia/o1?ok=pozycje.wiele')).toBeNull()
    expect(zAdresu('/zamowienia/o1?ok=pozycje.wiele&n=-1')).toBeNull()
    expect(zAdresu('/zamowienia/o1?info=__proto__')).toBeNull()
  })

  it('„Brak zmian” jako informacja', () => {
    expect(adresKarty('o1', { info: 'pozycje.brak' })).toBe('/zamowienia/o1?info=pozycje.brak')
    expect(zAdresu('/zamowienia/o1?info=pozycje.brak')).toEqual({ rodzaj: 'info', tresc: 'Brak zmian do zapisania.' })
  })

  it('adres bez komunikatu zachowuje resztę zapytania i kotwicę (także id szczegółów)', () => {
    expect(adresBezKomunikatu('/zamowienia/o1', 'ok=pozycje.wiele&n=3&historia=ludzie', '#pozycje')).toBe('/zamowienia/o1?historia=ludzie#pozycje')
    expect(adresBezKomunikatu('/zamowienia/o1', 'blad=szczegoly&k=0123456789ab', '')).toBe('/zamowienia/o1')
  })
})

describe('błędy kodem w adresie (dokończenie)', () => {
  it('błąd stały jedzie kodem słownika i wraca tym samym tekstem; błąd ma pierwszeństwo', () => {
    for (const [kod, tekst] of Object.entries(BLEDY_KARTY)) {
      expect(kodBledu(tekst)).toBe(kod)
      const adres = adresKarty('o1', { blad: tekst, ok: 'zapisano' })
      expect(adres).toBe(`/zamowienia/o1?blad=${kod}`)
      expect(zAdresu(adres)).toEqual({ rodzaj: 'blad', tresc: tekst })
    }
  })

  it('tekst w ?blad= nigdy nie jest pokazywany: obcy tekst i obcy kod dają ogólny komunikat', () => {
    expect(zAdresu('/zamowienia/o1?blad=Zap%C5%82a%C4%87+na+konto+123')).toEqual({ rodzaj: 'blad', tresc: BLEDY_KARTY.nieznany })
    expect(zAdresu('/zamowienia/o1?blad=__proto__')).toEqual({ rodzaj: 'blad', tresc: BLEDY_KARTY.nieznany })
    // błąd z treścią bez ciasteczka (wygasło albo obcy link) też ogólnie
    expect(zAdresu('/zamowienia/o1?blad=szczegoly&k=0123456789ab')).toEqual({ rodzaj: 'blad', tresc: BLEDY_KARTY.nieznany })
    expect(zAdresu('/zamowienia/o1?blad=szczegoly&k=0123456789ab', { k: 'ffffffffffff', tresc: 'cudze' })).toEqual({ rodzaj: 'blad', tresc: BLEDY_KARTY.nieznany })
  })

  it('błąd z treścią: ciasteczko httpOnly na ścieżce karty, w adresie tylko id; strona pokazuje treść przy zgodnym id', async () => {
    const jar = sloik()
    const tresc = 'Zapisano 1 zmianę, nie zapisano: SKU ŻÓŁW-1: Część tej pozycji jest już dosłana albo zamieniona'
    const adres = await naKarte('o1', { blad: tresc }, '', jar)
    const u = new URL(adres, 'http://x')
    expect(u.pathname).toBe('/zamowienia/o1')
    expect(u.searchParams.get('blad')).toBe('szczegoly')
    expect(adres).not.toContain('SKU')
    const zapis = [...jar.mapa.values()][0]!
    expect(zapis.opcje).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/zamowienia/o1', maxAge: 120 })
    const sz = await szczegolyBledu(jar)
    expect(sz?.k).toBe(u.searchParams.get('k'))
    expect(zAdresu(adres, sz)).toEqual({ rodzaj: 'blad', tresc })
    // błąd stały: bez ciasteczka
    const jar2 = sloik()
    expect(await naKarte('o1', { blad: BLEDY_KARTY['tryb-podgladu'] }, '', jar2)).toBe('/zamowienia/o1?blad=tryb-podgladu')
    expect(jar2.mapa.size).toBe(0)
  })

  it('ciasteczko: zła wartość odrzucona, treść ucięta do 1000 znaków', () => {
    expect(odkodujSzczegoly('xyz.abc')).toBeNull()
    expect(odkodujSzczegoly('0123456789ab.<script>')).toBeNull()
    expect(odkodujSzczegoly(undefined)).toBeNull()
    expect(odkodujSzczegoly(zakodujSzczegoly('0123456789ab', 'ą'.repeat(1200)))?.tresc).toBe('ą'.repeat(1000))
  })

  it('akcje karty nie przekazują tekstu sukcesu do adresu (tylko klucze) ani tekstu błędu w ?blad=', () => {
    for (const f of ['akcje-pozycje.ts', 'akcje-opis.ts', 'akcje-notatki.ts', 'akcje-platnosc.ts', 'akcje-klient.ts', 'akcje-praca.ts', 'akcje-status.ts']) {
      const kod = readFileSync(path.join(KARTA, f), 'utf8')
      expect(kod, f).not.toMatch(/\?blad=\$\{/)
      expect(kod, f).not.toMatch(/ok: '[A-ZŻŹĆŁŚ][^']*\.'/)
    }
  })
})

describe('strażnik kodu karty', () => {
  it('toast czyści adres przez history.replaceState, bez nawigacji routera (drugi render = drugi KLIENT_PODGLAD)', () => {
    const kod = readFileSync(path.join(KARTA, 'toast-z-adresu.tsx'), 'utf8').replace(/\/\/.*$/gm, '')
    expect(kod).toContain('window.history.replaceState(')
    expect(kod).not.toMatch(/useRouter|router\.(replace|push|refresh)/)
    // „Odśwież z kanału” bez router.refresh (akcja sama robi revalidatePath)
    expect(readFileSync(path.join(KARTA, 'klient-przyciski.tsx'), 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/router\.refresh/)
  })

  it('formularz pozycji z „usuń” ma okno potwierdzenia, a pole niesie nazwę pozycji do listy w oknie', () => {
    const kod = readFileSync(path.join(KARTA, 'pozycje.tsx'), 'utf8')
    expect(kod).toMatch(/\{edycja && <PotwierdzUsuniecie \/>\}/)
    expect(kod).toMatch(/name=\{`usun_\$\{l\.id\}`\}[^>]*data-nazwa=/)
  })

  it('lista pozycji do usunięcia z zaznaczonych pól', async () => {
    const { pozycjeDoUsuniecia } = await import('../../app/(panel)/zamowienia/[id]/potwierdz-usuniecie')
    const pola = [{ dataset: { nazwa: 'Przyprawa (SKU H-1)' } }, { dataset: {} }]
    const form = { querySelectorAll: (s: string) => (s.includes(':checked') && s.includes('usun_') ? pola : []) } as unknown as ParentNode
    expect(pozycjeDoUsuniecia(form)).toEqual(['Przyprawa (SKU H-1)', 'pozycja bez nazwy'])
  })
})
