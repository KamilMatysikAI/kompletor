// Podkomenda `npm run cien -- archiwum [--kanal WOO|ALLEGRO|EMPIK|EASYTOOLS] --konto <id> --od RRRR-MM-DD
// [--do RRRR-MM-DD] [--z-pliku <json>] [--z-faktur-bl <jsonl> [--zrodla-bl <csv> --mapa-zrodel "nazwa=KANAŁ;nazwa=POMIN;…"
// [--prog-bez-odpowiednika <zł> | --pozwol-bez-odpowiednika]]]
// [--na-sucho | --wykonaj] [--maks-stron N] [--plik <md>] [--firma <slug>]`
// (etapy 1–2), skrót `npm run archiwum -- …`, w obrazie `node dist/cien.cjs archiwum …`; `archiwum-woo` =
// to samo z `--kanal WOO` (etap 1). Import archiwum zamówień sprzed odczytu kanału przez Kompletora (zasady:
// lib/archiwum/import.ts). Kanał TYLKO czytany (GET listy zamówień przez adapter konta, z jego limitem tempa), albo
// plik JSON (`--z-pliku`): zrzut Allegro w kształcie API dla dni spoza okna API, eksport zamówień EasyTools.
// Domyślnie NA SUCHO (zero zapisów w bazie); `--wykonaj` zapisuje archiwum i przebieg (`ImportRun`, kursor do wznowienia).
// `--do` domyślnie = początek odczytu kanału przez Kompletora (`coverageFrom` konta); później = przycięte do tej chwili;
// konto bez `coverageFrom` (np. EasyTools, zamówienia przez API zapisu) wymaga jawnego `--do`.
// Na ekranie liczby, kwoty, statusy i id zamówień w kanale przy błędach; bez danych klientów.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { Channel, PrismaClient } from '@prisma/client'
import { createAccountAdapter, loadChannelAccounts } from '../lib/adaptery/konta'
import type { AdapterRegistry } from '../lib/adaptery/rejestr'
import type { WooResponse } from '../lib/zrodla/woo'
import type { SecretSource } from '../lib/sekrety'
import { czytnikWoo } from '../lib/archiwum/czytnik-woo'
import { granicaImportu, importujArchiwum, raportImportu, zrodloWoo, type WynikImportu, type ZrodloArchiwum } from '../lib/archiwum/import'
import { czytnikAllegro, czytnikMirakl, zamowieniaZPliku, zrodloAllegroApi, zrodloAllegroZrzut, zrodloEasyTools, zrodloEmpik, type AllegroGetListy, type MiraklGetListy } from '../lib/archiwum/zrodla'
import { fakturaBlZSurowej, fakturyZPliku, kandydaciZBazy, parujZeZrodlami, pierwszeZamowienieAllegroZApi, zrodloFakturyBl, ZRODLO_FAKTURA_BL, type FakturaBl } from '../lib/archiwum/faktury-bl'
import { bladSpozaMapy, parsujMapeZrodel, POMIN, tekstZrodelBl, zrodlaBlZCsv, type ZrodlaBl } from '../lib/archiwum/zrodla-bl'
import { poczatekDniaPl } from './rabat-woo'

interface MaListeWoo {
  odczytListyZamowienArchiwum<T>(query: Record<string, string | number | boolean>): Promise<WooResponse<T>>
  /** sufit rabatu z ustawień firmy (ta sama reguła co bieżące zamówienia Woo) */
  opcjeZamowienArchiwum?(): { rabatMaksProcent?: number }
}
const maListe = <T>(a: unknown): a is { odczytListyZamowienArchiwum: T } => !!a && typeof (a as { odczytListyZamowienArchiwum?: unknown }).odczytListyZamowienArchiwum === 'function'

const KANALY = ['WOO', 'ALLEGRO', 'EMPIK', 'EASYTOOLS'] as const satisfies readonly Channel[]
type KanalArchiwum = (typeof KANALY)[number]

