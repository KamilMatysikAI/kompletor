// Produkty i stany → Dodaj produkt. Formularz produktu od zera: nazwa, SKU, EAN, ceny, VAT,
// stan początkowy, jednostka, lokalizacja, waga, wymiary, opis, zdjęcia, rodzaj (ze stanem / bez stanu / zestaw).
// „Pobierz z…” (wFirma po SKU, oferta sklepu, kopia BaseLinkera) tylko wypełnia pola i jest widoczne wyłącznie, gdy firma
// ma daną integrację; błąd integracji nie blokuje formularza. Ekran nie publikuje na kanałach.
// Tylko z uprawnieniem `produkty.dodawanie`.
import Link from 'next/link'
import { requirePermission } from '@/lib/panel/kontekst'
import { qty } from '@/lib/panel/format'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { maDostawceAi } from '@/lib/produkty/ai-opis'
import { manyMessage, NO_SERVICE_NOTE, skuState, type SkuState } from '@/lib/produkty/dodawanie'
import { checkSku } from '@/lib/produkty/walidacja'
import { LIMIT_MESSAGE } from '@/lib/produkty/wfirma-towar'
import { blPoId, dostepneZrodla, ofertaPoId, zBl, zOferty, type Propozycja, type Zrodla } from '@/lib/produkty/zrodla'
import { pobierzDane, sprawdzSku } from './akcje'
import { FormularzDodania, FormularzProduktu, type DomyslneProduktu, type OpcjaSkladnika } from './formularz'
import { Odswiezanie } from './odswiezanie'

export const metadata = { title: 'Dodaj produkt' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const atFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const money = (n: number | null) => (n === null ? '—' : `${n.toFixed(2).replace('.', ',')} zł`)
const TYPE_LABEL: Record<string, string> = { good: 'towar', set: 'komplet', service: 'usługa' }

export default async function DodajProdukt({ searchParams }: Props) {
  const ctx = await requirePermission('produkty.dodawanie')
  const sp = await searchParams
  const z = one(sp.z) ?? ''
  const [zrodla, hasWfirma, ai] = await Promise.all([dostepneZrodla(ctx.db), firmaMaWfirme(ctx.db).catch(() => false), maDostawceAi(ctx.db)])
  // wFirma: dzisiejszy przepływ SKU → „Sprawdzam w wFirmie…” → dane z wFirmy
  const rawSku = z === 'wfirma' || (!z && one(sp.sku)) ? (one(sp.sku) ?? '') : ''
  const checked = rawSku ? checkSku(rawSku) : null
  const sku = checked?.ok ? checked.value : null
  const state: SkuState | null = sku && zrodla.wfirma ? await skuState(ctx.db, sku).catch(() => null) : null
  // oferta sklepu / BaseLinker: lista dopasowań albo jedno wybrane
  const q = (one(sp.q) ?? '').trim().slice(0, 64)
  const ref = one(sp.ref) ?? ''
  let propozycje: Propozycja[] = []
  let wybrana: Propozycja | null = null
  let bladZrodla: string | null = null
  try {
    if (z === 'oferta') wybrana = ref ? await ofertaPoId(ctx.db, ref) : null
    if (z === 'bl') wybrana = ref ? await blPoId(ctx.db, ref) : null
    if (!wybrana && q && z === 'oferta') propozycje = await zOferty(ctx.db, q)
    if (!wybrana && q && z === 'bl') propozycje = await zBl(ctx.db, q)
    if (!wybrana && propozycje.length === 1 && !propozycje[0]!.productId) wybrana = propozycje[0]!
  } catch {
    bladZrodla = 'Nie udało się odczytać danych źródła. Wpisz dane ręcznie.'
  }
  const skladniki: OpcjaSkladnika[] = (
    await ctx.db.product.findMany({ where: { kind: 'STOCKED', active: true }, select: { id: true, title: true, sku: true, unit: true }, orderBy: { title: 'asc' }, take: 1000 })
  ).map((p) => ({ id: p.id, label: `${p.title} (${p.sku})`, unit: p.unit as 'SZT' | 'KG' }))
  const d: DomyslneProduktu = wybrana
    ? {
        sku: wybrana.sku ?? q,
        nazwa: wybrana.title ?? '',
        ean: wybrana.ean ?? '',
        cena: wybrana.priceGross === null ? '' : wybrana.priceGross.toFixed(2).replace('.', ','),
        vat: wybrana.vatRate ?? '',
        stan: wybrana.stan === null ? '0' : String(wybrana.stan),
      }
    : { sku: q || undefined }
  const pokazWfirma = z === 'wfirma' && sku && state
  const wfirmaZamiastFormularza = pokazWfirma && state && (state.stan === 'kopia' || state.stan === 'istnieje')
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Dodaj produkt</h1>
          <div className="sub">
            Wpisz dane produktu.
            {zrodla.wfirma || zrodla.oferta || zrodla.bl ? ' Jeśli produkt już jest gdzie indziej, pobierz dane przyciskiem niżej i popraw, co trzeba.' : ''}
          </div>
        </div>
      </header>

      <PasekZrodel zrodla={zrodla} q={rawSku || q} />
      {one(sp.blad) === 'sku' && (
        <div className="banner red" role="alert">
          <div>{checked && !checked.ok ? checked.error : 'Podaj SKU (1–64 znaki, bez tabulatora i nowej linii).'}</div>
        </div>
      )}
      {bladZrodla && (
        <div className="banner amber" role="status">
          <div>{bladZrodla}</div>
        </div>
      )}
      {pokazWfirma && <Wynik sku={sku} state={state} pauza={one(sp.pauza) === '1'} ai={ai} />}
      {!wybrana && propozycje.length > 0 && <ListaPropozycji propozycje={propozycje} z={z} q={q} />}
      {!wybrana && q && (z === 'oferta' || z === 'bl') && propozycje.length === 0 && !bladZrodla && (
        <div className="banner amber" role="status">
          <div>
            {z === 'oferta' ? 'Nie ma oferty sklepu' : 'Nie ma produktu w kopii BaseLinkera'} o SKU albo EAN „{q}” (z ostatniego pobrania). Wpisz dane ręcznie niżej.
          </div>
        </div>
      )}
      {wybrana?.productId && (
        <div className="banner blue" role="status">
          <div>
            To {wybrana.typ === 'KANAL' ? 'oferta' : 'produkt BaseLinkera'} jest już powiązane z produktem: <Link href={`/produkty/${wybrana.productId}`}>przejdź do produktu</Link>.
          </div>
        </div>
      )}

      {!wfirmaZamiastFormularza && (
        <FormularzProduktu
          key={wybrana?.ref ?? 'reczny'}
          d={d}
          hasWfirma={hasWfirma}
          ai={ai}
          skladniki={skladniki}
          zrodlo={wybrana && !wybrana.productId ? { typ: wybrana.typ, ref: wybrana.ref, opis: wybrana.opis } : null}
        />
      )}

      <p className="muted small pr-mt">
        Produkt bez stanu (e-book, usługa) trafia też na listę <Link href="/produkty/bez-stanu">produktów bez stanu</Link>, żeby oferta z tym SKU łączyła się z nim przy imporcie. Ten
        ekran nie publikuje produktu na kanałach sprzedaży.
      </p>
    </>
  )
}

