import Link from 'next/link'
import { notFound } from 'next/navigation'
import { accountName, accounts, productDetail } from '@/lib/panel/dane'
import { channelPrefix, money, qty, SHORTAGE_LABEL, shortExternalId, STATUS_LABEL, when } from '@/lib/panel/format'
import { requireSession } from '@/lib/panel/kontekst'
import { productZoneInfo } from '@/lib/pakowanie/dane'
import { Miniatura } from '../../_komponenty/miniatura'
import { StrefaProduktu } from './strefa'
import { firmaMaWfirme } from '@/lib/kanaly/firma'
import { korygujStan } from './korekta'
import { maDostawceAi } from '@/lib/produkty/ai-opis'
import { historiaProduktu, ileZestawow, POLE_LABEL, skuEdytowalne, VAT_LABEL, ZRODLO_LABEL } from '@/lib/produkty/karta'
import { MAX_ZDJEC, zdjeciaProduktu } from '@/lib/produkty/zdjecia'
import { stanPackshotu } from '@/lib/produkty/packshot'
import { EdycjaKarty, EdycjaSkladu, type DaneKarty } from './edycja'
import { ZdjeciaProduktu } from './zdjecia'
import { SekcjaPowiazan } from './sekcja-powiazania'
import { opisPowiazania } from '@/lib/produkty/powiazania'
import { drzewoKategorii } from '@/lib/produkty/kategorie'
import { ToastZAdresuZapisu } from '@/app/ui'
import { KategoriaProduktu } from './kategoria'
import { AktywnoscProduktu } from './aktywnosc'
import { przeszkodyWylaczenia } from '@/lib/produkty/aktywnosc'

export const metadata = { title: 'Produkt' }

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const MOVE_LABEL: Record<string, string> = {
  WFIRMA_SYNC: 'zmiana w wFirmie (PZ, kompletacja albo korekta: sprawdź w wFirmie)',
  OWN_INVOICE: 'faktura z tego systemu',
  BL_INVOICE: 'faktura z BaseLinkera',
  OWN_CORRECTION: 'korekta',
  ISSUED_WITHOUT_DOCUMENT: 'wydane bez dokumentu',
  STOCK_MISSING: 'nie ma na półce',
  INITIAL_IMPORT: 'stan startowy z importu',
}

