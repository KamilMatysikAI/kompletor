import { describe, expect, it } from 'vitest'
import { BladSzablonu, formatujDateCzas, formatujKwote, wCiaguDniRoboczych } from './formaty'
import { nazwaPlikuFaktury, renderujMail, sprawdzNadpisanie } from './mail'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY, PDF_PRZYKLADOWY } from './przyklady'
import { renderujTekst } from './silnik'
import { SZABLONY_DOMYSLNE } from './szablony'
import type { Blok, KontekstMarki, RodzajMaila } from './typy'

const RODZAJE = Object.keys(SZABLONY_DOMYSLNE) as RodzajMaila[]
const K = KONTEKST_PRZYKLADOWY
const ZNACZNIK = /<\/?[a-z!][^>]*>/i

function render<R extends RodzajMaila>(rodzaj: R, zmiana: Partial<(typeof DANE_PRZYKLADOWE)[R]> = {}, k: KontekstMarki = K) {
  return renderujMail(rodzaj, k, { ...DANE_PRZYKLADOWE[rodzaj], ...zmiana })
}

function bladRenderu(f: () => unknown): BladSzablonu {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(BladSzablonu)
    return e as BladSzablonu
  }
  throw new Error('oczekiwano BladSzablonu')
}

function tekstyBlokow(b: Blok): string[] {
  switch (b.typ) {
    case 'szczegoly':
      return b.wiersze.flatMap((w) => [w.etykieta, w.wartosc])
    case 'przycisk':
      return [b.etykieta]
    case 'lista':
      return b.naglowek ? [b.naglowek] : []
    default:
      return [b.tekst]
  }
}

