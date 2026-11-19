// Przeprowadzka z BL: raport po polsku (Markdown + JSON), zapisywany poza repo. Bez danych klientów:
// zamówienia występują wyłącznie jako id BL, kanał, liczby pozycji i status; produkty i oferty — SKU, EAN, nazwa
// z katalogu (nie z zamówienia). Czysta funkcja: dostaje gotowe wyniki, niczego nie czyta.
import type { Analysis } from '../import/katalog'
import { offerIntent, sellableBl } from '../import/mapowanie'
import type { FetchIssue } from '../import/pobieranie'
import type { ZebraneDane } from './przebieg'
import type { PlanKonfiguracji } from './rozpoznanie'
import { statusFirmyDlaBl, TERMINALNE } from './statusy'
import { KOLORY_STATUSOW, type GrupaStatusowT, type StatusFirmyT } from '@/lib/panel/statusy'
import { bladZestawu, nazwaEtapu, planAutomatow, planStatusowFirmy, statusyPoPlanie, uzupelnienieEtapow } from './statusy-firmy'
import type { RoznicaStanu, WynikZapisu } from './zapis'
import type { WynikZamowienia } from './zamowienia'

export interface DaneRaportu {
  firma: string
  tryb: 'PROBNY' | 'ZAPIS'
  wygenerowano: Date
  dane: ZebraneDane
  plan: PlanKonfiguracji
  analiza: Analysis | null
  zamowienia: WynikZamowienia[]
  /** Otwarte zamówienia ze źródeł pominiętych w mapie albo bez konta — nie są przenoszone. */
  zamowieniaPominiete: number
  otwartePoStatusie: ReadonlyMap<string, number>
  powodyOdmowy: string[]
  roznice: RoznicaStanu[]
  /** statusy firmy (mapa statusów BL → status firmy w raporcie); brak = sama mapa na etapy */
  statusyFirmy?: readonly StatusFirmyT[]
  /** statusy firmy przed zapisem (plan importu); brak = statusyFirmy */
  statusyFirmyPrzed?: readonly StatusFirmyT[]
  /** grupy statusów firmy przed zapisem; `automatyZalozone` = znacznik automatów z poprzedniego zapisu */
  grupyStatusowFirmy?: readonly GrupaStatusowT[]
  automatyZalozone?: boolean
  zapis: WynikZapisu | null
}

/** import statusów BL jako statusów firmy i automaty z najbliższego szablonu (raport, ekran). */
export interface ImportStatusowJson {
  statusy: { id: string; nazwa: string; klucz: string; kolor: string; nazwaDlaKlienta: string | null; grupa: string | null; etap: string; doPotwierdzenia: boolean; juzJest: boolean }[]
  grupyNowe: string[]
  ukryteDomyslne: string[]
  ostrzezenia: string[]
  /** zestaw po imporcie nie przechodzi walidacji: statusy nie przejdą (powód) */
  blad: string | null
  automaty: { szablon: { id: string; nazwa: string } | null; powod: string; przeniesione: string[]; nieprzeniesione: { nazwa: string; powod: string }[]; juzJest: boolean }
}

export interface TabelaZgodnosci {
  wiersz: string
  bl: number
  plan: number
  uwagi: string
}

