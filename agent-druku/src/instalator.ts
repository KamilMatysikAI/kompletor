// Interaktywna część instalatora: `node dist/main.js --instaluj`. Woła ją skrypty/instaluj.ps1, gdy na
// komputerze nie ma jeszcze agent-druku.json albo gdy osoba wybrała „nowy kod”. Pyta o kod instalacyjny, sprawdza go
// żądaniem do serwera, pokazuje drukarki z Windows jako numerowaną listę, pyta, co jest czym, i zapisuje konfigurację.
// Logika (kod, role, scalanie pliku) jest w instalacja.ts i ma testy; tu zostaje tylko rozmowa z człowiekiem.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { DrukarkiWindows } from './drukarki.js'
import type { KodInstalacyjny, RodzajDrukarki } from './instalacja.js'
import { BladInstalacji, czyWydrukProbny, dekodujKodInstalacyjny, opisPrzydzialu, przydzielRole, rodzajZOdpowiedzi, zbudujKonfiguracje } from './instalacja.js'
import { wydrukujKartkeProbna } from './proba.js'
import { BladSerwera, KlientSerwera } from './serwer.js'

export interface OpcjeInstalatora {
  plikKonfiguracji: string
  katalogSkryptow: string
  powershell?: string
  /** SumatraPDF do kartki próbnej; bez niego „P” mówi, że druku próbnego nie ma. */
  sumatraPdf?: string
}

const pisz = (t = '') => process.stdout.write(`${t}\n`)