describe('szablony domyślne', () => {
  it.each(RODZAJE)('%s renderuje się z fikcyjnymi danymi', (rodzaj) => {
    const m = render(rodzaj)
    // szablony bez zamówienia (niski stan, reset hasła) mają własny znak rozpoznawczy w temacie
    const znak = rodzaj === 'niski-stan' ? 'KUB-300' : rodzaj === 'reset-hasla' || rodzaj === 'zaproszenie' ? 'Firma Testowa' : 'ZAM-2026-00123'
    expect(m.rodzaj).toBe(rodzaj)
    expect(m.temat).toContain(znak)
    expect(m.temat).not.toMatch(/[\r\n]/)
    expect(m.html).toMatch(/^<!DOCTYPE html>/)
    expect(m.html).toContain(znak)
    expect(m.tekst).toContain(znak)
    expect(m.odpowiedzDo).toBe('sklep@example.com')
    expect(m.tekst).toContain('Firma Testowa sp. z o.o.')
    expect(m.html).not.toMatch(/\{\{|\}\}/)
    expect(m.tekst).not.toMatch(/\{\{|\}\}/)
  })

  it('brak płatności: numer, kwota, link, N dni roboczych i data anulowania', () => {
    const m = render('brak-platnosci')
    expect(m.odbiorca).toBe('klient')
    expect(m.do).toBeNull()
    expect(m.tekst).toContain('Kwota do zapłaty: 1 234,50 zł')
    expect(m.tekst).toContain('Zapłać za zamówienie: https://platnosci.example.com/zaplac?zamowienie=ZAM-2026-00123&kwota=1234.50')
    expect(m.html).toContain('href="https://platnosci.example.com/zaplac?zamowienie=ZAM-2026-00123&amp;kwota=1234.50"')
    expect(m.tekst).toContain('Jeśli płatność nie wpłynie do 30 października 2026, zamówienie zostanie anulowane.')
    expect(m.tekst).not.toContain('w ciągu')
  })

  it('brak płatności: z datą anulowania treść „do <data>” także w sezonie, bez daty „w ciągu N dni roboczych”', () => {
    // Sezon: okres 1 dzień roboczy, przypomnienie po 2 dniach. Zdanie z datą nie obiecuje terminu, który minął.
    const sezon = render('brak-platnosci', { dniDoAnulowania: 1, terminAnulowania: new Date('2026-12-15T12:00:00Z') })
    expect(sezon.tekst).toContain('Jeśli płatność nie wpłynie do 15 grudnia 2026, zamówienie zostanie anulowane.')
    expect(sezon.tekst).not.toMatch(/w ciągu|dnia roboczego/)
    expect(sezon.html).toContain('do 15 grudnia 2026, zamówienie zostanie anulowane')
    const bezDaty = render('brak-platnosci', { terminAnulowania: null })
    expect(bezDaty.tekst).toContain('Jeśli płatność nie wpłynie w ciągu 5 dni roboczych od złożenia zamówienia, zamówienie zostanie anulowane.')
    expect(bezDaty.tekst).not.toContain('października')
  })

  it('pozycje: brak nazwy to błąd, pusta lista pomija blok', () => {
    const bezNazwy = [{ nazwa: undefined, ilosc: 2 }] as unknown as { nazwa: string; ilosc: number }[]
    expect(bladRenderu(() => render('brak-platnosci', { pozycje: bezNazwy })).message).toContain('pozycja 1: brak nazwy produktu')
    bladRenderu(() => render('gotowe-do-odbioru', { pozycje: [{ nazwa: '   ', ilosc: 1 }] }))
    expect(render('brak-platnosci', { pozycje: [] }).tekst).not.toContain('Zamówione produkty')
  })

  it('brak płatności bez linku: zamiast przycisku informacja o płatności; w sezonie krótszy termin', () => {
    const m = render('brak-platnosci', { linkPlatnosci: null, dniDoAnulowania: 1, terminAnulowania: null, pozycje: null })
    expect(m.html).not.toContain('Zapłać za zamówienie')
    expect(m.tekst).toContain('Płatności można dokonać w sposób wybrany przy składaniu zamówienia.')
    expect(m.tekst).toContain('w ciągu 1 dnia roboczego od złożenia zamówienia, zamówienie')
    expect(m.tekst).not.toContain('Zamówione produkty')
  })

  it('faktura: PDF z danych wraca jako załącznik, numer faktury i zamówienia w treści', () => {
    const m = render('faktura')
    expect(m.zalaczniki).toEqual([{ nazwaPliku: 'Faktura-FV-123-10-2026.pdf', typMime: 'application/pdf', tresc: PDF_PRZYKLADOWY }])
    expect(m.temat).toBe('Faktura FV 123/10/2026 do zamówienia ZAM-2026-00123')
    expect(m.tekst).toContain('Numer faktury: FV 123/10/2026')
    expect(render('faktura', { pdf: { tresc: PDF_PRZYKLADOWY, nazwaPliku: 'FV/1.PDF' } }).zalaczniki[0]!.nazwaPliku).toBe('FV-1.pdf')
    expect(m.html).toContain('FV 123/10/2026')
    expect(m.html).toContain('W załączniku przesyłamy fakturę FV 123/10/2026.')
  })

  it.each([null, undefined, ''])('faktura bez numeru (%s): temat, treść i nazwa pliku bez numeru, PDF w załączniku', (numerFaktury) => {
    const m = render('faktura', { numerFaktury })
    expect(m.temat).toBe('Faktura do zamówienia ZAM-2026-00123')
    expect(m.html).toContain('W załączniku przesyłamy fakturę do zamówienia ZAM-2026-00123.')
    expect(m.tekst).toContain('w załączniku przesyłamy fakturę do zamówienia złożonego w sklepie')
    expect(m.tekst).toContain('Numer zamówienia: ZAM-2026-00123')
    expect(m.tekst).not.toContain('Numer faktury')
    expect(m.html).not.toContain('Numer faktury')
    expect(`${m.temat} ${m.tekst} ${m.html}`).not.toMatch(/fakturę \.|Faktura {2}|nr\s*$/)
    expect(m.zalaczniki).toEqual([{ nazwaPliku: 'Faktura-do-zamówienia-ZAM-2026-00123.pdf', typMime: 'application/pdf', tresc: PDF_PRZYKLADOWY }])
  })

  it('faktura bez numeru: treść firmy z numerem poza sekcją ustępuje treści domyślnej, z numerem zostaje', () => {
    const nadpisania = { firma: { faktura: { temat: 'Twoja faktura {{numerFaktury}} ({{numerZamowienia}})', naglowek: 'Nagłówek firmy' } } }
    expect(renderujMail('faktura', K, DANE_PRZYKLADOWE.faktura, { nadpisania }).temat).toBe('Twoja faktura FV 123/10/2026 (ZAM-2026-00123)')
    const bez = renderujMail('faktura', K, { ...DANE_PRZYKLADOWE.faktura, numerFaktury: null }, { nadpisania })
    expect(bez.temat).toBe('Faktura do zamówienia ZAM-2026-00123')
    expect(bez.zalaczniki).toHaveLength(1)
    // treść firmy z numerem w sekcji działa także bez numeru
    const wSekcji = { firma: { faktura: { temat: 'Twoja faktura{{#numerFaktury}} {{numerFaktury}}{{/numerFaktury}} ({{numerZamowienia}})' } } }
    expect(renderujMail('faktura', K, { ...DANE_PRZYKLADOWE.faktura, numerFaktury: null }, { nadpisania: wSekcji }).temat).toBe('Twoja faktura (ZAM-2026-00123)')
    // inne błędy treści firmy nie są maskowane
    expect(bladRenderu(() => renderujMail('faktura', K, { ...DANE_PRZYKLADOWE.faktura, numerFaktury: null }, { nadpisania: { firma: { faktura: { temat: '{{nieMa}}' } } } })).bledy).toEqual(['temat: nieznana zmienna „nieMa”'])
  })

  it('faktura: brak PDF albo plik, który nie jest PDF, to błąd', () => {
    bladRenderu(() => render('faktura', { pdf: undefined }))
    bladRenderu(() => render('faktura', { pdf: { tresc: new Uint8Array() } }))
    expect(bladRenderu(() => render('faktura', { pdf: { tresc: new TextEncoder().encode('<html>') } })).message).toContain('nie jest plikiem PDF')
  })

  it('gotowe do odbioru: adres i godziny z danych sklepu', () => {
    const m = render('gotowe-do-odbioru')
    expect(m.tekst).toContain('Adres odbioru:\n- Sklep Żółwik\n- ul. Przykładowa 1\n- 00-000 Testowo')
    expect(m.tekst).toContain('Godziny odbioru:\n- poniedziałek-piątek 9:00-17:00\n- sobota 10:00-14:00')
    expect(m.tekst).toContain('do 6 listopada 2026')
    const bezOdbioru = { ...K, sklep: { ...K.sklep, odbiorOsobisty: null } }
    expect(bladRenderu(() => render('gotowe-do-odbioru', {}, bezOdbioru)).bledy).toEqual([
      'sklep „Żółwik”: brak adresu odbioru osobistego',
      'sklep „Żółwik”: brak godzin odbioru osobistego',
    ])
    const bezGodzin = { ...K, sklep: { ...K.sklep, odbiorOsobisty: { ...K.sklep.odbiorOsobisty!, godziny: [' '] } } }
    expect(bladRenderu(() => render('gotowe-do-odbioru', {}, bezGodzin)).bledy).toEqual([
      'sklep „Żółwik”: brak godzin odbioru osobistego',
    ])
  })

  it('błąd faktury: mail wewnętrzny do biura z treścią błędu i linkiem do panelu', () => {
    const m = render('blad-faktury')
    expect(m.odbiorca).toBe('biuro')
    expect(m.do).toBe('biuro@example.com')
    expect(m.tekst).toMatch(/^\[WIADOMOŚĆ WEWNĘTRZNA\]/)
    expect(m.html).toContain('WIADOMOŚĆ WEWNĘTRZNA')
    expect(m.html).toContain('href="https://panel.example.com/zamowienia/ZAM-2026-00123"')
    expect(m.tekst).toContain('    Kontrahent: brak pola <zip> (kod pocztowy)')
    expect(m.tekst).toContain('Kiedy: 25 października 2026, 14:05')
    expect(m.tekst).not.toContain('Ta wiadomość dotyczy zamówienia w sklepie')
    expect(render('faktura').tekst).toContain('Ta wiadomość dotyczy zamówienia w sklepie Żółwik.')
    const bezBiura = { ...K, firma: { ...K.firma, emailBiura: null } }
    bladRenderu(() => render('blad-faktury', {}, bezBiura))
  })

  it('powitanie z imieniem i bez', () => {
    expect(render('faktura').tekst).toContain('Dzień dobry Jan,')
    expect(render('faktura', { imie: '  ' }).tekst).toContain('Dzień dobry,')
    expect(render('faktura', { imie: null }).tekst).toContain('Dzień dobry,')
  })

  it.each(RODZAJE)('%s: ton bez długich myślników i nadmiaru wykrzykników', (rodzaj) => {
    const d = SZABLONY_DOMYSLNE[rodzaj]
    const teksty = [d.temat, d.podglad, d.naglowek, ...d.bloki.flatMap(tekstyBlokow)].join('\n')
    expect(teksty).not.toMatch(/[–—]|--/)
    expect((teksty.match(/!/g) ?? []).length).toBeLessThanOrEqual(1)
    const m = render(rodzaj)
    expect(m.tekst.replace(/^-- $/m, '')).not.toMatch(/[–—]/)
  })
})