export interface RaportJson {
  firma: string
  tryb: 'PROBNY' | 'ZAPIS'
  wygenerowano: string
  pobrano: string
  katalog: { id: string; nazwa: string; magazynStanu: string | null; zrodloStanu: 'wFirma' | 'magazyn BL' } | null
  /** wszystkie katalogi produktów BL (wybór katalogu na ekranie przeprowadzki). */
  katalogiBl: { id: string; nazwa: string }[]
  powodyOdmowy: string[]
  coPrzejdzie: Record<string, number>
  doDecyzji: {
    /** `otwartychZamowien` jako tekst „≥ N”, gdy status do decyzji czytano tylko pierwszą stroną. */
    statusy: { id: string; nazwa: string; grupa: string | null; podpowiedz: string | null; teraz: string; otwartychZamowien: number | string }[]
    przewoznicy: { metoda: string; zamowien: number; podpowiedz: string | null; powod: string }[]
    zrodlaBezAdaptera: { zrodlo: string; konto: string; powod: string }[]
    ofertyBezPowiazania: { kanal: string; konto: string; oferta: string; sku: string | null; powod: string }[]
    produktyBezSku: { idBl: string; nazwa: string; powod: string }[]
    produktyBezEan: number
    zestawy: { idBl: string; sku: string | null; problem: string }[]
    zamowieniaDoWyjasnienia: { idBl: string; kanal: string; pozycjeBezPowiazania: number; powod: string }[]
    rozniceStanow: RoznicaStanu[]
  }
  /** `statusFirmy` = nazwa statusu firmy, pod którym zamówienie będzie widać w panelu (null = nazwa etapu) */
  statusy: { id: string; nazwa: string; status: string; pewnosc: string; otwarte: boolean; statusFirmy?: string | null }[]
  /** `zrodlo` = „<typ>:<id>” źródła BL (klucz decyzji „pomiń źródło”). */
  konta: { kanal: string; konto: string; nazwa: string; adapter: string; blStorageId: string | null; pominiete: boolean; zrodlo: string }[]
  reguly: { priorytet: number; kanal: string | null; metoda: string | null; przewoznik: string; modul: string }[]
  zgodnosc: TabelaZgodnosci[]
  problemyPobierania: FetchIssue[]
  wywolaniaBl: Record<string, number>
  zapis: Record<string, unknown> | null
  /** (brak w raportach sprzed zmiany) */
  importStatusow?: ImportStatusowJson
}

/** Plan importu statusów i automatów z decyzji statusów i stanu firmy (czysto; to samo liczy zapis). */
export function importStatusow(d: Pick<DaneRaportu, 'plan' | 'statusyFirmy' | 'statusyFirmyPrzed' | 'grupyStatusowFirmy' | 'automatyZalozone'>): ImportStatusowJson {
  const ist = { statusy: d.statusyFirmyPrzed ?? d.statusyFirmy ?? [], grupy: d.grupyStatusowFirmy ?? [] }
  const p = planStatusowFirmy(d.plan.statusy, ist)
  const po = statusyPoPlanie(p, ist)
  const pelne = [...po.statusy, ...uzupelnienieEtapow(p, ist.statusy)]
  const a = planAutomatow(pelne, new Set(p.statusy.map((s) => s.etap)), d.plan.konta.filter((k) => !k.pominiete).map((k) => ({ typ: k.zrodlo.typ })), d.automatyZalozone ?? false)
  const grupaNazwa = new Map([...ist.grupy, ...p.grupy].map((g) => [g.key, g.name]))
  return {
    statusy: p.statusy.map((s) => ({ id: s.blStatusId, nazwa: s.nazwa, klucz: s.klucz, kolor: KOLORY_STATUSOW[s.kolor].nazwa, nazwaDlaKlienta: s.nazwaDlaKlienta, grupa: s.grupa ? (grupaNazwa.get(s.grupa) ?? null) : null, etap: nazwaEtapu(s.etap), doPotwierdzenia: s.doPotwierdzenia, juzJest: s.juzJest })),
    grupyNowe: p.grupy.map((g) => g.name),
    ukryteDomyslne: p.ukryteDomyslne.map((k) => ist.statusy.find((s) => s.key === k)?.name ?? k),
    ostrzezenia: p.ostrzezenia,
    blad: bladZestawu(pelne, po.grupy),
    automaty: { szablon: a.szablon, powod: a.powod, przeniesione: a.przeniesione, nieprzeniesione: a.nieprzeniesione, juzJest: a.juzJest },
  }
}

const NIE_PRZENOSIMY = [
  'historii zamówień (zamówienia zakończone: wysłane, odebrane, anulowane) — zostaje w BL',
  'danych klientów (imiona, adresy, e-maile, telefony, dane do faktur, komentarze) — ani z otwartych zamówień',
  'automatycznych akcji BL (API BaseLinkera ich nie udostępnia: w ich miejsce przychodzą wyłączone reguły najbliższego szablonu, patrz „Statusy i automatyczne akcje”), szablonów maili, wydruków i etykiet',
  'zwrotów i reklamacji prowadzonych w BL',
  'list poprzednich przesyłek i numerów nadania',
  'dokumentów sprzedaży (faktur, paragonów) i serii numeracji',
  'pól dodatkowych zamówień',
]

