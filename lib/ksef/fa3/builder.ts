// Builder faktury FA(3) dla KSeF. Czysta funkcja: dane faktury → XML UTF-8, sumy po stawkach i lista
// problemów. Bez Prismy, bez sieci, bez zapisu. Wszystkie problemy danych zbierane naraz (nie pierwszy błąd); przy
// jakimkolwiek problemie XML nie powstaje (`xml: null`), więc nie da się go odłożyć ani wysłać.
//
// Faktura liczona od brutto (sklep): netto stawki = suma brutto stawki / (1 + stawka), zaokrąglone do grosza per stawka
// tą samą funkcją co faktura wFirmy (`nettoGr`, lib/wfirma/faktura.ts). P_15 = suma brutto wierszy. Kwoty w groszach,
// zapis dziesiętny bez liczb zmiennoprzecinkowych. Tylko PLN i rodzaj „VAT”; korekty, zaliczki i waluty obce są poza
// zakresem (problem). Znaki niedozwolone w XML i w KSeF to problem, nigdy cicha zamiana.
// Problemy mają stałe teksty i ścieżki pól, bez wartości z danych: NIP i nazwa nabywcy nie wychodzą poza XML.
import { nettoGr } from '../../wfirma/faktura'
import {
  FA3_KOD_SYSTEMOWY,
  FA3_NAMESPACE,
  FA3_WARIANT,
  FA3_WERSJA,
  FA3_WERSJA_SCHEMY,
  KOLEJNOSC_STAWEK,
  type AdresFa3,
  type ProblemFa3,
  STAWKI_FA3,
  type SumaStawki,
  type SumyFa3,
  type WejscieFa3,
  type ZlozonaFa3,
} from './typy'

// ─── Pomocnicze (eksport do testów) ──────────────────────────────────────────

/** Wzorzec XSD `TNrNIP` (ElementarneTypyDanych): pierwsza cyfra 1–9 i nie dwa zera na pozycjach 2–3 (z DewFlow). */
const NIP_XSD_RE = /^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/

/** NIP w zapisie: spacje, myślniki i prefiks „PL” zdjęte (jak `normalizeNip` w DewFlow). */
export const normalizujNip = (v: string): string => v.replace(/^\s*PL/i, '').replace(/[\s-]/g, '')

/**
 * NIP: 10 cyfr po `normalizujNip`, wzorzec XSD i suma kontrolna wagami 6 5 7 2 3 4 5 6 7 mod 11. Wzorzec odrzuca
 * np. „0000000000”, który przechodzi samą sumę kontrolną, a padłby dopiero na schemacie.
 */
export function poprawnyNip(v: string): boolean {
  const d = normalizujNip(v)
  if (!/^\d{10}$/.test(d) || !NIP_XSD_RE.test(d)) return false
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7]
  const s = w.reduce((acc, x, i) => acc + x * Number(d[i]), 0) % 11
  return s !== 10 && s === Number(d[9])
}

/**
 * Znaki niedozwolone: sterujące C0 poza tab/LF/CR (XML 1.0), DEL i C1, nieznaki (U+FDD0–U+FDEF, U+FFFE, U+FFFF),
 * samotne surogaty oraz sterowanie kierunkiem tekstu (U+202A–U+202E, U+2066–U+2069) i znaki zerowej szerokości
 * (U+200B–U+200F, U+FEFF). Wszystkie jako sekwencje \uXXXX, nigdy dosłownie (formatter albo edytor
 * usuwa niewidoczny znak i strażnik cicho przestaje łapać zakres). [NIEPEWNE: pełna lista znaków odrzucanych przez KSeF od 16.07.2026, sprawdzić na TEST.]
 */