export interface ArgumentyArchiwum {
  kanal?: string
  konto?: string
  od?: string
  do?: string
  zPliku?: string
  /** plik faktur BL (JSON Lines, przycięty): archiwum Allegro z kanałem odtworzonym (etap 3) */
  zFakturBl?: string
  /** plik źródeł zamówień BL (CSV order_id;pochodzenie;…, bez danych klientów): kanał faktury z pliku, nie z parowania */
  zrodlaBl?: string
  /** nazwa źródła BL → kanał z archiwum albo POMIN, `"nazwa=ALLEGRO;nazwa 2=WOO;nazwa 3=POMIN"` (wymagane razem z `zrodlaBl`) */
  mapaZrodel?: string
  /** próg (zł) faktur z wpisem kanału z archiwum bez zamówienia tego kanału w bazie; powyżej = kod 1 (domyślnie 0) */
  progBezOdpowiednika?: string
  /** faktury bez odpowiednika w bazie tylko z ostrzeżeniem, bez kodu 1 */
  pozwolBezOdpowiednika?: boolean
  naSucho: boolean
  wykonaj: boolean
  maksStron?: string
  plik?: string
  registry: AdapterRegistry
  src: SecretSource
}

async function zrodlo(db: PrismaClient, kanal: KanalArchiwum, a: ArgumentyArchiwum): Promise<ZrodloArchiwum> {
  // konto musi istnieć także przy imporcie z pliku (literówka w --konto = wiersze archiwum bez konta w raporcie)
  const acc = (await loadChannelAccounts(db, { activeOnly: false })).find((x) => x.channel === kanal && x.channelAccountId === a.konto)
  if (!acc) throw new Error(`brak konta ${kanal} ${a.konto}`)
  if (a.zFakturBl) throw new Error('--z-faktur-bl obsługuje zrodloFaktur')
  if (a.zPliku) {
    if (kanal !== 'ALLEGRO' && kanal !== 'EASYTOOLS') throw new Error(`--z-pliku tylko dla ALLEGRO (zrzut) i EASYTOOLS; ${kanal} czyta się z API`)
    const lista = zamowieniaZPliku(await readFile(a.zPliku, 'utf8'))
    return kanal === 'ALLEGRO' ? zrodloAllegroZrzut(lista) : zrodloEasyTools(lista)
  }
  if (kanal === 'EASYTOOLS') throw new Error('EASYTOOLS: Kompletor nie czyta API EasyTools, podaj --z-pliku <eksport zamówień bez e-maila klienta>')
  const adapter = await createAccountAdapter(db, a.registry, acc, a.src)
  if (!maListe(adapter)) throw new Error(`adapter konta ${kanal} ${a.konto} (${acc.adapterKey}) nie ma odczytu listy zamówień do archiwum`)
  if (kanal === 'WOO') {
    const ad = adapter as unknown as MaListeWoo
    if (typeof ad.opcjeZamowienArchiwum !== 'function') throw new Error(`adapter konta Woo ${a.konto} nie podaje sufitu rabatu firmy (opcjeZamowienArchiwum)`)
    return zrodloWoo(czytnikWoo((q) => ad.odczytListyZamowienArchiwum<unknown>(q)), ad.opcjeZamowienArchiwum())
  }
  if (kanal === 'ALLEGRO') {
    const ad = adapter as unknown as { odczytListyZamowienArchiwum: AllegroGetListy }
    return zrodloAllegroApi(czytnikAllegro((q) => ad.odczytListyZamowienArchiwum(q)))
  }
  const ad = adapter as unknown as { odczytListyZamowienArchiwum: MiraklGetListy }
  return zrodloEmpik(czytnikMirakl((q) => ad.odczytListyZamowienArchiwum(q)))
}

