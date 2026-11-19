// ekran „Raporty” — sprzedaż wg okresu, konta kanału i produktu, marża z ceny zakupu, porównanie
// z poprzednim okresem i eksport XLSX. Sam odczyt (bez akcji serwera), filtry jako zwykły formularz GET (działa bez JS).
// Liczy `raportSprzedazy` (lib/api/raporty-sprzedaz.ts) — to samo co API i MCP. Reguły liczenia: docs/raporty.md.
import Link from 'next/link'
import { Baner, Karta, NaglowekStrony, PrzyciskLink, PustyStan } from '@/app/ui'
import { ApiInputError } from '@/lib/api/odpowiedzi'
import { type Grupowanie, type Miary, raportSprzedazy, type RaportSprzedazy, zapytanieSprzedazy, type ZapytanieSprzedazy, zmianaProcent } from '@/lib/api/raporty-sprzedaz'
import { accountKey, accounts } from '@/lib/panel/dane'
import { int, money, qty } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { WO, wykresOkresow } from '@/lib/panel/wykres-okresow'
import { addDays, toWarsaw } from '@/lib/rdzen/kalendarz'
import { raportDodatkowych, type RaportDodatkowych } from '@/lib/wysylka/raport-dodatkowych'
import './raporty.css'

export const metadata = { title: 'Raporty sprzedaży' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const GRUPY: { k: Grupowanie; t: string }[] = [
  { k: 'dzien', t: 'Dni' },
  { k: 'tydzien', t: 'Tygodnie' },
  { k: 'miesiac', t: 'Miesiące' },
]
const MIESIACE = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru']

function dzienKrotko(d: string): string {
  return `${Number(d.slice(8, 10))}.${d.slice(5, 7)}`
}
function podpisOkresu(k: string, g: Grupowanie): string {
  if (g === 'miesiac') return `${MIESIACE[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`
  return dzienKrotko(k)
}
function procent(v: number | null): string {
  return v === null ? '—' : `${v.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

/** Skróty zakresów (czas polski). */
function skroty(dzis: string): { t: string; od: string; do: string }[] {
  const [y, m] = [Number(dzis.slice(0, 4)), Number(dzis.slice(5, 7))]
  const pierwszy = `${dzis.slice(0, 8)}01`
  const poprzedniKoniec = addDays(pierwszy, -1)
  return [
    { t: 'Ten miesiąc', od: pierwszy, do: dzis },
    { t: 'Poprzedni miesiąc', od: `${poprzedniKoniec.slice(0, 8)}01`, do: poprzedniKoniec },
    { t: 'Ostatnie 7 dni', od: addDays(dzis, -6), do: dzis },
    { t: 'Ostatnie 30 dni', od: addDays(dzis, -29), do: dzis },
    { t: 'Ten rok', od: `${y}-01-01`, do: dzis },
    ...(m <= 2 ? [{ t: 'Poprzedni rok', od: `${y - 1}-01-01`, do: `${y - 1}-12-31` }] : []),
  ]
}

function Zmiana({ teraz, wczesniej, kwota }: { teraz: number | null; wczesniej: number | null; kwota?: boolean }) {
  if (teraz === null || wczesniej === null) return <span className="muted">poprzednio —</span>
  const z = zmianaProcent(teraz, wczesniej)
  const dir = z === null || z === 0 ? '' : z > 0 ? 'up' : 'down'
  return (
    <span className="muted">
      poprzednio {kwota ? money(wczesniej) : int(wczesniej)}
      {z !== null && (
        <>
          {' · '}
          <span className={`rap-zmiana ${dir}`}>
            {z > 0 ? '▲ +' : z < 0 ? '▼ −' : ''}
            {procent(Math.abs(z))}
          </span>
        </>
      )}
    </span>
  )
}

function Kafel({ t, v, opis }: { t: string; v: string; opis: React.ReactNode }) {
  return (
    <div className="rap-kafel">
      <div className="rap-kafel-t">{t}</div>
      <div className="rap-kafel-v num">{v}</div>
      <div className="small">{opis}</div>
    </div>
  )
}

function Kafle({ r }: { r: RaportSprzedazy }) {
  const a = r.razem
  const b = r.poprzedni.razem
  return (
    <div className="rap-kafle">
      <Kafel t="Zamówienia" v={int(a.zamowien)} opis={<Zmiana teraz={a.zamowien} wczesniej={b.zamowien} />} />
      <Kafel t="Wartość zamówień brutto" v={money(a.wartoscBrutto)} opis={<Zmiana teraz={a.wartoscBrutto} wczesniej={b.wartoscBrutto} kwota />} />
      <Kafel t="Średnia wartość zamówienia" v={money(a.sredniaWartosc)} opis={<Zmiana teraz={a.sredniaWartosc} wczesniej={b.sredniaWartosc} kwota />} />
      <Kafel t="Sprzedaż produktów netto" v={money(a.produktyNetto)} opis={<Zmiana teraz={a.produktyNetto} wczesniej={b.produktyNetto} kwota />} />
      <Kafel
        t="Marża netto"
        v={a.marza === null ? 'brak ceny zakupu' : money(a.marza)}
        opis={
          a.marza === null ? (
            <span className="muted">uzupełnij cenę zakupu w kartach produktów</span>
          ) : (
            <span className="muted">
              {procent(a.marzaProcent)} sprzedaży z ceną zakupu
              {a.bezCenyZakupuNetto > 0 ? ` · bez ceny zakupu: ${money(a.bezCenyZakupuNetto)} netto` : ''}
            </span>
          )
        }
      />
    </div>
  )
}

function WykresOkresow({ r, miara, adresMiary }: { r: RaportSprzedazy; miara: 'kwota' | 'liczba'; adresMiary: (m: 'kwota' | 'liczba') => string }) {
  const isMoney = miara === 'kwota'
  const g = wykresOkresow(r.okresy.map((o) => ({ podpis: podpisOkresu(o.okres, r.grupuj), wartosc: isMoney ? o.wartoscBrutto : o.zamowien })))
  // krótkie podpisy osi (na 390 px wykres się zmniejsza, a „15 000 zł” nie mieści się w marginesie)
  const fmtAxis = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} tys.` : String(Math.round(v)))
  const nazwa = isMoney ? 'Wartość zamówień brutto (zł)' : 'Liczba zamówień'
  return (
    <section className="card" aria-labelledby="h-okresy">
      <div className="card-head">
        <div>
          <h2 id="h-okresy">{nazwa} w okresach</h2>
          <div className="small muted">
            {GRUPY.find((x) => x.k === r.grupuj)!.t.toLowerCase()} · od {dzienKrotko(r.od)}.{r.od.slice(0, 4)} do {dzienKrotko(r.do)}.{r.do.slice(0, 4)} · anulowane poza wykresem
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Miara" style={{ margin: 0, border: 0 }}>
          <Link role="tab" aria-selected={isMoney} href={adresMiary('kwota')} scroll={false}>
            Kwota brutto
          </Link>
          <Link role="tab" aria-selected={!isMoney} href={adresMiary('liczba')} scroll={false}>
            Liczba
          </Link>
        </div>
      </div>
      <svg viewBox={`0 0 ${WO.W} ${WO.H}`} className="mchart rap-wykres" role="img" aria-label={`${nazwa} w okresach od ${r.od} do ${r.do}`}>
        {g.siatka.map((l) => (
          <g key={l.wartosc}>
            <line x1={WO.L} x2={WO.W - WO.R} y1={l.y} y2={l.y} className={l.baza ? 'grid base' : 'grid'} />
            <text x={WO.L - 6} y={l.y + 4} className="ax" textAnchor="end">
              {fmtAxis(l.wartosc)}
            </text>
          </g>
        ))}
        {g.slupki.map((s) => {
          const o = r.okresy[s.i]!
          return (
            <g key={o.okres}>
              {/* pole trafienia na całą wysokość okresu: podpowiedź także przy niskim słupku */}
              <rect x={s.x} y={WO.T} width={s.w} height={g.bazaY - WO.T} className="rap-traf">
                <title>{`${podpisOkresu(o.okres, r.grupuj)}${r.grupuj !== 'dzien' ? ` – ${dzienKrotko(o.okresDo)}` : ''}: ${int(o.zamowien)} zamówień, ${money(o.wartoscBrutto)} brutto${o.niepelny ? ' (okres niepełny)' : ''}`}</title>
              </rect>
              {s.path && <path className={o.niepelny ? 'bar rap-niepelny' : 'bar'} d={s.path} pointerEvents="none" />}
              {s.os && (
                <text x={s.x + s.w / 2} y={WO.H - 8} className="ax" textAnchor="middle">
                  {s.podpis}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <details className="small" style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer' }}>Tabela okresów</summary>
        <div className="rap-przewin">
          <table className="tbl">
            <thead>
              <tr>
                <th>Okres</th>
                <th className="right">Zamówienia</th>
                <th className="right">Wartość brutto</th>
                <th className="right">Produkty netto</th>
                <th className="right">Marża netto</th>
                <th className="right">Anulowane</th>
              </tr>
            </thead>
            <tbody>
              {r.okresy.map((o) => (
                <tr key={o.okres}>
                  <td>
                    {podpisOkresu(o.okres, r.grupuj)}
                    {r.grupuj === 'tydzien' ? ` – ${dzienKrotko(o.okresDo)}` : ''}
                    {o.niepelny ? <span className="muted"> (niepełny)</span> : null}
                  </td>
                  <td className="right num">{int(o.zamowien)}</td>
                  <td className="right num">{money(o.wartoscBrutto)}</td>
                  <td className="right num">{money(o.produktyNetto)}</td>
                  <td className="right num">{o.marza === null ? '—' : money(o.marza)}</td>
                  <td className="right num">{int(o.anulowanych)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

function WierszMiar({ m }: { m: Miary }) {
  return (
    <>
      <td className="right num">{int(m.zamowien)}</td>
      <td className="right num">{money(m.wartoscBrutto)}</td>
      <td className="right num rap-opc">{money(m.sredniaWartosc)}</td>
      <td className="right num rap-opc">{money(m.produktyNetto)}</td>
      <td className="right num">{m.marza === null ? <span className="muted">brak ceny zakupu</span> : money(m.marza)}</td>
      <td className="right num rap-opc">{procent(m.marzaProcent)}</td>
    </>
  )
}

export default async function Raporty({ searchParams }: Props) {
  // przychód i marża tylko z uprawnieniem „Raporty sprzedaży i marża” (Magazyn domyślnie bez)
  const ctx = await requirePermission('raporty.sprzedaz')
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 120) || null
  const now = new Date()
  const dzis = toWarsaw(now).day
  const miara = one(sp.miara) === 'liczba' ? 'liczba' : 'kwota'
  let q: ZapytanieSprzedazy
  let blad: string | null = null
  try {
    q = zapytanieSprzedazy({ od: one(sp.od), do: one(sp.do), grupuj: one(sp.grupuj), konto: one(sp.konto) }, now)
  } catch (e) {
    if (!(e instanceof ApiInputError)) throw e
    blad = e.message
    q = zapytanieSprzedazy({}, now)
  }
  const [r, accs, dodatkowe] = await Promise.all([raportSprzedazy(ctx.db, q, now), accounts(ctx.db), raportDodatkowych(ctx.db, q.od, q.do)])
  const parametry = (over: Record<string, string | null>) => {
    const p = new URLSearchParams()
    const v = { od: q.od, do: q.do, grupuj: one(sp.grupuj), konto: q.konto, miara: miara === 'kwota' ? null : miara, ...over }
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x)
    return p.toString()
  }
  const eksport = `/api/raporty/sprzedaz?${parametry({ miara: null })}`
  const pusty = r.razem.zamowien === 0 && r.razem.anulowanych === 0
  const kontaOpcje = accs.filter((a) => a.active || r.konta.some((k) => k.konto === accountKey(a.channel, a.channelAccountId)))
  const maxKonto = Math.max(1, ...r.konta.map((k) => k.wartoscBrutto))

  return (
    <>
      <NaglowekStrony
        tytul="Raporty sprzedaży"
        podtytul="Sprzedaż wg okresu, kanału i produktu, z marżą z ceny zakupu i porównaniem z poprzednim okresem. Liczone po dacie złożenia zamówienia, czas polski."
        akcje={
          <PrzyciskLink href={eksport} rozmiar="sm" prefetch={false} title="Podsumowanie, okresy, kanały i produkty (do 1000) w jednym pliku Excela">
            Pobierz Excel (XLSX)
          </PrzyciskLink>
        }
      />

      <form className="card rap-filtry" method="get" action="/raporty" aria-label="Zakres raportu">
        <div className="rap-pola">
          <div className="field">
            <label htmlFor="rap-od">Od</label>
            <input id="rap-od" name="od" type="date" className="input" defaultValue={q.od} max={dzis} />
          </div>
          <div className="field">
            <label htmlFor="rap-do">Do</label>
            <input id="rap-do" name="do" type="date" className="input" defaultValue={q.do} />
          </div>
          <div className="field">
            <label htmlFor="rap-grupuj">Podział</label>
            <select id="rap-grupuj" name="grupuj" className="input" defaultValue={one(sp.grupuj) ?? ''}>
              <option value="">Samo dobierze</option>
              {GRUPY.map((g) => (
                <option key={g.k} value={g.k}>
                  {g.t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rap-konto">Kanał</label>
            <select id="rap-konto" name="konto" className="input" defaultValue={q.konto ?? ''}>
              <option value="">Wszystkie kanały</option>
              {kontaOpcje.map((a) => (
                <option key={accountKey(a.channel, a.channelAccountId)} value={accountKey(a.channel, a.channelAccountId)}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit">
            Pokaż
          </button>
        </div>
        <div className="rap-skroty small" aria-label="Szybki wybór zakresu">
          {skroty(dzis).map((s) => (
            <Link key={s.t} href={`/raporty?${parametry({ od: s.od, do: s.do })}`} className={s.od === q.od && s.do === q.do ? 'chip sel' : 'chip'} aria-current={s.od === q.od && s.do === q.do ? 'true' : undefined}>
              {s.t}
            </Link>
          ))}
        </div>
      </form>

      {blad && (
        <Baner ton="blad" tytul="Nie da się pokazać tego zakresu.">
          {blad.replace(/^[a-z]+: /, '')}. Pokazuję bieżący miesiąc.
        </Baner>
      )}

      {pusty ? (
        <PustyStan tytul="Brak sprzedaży w tym zakresie">
          W wybranym zakresie nie ma zamówień{q.konto ? ' w tym kanale' : ''}. Wybierz inny zakres albo „Wszystkie kanały”.
        </PustyStan>
      ) : (
        <>
          {r.razem.nieznanaStawkaPozycji > 0 && (
            <Baner ton="ostrzezenie" tytul="Niektóre pozycje mają nierozpoznaną stawkę VAT.">
              {int(r.razem.nieznanaStawkaPozycji)} poz. w tym zakresie ma stawkę VAT, której raport nie rozpoznaje. Netto policzyliśmy ze
              stawki produktu, a bez niej z 23%. Popraw stawkę na karcie zamówienia (sekcja „Pozycje”) albo produktu.
            </Baner>
          )}
          <Kafle r={r} />
          <p className="small muted rap-uwaga">
            Porównanie z okresem {dzienKrotko(r.poprzedni.od)}.{r.poprzedni.od.slice(0, 4)} – {dzienKrotko(r.poprzedni.do)}.{r.poprzedni.do.slice(0, 4)} (tyle samo dni tuż przed).
            {r.razem.anulowanych > 0 && ` Anulowane: ${int(r.razem.anulowanych)} zamówień za ${money(r.razem.anulowaneBrutto)}, poza sprzedażą.`}
            {r.razem.zwrotyBrutto > 0 && ` Zwroty: ${money(r.razem.zwrotyBrutto)} brutto, odjęte od sprzedaży produktów.`}
            {r.pozaKompletorem.zamowien > 0 && ` Poza raportem: ${int(r.pozaKompletorem.zamowien)} zamówień z kanału za ${money(r.pozaKompletorem.brutto)}, których Kompletor nie realizuje (np. sprzed uruchomienia).`}{' '}
            <Link href="/pomoc/raporty">Jak liczymy</Link>
          </p>

          <WykresOkresow r={r} miara={miara} adresMiary={(m) => `/raporty?${parametry({ miara: m === 'kwota' ? null : m })}`} />

          <Karta tytul="Kanały" opis="Konta kanałów sprzedaży, największa wartość pierwsza.">
            <div className="rap-przewin">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Kanał</th>
                    <th className="rap-opc" aria-label="Udział w wartości" />
                    <th className="right">Zamówienia</th>
                    <th className="right">Wartość brutto</th>
                    <th className="right rap-opc">Średnia</th>
                    <th className="right rap-opc">Produkty netto</th>
                    <th className="right">Marża netto</th>
                    <th className="right rap-opc">Marża %</th>
                  </tr>
                </thead>
                <tbody>
                  {r.konta.map((k) => (
                    <tr key={k.konto}>
                      <td>
                        <Link href={`/raporty?${parametry({ konto: k.konto })}`}>{k.nazwa}</Link>
                      </td>
                      <td className="rap-opc rap-udzial">
                        <span className="rap-pasek" style={{ width: `${Math.round((k.wartoscBrutto / maxKonto) * 100)}%` }} aria-hidden="true" />
                      </td>
                      <WierszMiar m={k} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Karta>

          <Karta
            tytul="Produkty"
            opis={
              r.wiecejProduktow
                ? `${int(r.produkty.length)} najlepiej sprzedających się z ${int(r.produktowRazem)}, po wartości brutto. Wszystkie (do 1000) są w pliku Excela.`
                : 'Po wartości sprzedaży brutto, po zwrotach. Zestaw liczy się jako zestaw.'
            }
          >
            <div className="rap-przewin">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th className="right rap-opc">Ilość</th>
                    <th className="right rap-opc">Zamówienia</th>
                    <th className="right">Sprzedaż netto</th>
                    <th className="right rap-opc">Sprzedaż brutto</th>
                    <th className="right">Marża netto</th>
                    <th className="right rap-opc">Marża %</th>
                  </tr>
                </thead>
                <tbody>
                  {/* klucz z pozycji, bo dwa wiersze mogą nie mieć SKU (produkt usunięty, pozycje bez produktu) */}
                  {r.produkty.map((p, i) => (
                    <tr key={`${i}-${p.sku ?? ''}`}>
                      <td>
                        <div>{p.nazwa}</div>
                        {p.sku && <div className="small muted mono">{p.sku}</div>}
                        <div className="small muted rap-mobile">{qty(p.ilosc, p.jednostka)}</div>
                      </td>
                      <td className="right num rap-opc">{qty(p.ilosc, p.jednostka)}</td>
                      <td className="right num rap-opc">{int(p.zamowien)}</td>
                      <td className="right num">{money(p.netto)}</td>
                      <td className="right num rap-opc">{money(p.brutto)}</td>
                      <td className="right num">{p.brakCenyZakupu ? <span className="muted">brak ceny zakupu</span> : money(p.marza)}</td>
                      <td className="right num rap-opc">{p.brakCenyZakupu ? '—' : procent(p.marzaProcent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Karta>
        </>
      )}
      <KartaDodatkowych r={dodatkowe} />
    </>
  )
}

/** Dodatkowe przesyłki w tym samym zakresie dni (po dacie utworzenia przesyłki): liczba i koszt netto wpisany ręcznie. */
function KartaDodatkowych({ r }: { r: RaportDodatkowych }) {
  return (
    <Karta
      tytul="Dodatkowe przesyłki"
      opis="Dosyłki, paczki zastępcze i drugie paczki dodane na karcie zamówienia („Dodaj przesyłkę”), po dacie utworzenia, bez anulowanych. Koszt to kwota netto wpisana przy dodaniu; kosztu głównych przesyłek Kompletor nie zna."
    >
      {r.razem.liczba === 0 ? (
        <p className="muted">W tym okresie nie dodano żadnej dodatkowej przesyłki.</p>
      ) : (
        <div className="rap-przewin">
          <table className="tbl">
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th className="right">Przesyłki</th>
                <th className="right">Koszt netto</th>
                <th className="right">Bez wpisanego kosztu</th>
              </tr>
            </thead>
            <tbody>
              {r.rodzaje.map((x) => (
                <tr key={x.rodzaj}>
                  <td>{x.nazwa}</td>
                  <td className="right num">{int(x.liczba)}</td>
                  <td className="right num">{money(x.kosztNetto)}</td>
                  <td className="right num">{int(x.bezKosztu)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Razem</th>
                <td className="right num">{int(r.razem.liczba)}</td>
                <td className="right num">{money(r.razem.kosztNetto)}</td>
                <td className="right num">{int(r.razem.bezKosztu)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Karta>
  )
}