export const ZAKAZANE_ZNAKI =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFDD0-\uFDEF\uFEFF\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Grosze → „123.45” (bez liczb zmiennoprzecinkowych). */
export function kwota(gr: number): string {
  if (!Number.isSafeInteger(gr)) throw new Error('kwota w groszach musi być liczbą całkowitą')
  const z = gr < 0 ? '-' : ''
  const a = Math.abs(gr)
  return `${z}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

/** Ilość: całkowita bez części ułamkowej, inaczej do 6 miejsc bez zer końcowych (kg z gramów: 3 miejsca). */
export function ilosc(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
const poprawnaData = (v: string) => DATA_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/** DataWytworzeniaFa: dateTime UTC bez milisekund. */
const dataCzas = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Suma netto i VAT jednej stawki z brutto (jak `nettoGr` faktury wFirmy). */
export function sumaStawki(stawka: string, bruttoGr: number): SumaStawki {
  const n = nettoGr([{ bruttoGr, stawkaVat: stawka }])
  return { stawka, nettoGr: n, vatGr: bruttoGr - n, bruttoGr }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/** Limity z XSD: `TZnakowy` = 240 (P_2, P_8A, P_19A, SystemInfo, Klucz, Wartosc), `TZnakowy512` = Nazwa, AdresL1/L2, P_7. */
const MAX_TEKST = 240
const MAX_TEKST_512 = 512

export function zbudujFa3(w: WejscieFa3): ZlozonaFa3 {
  const problemy: ProblemFa3[] = []
  const dodaj = (kod: string, pole: string | undefined, tekst: string) => problemy.push({ kod, ...(pole ? { pole } : {}), tekst })

  /** Tekst do XML: pusty, za długi albo ze znakiem zakazanym = problem. Limit z typu XSD pola (240 albo 512). */
  const tekst = (v: string | null | undefined, pole: string, wymagany = true, max = MAX_TEKST): string => {
    const s = (v ?? '').trim()
    if (!s) {
      if (wymagany) dodaj('pole-puste', pole, 'Brak wymaganej wartości.')
      return ''
    }
    if (ZAKAZANE_ZNAKI.test(s)) dodaj('znak-zakazany', pole, 'Tekst zawiera znak niedozwolony w KSeF (sterujący, niewidoczny albo nieznak Unicode): popraw dane źródłowe.')
    if (s.length > max) dodaj('tekst-za-dlugi', pole, `Tekst dłuższy niż ${max} znaków.`)
    return s
  }

  // zakres tego etapu
  if (w.waluta !== 'PLN') dodaj('waluta-poza-zakresem', 'Fa.KodWaluty', 'Tylko faktury w PLN: waluty obce są poza zakresem tego etapu.')
  const kor = w.rodzaj === 'KOR'
  if (w.rodzaj !== 'VAT' && !kor) dodaj('rodzaj-poza-zakresem', 'Fa.RodzajFaktury', 'Tylko faktura VAT albo korekta (KOR): zaliczki są poza zakresem tego etapu.')
  if (kor && !w.korekta) dodaj('korekta-bez-faktury', 'Fa.DaneFaKorygowanej', 'Korekta bez danych faktury korygowanej.')
  if (!kor && w.korekta) dodaj('korekta-w-vat', 'Fa.RodzajFaktury', 'Dane faktury korygowanej tylko przy korekcie (KOR).')

  const numer = tekst(w.numer, 'Fa.P_2')
  if (!poprawnaData(w.dataWystawienia)) dodaj('data-zla', 'Fa.P_1', 'Data wystawienia nie jest datą RRRR-MM-DD.')
  if (w.dataDostawy && !poprawnaData(w.dataDostawy)) dodaj('data-zla', 'Fa.P_6', 'Data dostawy nie jest datą RRRR-MM-DD.')
  if (Number.isNaN(w.wytworzono.getTime())) dodaj('data-zla', 'Naglowek.DataWytworzeniaFa', 'Zła data wytworzenia.')

  // sprzedawca
  const s = w.sprzedawca
  if (!poprawnyNip(s.nip)) dodaj('nip-zly', 'Podmiot1.NIP', 'NIP sprzedawcy jest niepoprawny (10 cyfr z sumą kontrolną).')
  const sNazwa = tekst(s.nazwa, 'Podmiot1.Nazwa', true, MAX_TEKST_512)
  const adres = (a: AdresFa3 | null | undefined, pole: string, wymagany: boolean): string => {
    if (!a) {
      if (wymagany) dodaj('adres-brak', pole, 'Brak adresu.')
      return ''
    }
    if (a.kodKraju !== 'PL') dodaj('kraj-poza-zakresem', `${pole}.KodKraju`, 'Tylko adresy w Polsce w tym etapie.')
    const l1 = tekst(a.linia1, `${pole}.AdresL1`, true, MAX_TEKST_512)
    const l2 = tekst(a.linia2, `${pole}.AdresL2`, false, MAX_TEKST_512)
    return `<Adres><KodKraju>PL</KodKraju><AdresL1>${escapeXml(l1)}</AdresL1>${l2 ? `<AdresL2>${escapeXml(l2)}</AdresL2>` : ''}</Adres>`
  }
  const sAdres = adres(s.adres, 'Podmiot1.Adres', true)

  // nabywca: dane tylko w XML; problemy bez wartości
  const n = w.nabywca
  if (n.nip !== null && !poprawnyNip(n.nip)) dodaj('nip-zly', 'Podmiot2.NIP', 'NIP nabywcy jest niepoprawny (10 cyfr z sumą kontrolną).')
  const nNazwa = tekst(n.nazwa, 'Podmiot2.Nazwa', true, MAX_TEKST_512)
  const nAdres = adres(n.adres, 'Podmiot2.Adres', false)

  // wiersze i sumy
  if (!w.wiersze.length) dodaj('brak-wierszy', 'Fa.FaWiersz', 'Faktura bez pozycji.')
  const perStawka = new Map<string, number>()
  const wiersze: string[] = []
  for (const [i, r] of w.wiersze.entries()) {
    const pole = `Fa.FaWiersz[${i + 1}]`
    const st = STAWKI_FA3[r.stawka]
    if (!st) dodaj('stawka-nieznana', `${pole}.P_12`, 'Nieznana stawka VAT (dozwolone: 23, 8, 5, 0, zw, np).')
    if (!Number.isSafeInteger(r.bruttoGr) || !Number.isSafeInteger(r.cenaBruttoGr)) dodaj('kwota-zla', `${pole}.P_11A`, 'Kwota nie jest liczbą groszy.')
    else if (!kor && (r.bruttoGr < 0 || r.cenaBruttoGr < 0)) dodaj('kwota-ujemna', `${pole}.P_11A`, 'Ujemna kwota pozycji: tylko w korekcie.')
    else if (kor && r.cenaBruttoGr < 0) dodaj('kwota-ujemna', `${pole}.P_9B`, 'Cena jednostkowa nie może być ujemna (w korekcie ujemna jest ilość i wartość).')
    if (!(Number.isFinite(r.ilosc) && (kor ? r.ilosc !== 0 : r.ilosc > 0))) dodaj('ilosc-zla', `${pole}.P_8B`, kor ? 'Ilość w korekcie nie może być zerem.' : 'Ilość musi być dodatnia.')
    const nazwa = tekst(r.nazwa, `${pole}.P_7`, true, MAX_TEKST_512)
    const jm = tekst(r.jednostka, `${pole}.P_8A`)
    if (st && Number.isSafeInteger(r.bruttoGr)) perStawka.set(r.stawka, (perStawka.get(r.stawka) ?? 0) + r.bruttoGr)
    if (st && Number.isSafeInteger(r.bruttoGr) && Number.isSafeInteger(r.cenaBruttoGr) && Number.isFinite(r.ilosc))
      wiersze.push(
        `<FaWiersz><NrWierszaFa>${i + 1}</NrWierszaFa><P_7>${escapeXml(nazwa)}</P_7><P_8A>${escapeXml(jm)}</P_8A><P_8B>${ilosc(r.ilosc)}</P_8B>` +
          `<P_9B>${kwota(r.cenaBruttoGr)}</P_9B><P_11A>${kwota(r.bruttoGr)}</P_11A><P_12>${st.p12}</P_12></FaWiersz>`,
      )
  }
  const sumyStawek: SumaStawki[] = KOLEJNOSC_STAWEK.flatMap((k) => (perStawka.has(k) ? [sumaStawki(k, perStawka.get(k)!)] : []))
  const sumy: SumyFa3 = {
    nettoGr: sumyStawek.reduce((a, x) => a + x.nettoGr, 0),
    vatGr: sumyStawek.reduce((a, x) => a + x.vatGr, 0),
    bruttoGr: sumyStawek.reduce((a, x) => a + x.bruttoGr, 0),
    perStawka: sumyStawek,
  }
  if (w.oczekiwaneBruttoGr !== undefined && w.oczekiwaneBruttoGr !== null && w.oczekiwaneBruttoGr !== sumy.bruttoGr)
    dodaj('suma-rozna-od-zamowienia', 'Fa.P_15', 'Suma brutto pozycji różni się od kwoty zamówienia.')

  // zwolnienie: przy wierszach „zw” podstawa prawna z ustawień firmy, inaczej P_19N
  const zw = perStawka.has('zw')
  const podstawa = zw ? tekst(w.podstawaZwolnienia, 'Fa.Adnotacje.Zwolnienie.P_19A', false) : ''
  if (zw && !podstawa) dodaj('brak-podstawy-zwolnienia', 'Fa.Adnotacje.Zwolnienie', 'Pozycje zwolnione (zw) wymagają podstawy prawnej zwolnienia w ustawieniach KSeF firmy.')

  const opisy = (w.dodatkowyOpis ?? []).map((o, i) => {
    const k = tekst(o.klucz, `Fa.DodatkowyOpis[${i + 1}].Klucz`)
    const v = tekst(o.wartosc, `Fa.DodatkowyOpis[${i + 1}].Wartosc`)
    return `<DodatkowyOpis><Klucz>${escapeXml(k)}</Klucz><Wartosc>${escapeXml(v)}</Wartosc></DodatkowyOpis>`
  })
  const systemInfo = w.systemInfo ? tekst(w.systemInfo, 'Naglowek.SystemInfo') : ''
  // korekta (KOR): przyczyna, skutek w dacie korekty (2) i dane faktury korygowanej
  let korXml = ''
  if (kor && w.korekta) {
    const k = w.korekta
    const przyczyna = tekst(k.przyczyna, 'Fa.PrzyczynaKorekty')
    const nrK = tekst(k.numer, 'Fa.DaneFaKorygowanej.NrFaKorygowanej')
    if (!poprawnaData(k.dataWystawienia)) dodaj('data-zla', 'Fa.DaneFaKorygowanej.DataWystFaKorygowanej', 'Data faktury korygowanej nie jest datą RRRR-MM-DD.')
    const ksef = k.nrKsef ? tekst(k.nrKsef, 'Fa.DaneFaKorygowanej.NrKSeFFaKorygowanej') : ''
    korXml =
      `<PrzyczynaKorekty>${escapeXml(przyczyna)}</PrzyczynaKorekty><TypKorekty>2</TypKorekty>` +
      `<DaneFaKorygowanej><DataWystFaKorygowanej>${k.dataWystawienia}</DataWystFaKorygowanej><NrFaKorygowanej>${escapeXml(nrK)}</NrFaKorygowanej>` +
      (ksef ? `<NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>${escapeXml(ksef)}</NrKSeFFaKorygowanej>` : '<NrKSeFN>1</NrKSeFN>') +
      '</DaneFaKorygowanej>'
  }

  if (problemy.length) return { xml: null, wersjaSchemy: FA3_WERSJA, sumy, problemy }

  const sumyXml = sumyStawek
    .map((x) => {
      const st = STAWKI_FA3[x.stawka]!
      return `<${st.netto}>${kwota(x.nettoGr)}</${st.netto}>${st.vat ? `<${st.vat}>${kwota(x.vatGr)}</${st.vat}>` : ''}`
    })
    .join('')
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Faktura xmlns="${FA3_NAMESPACE}">` +
    '<Naglowek>' +
    `<KodFormularza kodSystemowy="${FA3_KOD_SYSTEMOWY}" wersjaSchemy="${FA3_WERSJA_SCHEMY}">FA</KodFormularza>` +
    `<WariantFormularza>${FA3_WARIANT}</WariantFormularza>` +
    `<DataWytworzeniaFa>${dataCzas(w.wytworzono)}</DataWytworzeniaFa>` +
    (systemInfo ? `<SystemInfo>${escapeXml(systemInfo)}</SystemInfo>` : '') +
    '</Naglowek>' +
    `<Podmiot1><DaneIdentyfikacyjne><NIP>${normalizujNip(s.nip)}</NIP><Nazwa>${escapeXml(sNazwa)}</Nazwa></DaneIdentyfikacyjne>${sAdres}</Podmiot1>` +
    '<Podmiot2><DaneIdentyfikacyjne>' +
    (n.nip !== null ? `<NIP>${normalizujNip(n.nip)}</NIP>` : '<BrakID>1</BrakID>') +
    `<Nazwa>${escapeXml(nNazwa)}</Nazwa></DaneIdentyfikacyjne>${nAdres}<JST>2</JST><GV>2</GV></Podmiot2>` +
    '<Fa>' +
    `<KodWaluty>PLN</KodWaluty><P_1>${w.dataWystawienia}</P_1><P_2>${escapeXml(numer)}</P_2>` +
    (w.dataDostawy && w.dataDostawy !== w.dataWystawienia ? `<P_6>${w.dataDostawy}</P_6>` : '') +
    sumyXml +
    `<P_15>${kwota(sumy.bruttoGr)}</P_15>` +
    '<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A>' +
    (zw ? `<Zwolnienie><P_19>1</P_19><P_19A>${escapeXml(podstawa)}</P_19A></Zwolnienie>` : '<Zwolnienie><P_19N>1</P_19N></Zwolnienie>') +
    '<NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>' +
    `<RodzajFaktury>${kor ? 'KOR' : 'VAT'}</RodzajFaktury>` +
    korXml +
    opisy.join('') +
    wiersze.join('') +
    '</Fa>' +
    '</Faktura>\n'
  return { xml, wersjaSchemy: FA3_WERSJA, sumy, problemy }
}