/** Sprawdzenie kodu: GET listy zleceń tym tokenem (nic nie zmienia na serwerze). null = w porządku. */
export async function sprawdzKodNaSerwerze(kod: KodInstalacyjny, fetchImpl?: typeof fetch): Promise<string | null> {
  const klient = new KlientSerwera({ serwer: kod.serwer, token: kod.token, stanowisko: kod.stanowisko, timeoutMs: 20_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  try {
    await klient.pobierzZlecenia()
    return null
  } catch (e) {
    const status = e instanceof BladSerwera ? e.status : undefined
    if (status === 401) return 'Serwer nie przyjął kodu: token jest nieważny (unieważniony, zastąpiony nowym albo stanowisko wyłączone). Utwórz nowy token w panelu.'
    if (status === 403) return 'Serwer nie przyjął kodu: token należy do innego stanowiska. Skopiuj kod jeszcze raz.'
    // Treść odpowiedzi serwera (i adres przekierowania) nie wraca na ekran: kod mógł wskazać obcy serwer.
    if (status !== undefined) return `Nie udało się połączyć z serwerem ${new URL(kod.serwer).origin}: odpowiedział kodem ${status}. Sprawdź, czy kod pochodzi z Twojego Kompletora.`
    return `Nie udało się połączyć z serwerem: ${(e as Error).message}`
  }
}

export async function instaluj(o: OpcjeInstalatora): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let skonczone = false
  // okno zamknięte / koniec wejścia w trakcie pytań = jasny komunikat (kod wyjścia 1 ustawia main.ts)
  rl.on('close', () => {
    if (!skonczone) pisz('\nBŁĄD: instalacja przerwana przed końcem — konfiguracja nie została zapisana.')
  })
  try {
    let poprzednia: unknown
    if (existsSync(o.plikKonfiguracji)) {
      try {
        poprzednia = JSON.parse(readFileSync(o.plikKonfiguracji, 'utf8').replace(/^﻿/, ''))
      } catch {
        poprzednia = undefined // uszkodzony plik zastąpimy nowym
      }
    }

    // 1. Kod instalacyjny
    let kod: KodInstalacyjny | undefined
    while (!kod) {
      pisz()
      pisz('Wklej kod instalacyjny z panelu Kompletora (Ustawienia → Wysyłka i druk → Druk → stanowisko → Nowy token).')
      pisz('Kod zaczyna się od kmi_. Wklejanie: prawy przycisk myszy w tym oknie, potem Enter.')
      const tekst = await rl.question('Kod: ')
      try {
        const k = dekodujKodInstalacyjny(tekst)
        pisz(`Sprawdzam kod na serwerze ${new URL(k.serwer).origin} …`)
        const blad = await sprawdzKodNaSerwerze(k)
        if (blad) {
          pisz(`BŁĄD: ${blad}`)
          continue
        }
        pisz(`OK: stanowisko „${k.stanowisko}” na serwerze ${new URL(k.serwer).origin}.`)
        kod = k
      } catch (e) {
        pisz(`BŁĄD: ${e instanceof BladInstalacji ? e.message : (e as Error).message}`)
      }
    }

    // 2. Drukarki z Windows
    const drukarki = new DrukarkiWindows({
      sumatraPdf: o.sumatraPdf ?? '',
      powershell: o.powershell ?? 'powershell.exe',
      katalogSkryptow: o.katalogSkryptow,
      limitCzasuMs: 60_000,
    })
    let nazwy: string[] = []
    for (;;) {
      try {
        nazwy = [...new Set((await drukarki.stan()).map((s) => s.nazwa))].sort((a, b) => a.localeCompare(b, 'pl'))
      } catch (e) {
        pisz(`BŁĄD: nie udało się odczytać drukarek z Windows: ${(e as Error).message}`)
      }
      if (nazwy.length) break
      pisz('Windows nie pokazuje żadnej drukarki. Zainstaluj drukarki (strona testowa z Windows ma wychodzić) i naciśnij Enter.')
      await rl.question('')
    }

    let mapa = {}
    for (;;) {
      pisz()
      pisz('Drukarki w Windows:')
      nazwy.forEach((n, i) => pisz(`  ${String(i + 1).padStart(2)}. ${n}`))
      pisz()
      pisz('Dla każdej drukarki wpisz: A = zwykła (kartki A4), T = termiczna (etykiety), Enter = pomiń (np. „Microsoft Print to PDF”).')
      pisz('Nie wiesz, która to drukarka? Wpisz P: wydrukuje się na niej kartka z numerem z tej listy.')
      const wybory: { nazwa: string; rodzaj: RodzajDrukarki }[] = []
      for (const [i, nazwa] of nazwy.entries()) {
        let rodzaj: RodzajDrukarki | null = null
        while (!rodzaj) {
          const odp = await rl.question(`  ${i + 1}. ${nazwa} [A/T/P/Enter]: `)
          if (czyWydrukProbny(odp)) {
            if (!o.sumatraPdf) {
              pisz('     Kartki próbnej nie da się wydrukować (brak programu SumatraPDF). Sprawdź drukarkę w Windows.')
              continue
            }
            pisz(`     Drukuję kartkę próbną z numerem ${i + 1} na „${nazwa}”…`)
            try {
              await wydrukujKartkeProbna(drukarki, nazwa, i + 1)
              pisz(`     Wysłano. Sprawdź, z której drukarki wyszła kartka z numerem ${i + 1}.`)
            } catch (e) {
              pisz(`     Nie udało się wydrukować: ${(e as Error).message}`)
            }
            continue
          }
          rodzaj = rodzajZOdpowiedzi(odp)
          if (!rodzaj) pisz('     Wpisz A, T, P albo naciśnij Enter.')
        }
        wybory.push({ nazwa, rodzaj })
      }
      try {
        mapa = przydzielRole(wybory)
      } catch (e) {
        pisz(`BŁĄD: ${(e as Error).message}`)
        continue
      }
      const opis = opisPrzydzialu(mapa)
      if (!opis.length) {
        pisz('Nie wybrano żadnej drukarki — wybierz co najmniej jedną.')
        continue
      }
      pisz()
      pisz(`Podsumowanie — stanowisko „${kod.stanowisko}”:`)
      for (const l of opis) pisz(`  ${l}`)
      if (!opis.some((l) => l.startsWith('A4 '))) pisz('  UWAGA: bez drukarki zwykłej karty i listy nie wydrukują się, a etykiety nie mają zapasu na A4.')
      const ok = (await rl.question('Zapisać? [T = tak / N = wybierz jeszcze raz]: ')).trim().toLowerCase()
      if (ok === '' || ok === 't' || ok === 'tak') break
    }

    // 3. Zapis (plik tymczasowy + zamiana: przerwanie w połowie nie zostawi uciętego JSON-a)
    const json = zbudujKonfiguracje(poprzednia, kod, mapa)
    const tymczasowy = `${o.plikKonfiguracji}.tmp`
    writeFileSync(tymczasowy, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    renameSync(tymczasowy, o.plikKonfiguracji)
    pisz('OK: zapisano agent-druku.json.')
    return 0
  } finally {
    skonczone = true
    rl.close()
  }
}
