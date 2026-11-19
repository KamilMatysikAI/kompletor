// Raport mapowania (markdown + CSV z pełnymi listami). Czysta funkcja: dane produktowe, zero danych klientów.
import type { Analysis, RawSources } from './katalog'
import { offerIntent, type OfferResult } from './mapowanie'
import type { ChannelMap, ChannelT } from './normalizacja'

const CHANNEL_NAMES: Record<ChannelT, string> = {
  WOO: 'Woo',
  ALLEGRO: 'Allegro',
  EMPIK: 'Empik',
  EASYTOOLS: 'EasyTools',
  BL_INNE: 'Inne źródła BL (InPost Buy, TikTok…)',
  RECZNE: 'Ręczne w BL',
}
const CHANNEL_ORDER: ChannelT[] = ['WOO', 'ALLEGRO', 'EMPIK', 'BL_INNE', 'RECZNE', 'EASYTOOLS']

/** Wiersz raportu: sklepy Woo osobno (konto), pozostałe kanały razem. Nazwa sklepu z konfiguracji firmy. */
function groupOf(o: Pick<OfferResult, 'channel' | 'accountId'>, map: ChannelMap | undefined): { key: string; label: string } {
  if (o.channel !== 'WOO') return { key: o.channel, label: CHANNEL_NAMES[o.channel] }
  const name = map?.names?.[`WOO|${o.accountId}`]
  return { key: `WOO|${o.accountId}`, label: `Woo ${name ?? o.accountId}` }
}

const fmt = (n: number) => n.toLocaleString('pl-PL').replace(/\u00a0/g, ' ')
const cell = (s: string | null | undefined) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
const zl = (n: number | null) => (n === null ? '—' : n.toFixed(2).replace('.', ','))

export function csv(rows: (string | number | null | undefined)[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = v === null || v === undefined ? '' : String(v)
            return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(';'),
      )
      .join('\r\n') + '\r\n'
  )
}

export interface ReportFiles {
  markdown: string
  csv: Record<string, string>
}

/** Dopasowane po samym SKU (Woo bez linku BL): ChannelOffer nieaktywna do zatwierdzenia w panelu. */
export function proposalOffers(offers: OfferResult[]): OfferResult[] {
  return offers
    .filter((o) => o.state === 'MAPPED' && offerIntent(o) === 'PROPOSAL')
    .sort((a, b) => b.sales90dQty - a.sales90dQty || a.externalId.localeCompare(b.externalId))
}

/** Do progu braków: bez jednoznacznego powiązania, z wyjątkiem dodatków z magazynu bez oferty (reguła firmy). */
const isProblem = (o: OfferResult) => o.state !== 'MAPPED' && !o.nonOffer

function problemOffers(offers: OfferResult[]): OfferResult[] {
  return offers
    .filter(isProblem)
    .sort((a, b) => b.sales90dQty - a.sales90dQty || b.sales90dOrders - a.sales90dOrders || a.name.localeCompare(b.name, 'pl'))
}

