// Przyciski „Co dalej” na karcie zamówienia (tryb PRACA): przejścia statusu z listy `dostepnePrzejscia`
// (`stanCoDalej`, lib/praca/dane.ts). Karta osadza je w nagłówku (główne) i w menu „Więcej” (reszta) przez
// `<PrzyciskiCoDalej>`. Widoczne tylko dla konta kanału w PRACA na instancji z EKRANY_PRACA=1.
// na komponentach app/ui. Niedostępny przycisk jest widoczny i nieaktywny, z powodem pod spodem; anulowanie
// i „Wyślij bez faktury” pytają oknem potwierdzenia (`PrzyciskPotwierdz`), bez JavaScriptu formularz wysyła się od razu
// (rdzeń i tak sprawdza przejście). Stara sekcja „Co dalej” z osobną kartą zniknęła: nie była już nigdzie
// osadzona, przyciski są w nagłówku karty.
// konto poza trybem PRACA dostaje te same przyciski nieaktywne (`wspolnyPowod`): jeden powód pod całą grupą
// zamiast tego samego zdania pod każdym przyciskiem.
import { POZYCJA_MENU, Przycisk, PrzyciskPotwierdz, PoleTekstowe, Wybor } from '@/app/ui'
import type { StanCoDalej } from '@/lib/praca/dane'
import type { Przycisk as PrzyciskPracy } from '@/lib/praca/przejscia-ekran'
import { przejdz } from './akcje-praca'

function Ukryte({ orderId, akcja }: { orderId: string; akcja: string }) {
  return (
    <>
      <input type="hidden" name="zamowienie" value={orderId} />
      <input type="hidden" name="akcja" value={akcja} />
    </>
  )
}

function Akcja({ orderId, p, przewoznicy, wMenu, idWspolnegoPowodu }: { orderId: string; p: PrzyciskPracy; przewoznicy: { carrier: string; nazwa: string }[]; wMenu: boolean; idWspolnegoPowodu?: string }) {
  const wariant = p.akcja === 'anuluj' ? 'niebezpieczny' : p.glowny && !wMenu ? 'glowny' : wMenu ? 'cichy' : 'drugorzedny'
  const klasa = wMenu ? POZYCJA_MENU : undefined
  const powod = p.powod ?? (p.wyborPrzewoznika && !przewoznicy.length ? 'Firma nie ma reguł przewoźników: dodaj je w Ustawienia → Wysyłka i druk → Przewoźnicy.' : null)
  if (powod && idWspolnegoPowodu) {
    return (
      <Przycisk wariant={wariant} className={klasa} powodWylaczenia={powod} aria-describedby={idWspolnegoPowodu}>
        {p.etykieta}
      </Przycisk>
    )
  }
  if (powod) {
    return (
      <div className="ui-akcja">
        <Przycisk wariant={wariant} className={klasa} powodWylaczenia={powod} aria-describedby={`cd-${p.akcja}`}>
          {p.etykieta}
        </Przycisk>
        <p id={`cd-${p.akcja}`} className="ui-akcja-powod">
          {powod}
        </p>
      </div>
    )
  }
  if (p.potwierdz) {
    return (
      <form action={przejdz} className="ui-akcja">
        <Ukryte orderId={orderId} akcja={p.akcja} />
        <PrzyciskPotwierdz
          wariant={wariant}
          className={klasa}
          data-zostaw-menu=""
          tytul={`${p.etykieta}?`}
          pytanie={p.potwierdz}
          tak={`Tak, ${p.etykieta.toLowerCase()}`}
          wariantTak={p.akcja === 'anuluj' ? 'niebezpieczny' : 'glowny'}
        >
          {p.etykieta}
        </PrzyciskPotwierdz>
      </form>
    )
  }
  return (
    <form action={przejdz} className="ui-akcja">
      <Ukryte orderId={orderId} akcja={p.akcja} />
      {p.numerNadania && <PoleTekstowe id={`cd-nadanie-${orderId}`} etykieta="Numer nadania" opcjonalne name="nadanie" maxLength={40} autoComplete="off" spellCheck={false} pattern="[A-Za-z0-9\- ]*" />}
      {p.wyborPrzewoznika && (
        <Wybor
          id={`cd-przewoznik-${orderId}`}
          etykieta="W zamówieniu jest teraz towar do wysłania: wybierz przewoźnika"
          name="przewoznik"
          required
          defaultValue=""
          opcje={[{ wartosc: '', etykieta: 'wybierz…', wylaczona: true }, ...przewoznicy.map((x) => ({ wartosc: x.carrier, etykieta: x.nazwa }))]}
        />
      )}
      <Przycisk type="submit" wariant={wariant} className={klasa}>
        {p.etykieta}
      </Przycisk>
    </form>
  )
}

/**
 * Przyciski „Co dalej” wg filtra: `glowne` = najwyżej 3 główne (nagłówek karty), `pozostale` = reszta (menu „Więcej”).
 * `wspolnyPowod` (konto poza trybem PRACA): wszystkie nieaktywne, powód raz pod grupą.
 */
export function PrzyciskiCoDalej({ orderId, stan, filtr, wspolnyPowod }: { orderId: string; stan: StanCoDalej; filtr: 'glowne' | 'pozostale'; wspolnyPowod?: string }) {
  const glowne = stan.przyciski.filter((p) => p.glowny).slice(0, 3)
  const lista = filtr === 'glowne' ? glowne : stan.przyciski.filter((p) => !glowne.includes(p))
  if (!lista.length) return null
  if (wspolnyPowod) {
    const id = `cd-podglad-${filtr}`
    // w podglądzie powody są jednakowe (tryb konta albo brak uprawnienia do przejść): ten z przycisków ma pierwszeństwo
    const tekst = lista[0]!.powod && lista.every((p) => p.powod === lista[0]!.powod) ? lista[0]!.powod : wspolnyPowod
    return (
      <div className="ui-akcja">
        <div className="ui-akcje-lista">
          {lista.map((p) => (
            <Akcja key={p.akcja} orderId={orderId} p={{ ...p, powod: p.powod ?? wspolnyPowod }} przewoznicy={stan.przewoznicy} wMenu={filtr === 'pozostale'} idWspolnegoPowodu={id} />
          ))}
        </div>
        <p id={id} className="ui-akcja-powod">
          {tekst}
        </p>
      </div>
    )
  }
  return (
    <div className="ui-akcje-lista">
      {lista.map((p) => (
        <Akcja key={p.akcja} orderId={orderId} p={p} przewoznicy={stan.przewoznicy} wMenu={filtr === 'pozostale'} />
      ))}
    </div>
  )
}