function PasekZrodel({ zrodla, q }: { zrodla: Zrodla; q: string }) {
  if (!zrodla.wfirma && !zrodla.oferta && !zrodla.bl) return null
  return (
    <section className="card" aria-labelledby="h-zrodla">
      <div className="card-head">
        <h2 id="h-zrodla">Pobierz dane (opcjonalnie)</h2>
        <span className="muted small">Wypełnia pola formularza; resztę wpiszesz sam</span>
      </div>
      <form action={pobierzDane} className="np-sku">
        <div className="field">
          <label htmlFor="np-q">SKU albo EAN</label>
          <input className="input mono" id="np-q" name="q" defaultValue={q} maxLength={64} required autoComplete="off" />
        </div>
        {zrodla.wfirma && (
          <button className="btn" type="submit" name="z" value="wfirma">
            Pobierz z wFirmy
          </button>
        )}
        {zrodla.oferta && (
          <button className="btn" type="submit" name="z" value="oferta">
            Pobierz z oferty sklepu
          </button>
        )}
        {zrodla.bl && (
          <button className="btn" type="submit" name="z" value="bl">
            Pobierz z BaseLinkera
          </button>
        )}
      </form>
    </section>
  )
}

function ListaPropozycji({ propozycje, z, q }: { propozycje: Propozycja[]; z: string; q: string }) {
  return (
    <section className="card" aria-labelledby="h-prop">
      <h2 id="h-prop">Znalezione dla „{q}”</h2>
      <ul className="plain">
        {propozycje.map((p) => (
          <li key={p.ref}>
            {p.productId ? (
              <>
                {p.title ?? p.sku} <span className="muted small">({p.opis})</span> · już powiązane: <Link href={`/produkty/${p.productId}`}>produkt</Link>
              </>
            ) : (
              <>
                <Link href={`/produkty/nowy?z=${z}&q=${encodeURIComponent(q)}&ref=${encodeURIComponent(p.ref)}`}>{p.title ?? p.sku ?? p.ref}</Link> <span className="muted small">({p.opis}{p.priceGross !== null ? `, ${money(p.priceGross)} brutto` : ''})</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Wynik({ sku, state, pauza, ai }: { sku: string; state: SkuState; pauza: boolean; ai: boolean }) {
  switch (state.stan) {
    case 'istnieje':
      return (
        <div className="banner blue" role="status">
          <div>
            Produkt o SKU <b className="mono">{sku}</b> już jest w katalogu: <Link href={`/produkty/${state.productId}`}>{state.title}</Link>
            {state.kind === 'DIGITAL' ? ' (bez stanu)' : ''}.
          </div>
        </div>
      )
    case 'sprawdzam':
      if (state.zawieszone)
        return (
          <div className="banner amber" role="status">
            <div>
              <b>Sprawdzenie w wFirmie nie ruszyło.</b> Spróbuj później (odśwież stronę) albo wpisz dane ręcznie niżej.
            </div>
          </div>
        )
      return (
        <div className="banner amber" role="status" aria-live="polite">
          <Odswiezanie />
          <div>
            <b>Sprawdzam w wFirmie…</b> Ekran odświeży się sam za kilka sekund.
          </div>
        </div>
      )
    case 'kilka':
      return (
        <div className="banner red" role="alert">
          <div>{manyMessage(state.towary)}</div>
        </div>
      )
    case 'odmowa':
      return (
        <div className="banner red" role="alert">
          <div>
            {state.komunikat} <Ponow sku={sku} /> Formularz niżej działa bez wFirmy (produkt bez stanu albo zestaw).
          </div>
        </div>
      )
    case 'niesprawdzone':
      return pauza ? (
        <div className="banner red" role="alert">
          <div>{LIMIT_MESSAGE}</div>
        </div>
      ) : (
        <div className="banner amber" role="status">
          <div>
            Tego SKU nie ma jeszcze w kopii towarów wFirmy. <Ponow sku={sku} label="Sprawdź w wFirmie" />
          </div>
        </div>
      )
    case 'brak':
      return (
        <div className="banner red" role="alert">
          <div>
            {state.komunikat} Towar ze stanem dodaj najpierw w magazynie wFirmy, potem sprawdź SKU jeszcze raz. {pauza ? LIMIT_MESSAGE : <Ponow sku={sku} />} Produkt bez stanu (e-book, usługa)
            albo zestaw dodasz formularzem niżej ({NO_SERVICE_NOTE}).
          </div>
        </div>
      )
    case 'kopia': {
      const g = state.copy.good
      const digital = state.kind === 'DIGITAL'
      return (
        <section className="card" aria-labelledby="h-wfirma">
          <div className="card-head">
            <h2 id="h-wfirma">Z wFirmy</h2>
            <span className="muted small">odczyt {atFmt.format(state.copy.readAt)} · pola z wFirmy zmieniasz w wFirmie</span>
          </div>
          <dl className="dl">
            <dt>Nazwa księgowa</dt>
            <dd>{g.name}</dd>
            <dt>Rodzaj</dt>
            <dd>
              {TYPE_LABEL[g.type] ?? g.type} →{' '}
              {digital ? <span className="chip">bez stanu (e-book, usługa)</span> : <span className="chip leaf">ze stanem</span>}
            </dd>
            <dt>Cena detaliczna</dt>
            <dd>
              {money(g.priceNetRetail)} netto · {money(g.priceGrossRetail)} brutto
            </dd>
            <dt>Cena zakupu</dt>
            <dd>{g.purchasePriceNet === null ? '—' : `${g.purchasePriceNet.toFixed(4).replace('.', ',')} zł netto`}</dd>
            <dt>VAT</dt>
            <dd>{g.vatRate ? `${g.vatRate}%` : '—'}</dd>
            <dt>EAN</dt>
            <dd className="mono">{g.ean ?? '—'}</dd>
            {!digital && (
              <>
                <dt>Stan startowy</dt>
                <dd>
                  <b>{qty(g.countBase, g.unit)}</b> <span className="muted small">(stan z wFirmy z chwili odczytu; dalej lustro magazynu wFirmy)</span>
                </dd>
              </>
            )}
          </dl>
          <hr className="np-sep" />
          <FormularzDodania
            sku={sku}
            rodzaj={digital ? 'bez-stanu' : 'wfirma'}
            nazwa={g.name}
            ean={g.ean ?? ''}
            nazwaWymagana={false}
            przycisk={digital ? 'Dodaj produkt bez stanu' : 'Dodaj produkt ze stanem'}
            stan={!digital}
            ai={ai}
          />
        </section>
      )
    }
  }
}

function Ponow({ sku, label = 'Sprawdź ponownie' }: { sku: string; label?: string }) {
  return (
    <form action={sprawdzSku} className="pr-inline">
      <input type="hidden" name="sku" value={sku} />
      <button className="btn ghost" type="submit">
        {label}
      </button>
    </form>
  )
}
