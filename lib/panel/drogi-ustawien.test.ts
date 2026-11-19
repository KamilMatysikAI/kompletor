import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bledneDrogiUstawien, uzupelnijDzialyUstawien } from './drogi-ustawien'

// każda droga „Ustawienia → Dział → Ekran” w dokumentacji (z niej czyta Pomoc) i w tekstach panelu
// prowadzi do zakładki, która jest w drzewie nawigacji (`nawigacja.ts`, działy).

const KORZEN = join(__dirname, '..', '..')

function pliki(katalog: string, rozszerzenia: RegExp): string[] {
  const wynik: string[] = []
  const idz = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.')) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) idz(p)
      else if (rozszerzenia.test(n) && !/drogi-ustawien/.test(n)) wynik.push(p)
    }
  }
  idz(join(KORZEN, katalog))
  return wynik
}

/** Markdown łamie wiersze w środku drogi („Ustawienia →⏎Poczta”): sklejamy wiersze akapitu i cytatu. */
function tekstDokumentu(md: string): string {
  return md.replace(/\n(?:>\s?)?(?=\S)/g, ' ')
}

/** W kodzie sprawdzamy wiersze z tekstami, nie komentarze (komentarz nie trafia do panelu). */
function wierszeKodu(ts: string): string[] {
  return ts.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l))
}

// Obca droga (inny program z własnymi „Ustawienia → …”) = dopisz program do OBCE_PROGRAMY w lib/panel/drogi-ustawien.ts.
const KOMUNIKAT = 'popraw ręcznie albo przez uzupelnijDzialyUstawien(); droga w innym programie (np. BaseLinker, wFirma) = dopisz go do OBCE_PROGRAMY w lib/panel/drogi-ustawien.ts'

describe('drogi do ustawień', () => {
  it('dopisuje dział i zamienia stare nazwy ekranów', () => {
    expect(uzupelnijDzialyUstawien('wpisz w Ustawienia → Poczta.')).toBe('wpisz w Ustawienia → Komunikacja i poczta → Poczta.')
    expect(uzupelnijDzialyUstawien('(Ustawienia → Użytkownicy)')).toBe('(Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia)')
    expect(uzupelnijDzialyUstawien('**Ustawienia → Kanały sprzedaży** → konto')).toBe('**Ustawienia → Sprzedaż i kanały → Kanały sprzedaży** → konto')
    expect(uzupelnijDzialyUstawien('w Ustawieniach → Hasło')).toBe('w Ustawieniach → Zespół i dostęp → Zmiana hasła')
    expect(uzupelnijDzialyUstawien('Ustawienia → Poczta → Szablony maili')).toBe('Ustawienia → Komunikacja i poczta → Szablony maili')
    expect(uzupelnijDzialyUstawien('Ustawienia → Integracje, sekret')).toBe('Ustawienia → Integracje i agenci AI → Integracje, sekret')
    expect(uzupelnijDzialyUstawien('Ustawienia → Przeprowadzka z BaseLinkera')).toBe('Ustawienia → Przejście z BaseLinkera → Przeprowadzka')
  })

  it('drogi z działem, drogi innych programów i drugi przebieg zostają bez zmian', () => {
    for (const t of [
      'Ustawienia → Wysyłka i druk → Druk',
      'Ustawienia → Integracje i agenci AI',
      'WooCommerce → Ustawienia → Zaawansowane → REST API',
      'W Claude Desktop: Ustawienia → Programista → Edytuj konfigurację',
      'claude.ai (Ustawienia → Łączniki)',
    ]) {
      expect(uzupelnijDzialyUstawien(t)).toBe(t)
      expect(bledneDrogiUstawien(t)).toEqual([])
    }
    const raz = uzupelnijDzialyUstawien('Ustawienia → Druk i Ustawienia → Dane firmy')
    expect(uzupelnijDzialyUstawien(raz)).toBe(raz)
  })

  it('drogi w BaseLinkerze, wFirmie i Allegro to obce programy', () => {
    for (const t of ['BaseLinker: Ustawienia → Integracje', 'w wFirmie → Ustawienia → Moja firma', 'Allegro → Ustawienia → Dostawa'])
      expect(bledneDrogiUstawien(t), t).toEqual([])
  })

  it('zgłasza drogę bez działu i zakładkę spoza działu', () => {
    expect(bledneDrogiUstawien('w Ustawienia → Poczta')[0]?.powod).toMatch(/brakuje nazwy działu/)
    expect(bledneDrogiUstawien('Ustawienia → Wysyłka i druk → Poczta')[0]?.powod).toMatch(/nie ma takiej zakładki/)
    expect(bledneDrogiUstawien('Ustawienia → Pomoc')).toHaveLength(1)
  })

  it('docs/: każda droga „Ustawienia → …” prowadzi do zakładki z nawigacji', () => {
    const bledy = pliki('docs', /\.md$/).flatMap((p) =>
      bledneDrogiUstawien(tekstDokumentu(readFileSync(p, 'utf8'))).map((b) => `${relative(KORZEN, p)}: ${b.fragment} (${b.powod})`),
    )
    expect(bledy, KOMUNIKAT).toEqual([])
  })

  it('teksty panelu (app/, lib/): każda droga „Ustawienia → …” prowadzi do zakładki z nawigacji', () => {
    const bledy = [...pliki('app', /\.tsx?$/), ...pliki('lib', /\.tsx?$/)].flatMap((p) =>
      wierszeKodu(readFileSync(p, 'utf8')).flatMap((l) => bledneDrogiUstawien(l).map((b) => `${relative(KORZEN, p)}: ${b.fragment} (${b.powod})`)),
    )
    expect(bledy, KOMUNIKAT).toEqual([])
  })
})