export function renderReport(raw: RawSources, a: Analysis, meta: { generatedAt: Date; runId?: string }): ReportFiles {
  const L: string[] = []
  const blAll = raw.bl.products
  const parents = blAll.filter((p) => p.hasVariants)
  const sellable = blAll.filter((p) => !p.hasVariants)
  const stocked = a.plan.products.filter((p) => p.kind === 'STOCKED')
  const bundles = a.plan.products.filter((p) => p.kind === 'BUNDLE')
  const sinceDate = new Date(raw.sales.sinceUnix * 1000).toISOString().slice(0, 10)
  const oldest = raw.sales.oldestUnix ? new Date(raw.sales.oldestUnix * 1000).toISOString().slice(0, 10) : '—'

  L.push('# Raport mapowania produktów i ofert (import z BL, tylko odczyt)')
  L.push('')
  L.push(
    `*Wygenerowany ${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC skryptem \`npm run import:katalog\`. ` +
      `Dane pobrane ${raw.fetchedAt.replace('T', ' ').slice(0, 16)} UTC. Źródła tylko do odczytu: BL (get*), wFirma (*/find), Empik OF21 (GET). ` +
      `Raport zawiera wyłącznie dane produktów i liczby zamówień, bez danych klientów.${meta.runId ? ` Przebieg importu: \`${meta.runId}\`.` : ''}*`,
  )
  L.push('')

  // ── Podsumowanie
  const withSalesProblems = problemOffers(a.offers).filter((o) => o.sales90dQty > 0)
  const proposals = proposalOffers(a.offers)
  const proposalsWithSales = proposals.filter((o) => o.sales90dQty > 0)
  const fromOverrides = a.offers.filter((o) => o.source === 'OVERRIDE')
  // Wiersze CSV zgodne z bieżącym powiązaniem BL (do usunięcia z pliku) — też w sekcji „Nadpisania” (drobna 6).
  const overridesAgreeing = a.offers.filter((o) => o.source !== 'OVERRIDE' && o.notes.some((n) => n.startsWith('nadpisanie zgodne z BL')))
  L.push('## Wynik w skrócie')
  L.push('')
  L.push(`- Katalog BL: **${fmt(blAll.length)}** rekordów magazynu (${fmt(sellable.length)} do sprzedaży, ${fmt(parents.length)} rodziców z wariantami, ${fmt(a.variants.length)} wariantów, ${fmt(a.bundles.length)} zestawów).`)
  if (raw.wfirma) {
    const c = a.compliance!
    L.push(`- wFirma: **${fmt(raw.wfirma.goods.length)}** towarów w magazynie wFirmy. Produkty BL (bez zestawów) z odpowiednikiem w wFirmie: **${fmt(c.checked - c.withoutCounterpart.length)} z ${fmt(c.checked)}** (po linku BL ${fmt(c.byMatch.LINK)}, po SKU ${fmt(c.byMatch.SKU)}, po EAN ${fmt(c.byMatch.EAN)}); bez odpowiednika **${fmt(c.withoutCounterpart.length)}**.`)
  } else {
    L.push('- wFirma: **nie pobrano** (brak kluczy albo błąd) — sekcja zgodności pusta.')
  }
  L.push(`- Produkty w nowym systemie po imporcie: **${fmt(stocked.length)}** ze stanem (towar/komplet wFirmy) + **${fmt(bundles.length)}** zestawów wirtualnych.`)
  L.push(`- Zamówienia BL od ${sinceDate} (${raw.salesDays} dni): **${fmt(raw.sales.orders)}** (najstarsze potwierdzone: ${oldest}); użyte tylko pozycje: produkt, oferta, ilość.`)
  if (raw.sales.complete === false) {
    L.push('- **UWAGA: sprzedaż pobrana niepełna** (błąd albo przerwanie `getOrders`, szczegóły w „Problemy przy pobieraniu”) — liczby sprzedaży i próg poniżej są zaniżone.')
  }
  L.push(`- **Próg przed F2 (PLAN.md, ryzyko 2): oferty ze sprzedażą w 90 dniach bez jednoznacznego powiązania = ${fmt(withSalesProblems.length)}** (sprzedanych sztuk/jednostek: ${fmt(withSalesProblems.reduce((s, o) => s + o.sales90dQty, 0))}). Cel: 0.`)
  L.push(
    `- **Do zatwierdzenia (Woo po SKU, bez linku BL): ${fmt(proposals.length)}** ofert, w tym ze sprzedażą w 90 dniach ${fmt(proposalsWithSales.length)} (${fmt(proposalsWithSales.reduce((s, o) => s + o.sales90dQty, 0))} szt.). ` +
      'Nowy system zakłada je jako **nieaktywne**: nie rezerwują stanu, dopóki człowiek nie potwierdzi powiązania w panelu (F2). Lista: `do-zatwierdzenia-po-sku.csv`.',
  )
  L.push(
    `- Powiązania z tabeli nadpisań (\`dane/nadpisania-ofert/<firma>.csv\`, oferty powiązane w BL po fakcie): **${fmt(fromOverrides.length)}**` +
      (a.overrideProblems.length ? `, problemy: ${fmt(a.overrideProblems.length)} (sekcja „Nadpisania”)` : '') +
      '.',
  )
  const rules = a.catalogRules
  if (rules.noStock.length || rules.nonOffer.length || rules.conflicts.length) {
    L.push(
      `- Reguły katalogu firmy (\`settings.catalog\`): oferty produktów bez stanu **${fmt(rules.noStock.length)}** (poza progiem, produkt DIGITAL), ` +
        `dodatki z magazynu bez oferty **${fmt(rules.nonOffer.length)}** (poza progiem)` +
        (rules.conflicts.length ? `, konflikty z katalogiem **${fmt(rules.conflicts.length)}** (liczą się do progu)` : '') +
        '. Sekcja „Produkty bez stanu i dodatki bez oferty”.',
    )
  }
  const located = stocked.filter((p) => p.location)
  L.push(
    `- Miejsca na półce z BL (\`locations\`): **${fmt(located.length)} z ${fmt(stocked.length)}** produktów ze stanem` +
      (a.plan.locationConflicts.length ? `; różne miejsca w rekordach BL jednego produktu: ${fmt(a.plan.locationConflicts.length)} (wzięte pierwsze)` : '') +
      '.',
  )
  L.push('')

  // ── Powiązania per kanał
  L.push('## Powiązania z magazynem per kanał')
  L.push('')
  L.push('| Kanał | Oferty / produkty kanału | Powiązane jednoznacznie | w tym po SKU — do zatwierdzenia | w tym z nadpisania | Bez powiązania | Wieloznaczne | Ze sprzedażą 90 dni | Braki ze sprzedażą 90 dni |')
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  const groups = new Map<string, { label: string; list: OfferResult[] }>()
  for (const ch of CHANNEL_ORDER)
    for (const o of a.offers.filter((x) => x.channel === ch)) {
      const g = groupOf(o, raw.channels)
      const cur = groups.get(g.key) ?? { label: g.label, list: [] }
      cur.list.push(o)
      groups.set(g.key, cur)
    }
  for (const { label, list } of groups.values()) {
    const mapped = list.filter((o) => o.state === 'MAPPED')
    L.push(
      `| ${label} | ${fmt(list.length)} | ${fmt(mapped.length)} | ${fmt(mapped.filter((o) => offerIntent(o) === 'PROPOSAL').length)} | ${fmt(mapped.filter((o) => o.source === 'OVERRIDE').length)} | ${fmt(list.filter((o) => o.state === 'UNMAPPED').length)} | ${fmt(list.filter((o) => o.state === 'AMBIGUOUS').length)} | ${fmt(list.filter((o) => o.sales90dQty > 0).length)} | **${fmt(list.filter((o) => isProblem(o) && o.sales90dQty > 0).length)}** |`,
    )
  }
  L.push('')
  L.push('Skąd lista ofert w kanale:')
  L.push('- **Sklepy Woo** — produkty i warianty z magazynów zewnętrznych BL (`getExternalStorageProductsList/Data`); powiązanie z linku BL (`links.shop_*` w `getInventoryProductsData`). Rodzice z wariantami pominięci (sprzedają się warianty). Gdy linku brak, a SKU jest jednoznaczne, oferta jest powiązana „po SKU” jako **propozycja**: ChannelOffer nieaktywna do zatwierdzenia w panelu. Warianty jednego produktu sklepu, które po SKU trafiają na ten sam produkt BL, są wieloznaczne (wariant to zwykle inna gramatura).')
  L.push('- **Allegro i inne źródła BL** — BL nie wystawia przez API listy ofert marketplace z powiązaniami, więc znamy tylko oferty, które sprzedały się w oknie (pozycje `getOrders`: `auction_id` → produkt magazynu). Oferta powiązana w BL po fakcie ma w historii `product_id = 0` na zawsze — takie wpisujemy do `dane/nadpisania-ofert/<firma>.csv` (źródło OVERRIDE). Pełna lista ofert Allegro wymaga własnego tokenu i wchodzi w adapter Allegro (F2). Próg PLAN.md dotyczy właśnie ofert ze sprzedażą, więc jest policzony w całości.')
  L.push('- **Empik** — pełna lista ofert z OF21 (`shop_sku` = SKU w BL) + powiązania ze sprzedaży BL (`auction_id` = „p” + `product_sku`).')
  L.push('')

  // ── Lista problemów
  const problems = problemOffers(a.offers)
  L.push('## Oferty bez powiązania albo z powiązaniem wieloznacznym (najpierw ze sprzedażą)')
  L.push('')
  L.push(`Wszystkich: ${fmt(problems.length)}, ze sprzedażą w 90 dniach: ${fmt(withSalesProblems.length)}. Pełna lista: \`oferty-bez-powiazania.csv\`. Poniżej wszystkie ze sprzedażą i do 30 bez sprzedaży.`)
  L.push('')
  L.push('| Kanał | Id oferty | SKU | Nazwa | Stan | Szt. 90 dni | Zam. 90 dni | Produkty BL | Uwagi |')
  L.push('|---|---|---|---|---|---:|---:|---|---|')
  const shown = [...withSalesProblems, ...problems.filter((o) => o.sales90dQty === 0).slice(0, 30)]
  for (const o of shown) {
    L.push(
      `| ${groupOf(o, raw.channels).label} | ${cell(o.externalId)} | ${cell(o.sku)} | ${cell(o.name).slice(0, 70)} | ${o.state === 'UNMAPPED' ? 'brak' : 'wieloznaczne'} | ${fmt(o.sales90dQty)} | ${fmt(o.sales90dOrders)} | ${cell(o.blProductIds.join(', '))} | ${cell(o.notes.join('; '))} |`,
    )
  }
  L.push('')
  L.push('### Co z tym zrobić (do progu 0 przed F2)')
  L.push('')
  L.push('1. **Pozycje sklepów Woo bez linku** (sprzedaż szła „ze sklepu”, nie z magazynu BL, więc BL nie zdejmował stanu): powiązać produkt sklepu z produktem magazynu — w BL (Magazyn → produkt → „Powiązania”) albo w nowym systemie przez tabelę `ChannelOffer` (edycja ręczna w panelu, F2). Do czasu przełączenia i tak liczy się BL, więc poprawka w BL usuwa też dzisiejsze przeliczenia stanów.')
  L.push('2. **Allegro/Empik/inne bez powiązania**: w BL powiązać ofertę z produktem magazynu (moduł ofert danej integracji). Oferty ze sprzedażą, które zniknęły z kanału, wystarczy oznaczyć jako zakończone.')
  L.push('2a. **Sklep Woo, „Id oferty” `bl:<id>`**: sprzedaż szła z produktu magazynu BL, ale ten produkt nie ma linku do żadnego produktu sklepu, więc nie wiadomo, którą ofertę sklepu rezerwować. Powiązać produkt magazynu z produktem sklepu w BL (jak w pkt 1).')
  L.push('3. **Wieloznaczne**: jedna oferta wskazuje kilka produktów BL (zmiana powiązania w oknie albo SKU zdublowane w BL). Rozstrzyga człowiek: który produkt jest właściwy; drugi rekord BL do scalenia albo usunięcia w BL.')
  L.push('4. **Po każdej poprawce w BL** wystarczy ponowić import (`npm run import:katalog`) — jest idempotentny, a ten raport policzy próg od nowa.')
  L.push('')

  // ── Do zatwierdzenia po SKU
  if (proposals.length) {
    L.push('## Do zatwierdzenia: oferty Woo dopasowane po SKU (bez linku w BL)')
    L.push('')
    L.push('BL tych ofert dziś nie synchronizuje (brak linku). Nowy system zakłada je jako nieaktywne; po potwierdzeniu w panelu (F2) zaczną rezerwować. Do 30 pierwszych, pełna lista w `do-zatwierdzenia-po-sku.csv`.')
    L.push('')
    L.push('| Kanał | Id oferty | SKU | Nazwa | Produkt BL | Szt. 90 dni |')
    L.push('|---|---|---|---|---|---:|')
    for (const o of proposals.slice(0, 30)) {
      L.push(`| ${groupOf(o, raw.channels).label} | ${cell(o.externalId)} | ${cell(o.sku)} | ${cell(o.name).slice(0, 70)} | ${cell(o.blProductIds.join(', '))} | ${fmt(o.sales90dQty)} |`)
    }
    L.push('')
  }

  // ── Reguły katalogu firmy
  if (rules.noStock.length || rules.nonOffer.length || rules.conflicts.length) {
    L.push('## Produkty bez stanu i dodatki bez oferty (reguły firmy)')
    L.push('')
    L.push(
      'Z konfiguracji firmy (`Organization.settings.catalog`: SKU albo kategoria sklepu, nie nazwa). **Produkt bez stanu** (e-book, usługa) dostaje w nowym systemie produkt rodzaju DIGITAL: oferta jest powiązana, ' +
        'pozycja nie rezerwuje, nie trafia do „brakuje”, stan nie idzie na kanał, a na fakturze jest usługą. **Dodatek bez oferty** (naklejka, banderola, składnik zestawu rozbijanego przez BL) ' +
        'to pozycja z magazynu BL bez oferty kanału — nie oferta, więc poza progiem.',
    )
    L.push('')
    L.push('| Rodzaj | Kanał | Id oferty | SKU | Nazwa | Szt. 90 dni | Zam. 90 dni |')
    L.push('|---|---|---|---|---|---:|---:|')
    for (const o of rules.noStock) L.push(`| bez stanu | ${groupOf(o, raw.channels).label} | ${cell(o.externalId)} | ${cell(o.sku)} | ${cell(o.name).slice(0, 70)} | ${fmt(o.sales90dQty)} | ${fmt(o.sales90dOrders)} |`)
    for (const o of rules.nonOffer) L.push(`| dodatek bez oferty | ${groupOf(o, raw.channels).label} | ${cell(o.externalId)} | ${cell(o.sku)} | ${cell(o.name).slice(0, 70)} | ${fmt(o.sales90dQty)} | ${fmt(o.sales90dOrders)} |`)
    L.push('')
    for (const c of rules.conflicts) L.push(`- **konflikt:** ${groupOf(c.offer, raw.channels).label} \`${cell(c.offer.externalId)}\`: ${cell(c.reason)}`)
    if (rules.conflicts.length) L.push('')
  }

  // ── Nadpisania
  if (fromOverrides.length || overridesAgreeing.length || a.overrideProblems.length) {
    L.push('## Nadpisania powiązań (`dane/nadpisania-ofert/<firma>.csv`)')
    L.push('')
    for (const o of fromOverrides) {
      L.push(`- ${groupOf(o, raw.channels).label} \`${cell(o.externalId)}\` → produkt BL ${cell(o.blProductIds.join(', '))} (SKU ${cell(o.sku)}), sprzedaż 90 dni: ${fmt(o.sales90dQty)} szt.${o.notes.length ? ` Uwagi: ${cell(o.notes.join('; '))}` : ''}`)
    }
    for (const o of overridesAgreeing) {
      L.push(`- ${groupOf(o, raw.channels).label} \`${cell(o.externalId)}\` → produkt BL ${cell(o.blProductIds.join(', '))} (${o.source}): nadpisanie zgodne z BL, wiersz w CSV można usunąć`)
    }
    for (const p of a.overrideProblems) L.push(`- **problem:** ${cell(p)}`)
    L.push('')
  }

  // ── Duplikaty
  L.push('## Duplikaty SKU i EAN')
  L.push('')
  L.push(`- SKU zdublowane w katalogu BL: **${fmt(a.dupSkuBl.size)}**${a.dupSkuBl.size ? ` — ${a.dupSkuBl.size > 25 ? '(pierwsze 25) ' : ''}${[...a.dupSkuBl.entries()].slice(0, 25).map(([k, v]) => `\`${k}\` ×${v.length}`).join(', ')}` : ''}.`)
  L.push(`- EAN zdublowane w katalogu BL: **${fmt(a.dupEanBl.size)}**${a.dupEanBl.size ? ` — ${a.dupEanBl.size > 25 ? '(pierwsze 25) ' : ''}${[...a.dupEanBl.entries()].slice(0, 25).map(([k, v]) => `\`${k}\` (${v.map((p) => p.sku ?? p.id).join(', ')})`).join(', ')}` : ''}.`)
  L.push(`- Kody (SKU) zdublowane w wFirmie (bez usług): **${fmt(a.dupCodeWfirma.size)}**${a.dupCodeWfirma.size ? ` — ${[...a.dupCodeWfirma.keys()].slice(0, 25).map((k) => `\`${k}\``).join(', ')}` : ''}.`)
  L.push(`- Produkty BL bez SKU: **${fmt(sellable.filter((p) => !p.sku).length)}**, bez EAN: **${fmt(sellable.filter((p) => !p.eanRaw).length)}**, z niepoprawnym EAN (suma kontrolna): **${fmt(a.plan.invalidEans.length)}**${a.plan.invalidEans.length ? ` — ${a.plan.invalidEans.length > 15 ? '(pierwsze 15) ' : ''}${a.plan.invalidEans.slice(0, 15).map((p) => `\`${p.sku ?? p.id}\`: „${cell(p.eanRaw)}”`).join(', ')}` : ''}.`)
  L.push(`- Kilka produktów BL na jeden towar wFirmy: **${fmt(a.plan.manyBlToOneWf.length)}**${a.plan.manyBlToOneWf.length ? ` — ${a.plan.manyBlToOneWf.length > 15 ? '(pierwsze 15) ' : ''}${a.plan.manyBlToOneWf.slice(0, 15).map((m) => `\`${m.wf.code ?? m.wf.id}\` ← ${m.bl.map((b) => b.sku ?? b.id).join(', ')}`).join('; ')}` : ''}. W nowym systemie to jeden produkt; oferty obu rekordów BL rezerwują ten sam stan.`)
  L.push(`- Link BL do wFirmy wskazuje inny towar niż SKU: **${fmt(a.plan.linkSkuConflicts.length)}**${a.plan.linkSkuConflicts.length ? ` — ${a.plan.linkSkuConflicts.slice(0, 15).map((c) => `BL \`${c.bl.sku}\` → link \`${c.viaLink.code ?? c.viaLink.id}\``).join(', ')}` : ''}. Wygrywa link (z niego BL bierze dziś stan).`)
  const ltm = a.plan.linkTargetMissing
  L.push(
    `- **Link BL do wFirmy wskazuje towar spoza pobranego magazynu** (usunięty albo w innym magazynie): **${fmt(ltm.length)}**` +
      (ltm.length ? ` — ${ltm.slice(0, 20).map((m) => `BL \`${m.bl.sku ?? m.bl.id}\` → towar ${m.wfirmaGoodIdLink}`).join(', ')}` : '') +
      '. Produkt **nie jest zakładany** (bez cichego dopasowania po SKU/EAN: stan byłby z innego towaru niż w BL); do poprawy linku w BL albo towaru w wFirmie. Kolumna `link_do_nieistniejacego_towaru` w `bl-bez-wfirmy.csv`.',
  )
  if (a.plan.skuCollisions.length) L.push(`- Kolizje SKU przy zakładaniu produktów: ${a.plan.skuCollisions.map((c) => `\`${c.sku}\``).join(', ')} (zapisane z sufiksem „~2”).`)
  L.push('')

  // ── Zestawy i warianty
  L.push('## Zestawy i warianty')
  L.push('')
  L.push(`Zestawy BL: **${fmt(a.bundles.length)}**, założone jako zestawy wirtualne (rezerwują składniki): **${fmt(bundles.length)}**.`)
  L.push('')
  if (a.bundles.length) {
    L.push('| SKU zestawu | Nazwa | Składniki (SKU BL × ilość) | Status |')
    L.push('|---|---|---|---|')
    const blById = new Map(blAll.map((p) => [p.id, p]))
    for (const b of a.bundles) {
      const comps = Object.entries(b.bundleProducts ?? {})
        .map(([id, q]) => `${blById.get(id)?.sku ?? id} × ${q}`)
        .join(', ')
      const prob = a.plan.bundleProblems.filter((x) => x.bl.id === b.id).map((x) => x.problem)
      L.push(`| ${cell(b.sku)} | ${cell(b.name).slice(0, 60)} | ${cell(comps)} | ${prob.length ? cell(prob.join('; ')) : 'założony'} |`)
    }
    L.push('')
  }
  L.push(`Warianty w BL: **${fmt(a.variants.length)}** (rodziców: ${fmt(parents.length)}); każdy wariant to osobny produkt z \`groupId\` = id rodzica w BL.`)
  L.push('')

  // ── Towary w kg
  const kg = a.plan.products.filter((p) => p.kind === 'STOCKED' && p.unit === 'KG')
  L.push('## Produkty powiązane z towarem wFirmy w kg')
  L.push('')
  L.push(
    `Takich produktów: **${fmt(kg.length)}**. Nowy system liczy je w gramach; import przyjmuje, że jedna sztuka oferty = 1 kg (\`qtyBasePerOffer\` = 1000), bo tak dziś działa BL (stan BL = kilogramy z wFirmy obcięte do całości). **Do potwierdzenia przy F2**, zwłaszcza dla nazw z gramaturą: jeśli oferta „50 g” zdejmuje w wFirmie 0,05 kg, trzeba ustawić \`qtyBasePerOffer\` = 50 dla tej oferty.`,
  )
  L.push('')
  if (kg.length) {
    const offersPerBl = new Map<string, { n: number; qty: number }>()
    for (const o of a.offers) {
      if (o.state !== 'MAPPED') continue
      for (const id of o.blProductIds) {
        const cur = offersPerBl.get(id) ?? { n: 0, qty: 0 }
        offersPerBl.set(id, { n: cur.n + 1, qty: cur.qty + o.sales90dQty })
      }
    }
    L.push('| SKU | Nazwa (BL) | Stan wFirmy [kg] | Oferty kanałów | Sprzedane 90 dni [szt. ofert] |')
    L.push('|---|---|---:|---:|---:|')
    for (const p of kg) {
      const agg = p.blIds.reduce((s, id) => ({ n: s.n + (offersPerBl.get(id)?.n ?? 0), qty: s.qty + (offersPerBl.get(id)?.qty ?? 0) }), { n: 0, qty: 0 })
      L.push(`| ${cell(p.sku)} | ${cell(p.title).slice(0, 60)} | ${p.wf?.count ?? '—'} | ${fmt(agg.n)} | ${fmt(agg.qty)} |`)
    }
    L.push('')
  }

  // ── Zgodność z wFirmą
  L.push('## Zgodność z wFirmą (punkt 3a, „produkt zakłada się raz”)')
  L.push('')
  if (!a.compliance) {
    L.push('Nie pobrano danych z wFirmy.')
  } else {
    const c = a.compliance
    const names = c.diffs.filter((d) => d.nameDiff)
    const prices = c.diffs.filter((d) => d.priceDiff)
    const vats = c.diffs.filter((d) => d.vatDiff)
    const stocks = c.diffs.filter((d) => d.stockDiff)
    L.push('| Miara | Liczba |')
    L.push('|---|---:|')
    L.push(`| Produkty BL do sprawdzenia (bez zestawów i rodziców) | ${fmt(c.checked)} |`)
    L.push(`| z odpowiednikiem po linku BL → wFirma (\`accounting_1\`) | ${fmt(c.byMatch.LINK)} |`)
    L.push(`| z odpowiednikiem tylko po SKU (= kod towaru) | ${fmt(c.byMatch.SKU)} |`)
    L.push(`| z odpowiednikiem tylko po EAN | ${fmt(c.byMatch.EAN)} |`)
    L.push(`| **bez odpowiednika w wFirmie** | **${fmt(c.withoutCounterpart.length)}** |`)
    L.push(`| nazwa w BL ≠ nazwa w wFirmie | ${fmt(names.length)} |`)
    L.push(`| cena brutto BL ≠ cena detaliczna brutto wFirmy | ${fmt(prices.length)} |`)
    L.push(`| stawka VAT BL ≠ VAT wFirmy | ${fmt(vats.length)} |`)
    L.push(`| stan BL (\`accounting_1\`) ≠ stan wFirmy (po obcięciu kg jak w BL) | ${fmt(stocks.length)} |`)
    L.push('')
    L.push('Pełne listy: `bl-bez-wfirmy.csv`, `bl-vs-wfirma-rozbieznosci.csv`.')
    L.push('')
    if (c.withoutCounterpart.length) {
      L.push('### Bez odpowiednika w wFirmie (do 40)')
      L.push('')
      L.push('| Id BL | SKU | Nazwa | Stan BL (wFirma) | Oferty ze sprzedażą 90 dni |')
      L.push('|---|---|---|---:|---:|')
      const soldBl = new Map<string, number>()
      for (const o of a.offers) for (const id of o.blProductIds) soldBl.set(id, (soldBl.get(id) ?? 0) + o.sales90dQty)
      const sorted = [...c.withoutCounterpart].sort((x, y) => (soldBl.get(y.id) ?? 0) - (soldBl.get(x.id) ?? 0))
      for (const p of sorted.slice(0, 40)) {
        L.push(`| ${p.id} | ${cell(p.sku)} | ${cell(p.name).slice(0, 70)} | ${p.stockAccounting ?? '—'} | ${fmt(soldBl.get(p.id) ?? 0)} |`)
      }
      L.push('')
    }
    if (vats.length) {
      L.push('### Rozbieżny VAT (wszystkie, do 60)')
      L.push('')
      L.push('| SKU | Nazwa | VAT BL | VAT wFirma |')
      L.push('|---|---|---:|---:|')
      for (const d of vats.slice(0, 60)) L.push(`| ${cell(d.bl.sku)} | ${cell(d.wf.name).slice(0, 60)} | ${d.vatDiff!.bl} | ${d.vatDiff!.wf} |`)
      L.push('')
    }
    if (prices.length) {
      L.push('### Rozbieżna cena (największe różnice, do 40)')
      L.push('')
      L.push('| SKU | Nazwa | BL brutto | wFirma detaliczna brutto |')
      L.push('|---|---|---:|---:|')
      const sorted = [...prices].sort((x, y) => Math.abs((y.priceDiff!.bl ?? 0) - (y.priceDiff!.wf ?? 0)) - Math.abs((x.priceDiff!.bl ?? 0) - (x.priceDiff!.wf ?? 0)))
      for (const d of sorted.slice(0, 40)) L.push(`| ${cell(d.bl.sku)} | ${cell(d.wf.name).slice(0, 60)} | ${zl(d.priceDiff!.bl)} | ${zl(d.priceDiff!.wf)} |`)
      L.push('')
    }
    if (names.length) {
      L.push('### Rozbieżna nazwa (przykłady, do 25)')
      L.push('')
      L.push('| SKU | Nazwa w BL (na kanałach) | Nazwa w wFirmie (księgowa) |')
      L.push('|---|---|---|')
      for (const d of names.slice(0, 25)) L.push(`| ${cell(d.bl.sku)} | ${cell(d.bl.name).slice(0, 70)} | ${cell(d.wf.name).slice(0, 70)} |`)
      L.push('')
    }
    L.push('Jak to czytać przy „produkt zakłada się raz”: nazwa księgowa i cena detaliczna przychodzą z wFirmy, a nazwa na kanałach (`title`) jest własnym polem produktu — rozbieżna nazwa nie jest więc błędem, tylko informacją, że tytuł trzeba zachować z BL (import tak robi). Rozbieżny VAT i cena to sprawy do wyjaśnienia z biurem przed F2b: jeśli na kanałach obowiązuje cena z BL, a w wFirmie inna, „Dodaj produkt” zaciągnąłby złą cenę.')
  }
  L.push('')

  // ── Problemy pobierania
  L.push('## Problemy przy pobieraniu')
  L.push('')
  if (!raw.issues.length) L.push('Brak — wszystkie źródła pobrane w całości.')
  for (const i of raw.issues.slice(0, 50)) L.push(`- \`${i.kind}\` ${cell(i.ref)}: ${cell(i.message).slice(0, 200)}`)
  L.push('')

  // ── CSV
  const offersCsv = csv([
    ['kanal', 'konto', 'id_oferty', 'sku', 'ean', 'nazwa', 'stan', 'zrodlo', 'produkty_bl', 'szt_90d', 'zam_90d', 'ostatnia_sprzedaz', 'uwagi'],
    ...problems.map((o) => [
      o.channel,
      o.accountId,
      o.externalId,
      o.sku,
      o.ean,
      o.name,
      o.state,
      o.source,
      o.blProductIds.join(' '),
      o.sales90dQty,
      o.sales90dOrders,
      o.lastSoldAt?.toISOString().slice(0, 10) ?? '',
      o.notes.join('; '),
    ]),
  ])
  const allOffersCsv = csv([
    ['kanal', 'konto', 'id_oferty', 'sku', 'stan', 'zrodlo', 'produkty_bl', 'szt_90d', 'zam_90d', 'do_zatwierdzenia', 'z_nadpisania', 'uwagi'],
    ...a.offers.map((o) => [
      o.channel,
      o.accountId,
      o.externalId,
      o.sku,
      o.state,
      o.source,
      o.blProductIds.join(' '),
      o.sales90dQty,
      o.sales90dOrders,
      o.state === 'MAPPED' && offerIntent(o) === 'PROPOSAL' ? 'tak' : '',
      o.source === 'OVERRIDE' ? 'tak' : '',
      o.notes.join('; '),
    ]),
  ])
  const proposalsCsv = csv([
    ['kanal', 'konto', 'id_oferty', 'sku', 'nazwa', 'produkty_bl', 'szt_90d', 'zam_90d', 'uwagi'],
    ...proposals.map((o) => [o.channel, o.accountId, o.externalId, o.sku, o.name, o.blProductIds.join(' '), o.sales90dQty, o.sales90dOrders, o.notes.join('; ')]),
  ])
  const files: Record<string, string> = {
    'oferty-bez-powiazania.csv': offersCsv,
    'oferty-wszystkie.csv': allOffersCsv,
    'do-zatwierdzenia-po-sku.csv': proposalsCsv,
  }
  if (a.compliance) {
    files['bl-bez-wfirmy.csv'] = csv([
      ['id_bl', 'sku', 'ean', 'nazwa', 'stan_bl_accounting', 'link_wfirma', 'link_do_nieistniejacego_towaru'],
      ...a.compliance.withoutCounterpart.map((p) => [
        p.id,
        p.sku,
        p.eanRaw,
        p.name,
        p.stockAccounting,
        p.wfirmaGoodIdLink,
        a.plan.linkTargetMissing.some((m) => m.bl.id === p.id) ? 'tak' : '',
      ]),
    ])
    files['bl-vs-wfirma-rozbieznosci.csv'] = csv([
      ['id_bl', 'sku_bl', 'id_wfirma', 'kod_wfirma', 'dopasowanie', 'nazwa_bl', 'nazwa_wfirma', 'cena_bl', 'cena_wfirma', 'vat_bl', 'vat_wfirma', 'stan_bl', 'stan_wfirma'],
      ...a.compliance.diffs.map((d) => [
        d.bl.id,
        d.bl.sku,
        d.wf.id,
        d.wf.code,
        d.match,
        d.nameDiff ? d.bl.name : '',
        d.nameDiff ? d.wf.name : '',
        d.priceDiff?.bl ?? '',
        d.priceDiff?.wf ?? '',
        d.vatDiff?.bl ?? '',
        d.vatDiff?.wf ?? '',
        d.stockDiff?.bl ?? '',
        d.stockDiff?.wf ?? '',
      ]),
    ])
  }
  return { markdown: L.join('\n') + '\n', csv: files }
}
