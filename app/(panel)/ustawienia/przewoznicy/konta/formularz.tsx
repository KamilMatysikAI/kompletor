'use client'
// Konta przewoźników: klucze (puste pole = bez zmiany), ustawienia konta z manifestu adaptera
// i wyłączniki nadawania reguł — jeden formularz, jeden PasekZapisu. „Sprawdź połączenie” to osobny formularz
// poza tym (atrybut `form` przycisku), więc test nie wysyła niezapisanych zmian.
// zapis przez `onSubmit`, nie `<form action={fn}>`: React 19 po akcji funkcyjnej sam resetuje formularz do
// wartości domyślnych z chwili przed odświeżeniem danych, więc po „Zapisz zmiany” pola wracały puste (nowe konto) albo
// stare, a zapisane wartości było widać dopiero po F5; po błędzie ginęły wpisane dane. Teraz pola zostają, karta konta
// montuje się od nowa, gdy przyjdą zapisane wartości z serwera (klucz = odcisk danych konta), a wpisane klucze znikają
// z pól po udanym zapisie (wartość kluczy nigdy nie wraca do panelu).
import { startTransition, useActionState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Karta, Odznaka, PasekZapisu, PoleHasla, PoleTekstowe, Przelacznik, Przycisk, ToastPoAkcji, Wybor, Zaawansowane } from '@/app/ui'
import type { KontoPrzewoznika } from '@/lib/wysylka/konta'
import { dodajKonto, zapiszKonta, type StanKont } from './akcje'

const kiedy = (iso: string) => new Date(iso).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
const etykietaPola = (opis: string) => opis.charAt(0).toUpperCase() + opis.slice(1)
const nrReguly = (priority: number, wszystkie: number[]) => wszystkie.indexOf(priority) + 1

/**
 * Odcisk danych karty konta z serwera: zmienia się, gdy po zapisie przyjdą nowe wartości pól, stan kluczy
 * albo wyłączników nadawania. Służy za klucz karty, bo pola są niekontrolowane (`defaultValue` działa tylko przy montażu).
 */
export function odciskKonta(k: KontoPrzewoznika): string {
  return JSON.stringify([k.id, k.sekrety.map((s) => [s.name, s.zrodlo]), k.pola.map((p) => [p.key, p.wartosc]), k.reguly.map((r) => [r.id, r.nadawanie])])
}

/** Pola kluczy w formularzu kont (`k-<konto>-s-<nazwa>`): po udanym zapisie czyszczone, wartość nie wraca do panelu. */
export const POLE_KLUCZA_RE = /^k-.+-s-/