function decyzjeOfert(a: Analysis | null): RaportJson['doDecyzji']['ofertyBezPowiazania'] {
  if (!a) return []
  return a.offers
    .filter((o) => o.state !== 'MAPPED' || offerIntent(o) === 'PROPOSAL')
    .map((o) => ({
      kanal: o.channel,
      konto: o.accountId,
      oferta: o.externalId,
      sku: o.sku,
      powod:
        o.state === 'AMBIGUOUS'
          ? 'oferta wskazuje kilka produktów BL'
          : o.state === 'UNMAPPED'
            ? 'oferta bez powiązania z produktem'
            : 'dopasowana tylko po SKU — do zatwierdzenia w panelu (oferta nieaktywna)',
    }))
}

export function zbudujRaport(d: DaneRaportu): RaportJson {
  const { plan, analiza: a, dane } = d
  const raw = dane.katalog
  const otwarteIds = new Set(plan.statusy.filter((s) => !TERMINALNE.has(s.status)).map((s) => s.blStatusId))
  const sellable = raw ? sellableBl(raw.bl.products) : []
  const produktyPlan = a?.plan.products ?? []
  const ofertyBl = raw ? raw.shopOffers.filter((o) => !o.isParentWithVariants).length : 0
  const ofertyZeSprzedazy = a ? a.offers.filter((o) => o.source === 'BL_ORDERS' || (o.channel !== 'WOO' && o.channel !== 'EMPIK')).length : 0
  const zam = d.zamowienia
  const bezSku = a ? a.plan.blWithoutWfirma.filter((p) => !p.isBundle) : []
  const zrodloStanu = raw?.stockSource === 'bl' ? 'magazyn BL' : 'wFirma'

  const imp = importStatusow(d)
  const coPrzejdzie: Record<string, number> = {
    statusyFirmyNowe: imp.blad ? 0 : imp.statusy.filter((s) => !s.juzJest).length,
    regulyZSzablonu: imp.automaty.juzJest ? 0 : imp.automaty.przeniesione.length,
    konta: plan.konta.filter((k) => !k.pominiete).length,
    statusy: plan.statusy.length,
    produkty: produktyPlan.filter((p) => p.kind === 'STOCKED').length,
    zestawy: produktyPlan.filter((p) => p.kind === 'BUNDLE').length,
    produktyBezStanu: produktyPlan.filter((p) => p.kind === 'DIGITAL').length,
    stanyStartowe: produktyPlan.filter((p) => p.kind === 'STOCKED').length - d.roznice.length,
    ofertyAktywne: a ? a.offers.filter((o) => o.state === 'MAPPED' && offerIntent(o) === 'ACTIVE').length : 0,
    ofertyDoZatwierdzenia: a ? a.offers.filter((o) => o.state === 'MAPPED' && offerIntent(o) === 'PROPOSAL').length : 0,
    regulyPrzewoznikow: plan.reguly.length,
    zamowieniaOtwarte: zam.length,
    zamowieniaDoWyjasnienia: zam.filter((z) => z.status === 'DO_WYJASNIENIA').length,
    zamowieniaBledy: zam.filter((z) => z.wynik === 'BLAD').length,
  }

  const zgodnosc: TabelaZgodnosci[] = [
    {
      wiersz: 'Produkty (z wariantami, bez rodziców wariantów)',
      bl: sellable.length,
      plan: produktyPlan.reduce((n, p) => n + (p.kind === 'DIGITAL' ? 0 : p.blIds.length), 0),
      uwagi: `bez produktu w planie: ${bezSku.length} (brak SKU / SKU powtórzone / bez towaru wFirmy), zestawy z problemem: ${a?.plan.bundleProblems.length ?? 0}`,
    },
    {
      wiersz: 'Oferty (sklepy z BL + kanały ze sprzedaży)',
      bl: ofertyBl + ofertyZeSprzedazy,
      plan: a ? a.offers.filter((o) => o.state === 'MAPPED').length : 0,
      uwagi: `bez powiązania albo wieloznaczne: ${a ? a.offers.filter((o) => o.state !== 'MAPPED').length : 0}`,
    },
    {
      wiersz: 'Otwarte zamówienia',
      bl: dane.zamowienia.otwarte.filter((o) => otwarteIds.has(o.order_status_id)).length,
      plan: zam.filter((z) => z.wynik !== 'BLAD').length,
      uwagi: `pominięte (źródło pominięte w mapie): ${d.zamowieniaPominiete}, błędy: ${coPrzejdzie['zamowieniaBledy']}`,
    },
    {
      wiersz: 'Ostatnie zamówienia (okno 30 dni, tylko do rozpoznania metod dostawy)',
      bl: dane.zamowienia.ostatnie.length,
      plan: 0,
      uwagi: dane.zamowienia.ostatnieObciete
        ? `okno obcięte do ${dane.zamowienia.ostatnie.length} pierwszych zamówień (limit stron) — to nie błąd: metody dostawy rozpoznane z tej próbki`
        : 'pełne okno; nie są przenoszone, jeśli nie są otwarte',
    },
  ]

  return {
    firma: d.firma,
    tryb: d.tryb,
    wygenerowano: d.wygenerowano.toISOString(),
    pobrano: dane.pobrano,
    katalog: plan.katalog ? { id: plan.katalog.id, nazwa: plan.katalog.nazwa, magazynStanu: plan.katalog.magazynStanu, zrodloStanu } : null,
    katalogiBl: dane.konfiguracja.katalogi.map((k) => ({ id: k.id, nazwa: k.nazwa })),
    powodyOdmowy: d.powodyOdmowy,
    coPrzejdzie,
    doDecyzji: {
      statusy: plan.statusy
        .filter((s) => s.pewnosc === 'DO_DECYZJI')
        .map((s) => ({ id: s.blStatusId, nazwa: s.nazwa, grupa: s.grupa, podpowiedz: s.podpowiedz, teraz: s.status, otwartychZamowien: (dane.zamowienia.statusyObciete ?? []).includes(s.blStatusId) ? `≥ ${d.otwartePoStatusie.get(s.blStatusId) ?? 0}` : (d.otwartePoStatusie.get(s.blStatusId) ?? 0) })),
      przewoznicy: plan.decyzjePrzewoznikow.map((x) => ({ metoda: x.metoda, zamowien: x.zamowien, podpowiedz: x.podpowiedz, powod: x.powod })),
      zrodlaBezAdaptera: plan.konta.filter((k) => k.ostrzezenie).map((k) => ({ zrodlo: `${k.zrodlo.typ}:${k.zrodlo.id}`, konto: `${k.channel}/${k.channelAccountId}`, powod: k.ostrzezenie! })),
      ofertyBezPowiazania: decyzjeOfert(a),
      produktyBezSku: bezSku.map((p) => ({ idBl: p.id, nazwa: p.name, powod: !p.sku ? 'brak SKU' : raw?.stockSource === 'bl' ? `SKU „${p.sku}” powtórzone w BL` : 'bez towaru w wFirmie' })),
      produktyBezEan: sellable.filter((p) => !p.isBundle && !p.ean).length,
      zestawy: (a?.plan.bundleProblems ?? []).map((x) => ({ idBl: x.bl.id, sku: x.bl.sku, problem: x.problem })),
      zamowieniaDoWyjasnienia: zam
        .filter((z) => z.status === 'DO_WYJASNIENIA' || z.wynik === 'BLAD')
        .map((z) => ({
          idBl: z.blOrderId,
          kanal: `${z.channel}/${z.channelAccountId}`,
          pozycjeBezPowiazania: z.pozycjeBezPowiazania,
          powod: z.wynik === 'BLAD' ? `błąd: ${z.blad ?? '?'}` : z.pozycjeBezPowiazania ? 'pozycja bez powiązania z produktem' : 'metoda dostawy bez reguły przewoźnika',
        })),
      rozniceStanow: d.roznice,
    },
    statusy: plan.statusy.map((s) => ({ id: s.blStatusId, nazwa: s.nazwa, status: s.status, pewnosc: s.pewnosc, otwarte: !TERMINALNE.has(s.status), ...(d.statusyFirmy?.length ? { statusFirmy: statusFirmyDlaBl(s, d.statusyFirmy)?.nazwa ?? null } : {}) })),
    konta: plan.konta.map((k) => ({ kanal: k.channel, konto: k.channelAccountId, nazwa: k.name, adapter: k.adapterKey, blStorageId: k.blStorageId, pominiete: k.pominiete, zrodlo: `${k.zrodlo.typ}:${k.zrodlo.id}` })),
    reguly: plan.reguly.map((r) => ({ priorytet: r.priority, kanal: r.channel, metoda: r.metoda, przewoznik: r.carrier, modul: r.shippingModule })),
    zgodnosc,
    problemyPobierania: [...new Map([...dane.issues, ...(raw?.issues ?? [])].map((i) => [`${i.kind}|${i.ref}|${i.message}`, i])).values()],
    wywolaniaBl: dane.wywolania,
    zapis: d.zapis
      ? {
          runId: d.zapis.runId,
          kontaNowe: d.zapis.konfiguracja.kontaNowe,
          produkty: d.zapis.katalog?.products ?? 0,
          stanyNowe: d.zapis.katalog?.stocksCreated ?? 0,
          oferty: d.zapis.katalog?.channelOffers ?? 0,
          reguly: d.zapis.reguly.powod,
          zamowieniaNowe: d.zapis.zamowienia.filter((z) => z.wynik === 'NOWE').length,
          zamowieniaDuplikaty: d.zapis.zamowienia.filter((z) => z.wynik === 'DUPLIKAT').length,
          ...(d.zapis.konfiguracja.statusyFirmy ? { statusyFirmyNowe: d.zapis.konfiguracja.statusyFirmy.nowe, statusyUkryte: d.zapis.konfiguracja.statusyFirmy.ukryte } : {}),
          ...(d.zapis.konfiguracja.automaty ? { regulyZBl: d.zapis.konfiguracja.automaty.reguly } : {}),
        }
      : null,
    importStatusow: imp,
  }
}

