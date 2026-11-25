// Blok „Przesyłka” w ekranie zamówienia: podgląd parametrów i nadanie u przewoźnika z gabarytem, etykieta,
// poprawka adresu przed nadaniem. Część sekcji „Dostawa i przesyłki” (dostawa.tsx), bez
// własnej karty (tytuł daje pasek nagłówka sekcji „Przesyłka”, dostawa.tsx); przewoźnik z kanału jest w sekcji, tu tylko kod usługi przewoźnika przesyłki. Przyciski mają role z `pakowanie.stanowisko`, poprawkę adresu
// `klienci.dane`. Klient bazy przychodzi z sesji ekranu.
import type { Carrier } from '@prisma/client'
import { Odznaka, Przycisk } from '@/app/ui'
import { CARRIER_LABEL, money, when } from '@/lib/panel/format'
import type { PanelContext } from '@/lib/panel/kontekst'
import { bramkaNadania, moznaPoprawicAdres, widokPrzesylki } from '@/lib/wysylka/nadanie'
import { ostrzezeniaDoPotwierdzenia, podgladPrzesylki } from '@/lib/wysylka/podglad'
import { poprzedniaPrzesylka } from '@/lib/wysylka/poprzednia'
import { stanZmianySposobu } from '@/lib/wysylka/zmiana-sposobu'
import { NadaniePrzesylki } from '../../_komponenty/nadanie-przesylki'
import { PoprawAdres } from './popraw-adres'
import { PodzialAdresuAi } from '../../_komponenty/podzial-adresu-ai'
import { powodBrakuAsystentaAdresu } from '@/lib/klienci/adres-ai'
import { DrukujEtykieteOdbioru, DrukujEtykieteProbna } from '../../_komponenty/druk'
import { czyOdbiorOsobisty } from '@/lib/druk/etykieta-odbioru'
import { PrzygotujPrzesylke } from './przygotuj-przesylke'
import { tekstStanuBezNadania } from './przesylka-stan'
import { ZmianaSposobu } from './zmiana-sposobu'