export function FormularzKont({ konta, przewoznicy, priorytety }: { konta: KontoPrzewoznika[]; przewoznicy: Record<string, string>; priorytety: number[] }) {
  const [stan, akcja, trwa] = useActionState<StanKont, FormData>(zapiszKonta, {})
  const ref = useRef<HTMLFormElement>(null)
  const router = useRouter()
  const zapisz = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    startTransition(() => akcja(form))
  }
  // po udanym zapisie: wpisane klucze znikają z pól, a strona dociąga zapisane wartości (gdyby odpowiedź akcji ich nie
  // niosła); zdarzenie `reset` (bez resetu pól) mówi paskowi zapisu, że bieżące wartości są stanem zapisanym
  const poprzedni = useRef(stan)
  useEffect(() => {
    if (stan === poprzedni.current) return
    poprzedni.current = stan
    if (!stan.ok) return
    const f = ref.current
    if (f) for (const el of f.querySelectorAll<HTMLInputElement>('input')) if (POLE_KLUCZA_RE.test(el.name)) el.value = ''
    f?.dispatchEvent(new Event('reset'))
    router.refresh()
  }, [stan, router])
  // karta zamontowana od nowa z zapisanymi wartościami: nowy stan zapisany dla paska
  const odciski = konta.map(odciskKonta).join('|')
  useEffect(() => {
    ref.current?.dispatchEvent(new Event('reset'))
  }, [odciski])
  return (
    <form ref={ref} onSubmit={zapisz} aria-label="Konta przewoźników">
      <ToastPoAkcji stan={stan} />
      {konta.map((k) => {
        const komplet = k.sekrety.filter((s) => s.wymagany).every((s) => s.ustawiony)
        // klucze z konfiguracji serwera (self-host) to osobny stan, „Sprawdź połączenie” działa też z nimi
        const zSerwera = komplet && k.sekrety.some((s) => s.zrodlo === 'serwer')
        const wymagane = k.pola.filter((p) => p.wymagane)
        const reszta = k.pola.filter((p) => !p.wymagane)
        const pole = (p: KontoPrzewoznika['pola'][number]) => {
          const id = `k-${k.id}-p-${p.key}`
          if (p.opcje)
            return <Wybor key={p.key} id={id} name={id} etykieta={etykietaPola(p.opis)} defaultValue={p.wartosc} opcje={[{ wartosc: '', etykieta: 'domyślnie' }, ...p.opcje.map((o) => ({ wartosc: o.value, etykieta: o.label }))]} />
          if (p.typ === 'boolean')
            return (
              <Wybor
                key={p.key}
                id={id}
                name={id}
                etykieta={etykietaPola(p.opis)}
                defaultValue={p.wartosc === 'true' ? 'tak' : p.wartosc === 'false' ? 'nie' : ''}
                opcje={[
                  { wartosc: '', etykieta: 'domyślnie' },
                  { wartosc: 'tak', etykieta: 'tak' },
                  { wartosc: 'nie', etykieta: 'nie' },
                ]}
              />
            )
          return <PoleTekstowe key={p.key} id={id} name={id} etykieta={etykietaPola(p.opis)} defaultValue={p.wartosc} inputMode={p.typ === 'number' ? 'decimal' : undefined} opcjonalne={!p.wymagane} />
        }
        return (
          <Karta
            key={`${k.id}|${odciskKonta(k)}`}
            className="konto-przew"
            tytul={k.nazwa}
            opis={
              k.reguly.length
                ? `Używane w regułach: ${k.reguly.map((r) => `nr ${nrReguly(r.priority, priorytety)} (${przewoznicy[r.carrier] ?? r.carrier})`).join(', ')}`
                : 'Żadna reguła jeszcze go nie używa. Klucze i ustawienia konta zapiszesz już teraz; nadawać zacznie, gdy wybierzesz ten moduł wysyłki w regule na ekranie Przewoźnicy.'
            }
            akcje={
              // Wysyłam z Allegro: bez kluczy i bez testu połączenia (konto Allegro z Kanałów sprzedaży)
              k.bezKluczy ? undefined : (
                <>
                  <Odznaka ton={komplet ? (zSerwera ? 'info' : 'sukces') : 'neutralny'} title={zSerwera ? 'Klucze ustawił administrator w konfiguracji serwera; klucz wpisany tutaj ma pierwszeństwo.' : undefined}>
                    {komplet ? (zSerwera ? 'klucze z konfiguracji serwera' : 'klucze ustawione') : 'brak kluczy'}
                  </Odznaka>
                  <Przycisk type="submit" form={`test-${k.id}`} rozmiar="sm" powodWylaczenia={komplet ? undefined : 'Najpierw wpisz i zapisz klucze'}>
                    Sprawdź połączenie
                  </Przycisk>
                </>
              )
            }
          >
            {k.test && (
              <p className="small">
                Ostatni test {kiedy(k.test.at)}:{' '}
                <Odznaka ton={k.test.ok ? 'sukces' : 'blad'} rozmiar="sm">
                  {k.test.ok ? 'działa' : 'błąd'}
                </Odznaka>{' '}
                {k.test.message}
              </p>
            )}
            {k.bezKluczy && <p className="small">Korzysta z konta Allegro w Kanałach sprzedaży, więc nie ma tu osobnych kluczy.</p>}
            <div className="konto-pola">
              {k.sekrety.map((s) => (
                <PoleHasla
                  key={s.name}
                  id={`k-${k.id}-s-${s.name}`}
                  name={`k-${k.id}-s-${s.name}`}
                  etykieta={s.nazwa}
                  autoComplete="off"
                  placeholder={s.zrodlo === 'panel' ? 'ustawiony (wpisz, aby zmienić)' : s.zrodlo === 'serwer' ? 'z konfiguracji serwera (wpisz, aby zapisać tutaj)' : 'brak'}
                  opcjonalne={!s.wymagany}
                />
              ))}
              {wymagane.map(pole)}
            </div>
            {k.reguly.some((r) => r.nadawanie !== null) && (
              <div className="konto-pola">
                {k.reguly
                  .filter((r) => r.nadawanie !== null)
                  .map((r) => (
                    <div key={r.id}>
                      <input type="hidden" name={`n-${r.id}-jest`} value="tak" />
                      <Przelacznik
                        id={`n-${r.id}`}
                        name={`n-${r.id}`}
                        value="tak"
                        defaultChecked={r.nadawanie === true}
                        etykieta={`Nadawanie z Kompletora: ${przewoznicy[r.carrier] ?? r.carrier}`}
                        pomoc="Włączone: „Nadaj” tworzy przesyłkę u przewoźnika (płatną). Wyłączone: przycisk widać, ale nic nie wysyła."
                      />
                    </div>
                  ))}
              </div>
            )}
            {reszta.length > 0 && (
              <Zaawansowane>
                <div className="konto-pola">{reszta.map(pole)}</div>
              </Zaawansowane>
            )}
          </Karta>
        )
      })}
      <PasekZapisu oczekuje={trwa} />
    </form>
  )
}

/**
 * „Dodaj konto”: drugie konto tego samego przewoźnika, np. osobne DPD dla salonów Empik. Po dodaniu karta
 * konta pojawia się wyżej (klucze wpisuje się tam), a reguła wybiera konto pod „Moduł wysyłki” na ekranie Przewoźnicy.
 */
export function DodajKonto({ glowne }: { glowne: { wartosc: string; etykieta: string }[] }) {
  const [stan, akcja, trwa] = useActionState<StanKont, FormData>(dodajKonto, {})
  return (
    <Karta tytul="Drugie konto przewoźnika" opis="Np. osobne konto DPD dla salonów Empik albo drugie konto InPost dla innej marki. Klucze nowego konta wpiszesz w jego karcie.">
      <ToastPoAkcji stan={stan} bledy={false} />
      <form action={akcja} key={stan.ok ? stan.komunikat : 'nowe'} className="konto-pola konto-dodaj" aria-label="Dodaj konto przewoźnika">
        <Wybor id="nowe-konto-przew" name="konto" etykieta="Przewoźnik" opcje={glowne} />
        <PoleTekstowe id="nowe-konto-nazwa" name="nazwa" etykieta="Nazwa konta" maxLength={40} required placeholder="Salony Empik" autoComplete="off" blad={stan.ok === false ? stan.komunikat : undefined} />
        <div>
          <Przycisk type="submit" ladowanie={trwa}>
            Dodaj konto
          </Przycisk>
        </div>
      </form>
    </Karta>
  )
}