describe('brak zmiennej to błąd, nie pusty tekst', () => {
  // niski stan i reset hasła nie dotyczą zamówienia
  it.each(RODZAJE.filter((r) => SZABLONY_DOMYSLNE[r].zmienne['numerZamowienia']))('%s bez numeru zamówienia', (rodzaj) => {
    const e = bladRenderu(() => render(rodzaj, { numerZamowienia: undefined } as never))
    expect(e.message).toContain('numerZamowienia')
  })

  it('pusty tekst traktujemy jak brak', () => {
    expect(bladRenderu(() => render('faktura', { numerZamowienia: '   ' })).message).toContain('numerZamowienia')
    // numer faktury jest nieobowiązkowy: pusty = wariant bez numeru, nie błąd
    expect(render('faktura', { numerFaktury: '   ' }).temat).toBe('Faktura do zamówienia ZAM-2026-00123')
  })

  it('zmienna opcjonalna użyta poza sekcją i nieobecna', () => {
    expect(() => renderujTekst('Link: {{link}}', {})).toThrow(BladSzablonu)
    expect(renderujTekst('{{#link}}Link: {{link}}{{/link}}{{^link}}brak{{/link}}', {})).toBe('brak')
  })

  it('nadpisanie z nieznaną zmienną albo złą składnią jest odrzucane', () => {
    expect(sprawdzNadpisanie('faktura', { temat: 'Faktura {{numerFaktury}}' })).toEqual([])
    expect(sprawdzNadpisanie('faktura', { temat: 'Faktura {{nieMa}}' })).toEqual(['temat: nieznana zmienna „nieMa”'])
    expect(sprawdzNadpisanie('faktura', { temat: 'Faktura {{#imie}}x' })[0]).toContain('niezamknięta sekcja')
    expect(sprawdzNadpisanie('faktura', { temat: 'Faktura {numer}}' })[0]).toContain('niepoprawny znacznik')
    expect(sprawdzNadpisanie('faktura', { bloki: [{ typ: 'obrazek' } as unknown as Blok] })[0]).toContain('nieznany typ bloku')
    const e = bladRenderu(() =>
      renderujMail('faktura', K, DANE_PRZYKLADOWE.faktura, { nadpisania: { sklep: { faktura: { temat: '{{nieMa}}' } } } }),
    )
    expect(e.bledy).toEqual(['temat: nieznana zmienna „nieMa”'])
  })

  it('nadpisanie dla nieznanego rodzaju maila zwraca błąd zamiast wyjątku', () => {
    expect(sprawdzNadpisanie('xxx' as RodzajMaila, { temat: 'x' })).toEqual(['nieznany rodzaj maila „xxx”'])
    expect(sprawdzNadpisanie('toString' as RodzajMaila, { temat: 'x' })).toEqual(['nieznany rodzaj maila „toString”'])
  })

  it('nadpisanie: jesli z nieznaną zmienną odrzucone, puste bloki wracają do domyślnych', () => {
    expect(sprawdzNadpisanie('faktura', { bloki: [{ typ: 'akapit', tekst: 'x', jesli: 'nieMa' }] }).join(' ')).toContain('nieMa')
    expect(sprawdzNadpisanie('faktura', { bloki: [] })).toEqual([])
    const m = renderujMail('faktura', K, DANE_PRZYKLADOWE.faktura, { nadpisania: { firma: { faktura: { bloki: [] } } } })
    expect(m.tekst).toContain('w załączniku przesyłamy fakturę')
  })

  it('zagnieżdżone sekcje działają, niedopasowane zamknięcie jest błędem', () => {
    const wzor = '{{#a}}A{{#b}}+B{{/b}}{{^b}}-B{{/b}}{{/a}}'
    expect(renderujTekst(wzor, { a: 'x', b: 'y' })).toBe('A+B')
    expect(renderujTekst(wzor, { a: 'x' })).toBe('A-B')
    expect(renderujTekst(wzor, {})).toBe('')
    expect(() => renderujTekst('{{#a}}x{{/b}}', { a: 'x' })).toThrow(BladSzablonu)
  })
})

