// Lista faktur i korekt (jak „Faktury i paragony” w BaseLinkerze). Zakładki Faktury i Korekty, filtry
// w adresie (seria, numer, miesiąc, rok, nabywca po e-mailu albo telefonie, „błąd wystawienia”), w wierszu numer
// z programu (pod nim nasz identyfikator), zamówienie, nabywca, brutto, data, stan i akcje: PDF, „Ponów”, „Korekta”.
// PDF wielu naraz: jeden plik z dokumentami z bieżącej strony (najwyżej 50). Widzi osoba z uprawnieniem
// „Faktura na karcie zamówienia”; PDF dodatkowo wymaga dostępu do danych klientów (faktura niesie dane nabywcy).
import Link from 'next/link'
import { Baner, NaglowekStrony, Odznaka, PasekFiltrow, PrzyciskLink, PustyStan, Tabela, Zakladki, type KolumnaTabeli, type WierszTabeli } from '@/app/ui'
import { ustawieniaDokumentowFirmy } from '@/lib/dokumenty/firma'
import { biezacyOkres, listaFaktur, skrotKomunikatu, type FiltryFaktur, type ZakladkaFaktur } from '@/lib/dokumenty/lista'
import { KOMUNIKAT_INNA_FRAZA, szukajPoKliencie } from '@/lib/klienci/odczyt'
import { money, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { PonowDokument } from './przyciski'
import '../zamowienia/_lista/lista.css'

export const metadata = { title: 'Faktury' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const MIESIACE = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień']

const KOLUMNY: KolumnaTabeli[] = [
  { klucz: 'numer', etykieta: 'Numer' },
  { klucz: 'zamowienie', etykieta: 'Zamówienie', szerokosc: '9rem' },
  { klucz: 'nabywca', etykieta: 'Nabywca', szerokosc: '8rem' },
  { klucz: 'brutto', etykieta: 'Brutto', szerokosc: '7rem' },
  { klucz: 'data', etykieta: 'Data', szerokosc: '6.5rem' },
  { klucz: 'stan', etykieta: 'Stan', szerokosc: '14rem' },
  { klucz: 'akcje', etykieta: 'Akcje', szerokosc: '13rem' },
]

export default async function Faktury({ searchParams }: Props) {
  const ctx = await requirePermission('zamowienia.faktury')
  const sp = await searchParams
  const zakladka: ZakladkaFaktur = one(sp.z) === 'korekty' ? 'korekty' : 'faktury'
  const teraz = biezacyOkres()
  const rokTxt = one(sp.rok)
  const rok = rokTxt === 'wszystkie' ? undefined : Number(rokTxt) || teraz.rok
  const miesiac = one(sp.mies) ? Number(one(sp.mies)) || undefined : rokTxt ? undefined : teraz.miesiac
  const nabywca = (one(sp.nabywca) ?? '').trim()
  let zamowieniaNabywcy: string[] | null = null
  let komunikatNabywcy: string | null = null
  if (nabywca) {
    const w = await szukajPoKliencie(ctx.db, nabywca, { actorId: ctx.user.id, limit: 200 })
    if (w.stan === 'OK') zamowieniaNabywcy = w.orderIds
    else {
      zamowieniaNabywcy = []
      komunikatNabywcy = w.stan === 'INNA_FRAZA' ? KOMUNIKAT_INNA_FRAZA : w.stan === 'BEZ_UPRAWNIEN' ? 'Filtr po nabywcy wymaga dostępu do danych klientów.' : 'Dane klientów są niedostępne (brak klucza szyfrowania na serwerze).'
    }
  }
  const f: FiltryFaktur = { zakladka, seria: one(sp.seria), numer: one(sp.numer), rok, miesiac, zamowieniaNabywcy, tylkoBledy: one(sp.blad) === 'tak' }
  const [dane, u] = await Promise.all([listaFaktur(ctx.db, f), ustawieniaDokumentowFirmy(ctx.db)])
  const now = new Date()
  const mozePdf = ctx.permissions.has('klienci.dane')
  const mozeKorekty = ctx.permissions.has('zwroty.korekty')
  const wylaczone = u.fakturyWlaczone ? null : 'Wystawianie faktur z Kompletora jest wyłączone (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży)'
  const qs = (zmiany: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)])), ...zmiany })) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `?${s}` : ''
  }
  const pdfy = dane.wiersze.filter((w) => w.pdf).slice(0, 50)
  const aktywne = [f.seria, rokTxt, one(sp.mies), nabywca, f.tylkoBledy ? 'tak' : ''].filter(Boolean).length

  const wiersze: WierszTabeli[] = dane.wiersze.map((w) => {
    const pdfHref = w.pdf ? `/api/faktury/pdf?k=${encodeURIComponent(w.klucz)}` : null
    const powodPonow = w.ponow === 'korekta-wfirma' ? (mozeKorekty ? null : 'Brak uprawnienia „Zwroty: zlecenie korekty faktury”') : wylaczone
    return {
      id: w.klucz,
      etykieta: `${w.rodzaj === 'korekta' ? 'Korekta' : 'Faktura'} ${w.numer ?? w.zamowienie}`,
      ton: w.stan === 'BLAD' ? 'blad' : undefined,
      komorki: {
        numer: (
          <>
            {w.numer ? <b className="mono">{w.numer}</b> : <span className="muted">bez numeru</span>}
            <br />
            <span className="small muted mono" title="Identyfikator w Kompletorze" style={{ overflowWrap: 'anywhere' }}>
              {w.nasz}
            </span>
            {w.korygowana && (
              <span className="small muted">
                <br />
                koryguje {w.korygowana}
              </span>
            )}
          </>
        ),
        zamowienie: <Link href={`/zamowienia/${w.orderId}`}>{w.zamowienie}</Link>,
        nabywca: <span className="small">{w.nabywca}</span>,
        brutto: w.bruttoGr === null ? <span className="muted">—</span> : <span className="num">{money(w.bruttoGr / 100)}</span>,
        data: <span title={w.data.toISOString()}>{when(w.data, now)}</span>,
        stan: (
          <>
            <Odznaka ton={w.ton} className="kz-zawijaj">
              {w.stanTekst}
            </Odznaka>
            <span className="small muted">
              <br />
              {w.program === 'ksef' ? 'KSeF' : 'wFirma'}
            </span>
            {w.ksefNumer && (
              <span className="small mono" style={{ overflowWrap: 'anywhere' }}>
                <br />
                {w.ksefNumer}
              </span>
            )}
            {w.blad && <KomunikatStanu tekst={w.blad} />}
          </>
        ),
        akcje: (
          <span className="pl-akcje-wiersza">
            {pdfHref ? (
              mozePdf ? (
                <a className="btn small" href={pdfHref} target="_blank" rel="noopener">
                  PDF
                </a>
              ) : (
                <span className="btn small is-disabled" aria-disabled="true" title="PDF niesie dane nabywcy: potrzebne uprawnienie do danych klientów">
                  PDF
                </span>
              )
            ) : null}
            {w.ponow ? <PonowDokument klucz={w.klucz} etykieta={w.ponow === 'ksef' && w.stan === 'SZKIC' ? 'Wyślij do KSeF' : 'Ponów'} powodWylaczenia={powodPonow} potwierdzenie={w.ponow === 'korekta-wfirma' && (w.blad ?? '').startsWith('timeout')} /> : null}
            {w.rodzaj === 'faktura' && w.stan === 'WYSTAWIONA' ? (
              <PrzyciskLink href={`/zwroty/nowy?zamowienie=${w.orderId}`} wariant="cichy" rozmiar="sm" title="Korekta powstaje ze zwrotu albo reklamacji zamówienia">
                Korekta
              </PrzyciskLink>
            ) : null}
            {w.rodzaj === 'korekta' && w.returnId ? (
              <PrzyciskLink href={`/zwroty/${w.returnId}`} wariant="cichy" rozmiar="sm">
                Zwrot
              </PrzyciskLink>
            ) : null}
          </span>
        ),
      },
    }
  })

  const opcja = (wartosc: string, etykieta: string) => (
    <option key={wartosc} value={wartosc}>
      {etykieta}
    </option>
  )
  const lata = Array.from({ length: 4 }, (_, i) => String(teraz.rok - i))
  return (
    <>
      <NaglowekStrony
        tytul="Faktury"
        podtytul={`Faktury i korekty ze wszystkich zamówień${u.program === 'brak' ? '. Ta firma nie wystawia faktur z Kompletora (Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży)' : ''}.`}
        akcje={
          <>
            {mozePdf && pdfy.length > 0 && (
              <a className="btn small" href={`/api/faktury/pdf?${new URLSearchParams(pdfy.map((w) => ['k', w.klucz]))}`} target="_blank" rel="noopener">
                PDF z tej strony ({pdfy.length})
              </a>
            )}
            <PrzyciskLink href="/pomoc/dokumenty-sprzedazy" wariant="cichy" rozmiar="sm">
              Jak to działa
            </PrzyciskLink>
          </>
        }
      />
      <Zakladki
        etykieta="Rodzaj dokumentu"
        zakladki={[
          { href: `/faktury${qs({ z: undefined })}`, etykieta: 'Faktury', aktywna: zakladka === 'faktury' },
          { href: `/faktury${qs({ z: 'korekty' })}`, etykieta: 'Korekty', aktywna: zakladka === 'korekty' },
        ]}
      />
      {wylaczone && u.program !== 'brak' && (
        <Baner ton="info">
          {wylaczone}: lista pokazuje dokumenty, a „Ponów” i „Wyślij do KSeF” są nieaktywne. Włączasz je w <Link href="/ustawienia/dokumenty">Ustawienia → Dokumenty i faktury → Dokumenty sprzedaży</Link>.
        </Baner>
      )}
      {komunikatNabywcy && <Baner ton="info">{komunikatNabywcy}</Baner>}
      <PasekFiltrow
        akcja="/faktury"
        szukaj={{ nazwa: 'numer', wartosc: f.numer, etykieta: 'Szukaj po numerze', podpowiedz: 'numer faktury, zamówienia albo KSeF' }}
        aktywne={aktywne}
        zwijane
        wyczysc={`/faktury${zakladka === 'korekty' ? '?z=korekty' : ''}`}
        zachowaj={{ z: zakladka === 'korekty' ? 'korekty' : undefined }}
      >
        <div className="field">
          <label htmlFor="f-seria">Seria (początek numeru)</label>
          <input className="input" id="f-seria" name="seria" defaultValue={f.seria ?? ''} placeholder="np. FV" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="f-mies">Miesiąc</label>
          <select className="input" id="f-mies" name="mies" defaultValue={miesiac ? String(miesiac) : ''}>
            {opcja('', 'Wszystkie')}
            {MIESIACE.map((m, i) => opcja(String(i + 1), m))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-rok">Rok</label>
          <select className="input" id="f-rok" name="rok" defaultValue={rok ? String(rok) : 'wszystkie'}>
            {lata.map((r) => opcja(r, r))}
            {opcja('wszystkie', 'Wszystkie')}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-nab">Nabywca (e-mail albo telefon)</label>
          <input className="input" id="f-nab" name="nabywca" defaultValue={nabywca} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="f-blad">Stan</label>
          <select className="input" id="f-blad" name="blad" defaultValue={f.tylkoBledy ? 'tak' : ''}>
            {opcja('', 'Wszystkie')}
            {opcja('tak', 'Błąd wystawienia')}
          </select>
        </div>
      </PasekFiltrow>
      <Tabela
        id="faktury"
        etykieta={zakladka === 'korekty' ? 'Korekty' : 'Faktury'}
        kolumny={KOLUMNY}
        wiersze={wiersze}
        pustyStan={
          <PustyStan tytul={zakladka === 'korekty' ? 'Brak korekt w tym okresie' : 'Brak faktur w tym okresie'} akcja={aktywne ? <PrzyciskLink href="/faktury?rok=wszystkie">Pokaż wszystkie</PrzyciskLink> : undefined}>
            {zakladka === 'korekty' ? 'Korekta powstaje ze zwrotu albo reklamacji (Zwroty → karta zwrotu).' : 'Faktura pojawi się tutaj, gdy Kompletor ją wystawi albo przygotuje do wysyłki do KSeF.'}
          </PustyStan>
        }
      />
      {dane.wiecej && <p className="small muted">Pokazano najnowsze 100 dokumentów: zawęź filtry (miesiąc, seria, numer), żeby zobaczyć starsze.</p>}
    </>
  )
}

/** Komunikat w kolumnie „Stan”: skrót na granicy słowa, całość w podpowiedzi i w rozwinięciu (dotyk nie ma podpowiedzi). */
function KomunikatStanu({ tekst }: { tekst: string }) {
  const { skrot, caly } = skrotKomunikatu(tekst)
  if (!caly) {
    return (
      <span className="small">
        <br />
        {skrot}
      </span>
    )
  }
  return (
    <details className="small" title={caly}>
      <summary>{skrot}</summary>
      {caly}
    </details>
  )
}