export async function archiwumCli(db: PrismaClient, a: ArgumentyArchiwum): Promise<number> {
  const kanal = (a.kanal ?? 'WOO').toUpperCase()
  if (!(KANALY as readonly string[]).includes(kanal)) throw new Error(`--kanal: ${KANALY.join(' | ')}`)
  if (!a.konto || !/^[\x21-\x7e]{1,100}$/.test(a.konto)) throw new Error('--konto <id konta kanału> (wymagane)')
  if (!a.od) throw new Error('--od RRRR-MM-DD (wymagane, np. 2025-01-01)')
  if (a.naSucho && a.wykonaj) throw new Error('--na-sucho i --wykonaj naraz: wybierz jedno')
  let maksStron: number | undefined
  if (a.maksStron !== undefined) {
    maksStron = Number(a.maksStron)
    if (!Number.isInteger(maksStron) || maksStron < 1 || maksStron > 10_000) throw new Error('--maks-stron: liczba całkowita 1–10000')
  }
  if (a.zFakturBl && a.zPliku) throw new Error('--z-faktur-bl i --z-pliku naraz: wybierz jedno')
  if ((a.zrodlaBl || a.mapaZrodel) && !a.zFakturBl) throw new Error('--zrodla-bl i --mapa-zrodel tylko z --z-faktur-bl')
  if (!a.zrodlaBl !== !a.mapaZrodel) throw new Error('--zrodla-bl i --mapa-zrodel podaje się razem')
  if ((a.progBezOdpowiednika !== undefined || a.pozwolBezOdpowiednika) && !a.zrodlaBl) throw new Error('--prog-bez-odpowiednika i --pozwol-bez-odpowiednika tylko z --zrodla-bl')
  if (a.progBezOdpowiednika !== undefined && a.pozwolBezOdpowiednika) throw new Error('--prog-bez-odpowiednika i --pozwol-bez-odpowiednika naraz: wybierz jedno')
  if (a.progBezOdpowiednika !== undefined && !/^\d{1,9}([.,]\d{1,2})?$/.test(a.progBezOdpowiednika)) throw new Error('--prog-bez-odpowiednika: kwota w zł, np. 0 albo 150,00')
  const fakt = a.zFakturBl ? await zrodloFaktur(db, kanal, a) : null
  // przegląd r2 (W-A): z `--wykonaj` faktury bez odpowiednika ponad próg zatrzymują przebieg PRZED importem i wycofaniem
  // (zapis i usunięcie wierszy przy takim stanie wyrzuciłyby sprzedaż z raportu); na sucho pełny raport i kod 1 niżej
  if (fakt?.bezOdpowiednikaPonadProg && a.wykonaj) {
    console.log(fakt.opis)
    if (a.plik) await writeFile(a.plik, `${fakt.opis}\n`, 'utf8')
    console.error(`[archiwum] ${fakt.bezOdpowiednikaPonadProg} — nic nie zapisano ani nie usunięto`)
    return 1
  }
  const zr = fakt ? fakt.zr : await zrodlo(db, kanal as KanalArchiwum, a)
  let w: WynikImportu
  let kod = 0
  try {
    w = await importujArchiwum(db, zr, {
      konto: a.konto,
      od: poczatekDniaPl(a.od),
      ...(fakt ? { do: fakt.do } : a.do ? { do: poczatekDniaPl(a.do) } : {}),
      naSucho: !a.wykonaj,
      ...(zr.maksNaStrone ? { naStrone: zr.maksNaStrone } : {}),
      ...(maksStron ? { maksStron } : {}),
    })
  } catch (e) {
    const czesciowy = (e as { wynik?: WynikImportu }).wynik
    console.error(`[archiwum] ${e instanceof Error ? e.message : String(e)}`)
    if (!czesciowy) return 1
    w = czesciowy
    kod = 1
  }
  if (fakt) w.opisGranicy = fakt.zrodloKonca // przegląd końcowy: ten sam opis co w sekcji faktur
  const md = raportImportu(w) + (fakt ? `\n\n${fakt.opis}` : '')
  console.log(md)
  if (a.plik) await writeFile(a.plik, `${md}\n`, 'utf8')
  if (fakt?.bezOdpowiednikaPonadProg) console.error(`[archiwum] ${fakt.bezOdpowiednikaPonadProg}`)
  // 1 = błąd przebiegu albo zamówienie z błędem (także nierozwiązane z wcześniejszej części wznowionego przebiegu); 3 = zakres nieprzeczytany do końca (--maks-stron), reszta przy wznowieniu
  // 1 także na sucho przy fakturach z wpisem kanału z archiwum bez zamówienia w bazie ponad próg (z `--wykonaj` przebieg zatrzymuje się wyżej, przed zapisem)
  if (kod || w.bledy.length || w.bledyOtwarte || fakt?.bezOdpowiednikaPonadProg) return 1
  return w.koniec ? 0 : 3
}