export async function BlokPrzesylki({
  ctx,
  orderId,
  przewoznikKanalu,
  powodPodgladu = null,
  podzialAdresu = false,
}: {
  ctx: PanelContext
  orderId: string
  przewoznikKanalu?: Carrier | null
  powodPodgladu?: string | null
  /** kurier do drzwi, numer domu w jednej linii z ulicą i bez jednoznacznego podziału (z odczytu w page.tsx). */
  podzialAdresu?: boolean
}) {
  const p = await podgladPrzesylki(ctx.db, orderId)
  if (!p) return <p className="muted small kz-bez-marginesu">Brak danych przesyłki dla tego zamówienia.</p>
  const z = p.zapisana
  const moze = ctx.permissions.has('pakowanie.stanowisko')
  // odbiór osobisty nie ma przesyłki; zamiast niej etykieta odbioru do naklejenia na paczkę
  const odbior = moze && !!p.nieDotyczy && (await czyOdbiorOsobisty(ctx.db, orderId))
  const now = new Date()
  const b = moze ? await bramkaNadania(ctx.db, orderId) : null
  const nadana = moze ? await widokPrzesylki(ctx.db, orderId, now) : null
  const poprzednia = moze && !nadana ? await poprzedniaPrzesylka(ctx.db, orderId) : null
  const poprawka = ctx.permissions.has('klienci.dane') && !p.nieDotyczy && (await moznaPoprawicAdres(ctx.db, orderId))
  // zmiana sposobu wysyłki: dane odbiorcy (klienci.dane) i nadanie (pakowanie.stanowisko); także przy odbiorze osobistym
  const zmiana = moze && ctx.permissions.has('klienci.dane') ? await stanZmianySposobu(ctx.db, orderId) : null
  const pokazZmiane = !!zmiana && !zmiana.ukryj && zmiana.opcje.some((o) => o.klucz !== zmiana.obecna)
  // powód nieaktywnego „Podpowiedz podział adresu” (tryb konta, brak asystenta AI, limit) bez pytania modelu
  const powodPodzialu = poprawka && podzialAdresu ? (powodPodgladu ?? (await powodBrakuAsystentaAdresu(ctx.db))) : null
  const powodZmiany = zmiana ? (zmiana.powod === null ? null : (powodPodgladu ?? zmiana.powod)) : null
  // po utworzeniu przesyłki podgląd (wartości policzone przed nadaniem, ostrzeżenia, „Podgląd nieaktualny”)
  // znika; zostaje stan, numer, etykieta i akcje z bloku nadania
  // osoba bez `pakowanie.stanowisko` widzi stan przesyłki zgodny z prawdą (tworzy się, do sprawdzenia, utworzona)
  const stanBezNadania = moze ? null : ((await ctx.db.shipment.findFirst({ where: { orderId, state: { in: ['TWORZENIE', 'UTWORZONA', 'NIEJEDNOZNACZNA'] } }, orderBy: { createdAt: 'desc' }, select: { state: true } }))?.state ?? null)
  const aktywna = moze ? !!nadana && nadana.stan !== 'BLAD' && nadana.stan !== 'ANULOWANA' : stanBezNadania !== null
  // ostrzeżenia do potwierdzenia pokazuje krok „Sprawdź przed nadaniem” przy przycisku, nie lista nad nim
  const krokPotwierdzen = moze && !!b && !b.nieDotyczy && !b.powod && !aktywna
  const doPotwierdzenia = krokPotwierdzen ? await ostrzezeniaDoPotwierdzenia(ctx.db, orderId) : []
  const problemy = z ? z.problemy.filter((pr) => !(krokPotwierdzen && pr.poziom === 'OSTRZEZENIE' && doPotwierdzenia.some((d) => d.kod === pr.kod))) : []
  return (
    <div className="kz-przesylka-blok">
      {p.nieDotyczy ? (
        <>
          <p className="muted small">Nie dotyczy. {p.nieDotyczy}</p>
          {odbior && <DrukujEtykieteOdbioru orderId={orderId} />}
        </>
      ) : aktywna ? (
        moze ? null : <p className="muted small">{tekstStanuBezNadania(stanBezNadania)}</p>
      ) : z ? (
        <>
          <dl className="dl">
            {(z.przewoznik !== przewoznikKanalu || z.courierCode) && (
              <>
                <dt>Przewoźnik przesyłki</dt>
                <dd>
                  {CARRIER_LABEL[z.przewoznik]}
                  {z.courierCode ? <span className="mono small muted"> · {z.courierCode}</span> : null}
                </dd>
              </>
            )}
            <dt>Gabaryt</dt>
            <dd>{z.gabaryt ?? '—'}</dd>
            <dt>Wymiary</dt>
            <dd className="num">
              {z.wymiary ?? '—'}
              {z.wymiaryRobocze ? <span className="small muted"> (robocze, do potwierdzenia)</span> : null}
            </dd>
            <dt>Waga</dt>
            <dd className="num">
              {z.wagaKg === null ? '—' : `${z.wagaKg.toLocaleString('pl-PL')} kg`}
              {z.wagaRobocza ? <span className="small muted"> (robocza, do potwierdzenia)</span> : null}
              {z.wagaZUstawien ? <span className="small muted"> (z ustawień przewoźnika)</span> : null}
            </dd>
            {z.pobranie ? (
              <>
                <dt>Kwota pobrania</dt>
                <dd className="num">{money(z.pobranie)}</dd>
              </>
            ) : null}
            <dt>Policzono</dt>
            <dd>
              {when(z.przygotowano, now)} {z.nieaktualny && (
                <Odznaka ton="ostrzezenie" title="Zamówienie zmieniło się po policzeniu: policz ponownie">
                  Podgląd nieaktualny
                </Odznaka>
              )}
            </dd>
          </dl>
          {problemy.length > 0 && (
            <div className="kz-poz-znaczniki kz-odstep-gora">
              {problemy.map((pr, i) => (
                <Odznaka key={i} ton={pr.poziom === 'BLAD' ? 'blad' : pr.poziom === 'INFO' ? 'info' : 'ostrzezenie'} className="kz-zawijaj">
                  {pr.tekst}
                </Odznaka>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="muted small">Jeszcze nie policzono.</p>
      )}
      {moze && !p.nieDotyczy && !aktywna && <PrzygotujPrzesylke orderId={orderId} gabaryty={p.gabaryty} ponownie={!!z} />}
      {/* etykieta próbna na stanowisko druku (atrapa „PRÓBA”), tylko dopóki nie ma prawdziwej przesyłki */}
      {moze && !p.nieDotyczy && z && (!nadana || nadana.stan === 'BLAD') && <DrukujEtykieteProbna orderId={orderId} />}
      {/* nadanie u przewoźnika z gabarytem, numer nadania, etykieta, ponowny druk */}
      {moze && b && !b.nieDotyczy && (
        // klucz z modułu: po zmianie sposobu wysyłki blok nadania zaczyna od nowego stanu serwera (gabaryty nowego przewoźnika)
        <NadaniePrzesylki key={`${b.modul ?? ''}:${zmiana?.obecna ?? ''}`} orderId={orderId} poczatkowy={{ powod: b.powod, nieDotyczy: b.nieDotyczy, gabaryty: b.gabaryty, modul: b.modul, przesylka: nadana, moznaPoprawic: !!poprawka, mozeRozstrzygnac: ctx.permissions.has('przesylki.rozstrzyganie'), poprzednia, podzialAdresu: null, doPotwierdzenia }} />
      )}
      {/* po zmianie sposobu wysyłki formularz poprawki zaczyna od świeżych danych (punkt, adres) */}
      {/* zapis poprawki adresu ma bramkę trybu pracy, więc w „Tylko podgląd” przycisk nieaktywny z powodem;
          gdy obok stoi nieaktywne „Zmień sposób wysyłki” z tym samym powodem, oba przyciski mają jedno zdanie powodu */}
      {/* propozycja podziału linii adresu od asystenta AI z „Zatwierdź”; po zapisie komponent zostaje z potwierdzeniem */}
      {poprawka && <PodzialAdresuAi orderId={orderId} powod={powodPodzialu} potrzebny={podzialAdresu} />}
      {poprawka && !powodPodgladu && <PoprawAdres key={zmiana?.obecna ?? ''} orderId={orderId} />}
      {poprawka && powodPodgladu && (
        <div className="ui-akcja">
          <div className="kz-poz-akcje">
            <Przycisk rozmiar="sm" powodWylaczenia={powodPodgladu} aria-describedby={`pa-powod-${orderId}`}>
              Popraw adres albo punkt odbioru przed nadaniem
            </Przycisk>
            {pokazZmiane && powodZmiany === powodPodgladu && (
              <Przycisk rozmiar="sm" powodWylaczenia={powodZmiany} aria-describedby={`pa-powod-${orderId}`}>
                Zmień sposób wysyłki
              </Przycisk>
            )}
          </div>
          <p id={`pa-powod-${orderId}`} className="ui-akcja-powod">
            {powodPodgladu}
          </p>
        </div>
      )}
      {pokazZmiane &&
        !(poprawka && powodPodgladu && powodZmiany === powodPodgladu) &&
        (powodZmiany ? (
          <div className="ui-akcja">
            <div className="kz-poz-akcje">
              <Przycisk rozmiar="sm" powodWylaczenia={powodZmiany} aria-describedby={`zs-powod-${orderId}`}>
                Zmień sposób wysyłki
              </Przycisk>
            </div>
            <p id={`zs-powod-${orderId}`} className="ui-akcja-powod">
              {powodZmiany}
            </p>
          </div>
        ) : (
          <ZmianaSposobu orderId={orderId} opcje={zmiana!.opcje} obecna={zmiana!.obecna} uwagi={zmiana!.uwagi} pobranie={zmiana!.pobranie} />
        ))}
    </div>
  )
}