describe('ucieczka HTML i bezpieczeństwo', () => {
  it('znaki sterujące (NUL, BEL) z danych nie trafiają do tematu ani HTML', () => {
    const m = render('faktura', { numerFaktury: 'FV\u0000\u00071' })
    expect(m.temat).toBe('Faktura FV 1 do zamówienia ZAM-2026-00123')
    expect(m.temat).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(m.html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
    expect(m.tekst).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
  })

  it('znaki C1 (U+0080–U+009F) z danych znikają z HTML i tekstu tak jak z tematu; NBSP zostaje', () => {
    const m = render('faktura', { numerFaktury: 'FV\u0085\u009b1\u00a02' })
    expect(m.temat).not.toMatch(/[\u0080-\u009f]/)
    expect(m.html).not.toMatch(/[\u0080-\u009f]/)
    expect(m.tekst).not.toMatch(/[\u0080-\u009f]/)
    expect(m.html).toContain('FV1\u00a02')
    expect(m.tekst).toContain('FV1\u00a02')
  })

  it('szerokość logo z bazy jako tekst jest zamieniana na liczbę; pusty tekst = domyślna', () => {
    expect(render('faktura', {}, { ...K, sklep: { ...K.sklep, logoSzerokosc: '200' } }).html).toContain('width="200"')
    expect(render('faktura', {}, { ...K, sklep: { ...K.sklep, logoSzerokosc: ' ' } }).html).toContain('width="160"')
    for (const logoSzerokosc of ['abc', '0', '-5']) {
      const k = { ...K, sklep: { ...K.sklep, logoSzerokosc } }
      expect(bladRenderu(() => render('faktura', {}, k)).message).toContain('szerokość logo')
    }
  })

  it('szerokość logo musi być dodatnią liczbą; logo ciemne bez zwykłego to błąd konfiguracji', () => {
    for (const logoSzerokosc of [Number.NaN, Number.POSITIVE_INFINITY, 0, -10]) {
      const k = { ...K, sklep: { ...K.sklep, logoSzerokosc } }
      expect(bladRenderu(() => render('faktura', {}, k)).message).toContain('szerokość logo')
    }
    expect(render('faktura', {}, { ...K, sklep: { ...K.sklep, logoSzerokosc: null } }).html).toContain('width="160"')
    const ciemneBezJasnego = { ...K, sklep: { ...K.sklep, logoUrl: null, logoCiemneUrl: 'https://example.com/logo-ciemne.png' } }
    expect(bladRenderu(() => render('faktura', {}, ciemneBezJasnego)).message).toContain('logo w wersji ciemnej')
    expect(render('faktura').html).not.toContain('class=""')
  })

  it('podgląd w skrzynce ma wypełniacz, więc klient nie dokleja dalszej treści', () => {
    expect(render('faktura').html).toMatch(/W załączniku przesyłamy fakturę FV 123\/10\/2026\.(&zwnj;&nbsp;){60}<\/div>/)
  })

  it('nazwa produktu ze znakiem < i & jest uciekana w HTML, w tekście zostaje jak jest', () => {
    const m = render('brak-platnosci')
    expect(m.html).toContain('1 × Zestaw &lt;Prezent&gt; „Jesień” &amp; dzbanek')
    expect(m.html).not.toContain('<Prezent>')
    expect(m.tekst).toContain('1 × Zestaw <Prezent> „Jesień” & dzbanek')
  })

  it('imię, treść błędu i tekst nadpisania nie wstrzykują znaczników', () => {
    const m = render('brak-platnosci', { imie: '<script>alert(1)</script>' })
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(render('blad-faktury').html).toContain('brak pola &lt;zip&gt;')
    const n = renderujMail('faktura', K, DANE_PRZYKLADOWE.faktura, {
      nadpisania: { sklep: { faktura: { bloki: [{ typ: 'akapit', tekst: '<b onclick="x">Dziękujemy</b>' }] } } },
    })
    expect(n.html).toContain('&lt;b onclick=&quot;x&quot;&gt;Dziękujemy&lt;/b&gt;')
  })

  it('link spoza http(s) jest odrzucany', () => {
    bladRenderu(() => render('brak-platnosci', { linkPlatnosci: 'javascript:alert(1)' }))
    bladRenderu(() => render('blad-faktury', { linkDoZamowienia: 'data:text/html,x' }))
    bladRenderu(() => render('faktura', {}, { ...K, sklep: { ...K.sklep, logoUrl: 'javascript:x' } }))
  })

  it('zły kolor i adres do odpowiedzi marki to błąd', () => {
    const e = bladRenderu(() =>
      render('faktura', {}, { ...K, sklep: { ...K.sklep, kolorGlowny: 'red;background:url(x)', odpowiedzDo: 'nie-mail' } }),
    )
    expect(e.bledy).toHaveLength(2)
  })

  it('nowa linia w danych nie przechodzi do tematu (nagłówek maila)', () => {
    const m = render('faktura', { numerFaktury: 'FV 1\r\nBcc: ktos@example.com' })
    expect(m.temat).toBe('Faktura FV 1 Bcc: ktos@example.com do zamówienia ZAM-2026-00123')
  })
})

describe('polskie znaki', () => {
  it('w temacie i treści (HTML w UTF-8, tekst bez encji)', () => {
    const sklep = { ...K.sklep, nazwa: 'Zażółć Gęślą Jaźń' }
    const m = render('blad-faktury', {}, { ...K, sklep })
    expect(m.temat).toBe('Błąd wystawiania faktury: zamówienie ZAM-2026-00123 (Zażółć Gęślą Jaźń)')
    expect(m.html).toContain('<meta charset="utf-8">')
    expect(m.html).toContain('Nie udało się wystawić faktury')
    expect(m.html).toContain('Zażółć Gęślą Jaźń')
    expect(m.tekst).toContain('ze sklepu Zażółć Gęślą Jaźń nie została wystawiona')
    expect(m.tekst).not.toMatch(/&[a-z#0-9]+;/i)
  })
})

describe('wersja tekstowa', () => {
  it.each(RODZAJE)('%s: bez znaczników HTML', (rodzaj) => {
    // Dane bez nawiasów ostrych: w wersji tekstowej dane klienta zostają dosłowne (patrz test ucieczki).
    const zmiana =
      rodzaj === 'brak-platnosci' || rodzaj === 'nieudana-platnosc'
        ? { pozycje: [{ nazwa: 'Przyprawa', ilosc: 1 }] }
        : rodzaj === 'blad-faktury'
          ? { trescBledu: 'Brak kodu pocztowego' }
          : {}
    const m = render(rodzaj, zmiana as never)
    expect(m.tekst).not.toMatch(ZNACZNIK)
    expect(m.tekst).not.toMatch(/&(amp|lt|gt|quot|nbsp);/)
    expect(m.tekst.endsWith('\n')).toBe(true)
  })
})

describe('HTML dla klientów pocztowych', () => {
  it.each(RODZAJE)('%s: tabele, style inline, 600 px, bez zewnętrznych czcionek', (rodzaj) => {
    const { html } = render(rodzaj)
    expect(html).toContain('width="600"')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).not.toMatch(/<link\b|@import|@font-face|fonts\.googleapis/i)
    expect(html).not.toMatch(/<(div|p|h1|td|a)\b[^>]*\bclass="[^"]*"(?![^>]*style=)/) // klasa bez stylu inline
    expect(html).not.toMatch(/<script/i)
    const zrodla = [...html.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1])
    expect(zrodla.every((s) => s === 'https://example.com/logo.png')).toBe(true)
  })

  it('logo na białej plakietce; wersja ciemna podmieniana przez prefers-color-scheme', () => {
    const { html } = render('faktura')
    expect(html).toMatch(/bgcolor="#ffffff" style="background-color:#ffffff;padding:8px;/)
    const ciemne = render('faktura', {}, { ...K, sklep: { ...K.sklep, logoCiemneUrl: 'https://example.com/logo-ciemne.png' } }).html
    expect(ciemne).toContain('class="logo-ciemne" src="https://example.com/logo-ciemne.png"')
    expect(ciemne).toContain('@media (prefers-color-scheme: dark)')
  })

  it('bez logo nagłówkiem jest nazwa sklepu; jasny kolor marki ma czarny tekst przycisku', () => {
    const sklep = { ...K.sklep, logoUrl: null, kolorGlowny: '#ffd500' }
    const { html } = render('brak-platnosci', {}, { ...K, sklep })
    expect(html).not.toContain('<img')
    expect(html).toContain('>Żółwik</p>')
    expect(html).toContain('color:#000000;text-decoration:none')
  })
})

describe('nadpisania per firma i per sklep', () => {
  it('sklep wygrywa z firmą, firma z domyślnym, pole po polu', () => {
    const m = renderujMail('faktura', K, DANE_PRZYKLADOWE.faktura, {
      nadpisania: {
        firma: { faktura: { temat: 'Firma: faktura {{numerFaktury}}', naglowek: 'Nagłówek firmy' } },
        sklep: { faktura: { temat: 'Sklep {{sklep.nazwa}}: faktura {{numerFaktury}}' } },
      },
    })
    expect(m.temat).toBe('Sklep Żółwik: faktura FV 123/10/2026')
    expect(m.tekst).toContain('Nagłówek firmy')
    expect(m.zalaczniki).toHaveLength(1)
  })
})

describe('formaty', () => {
  it('kwoty, odmiana dni roboczych, daty w Europe/Warsaw', () => {
    expect(formatujKwote(0)).toBe('0,00 zł')
    expect(formatujKwote(5)).toBe('0,05 zł')
    expect(formatujKwote(123_456_789, 'EUR')).toBe('1 234 567,89 EUR')
    expect(() => formatujKwote(1.5)).toThrow(BladSzablonu)
    expect(wCiaguDniRoboczych(1)).toBe('1 dnia roboczego')
    expect(wCiaguDniRoboczych(3)).toBe('3 dni roboczych')
    expect(() => wCiaguDniRoboczych(0)).toThrow(BladSzablonu)
    expect(formatujDateCzas(new Date('2026-07-01T22:30:00Z'))).toBe('2 lipca 2026, 00:30') // CEST
    expect(formatujDateCzas(new Date('2026-12-31T23:15:00Z'))).toBe('1 stycznia 2027, 00:15') // CET
    expect(nazwaPlikuFaktury('FV 12/10/2026')).toBe('Faktura-FV-12-10-2026.pdf')
    expect(nazwaPlikuFaktury('Korekta Ś/1')).toBe('Faktura-Korekta-Ś-1.pdf')
  })
})

describe('niski stan i reset hasła', () => {
  it('niski stan idzie do biura z liczbami i bez linku, gdy go nie ma', () => {
    const m = render('niski-stan', { linkDoProduktu: null })
    expect(m.odbiorca).toBe('biuro')
    expect(m.do).toBe('biuro@example.com')
    expect(m.temat).toBe('Niski stan: KUB-300 Kubek ceramiczny 300 ml')
    expect(m.tekst).toContain('Dostępne: 3 szt.')
    expect(m.tekst).toContain('Próg: 10 szt.')
    expect(m.tekst).not.toContain('Otwórz produkt')
    bladRenderu(() => render('niski-stan', {}, { ...K, firma: { ...K.firma, emailBiura: null } }))
  })

  it('reset hasła: adresat to konto, link jednorazowy tylko http(s), polskie znaki w HTML', () => {
    const m = render('reset-hasla')
    expect(m.do).toBe('osoba@example.com')
    expect(m.tekst).toContain('Ustaw nowe hasło: https://panel.example.com/nowe-haslo?t=przyklad-tokenu-do-podgladu')
    expect(m.html).toContain('Jeśli to nie Ty, zignoruj tę wiadomość: hasło się nie zmieni.')
    bladRenderu(() => render('reset-hasla', { link: 'javascript:alert(1)' }))
  })

  it('zaproszenie: adresat to zaproszona osoba, rola i link tylko http(s), polskie znaki', () => {
    const m = render('zaproszenie')
    expect(m.do).toBe('osoba@example.com')
    expect(m.temat).toBe('Zaproszenie do firmy Firma Testowa sp. z o.o. w Kompletorze')
    expect(m.tekst).toContain('Przyjmij zaproszenie: https://panel.example.com/zaproszenie?t=przyklad-tokenu-do-podgladu')
    expect(m.tekst).toContain('(rola: Magazyn)')
    expect(m.html).toContain('zignoruj tę wiadomość')
    bladRenderu(() => render('zaproszenie', { link: 'javascript:alert(1)' }))
    bladRenderu(() => render('zaproszenie', { email: ' ' }))
  })

  it('błąd faktury bez linku do panelu (instancja bez PANEL_URL) dalej się renderuje', () => {
    const m = render('blad-faktury', { linkDoZamowienia: '' })
    expect(m.tekst).not.toContain('Otwórz zamówienie w panelu')
  })
})

describe('„Nieudana płatność online”', () => {
  it('pytanie o problem, dane do przelewu z ustawień, zdanie o zwolnionym towarze i termin anulowania', () => {
    const m = render('nieudana-platnosc')
    expect(m.temat).toBe('Czy był problem z płatnością za zamówienie ZAM-2026-00123?')
    expect(m.tekst).toContain('Płatność online za to zamówienie nie doszła do skutku. Czy wystąpił jakiś problem z płatnością?')
    expect(m.tekst).toContain('Firma Testowa sp. z o.o.')
    expect(m.tekst).toContain('12 3456 7890 1234 5678 9012 3456')
    expect(m.tekst).toContain('Zamówienie ZAM-2026-00123')
    expect(m.tekst).toContain('nie jest już dla Państwa zarezerwowany')
    expect(m.tekst).toContain('30 października 2026')
    expect(m.html).toContain('12 3456 7890 1234 5678 9012 3456')
  })

  it('towar trzymany: bez zdania o rezerwacji; IBAN w grupach po 4', () => {
    const m = render('nieudana-platnosc', { towarZwolniony: false, rachunek: 'pl12 3456 7890 1234 5678 9012 3456' })
    expect(m.tekst).not.toContain('zarezerwowany')
    expect(m.tekst).toContain('PL12 3456 7890 1234 5678 9012 3456')
  })

  it('bez rachunku albo z rachunkiem w złym kształcie mail nie powstaje', () => {
    expect(bladRenderu(() => render('nieudana-platnosc', { rachunek: '' })).bledy).toEqual(['firma „Firma Testowa sp. z o.o.”: brak numeru rachunku do przelewu'])
    expect(bladRenderu(() => render('nieudana-platnosc', { rachunek: '123' })).bledy).toEqual(['niepoprawny numer rachunku do przelewu'])
  })

  it('bez długich myślników i wykrzykników', () => {
    const m = render('nieudana-platnosc')
    expect(`${m.temat}\n${m.tekst}`).not.toMatch(/[—!]/)
  })
})