/**
 * Etap 3: archiwum Allegro z faktur BL. Koniec zakresu = najwcześniejsze zamówienie Allegro w archiwum z API albo
 * zrzutu tego konta (rozłączność z oknem API: dalej faktura Allegro już ma swój wiersz), `--do` może go tylko skrócić;
 * konto bez archiwum Allegro z API wymaga jawnego `--do`. Pary z innymi kanałami liczone na kandydatach z bazy
 * (archiwum Woo, Empiku, EasyTools i `Order`), więc najpierw import etapów 1–2, potem faktury.
 */
/** Grosze per waluta → „12,50 zł + 3,00 CZK” (do opisu parowania). */
const kwoty = (m: ReadonlyMap<string, number>) => [...m].sort(([a], [b]) => (a === 'PLN' ? -1 : b === 'PLN' ? 1 : a < b ? -1 : 1)).map(([w, g]) => `${(g / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${w === 'PLN' ? 'zł' : w}`).join(' + ') || '0,00 zł'
const sumaWgWaluty = (fs: readonly FakturaBl[]) => {
  const m = new Map<string, number>()
  for (const f of fs) m.set(f.waluta, (m.get(f.waluta) ?? 0) + f.bruttoGr)
  return m
}

async function zrodloFaktur(db: PrismaClient, kanal: string, a: ArgumentyArchiwum): Promise<{ zr: ZrodloArchiwum; do: Date; opis: string; zrodloKonca: string; bezOdpowiednikaPonadProg: string | null }> {
  if (kanal !== 'ALLEGRO') throw new Error('--z-faktur-bl tylko z --kanal ALLEGRO (faktura bez pary w innym kanale = Allegro)')
  const acc = (await loadChannelAccounts(db, { activeOnly: false })).find((x) => x.channel === 'ALLEGRO' && x.channelAccountId === a.konto)
  if (!acc) throw new Error(`brak konta ALLEGRO ${a.konto}`)
  const od = poczatekDniaPl(a.od!)
  const pierwszeApi = await pierwszeZamowienieAllegroZApi(db, a.konto!)
  const doParam = a.do ? poczatekDniaPl(a.do) : null
  if (!pierwszeApi && !doParam) throw new Error(`konto ALLEGRO ${a.konto} nie ma archiwum z API ani zrzutu: zaimportuj je najpierw albo podaj --do RRRR-MM-DD`)
  const koniec = pierwszeApi && (!doParam || pierwszeApi.createdAtChannel < doParam) ? pierwszeApi.createdAtChannel : doParam!
  // przegląd etapu 3: parowanie, opis i wycofanie na tej samej granicy, do której importer naprawdę zapisuje
  // (przycięcie do coverageFrom konta w `granicaImportu`): faktura z obciętego ogona nie zabierze pary fakturze z zakresu
  const gr = await granicaImportu(db, a.konto!, koniec, 'ALLEGRO')
  const doDnia = gr.do
  // przegląd końcowy: naturalny koniec konta liczony bez `--do` (granica wycofania wierszy zapisanych wcześniej)
  const koniecKonta = pierwszeApi
    ? (await granicaImportu(db, a.konto!, pierwszeApi.createdAtChannel, 'ALLEGRO')).do
    : await granicaImportu(db, a.konto!, undefined, 'ALLEGRO').then((g) => g.do, () => null)
  const zrodloKonca = gr.granica === 'parametr przycięty do konta' ? 'początek odczytu kanału przez Kompletora (coverageFrom)' : pierwszeApi && koniec === pierwszeApi.createdAtChannel ? 'pierwsze zamówienie Allegro w archiwum z API/zrzutu' : 'parametr --do'
  // plik źródeł BL czytany przed fakturami: zły plik (kolumna z danymi klientów, kodowanie, zły numer, nazwa spoza mapy)
  // zatrzymuje przebieg przed jakimkolwiek zapisem i przed wycofaniem
  let zrodla: ZrodlaBl | null = null
  let skrotOpcji: string | undefined
  if (a.zrodlaBl) {
    const mapa = parsujMapeZrodel(a.mapaZrodel!, { kanalKonta: 'ALLEGRO', kanalyArchiwum: KANALY })
    const bajty = await readFile(a.zrodlaBl)
    zrodla = zrodlaBlZCsv(tekstZrodelBl(bajty), mapa)
    // wznowienie tylko z tym samym plikiem źródeł i tą samą mapą
    skrotOpcji = createHash('sha256').update(bajty).update('\0').update(JSON.stringify([...mapa].sort())).digest('hex').slice(0, 16)
  }
  const surowe = fakturyZPliku(await readFile(a.zFakturBl!, 'utf8'))
  const czytelne: FakturaBl[] = []
  for (const r of surowe) {
    try {
      czytelne.push(fakturaBlZSurowej(r))
    } catch {
      // nieczytelny rekord trafi do raportu jako błąd mapowania importera
    }
  }
  if (zrodla) {
    const blad = bladSpozaMapy(zrodla, czytelne.filter((f) => f.typ === 'normal' && f.orderId !== null).map((f) => f.orderId!))
    if (blad) throw new Error(blad)
  }
  const faktury: FakturaBl[] = []
  const zeZrodel = new Map<string, FakturaBl[]>()
  for (const f of czytelne) {
    if (f.typ !== 'normal' || f.czasSprzedazy < od || f.czasSprzedazy >= doDnia) continue
    const kz = zrodla && f.orderId !== null ? zrodla.kanal.get(f.orderId) : undefined
    if (kz !== undefined) zeZrodel.set(kz, [...(zeZrodel.get(kz) ?? []), f])
    else faktury.push(f)
  }
  const kandydaci = await kandydaciZBazy(db, od, doDnia)
  // faktury z wpisem kanału z archiwum zajmują pary swojego kanału, zanim sparują się faktury bez wpisu
  const zWpisem = [...zeZrodel].filter(([k]) => k !== 'ALLEGRO' && k !== POMIN).flatMap(([k, fs]) => fs.map((f) => ({ f, kanal: k })))
  const { pary, wlasne, bezOdpowiednika } = parujZeZrodlami(faktury, zWpisem, kandydaci)
  const wgKanalu = new Map<string, number>()
  for (const k of pary.values()) wgKanalu.set(k.kanal, (wgKanalu.get(k.kanal) ?? 0) + 1)
  // (c): sprzedaż innego kanału wg pliku bez zamówienia w bazie nie jest liczona nigdzie: ostrzeżenie i próg
  const sumaBez = sumaWgWaluty(bezOdpowiednika)
  const progGr = a.progBezOdpowiednika !== undefined ? Math.round(Number(a.progBezOdpowiednika.replace(',', '.')) * 100) : 0
  const ponadProg = bezOdpowiednika.length > 0 && !a.pozwolBezOdpowiednika && ((sumaBez.get('PLN') ?? 0) > progGr || [...sumaBez.keys()].some((w) => w !== 'PLN'))
  const kanalFaktury = new Map(zWpisem.map((x) => [x.f.invoiceId, x.kanal]))
  const wgKanaluBez = new Map<string, FakturaBl[]>()
  for (const f of bezOdpowiednika) wgKanaluBez.set(kanalFaktury.get(f.invoiceId)!, [...(wgKanaluBez.get(kanalFaktury.get(f.invoiceId)!) ?? []), f])
  // przegląd r2 (W-A): liczba i suma per kanał; D-B: do 20 numerów faktur (numery dokumentów, bez danych nabywcy) do sprawdzenia ręcznie
  const opisBez = `${bezOdpowiednika.length} za ${kwoty(sumaBez)}${wgKanaluBez.size ? ` (${[...wgKanaluBez].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, fs]) => `${k} ${fs.length} za ${kwoty(sumaWgWaluty(fs))}`).join(', ')})` : ''}`
  const numeryBez = [...bezOdpowiednika].sort((x, y) => x.czasSprzedazy.getTime() - y.czasSprzedazy.getTime() || x.invoiceId - y.invoiceId)
  const opisNumerowBez = numeryBez.length ? `${numeryBez.slice(0, 20).map((f) => `${f.numer} (${f.czasSprzedazy.toISOString().slice(0, 10)})`).join(', ')}${numeryBez.length > 20 ? ` i ${numeryBez.length - 20} więcej` : ''}` : ''
  const nZeZrodel = [...zeZrodel.values()].reduce((x, y) => x + y.length, 0)
  const pomin = zeZrodel.get(POMIN) ?? []
  const allegroZPliku = zeZrodel.get('ALLEGRO') ?? []
  const walutaSprzeczna = zrodla ? [...zeZrodel.values()].flat().filter((f) => { const w = zrodla!.waluta.get(f.orderId!); return !!w && w !== f.waluta }).length : 0
  const linieZrodel = zrodla
    ? [
        `- Plik źródeł BL: ${zrodla.wierszy} zamówień; faktury w zakresie z wpisem w pliku: ${nZeZrodel} (Allegro, kanał podany: ${allegroZPliku.length}; inny kanał z archiwum: ${zWpisem.length}, z zamówieniem swojego kanału w bazie: ${wlasne.size}).`,
        ...[...zeZrodel].filter(([k]) => k !== 'ALLEGRO' && k !== POMIN).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, fs]) => `- wg pliku źródeł: ${k}: ${fs.length}`),
        `- Pominięte świadomie (${POMIN} w mapie): ${pomin.length} za ${kwoty(sumaWgWaluty(pomin))}.`,
        `- Inny kanał wg pliku, bez odpowiednika w bazie: ${opisBez}.`,
        ...(opisNumerowBez ? [`- Numery faktur bez odpowiednika (data sprzedaży): ${opisNumerowBez}.`] : []),
        ...(bezOdpowiednika.length ? [`- **Ostrzeżenie:** te faktury nie liczą się w żadnym kanale (nie ma ich zamówienia w archiwum ani w Kompletorze); najpierw zaimportuj archiwum tego kanału za ten okres${ponadProg ? `; kod wyjścia 1 (próg --prog-bez-odpowiednika)${a.wykonaj ? ', przebieg zatrzymany przed zapisem' : ''}` : ''}.`] : []),
        ...(walutaSprzeczna ? [`- Waluta w pliku źródeł inna niż na fakturze: ${walutaSprzeczna} (liczona waluta faktury).`] : []),
        `- Usuwanie z archiwum faktur z wpisem innego kanału albo ${POMIN} dotyczy tylko zakresu dat przebiegu (tego samego co licznik „bez odpowiednika”).`,
      ]
    : []
  const opis = [
    `## Parowanie faktur (${ZRODLO_FAKTURA_BL})`,
    '',
    `- Koniec zakresu: ${doDnia.toISOString()} (${zrodloKonca}).`,
    ...linieZrodel,
    `- Faktury ${zrodla ? 'bez wpisu w pliku źródeł' : 'normalne w zakresie'}: ${faktury.length}; z parą w innym kanale albo źródle: ${pary.size}; bez pary (= Allegro, kanał odtworzony): ${faktury.length - pary.size}.`,
    `- Kandydaci z bazy: ${kandydaci.length}.`,
    ...[...wgKanalu].sort().map(([k, n]) => `- para: ${k}: ${n}`),
  ].join('\n')
  const zr = zrodloFakturyBl(surowe, pary, koniecKonta, zrodla, { od, do: doDnia })
  if (skrotOpcji) zr.skrotOpcji = skrotOpcji
  const bezOdpowiednikaPonadProg = ponadProg ? `faktury z wpisem kanału z archiwum bez zamówienia w bazie: ${opisBez}; numery: ${opisNumerowBez}; ponad próg ${kwoty(new Map([['PLN', progGr]]))} (inna waluta niż PLN zawsze); najpierw zaimportuj archiwum tego kanału za ten okres albo, po sprawdzeniu tych faktur, podaj --prog-bez-odpowiednika <zł> / --pozwol-bez-odpowiednika` : null
  return { zr, do: doDnia, opis, zrodloKonca, bezOdpowiednikaPonadProg }
}

/** Etap 1: `archiwum-woo` = `archiwum --kanal WOO`. */
export async function archiwumWooCli(db: PrismaClient, a: Omit<ArgumentyArchiwum, 'kanal' | 'zPliku'>): Promise<number> {
  return archiwumCli(db, { ...a, kanal: 'WOO' })
}