const wartosc = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 60)}…` : v) : Array.isArray(v) ? `${v.length} poz.` : String(v))
const liczbaPl = (n: number) => String(n).replace('.', ',')

/** Wartość pola w historii po ludzku: kwoty jak w panelu, VAT z etykiety, jednostki. */
function wartoscPola(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'active' && typeof v === 'boolean') return v ? 'włączony' : 'wyłączony'
  if (typeof v === 'number') {
    if (k === 'priceGross' || k === 'purchasePriceNet') return money(v)
    if (k === 'weightG') return `${liczbaPl(v)} g`
    if (k === 'lengthCm' || k === 'widthCm' || k === 'heightCm') return `${liczbaPl(v)} cm`
    return liczbaPl(v)
  }
  if (k === 'vatRate' && typeof v === 'string') return VAT_LABEL[v] ?? v
  return wartosc(v)
}

/** Wpis AuditLog produktu po ludzku: zmienione pola „przed → po” albo zdarzenie (dodanie, zdjęcie). */
function opisZmiany(before: unknown, after: unknown): string {
  const a = after && typeof after === 'object' && !Array.isArray(after) ? (after as Record<string, unknown>) : {}
  const b = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {}
  if (a['dodanyWPanelu']) return 'produkt dodany w panelu'
  if (a['zKanalu']) return `produkt założony z oferty ${String(a['zKanalu'])}`
  if (a['zdjecieDodane']) return a['zOferty'] ? 'dodane zdjęcie z oferty sklepu' : 'dodane zdjęcie'
  if (a['zdjecieUsuniete']) return 'usunięte zdjęcie'
  if (a['zdjeciaZOfertyBledy']) return 'nie wszystkie zdjęcia z oferty sklepu udało się pobrać'
  if (a['powiazanie']) return opisPowiazania(a)
  if (a['towarWfirmy']) return `powiązany z towarem wFirmy „${String(a['towarWfirmy'])}”`
  // produkt przeniesiony przy usunięciu kategorii
  const keys = Object.keys(a).filter((k) => k !== 'zUsunietej')
  if (!keys.length) return 'zmiana'
  if (a['zUsunietej']) return `kategoria: ${wartoscPola('kategoria', b['kategoria'])} → ${wartoscPola('kategoria', a['kategoria'])} (poprzednia kategoria usunięta)`
  return keys.map((k) => (k === 'zdjecia' ? 'kolejność zdjęć' : k === 'sklad' ? 'skład zestawu' : `${(POLE_LABEL[k] ?? k).replace(/ \((g|cm)\)$/, '')}: ${wartoscPola(k, b[k])} → ${wartoscPola(k, a[k])}`)).join('; ')
}

export default async function Produkt({ params, searchParams }: Props) {
  const ctx = await requireSession()
  const { id } = await params
  const [p, accs, zone, hasWfirma] = await Promise.all([productDetail(ctx.db, id), accounts(ctx.db), productZoneInfo(ctx.db, id), firmaMaWfirme(ctx.db)])
  if (!p) notFound()
  const canEdit = ctx.permissions.has('produkty.dodawanie')
  const [zdjecia, historia, ai, opcjeSkladu, stanySkladnikow, packshot, kategorie, przeszkody] = await Promise.all([
    zdjeciaProduktu(ctx.db, p.id),
    historiaProduktu(ctx.db, p.id),
    canEdit ? maDostawceAi(ctx.db) : Promise.resolve(false),
    p.kind === 'BUNDLE' && canEdit && p.dataSource !== 'BL'
      ? ctx.db.product.findMany({ where: { kind: 'STOCKED', active: true }, select: { id: true, title: true, sku: true }, orderBy: { title: 'asc' }, take: 1000 })
      : Promise.resolve([]),
    p.kind === 'BUNDLE' ? ctx.db.stock.findMany({ where: { productId: { in: p.bundleComponents.map((c) => c.componentId) } }, select: { productId: true, physical: true, reserved: true } }) : Promise.resolve([]),
    canEdit ? stanPackshotu(ctx.db).catch(() => 'wylaczony' as const) : Promise.resolve('wylaczony' as const),
    drzewoKategorii(ctx.db),
    canEdit && p.active ? przeszkodyWylaczenia(ctx.db, [p.id]) : Promise.resolve(new Map<string, string[]>()), // wyłączanie
  ])
  const kategoria = p.categoryId ? (kategorie.find((k) => k.id === p.categoryId) ?? null) : null
  // pozostałe warianty z tej samej grupy
  const warianty = p.groupId
    ? await ctx.db.product.findMany({ where: { groupId: p.groupId, id: { not: p.id } }, orderBy: { sku: 'asc' }, take: 50, select: { id: true, sku: true, title: true, active: true } })
    : []
  // firma bez wFirmy prowadzi stan sama (korekta z panelu); z wFirmą stan to lustro, przycisku nie ma
  const sp = await searchParams
  const dodano = typeof sp.dodano === 'string'
  const uwagi = typeof sp.uwagi === 'string' ? sp.uwagi.slice(0, 600) : null
  const korekta = typeof sp.korekta === 'string' ? sp.korekta : null
  const korektaBlad = typeof sp.blad === 'string' ? sp.blad.slice(0, 200) : null
  const canCorrect = !hasWfirma && p.kind === 'STOCKED' && ctx.permissions.has('ustawienia')
  const now = new Date()
  const physical = p.stocks.reduce((s, r) => s + r.physical, 0)
  const reserved = p.stocks.reduce((s, r) => s + r.reserved, 0)
  const available = Math.max(0, physical - reserved)
  const wfirma = p.stocks.reduce((s, r) => s + r.wfirmaCount, 0)
  const pending = p.stocks.reduce((s, r) => s + r.pendingDelta, 0)
  const readAt = p.stocks.map((s) => s.wfirmaReadAt).sort((a, b) => b.getTime() - a.getTime())[0]
  const isBundle = p.kind === 'BUNDLE'
  const isDigital = p.kind === 'DIGITAL'
  const dec = (v: { toString(): string } | null) => (v === null ? '' : String(Number(v.toString())).replace('.', ','))
  const daneKarty: DaneKarty = {
    id: p.id,
    sku: p.sku,
    kind: p.kind,
    unit: p.unit,
    zWfirmy: p.dataSource === 'WFIRMA',
    skuEdytowalne: skuEdytowalne(p.dataSource),
    skuGdzie: p.dataSource === 'WFIRMA' ? 'z wFirmy, zmieniasz w wFirmie' : p.dataSource === 'BL' ? 'z BaseLinkera, zmieniasz w BaseLinkerze' : null,
    title: p.title,
    nameAccounting: p.nameAccounting,
    ean: p.ean ?? '',
    opis: p.description ?? '',
    cena: p.priceGross === null ? '' : Number(p.priceGross.toString()).toFixed(2).replace('.', ','),
    vat: p.vatRate ?? '',
    cenaZakupu: dec(p.purchasePriceNet),
    netto: money(p.priceNet),
    waga: p.weightG === null ? '' : String(p.weightG),
    dlugosc: dec(p.lengthCm),
    szerokosc: dec(p.widthCm),
    wysokosc: dec(p.heightCm),
    prog: p.lowStockThreshold === null ? '' : String(p.lowStockThreshold),
    lokalizacja: p.stocks.find((s) => s.location)?.location ?? '',
    grupa: p.groupId ?? '',
    maStan: p.stocks.length > 0,
  }
  const moznaZestawow = ileZestawow(
    p.bundleComponents.map((c) => ({ qtyBase: c.qtyBase, dostepne: Math.max(0, stanySkladnikow.filter((x) => x.productId === c.componentId).reduce((a, x) => a + x.physical - x.reserved, 0)) })),
  )
  return (
    <>
      <header className="page-head">
        <div className="pline">
          <Miniatura title={p.title} size={72} zdjecie={zdjecia[0]?.id ?? null} />
          <div>
            <h1>{p.title}</h1>
            <div className="sub">
              <span className="mono">{p.sku}</span>
              {p.ean && <> · EAN {p.ean}</>} · {isBundle ? 'zestaw (rezerwuje składniki)' : isDigital ? 'bez stanu (e-book, usługa)' : p.unit === 'KG' ? 'towar na wagę (ilości w gramach)' : 'towar w sztukach'}
              {!p.active && ' · wyłączony'}
            </div>
            <div className="chips pr-mt-s">
              <span className="chip">{ZRODLO_LABEL[p.dataSource]}</span>
            </div>
          </div>
        </div>
        {canEdit && <AktywnoscProduktu productId={p.id} aktywny={p.active} przeszkody={przeszkody.get(p.id) ?? []} stan={p.kind === 'STOCKED' ? p.stocks.reduce((a, x) => a + x.physical, 0) : null} />}
      </header>
      <ToastZAdresuZapisu sukces="aktywnosc" blad="aktywnoscBlad" uwaga="aktywnoscUwaga" komunikaty={{ wylaczony: 'Produkt wyłączony.', wlaczony: 'Produkt włączony.', 'bez-zmian': 'Bez zmian.' }} />
      <nav className="tabs" aria-label="Sekcje karty produktu">
        <a href="#dane">Produkt</a>
        <a href="#zdjecia">
          Zdjęcia<span className="cnt">{zdjecia.length}</span>
        </a>
        {!isDigital && <a href={isBundle ? '#sklad' : '#stan'}>{isBundle ? 'Skład zestawu' : 'Stan i magazyn'}</a>}
        <a href="#powiazania">
          Powiązania<span className="cnt">{p.offers.filter((o) => o.active).length}</span>
        </a>
        <a href="#historia-zmian">Historia zmian</a>
        <Link href={`/produkty/${p.id}/publikacja`}>Publikacja</Link>
      </nav>
      {dodano && (
        <div className="banner leaf-soft" role="status">
          <div>
            <b>Produkt dodany.</b> {uwagi}
          </div>
        </div>
      )}
      {!dodano && uwagi && (
        <div className="banner amber" role="status">
          <div>{uwagi}</div>
        </div>
      )}

      <section className="card" id="dane" aria-labelledby="h-dane-p">
        <div className="card-head">
          <h2 id="h-dane-p">Dane produktu</h2>
          <span className="muted small">
            {p.dataSource === 'WFIRMA' ? <>ceny i VAT z wFirmy{p.wfirmaSyncedAt ? <>, odczyt {when(p.wfirmaSyncedAt, now)}</> : null}</> : canEdit ? 'wszystkie pola edytowalne' : 'tylko podgląd'}
          </span>
        </div>
        <EdycjaKarty d={daneKarty} canEdit={canEdit} ai={ai} />
      </section>

      {warianty.length > 0 && (
        <section className="card" id="warianty" aria-labelledby="h-war">
          <div className="card-head">
            <h2 id="h-war">Warianty</h2>
            <span className="muted small">
              grupa <span className="mono">{p.groupId}</span>: {warianty.length + 1} produktów
            </span>
          </div>
          <ul className="small" style={{ margin: 0 }}>
            {warianty.map((w) => (
              <li key={w.id}>
                <Link href={`/produkty/${w.id}`}>{w.title}</Link> <span className="mono muted">{w.sku}</span>
                {!w.active && <span className="chip"> nieaktywny</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" id="zdjecia" aria-labelledby="h-zdj">
        <div className="card-head">
          <h2 id="h-zdj">Zdjęcia</h2>
          <span className="muted small">pierwsze jest główne: lista produktów, karta zamówienia, pakowanie i wydruk</span>
        </div>
        <ZdjeciaProduktu produkt={p.id} tytul={p.title} zdjecia={zdjecia.map((z) => ({ id: z.id, sourceUrl: z.sourceUrl }))} canEdit={canEdit} max={MAX_ZDJEC} packshot={packshot} />
      </section>

      {isDigital && (
        <section className="card" aria-labelledby="h-bez-stanu">
          <h2 id="h-bez-stanu" style={{ marginBottom: 8 }}>
            Bez stanu
          </h2>
          <p className="small" style={{ margin: 0 }}>
            Nie rezerwuje, nie trafia do „brakuje” ani na kanały. Na fakturze jako usługa (bez WZ i bez ruchu magazynowego).
            Zamówienie z samymi takimi pozycjami idzie bez wysyłki: od razu faktura, potem „Odebrane”.
          </p>
        </section>
      )}

      {!isBundle && !isDigital && (
        <section className="card" id="stan" aria-labelledby="h-stan">
          <div className="card-head">
            <h2 id="h-stan">Stan</h2>
            <span className="muted small">
              lokalizacja: <b className="mono">{p.stocks.find((s) => s.location)?.location ?? '—'}</b>
            </span>
          </div>
          {p.stocks.length === 0 ? (
            <p className="muted">{hasWfirma ? 'Brak stanu: produkt nie ma jeszcze odczytu z magazynu wFirmy.' : 'Brak stanu: ustaw go korektą niżej.'}</p>
          ) : (
            <div className="eq" role="group" aria-label="Fizycznie minus zarezerwowane równa się dostępne">
              <div className="term">
                <div className="k">Fizycznie</div>
                <div className="v">{qty(physical, p.unit)}</div>
                <div className="why">
                  {hasWfirma ? (
                    <>
                      wFirma {qty(wfirma, p.unit)}
                      {pending !== 0 && <> · w drodze do wFirmy {qty(pending, p.unit)}</>}
                      {readAt && <> · odczyt {when(readAt, now)}</>}
                    </>
                  ) : (
                    'stan prowadzony w tym systemie (bez wFirmy)'
                  )}
                </div>
              </div>
              <div className="op">−</div>
              <div className="term">
                <div className="k">Zarezerwowane</div>
                <div className="v">{qty(reserved, p.unit)}</div>
                <div className="why">zamówienia: {new Set(p.reservations.map((r) => r.orderId)).size}</div>
              </div>
              <div className="op">=</div>
              <div className={`term result${available === 0 ? ' zero' : ''}`}>
                <div className="k">Dostępne</div>
                <div className="v">{qty(available, p.unit)}</div>
                <div className="why">{physical - reserved < 0 ? `nadmiar rezerwacji: ${qty(reserved - physical, p.unit)}` : 'tyle mogą sprzedać kanały'}</div>
              </div>
            </div>
          )}
          {korekta === 'ok' && (
            <div className="banner leaf-soft" role="status">
              <div>Korekta stanu zapisana.</div>
            </div>
          )}
          {korekta === 'blad' && korektaBlad && (
            <div className="banner red" role="alert" style={{ marginTop: 12 }}>
              <div>{korektaBlad}</div>
            </div>
          )}
          {canCorrect && (
            <details style={{ marginTop: 12 }}>
              <summary className="btn small" style={{ display: 'inline-flex' }}>
                Korekta stanu
              </summary>
              <form action={korygujStan} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }} aria-label="Korekta stanu">
                <input type="hidden" name="produkt" value={p.id} />
                <input type="hidden" name="jednostka" value={p.unit} />
                <div className="field" style={{ width: 140 }}>
                  <label htmlFor="k-stan">Stan po przeliczeniu{p.unit === 'KG' ? ' (kg)' : ' (szt.)'}</label>
                  <input className="input" id="k-stan" name="stan" inputMode="decimal" required defaultValue={p.unit === 'KG' ? String(physical / 1000) : String(physical)} />
                </div>
                <div className="field" style={{ flex: '1 1 200px' }}>
                  <label htmlFor="k-powod">Powód</label>
                  <input className="input" id="k-powod" name="powod" required minLength={3} maxLength={300} placeholder="np. inwentaryzacja, uszkodzone" />
                </div>
                <button className="btn primary" type="submit">
                  Zapisz korektę
                </button>
              </form>
            </details>
          )}
        </section>
      )}

      {isBundle && (
        <section className="card" id="sklad" aria-labelledby="h-skl">
          <div className="card-head">
            <h2 id="h-skl">Składniki zestawu</h2>
            <span className="muted small">
              można zrobić teraz: <b>{moznaZestawow}</b> szt.
            </span>
          </div>
          <ul className="plain">
            {p.bundleComponents.map((c) => (
              <li key={c.componentId}>
                <Link href={`/produkty/${c.component.id}`}>{c.component.title}</Link> <span className="mono small muted">{c.component.sku}</span> × {qty(c.qtyBase, c.component.unit)}
                {c.priceShare !== null && <span className="muted small"> · {(Number(c.priceShare.toString()) * 100).toFixed(2).replace('.', ',')}% ceny</span>}
              </li>
            ))}
          </ul>
          {canEdit && p.dataSource !== 'BL' && (
            <details className="pr-more">
              <summary className="btn small">Zmień skład</summary>
              <EdycjaSkladu
                produkt={p.id}
                sklad={p.bundleComponents.map((c) => ({ id: c.componentId, qtyBase: c.qtyBase, udzial: c.priceShare === null ? '' : String(Number((Number(c.priceShare.toString()) * 100).toFixed(2))) }))}
                opcje={opcjeSkladu.map((o) => ({ id: o.id, label: `${o.title} (${o.sku})` }))}
              />
            </details>
          )}
          {p.dataSource === 'BL' && <p className="muted small">Skład z BaseLinkera: zmieniasz go w BaseLinkerze.</p>}
        </section>
      )}

      <ToastZAdresuZapisu sukces="kategoria" blad="kategoriaBlad" komunikaty={{ zapisana: 'Kategoria zapisana.', 'bez-zmian': 'Kategoria bez zmian.' }} />
      <KategoriaProduktu productId={p.id} kategoria={kategoria} zrodlo={p.categorySource} drzewo={kategorie} canEdit={canEdit} />

      {zone && <StrefaProduktu productId={p.id} info={zone} canEdit={ctx.permissions.has('ustawienia')} />}

      <SekcjaPowiazan
        db={ctx.db}
        p={{ id: p.id, sku: p.sku, unit: p.unit, kind: p.kind, wfirmaGoodId: p.wfirmaGoodId }}
        accs={accs}
        sp={sp}
        canEdit={canEdit}
        canSettings={ctx.permissions.has('ustawienia')}
        hasWfirma={hasWfirma}
        now={now}
      />

      <section className="card" aria-labelledby="h-rel">
        <h2 id="h-rel">Relacje</h2>
        {p.usedInBundles.length === 0 && <p className="muted small">Produkt nie jest składnikiem żadnego zestawu.</p>}
        {p.usedInBundles.length > 0 && (
          <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
            W zestawach:{' '}
            {p.usedInBundles.map((b, i) => (
              <span key={b.bundleId}>
                {i > 0 && ', '}
                <Link href={`/produkty/${b.bundle.id}`}>{b.bundle.title}</Link>
              </span>
            ))}
          </p>
        )}
      </section>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <section className="card" aria-labelledby="h-rez">
          <h2 id="h-rez" style={{ marginBottom: 8 }}>
            Rezerwacje i braki
          </h2>
          {p.reservations.length === 0 && p.shortages.length === 0 ? (
            <p className="muted small">Brak aktywnych rezerwacji.</p>
          ) : (
            <ul className="plain">
              {p.reservations.map((r) => (
                <li key={r.id}>
                  <Link href={`/zamowienia/${r.order.id}`}>
                    {channelPrefix(r.order.channel, accountName(accs, r.order.channel, r.order.channelAccountId))} {shortExternalId(r.order.externalId)}
                  </Link>{' '}
                  · {qty(r.qtyBase, p.unit)} · {STATUS_LABEL[r.order.status]}
                  {r.state === 'CONSUMING' && ' · faktura w drodze'}
                </li>
              ))}
              {p.shortages.map((s) => (
                <li key={s.id}>
                  <Link href={`/zamowienia/${s.order.id}`}>
                    {channelPrefix(s.order.channel, accountName(accs, s.order.channel, s.order.channelAccountId))} {shortExternalId(s.order.externalId)}
                  </Link>{' '}
                  · <span className="chip red">{SHORTAGE_LABEL[s.state]}: {qty(s.qtyBase, p.unit)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="h-hist">
          <h2 id="h-hist" style={{ marginBottom: 8 }}>
            Historia stanu
          </h2>
          {p.movements.length === 0 ? (
            <p className="muted small">Brak zmian.</p>
          ) : (
            <ul className="plain">
              {p.movements.map((m) => (
                <li key={m.id}>
                  <span className="mono small muted">{when(m.createdAt, now)}</span> <b className="num">{m.deltaPhysical > 0 ? '+' : ''}{qty(m.deltaPhysical, p.unit)}</b> {m.source === 'INITIAL_IMPORT' && m.reason ? m.reason : (MOVE_LABEL[m.source] ?? m.source)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" id="historia-zmian" aria-labelledby="h-hz">
        <h2 id="h-hz">Historia zmian danych</h2>
        {historia.length === 0 ? (
          <p className="muted small">Brak zapisanych zmian.</p>
        ) : (
          <ul className="plain">
            {historia.map((h) => (
              <li key={h.id}>
                <span className="mono small muted">{when(h.createdAt, now)}</span> {opisZmiany(h.before, h.after)} <span className="muted small">· {h.actorId.startsWith('system:') ? 'system' : 'użytkownik'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