const esc = (s: string | number | null | undefined) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const LIMIT = 200

function tabela(naglowki: string[], wiersze: (string | number | null | undefined)[][]): string {
  if (!wiersze.length) return '_brak_\n'
  const cut = wiersze.slice(0, LIMIT)
  const more = wiersze.length > LIMIT ? `\n_…i ${wiersze.length - LIMIT} więcej (pełna lista w raport-przeprowadzki.json)_\n` : ''
  return [`| ${naglowki.join(' | ')} |`, `| ${naglowki.map(() => '---').join(' | ')} |`, ...cut.map((w) => `| ${w.map(esc).join(' | ')} |`)].join('\n') + '\n' + more
}

export function renderMarkdown(r: RaportJson, plan: PlanKonfiguracji): string {
  const L: string[] = []
  const c = r.coPrzejdzie
  L.push(`# Przeprowadzka z BaseLinkera — ${r.tryb === 'PROBNY' ? 'tryb próbny (nic nie zapisano)' : 'zapis'}`)
  L.push('')
  L.push(`Firma: **${r.firma}** · raport: ${r.wygenerowano} · dane z BL: ${r.pobrano}`)
  L.push('')
  L.push('W BaseLinkerze nic się nie zmieniło: przeprowadzka używa tylko metod odczytu. BaseLinker zostaje źródłem prawdy do przełączenia, a Kompletor działa obok w trybie „Tylko podgląd”.')
  L.push('')
  if (r.katalog) L.push(`Katalog BL: **${r.katalog.id}** „${esc(r.katalog.nazwa)}”, stan startowy z: **${r.katalog.zrodloStanu}**${r.katalog.zrodloStanu === 'magazyn BL' ? ` (${r.katalog.magazynStanu ?? '?'})` : ''}.`)
  else L.push(`**Katalog BL nie wybrany:** ${esc(plan.bladKatalogu)}`)
  L.push('')
  if (r.powodyOdmowy.length) {
    L.push(r.tryb === 'PROBNY' ? '## Zapis (`--zapisz`) zostałby teraz odrzucony' : '## Zapis odrzucony')
    L.push('')
    for (const p of r.powodyOdmowy) L.push(`- ${p}`)
    L.push('')
  } else if (r.tryb === 'PROBNY') {
    L.push('Zapis (`--zapisz`) jest możliwy — po przejrzeniu raportu i decyzjach w pliku mapy.')
    L.push('')
  }

  L.push('## 1. Co przejdzie')
  L.push('')
  L.push(
    tabela(
      ['Etap', 'Liczba', 'Uwagi'],
      [
        ['Konta kanałów (wszystkie w trybie CIEN)', c['konta'], plan.konta.filter((k) => !k.pominiete).map((k) => `${k.channel} ${k.name}`).join(', ')],
        ['Statusy BL w mapie', c['statusy'], `otwarte: ${r.statusy.filter((s) => s.otwarte).length}, do decyzji: ${r.doDecyzji.statusy.length}`],
        ['Produkty ze stanem', c['produkty'], ''],
        ['Zestawy', c['zestawy'], ''],
        ['Produkty bez stanu', c['produktyBezStanu'], 'reguły katalogu firmy'],
        ['Stany startowe', c['stanyStartowe'], r.doDecyzji.rozniceStanow.length ? `istniejących stanów nie nadpisujemy: ${r.doDecyzji.rozniceStanow.length} różnic niżej` : ''],
        ['Oferty aktywne', c['ofertyAktywne'], ''],
        ['Oferty do zatwierdzenia', c['ofertyDoZatwierdzenia'], 'dopasowane tylko po SKU, nieaktywne'],
        ['Reguły przewoźników', c['regulyPrzewoznikow'], 'moduł wysyłki: BRAK (bez kluczy kurierów)'],
        ['Otwarte zamówienia', c['zamowieniaOtwarte'], `w tym do wyjaśnienia: ${c['zamowieniaDoWyjasnienia']}, błędy: ${c['zamowieniaBledy']}`],
      ],
    ),
  )
  if (r.zapis) {
    L.push('**Zapisano:** ' + Object.entries(r.zapis).map(([k, v]) => `${k}: ${esc(v as string)}`).join(', '))
    L.push('')
  }

  L.push('## 2. Co wymaga decyzji człowieka')
  L.push('')
  L.push('Decyzje wpisz w pliku mapy (JSON, bez danych klientów) i uruchom ponownie z `--mapa <plik>`. Przykład:')
  L.push('')
  L.push('```json')
  L.push(
    JSON.stringify(
      {
        statusy: Object.fromEntries(r.doDecyzji.statusy.slice(0, 2).map((s) => [s.id, s.podpowiedz ?? 'DO_WYJASNIENIA'])),
        przewoznicy: Object.fromEntries(r.doDecyzji.przewoznicy.slice(0, 2).map((p) => [p.metoda, p.podpowiedz ?? 'BRAK'])),
        zrodla: {},
      },
      null,
      2,
    ),
  )
  L.push('```')
  L.push('')
  L.push('### Statusy BL')
  L.push('')
  L.push('Status niepewny nigdy nie jest „zakończony”: do decyzji przechodzi jako DO_WYJASNIENIA. `--zapisz` odmawia, dopóki status do decyzji ma otwarte zamówienia.')
  L.push('')
  L.push(tabela(['Id', 'Nazwa w BL', 'Grupa', 'Podpowiedź', 'Teraz', 'Otwarte zam.'], r.doDecyzji.statusy.map((s) => [s.id, s.nazwa, s.grupa, s.podpowiedz, s.teraz, s.otwartychZamowien])))
  L.push('### Przewoźnicy (metody dostawy bez pewnego przewoźnika)')
  L.push('')
  L.push(tabela(['Metoda dostawy', 'Zamówień', 'Podpowiedź', 'Powód'], r.doDecyzji.przewoznicy.map((p) => [p.metoda, p.zamowien, p.podpowiedz, p.powod])))
  L.push('### Źródła zamówień bez adaptera w Kompletorze')
  L.push('')
  L.push(tabela(['Źródło BL', 'Konto', 'Uwaga'], r.doDecyzji.zrodlaBezAdaptera.map((z) => [z.zrodlo, z.konto, z.powod])))
  L.push('### Oferty bez powiązania albo do zatwierdzenia')
  L.push('')
  L.push(tabela(['Kanał', 'Konto', 'Oferta', 'SKU', 'Powód'], r.doDecyzji.ofertyBezPowiazania.map((o) => [o.kanal, o.konto, o.oferta, o.sku, o.powod])))
  L.push('### Produkty bez produktu w planie (bez SKU, SKU powtórzone, bez towaru wFirmy)')
  L.push('')
  L.push('Nie sklejamy produktów po samej nazwie. Popraw SKU w BL albo zdecyduj w panelu po zapisie.')
  L.push('')
  L.push(tabela(['Id BL', 'Nazwa', 'Powód'], r.doDecyzji.produktyBezSku.map((p) => [p.idBl, p.nazwa, p.powod])))
  L.push(`Produkty bez EAN: **${r.doDecyzji.produktyBezEan}** (przejdą, ale bez EAN część kanałów ich nie przyjmie).`)
  L.push('')
  L.push('### Zestawy z problemem')
  L.push('')
  L.push(tabela(['Id BL', 'SKU', 'Problem'], r.doDecyzji.zestawy.map((z) => [z.idBl, z.sku, z.problem])))
  L.push('### Zamówienia do wyjaśnienia')
  L.push('')
  L.push(tabela(['Id zamówienia BL', 'Konto', 'Pozycje bez powiązania', 'Powód'], r.doDecyzji.zamowieniaDoWyjasnienia.map((z) => [z.idBl, z.kanal, z.pozycjeBezPowiazania, z.powod])))
  L.push('### Stany różne od źródła (istniejący stan w Kompletorze zostaje)')
  L.push('')
  L.push(tabela(['SKU', 'Kompletor', 'Źródło'], r.doDecyzji.rozniceStanow.map((x) => [x.sku, x.kompletor, x.zrodlo])))

  L.push('## 3. Czego nie przenosimy')
  L.push('')
  for (const x of NIE_PRZENOSIMY) L.push(`- ${x}`)
  L.push('')

  L.push('## 4. Co dalej (człowiek)')
  L.push('')
  const sklepy = plan.konta.filter((k) => k.channel === 'WOO' && !k.pominiete)
  const allegro = plan.konta.filter((k) => k.channel === 'ALLEGRO' && !k.pominiete)
  const empik = plan.konta.filter((k) => k.channel === 'EMPIK' && !k.pominiete)
  const kroki = [
    'Przejrzyj sekcję 2 i zapisz decyzje (na ekranie przeprowadzki „Zapisz decyzje”, w poleceniu: plik mapy); uruchom tryb próbny jeszcze raz, aż sekcja „zapis zostałby odrzucony” zniknie.',
    'Uruchom import (na ekranie przeprowadzki „Importuj”, w poleceniu `--zapisz`). Wszystkie konta powstają w trybie „Tylko podgląd”: Kompletor niczego nie wysyła do kanałów.',
    ...(sklepy.length ? [`Sklepy (${sklepy.map((k) => k.name).join(', ')}): każdy sklep potrzebuje własnych kluczy API sklepu: wpisz je na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży).`] : []),
    ...(allegro.length ? [`Allegro (${allegro.map((k) => k.name).join(', ')}): przycisk „Połącz z Allegro” na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży).`] : []),
    ...(empik.length ? ['Empik: klucz API konta Empik na ekranie konta (Ustawienia → Sprzedaż i kanały → Kanały sprzedaży).'] : []),
    ...(plan.reguly.length ? ['Kurierzy: klucze API kurierów (Ustawienia → Wysyłka i druk → Przewoźnicy); do tego czasu etykiety robi BaseLinker.'] : []),
    'Do przełączenia każdego kanału (osobna decyzja) BaseLinker zostaje źródłem prawdy; Kompletor porównuje dane w trybie „Tylko podgląd”.',
  ]
  kroki.forEach((k, i) => L.push(`${i + 1}. ${k}`))
  L.push('')

  if (r.importStatusow) {
    const im = r.importStatusow
    L.push('## Statusy i automatyczne akcje')
    L.push('')
    if (im.blad) L.push(`**Statusy z BL nie przejdą:** ${esc(im.blad)}`)
    L.push('Statusy BL przechodzą jako statusy firmy z nazwą, kolorem, nazwą dla klienta i grupą. Etap pracy każdego statusu (od niego zależy pakowanie i wysyłka) dobiera Kompletor; pozycje „do potwierdzenia” wybierz w sekcji „Decyzje”, zanim zatwierdzisz import.')
    L.push('')
    L.push(tabela(['Id', 'Nazwa', 'Etap pracy', 'Kolor', 'Nazwa dla klienta', 'Grupa', 'Do potwierdzenia', 'Już jest'], im.statusy.map((s) => [s.id, s.nazwa, s.etap, s.kolor, s.nazwaDlaKlienta, s.grupa, s.doPotwierdzenia ? 'tak' : '', s.juzJest ? 'tak' : ''])))
    if (im.ukryteDomyslne.length) L.push(`Domyślne statusy ukryte po imporcie (zastąpią je statusy z BL): ${im.ukryteDomyslne.join(', ')}.`, '')
    for (const o of im.ostrzezenia) L.push(`- ${esc(o)}`)
    const a = im.automaty
    L.push('')
    L.push('### Automatyczne akcje')
    L.push('')
    L.push(`API BaseLinkera nie pozwala odczytać automatycznych akcji, więc trzeba je odtworzyć. Proponujemy szablon **${esc(a.szablon?.nazwa)}** (${esc(a.powod)}): jego reguły trafią do grupy „Z BaseLinkera”, wyłączone. Sprawdź je przyciskiem „Sprawdź na ostatnich 7 dniach” (Ustawienia → Sprzedaż i kanały → Automatyczne akcje) i włącz te, które odpowiadają Twoim akcjom z BL.`)
    L.push('')
    if (a.juzJest) L.push('Grupa „Z BaseLinkera” już jest (poprzedni import): import niczego do niej nie dokłada.', '')
    L.push(tabela(['Reguła szablonu', 'Przejdzie?'], [...a.przeniesione.map((n) => [n, 'tak']), ...a.nieprzeniesione.map((n) => [n.nazwa, `nie: ${n.powod}`])]))
  }

  L.push('## 5. Tabela zgodności (BL ↔ plan)')
  L.push('')
  L.push(tabela(['', 'W BL', 'W planie', 'Uwagi'], r.zgodnosc.map((z) => [z.wiersz, z.bl, z.plan, z.uwagi])))

  L.push('## Dodatki')
  L.push('')
  L.push('### Mapa statusów')
  L.push('')
  const zFirmy = r.statusy.some((s) => s.statusFirmy !== undefined)
  L.push(
    zFirmy
      ? tabela(['Id', 'Nazwa w BL', 'Status Kompletora', 'Status firmy', 'Pewność', 'Otwarte?'], r.statusy.map((s) => [s.id, s.nazwa, s.status, s.statusFirmy ?? '(nazwa etapu)', s.pewnosc, s.otwarte ? 'tak' : 'nie']))
      : tabela(['Id', 'Nazwa w BL', 'Status Kompletora', 'Pewność', 'Otwarte?'], r.statusy.map((s) => [s.id, s.nazwa, s.status, s.pewnosc, s.otwarte ? 'tak' : 'nie'])),
  )
  L.push('### Konta kanałów')
  L.push('')
  L.push(tabela(['Kanał', 'Konto', 'Nazwa', 'Adapter', 'Magazyn BL', 'Pominięte'], r.konta.map((k) => [k.kanal, k.konto, k.nazwa, k.adapter, k.blStorageId, k.pominiete ? 'tak' : ''])))
  L.push('### Reguły przewoźników')
  L.push('')
  L.push(tabela(['Priorytet', 'Kanał', 'Metoda dostawy', 'Przewoźnik', 'Moduł'], r.reguly.map((x) => [x.priorytet, x.kanal, x.metoda ?? '(każda)', x.przewoznik, x.modul])))
  if (plan.ostrzezenia.length) {
    L.push('### Ostrzeżenia')
    L.push('')
    for (const o of plan.ostrzezenia) L.push(`- ${o}`)
    L.push('')
  }
  L.push('### Problemy pobierania')
  L.push('')
  L.push(tabela(['Rodzaj', 'Ref', 'Treść'], r.problemyPobierania.map((i) => [i.kind, i.ref, i.message])))
  L.push('### Wywołane metody BL (tylko odczyt, lista z lib/przeprowadzka/metody.ts)')
  L.push('')
  L.push(tabela(['Metoda', 'Wywołań'], Object.entries(r.wywolaniaBl).map(([m, n]) => [m, n])))
  return L.join('\n')
}
