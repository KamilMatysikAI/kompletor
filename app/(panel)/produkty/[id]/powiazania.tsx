'use client'
// Karta produktu → Powiązania: przyciski z pytaniem i wynikiem w toaście. Dane i skutki liczy ekran
// serwerowy (page.tsx + lib/produkty/powiazania.ts), tu tylko formularze akcji.
import { useActionState } from 'react'
import { PoleTekstowe, Przycisk, PrzyciskPotwierdz, ToastPoAkcji, useToast } from '@/app/ui'
import { odlaczAkcja, powiazAkcja, przepnijAkcja, wskazTowarAkcja, type StanPowiazan } from './powiazania-akcje'

const START: StanPowiazan = { ok: false, komunikat: null }

/**
 * „Powiąż” przy ofercie z wyszukiwarki (karta produktu) i przy kandydacie w „Do decyzji” (ekran konta):
 * przelicznik i jeden klik. Toast wołany od razu po wyniku akcji, nie z efektu: w „Do decyzji” wiersz z tym
 * formularzem znika razem z odświeżeniem ekranu, więc efekt odmontowanego formularza by się nie wykonał.
 */
export function PowiazZOferta({ produkt, konto, oferta, przelicznik, etykieta, powodWylaczenia, przycisk = 'Powiąż' }: { produkt: string; konto: string; oferta: string; przelicznik: number; etykieta: string; powodWylaczenia?: string; przycisk?: string }) {
  const toast = useToast()
  const [, akcja, pending] = useActionState(async (prev: StanPowiazan, form: FormData) => {
    const s = await powiazAkcja(prev, form)
    if (s.ok) toast.sukces(s.komunikat ?? 'Powiązano.')
    else toast.blad(s.komunikat ?? 'Nie udało się zapisać.')
    return s
  }, START)
  const id = `pw-${konto}-${oferta}-${produkt}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  return (
    <form action={akcja} className="ui-wiersz-formularza" aria-label={`Powiąż ofertę ${etykieta}`}>
      <input type="hidden" name="produkt" value={produkt} />
      <input type="hidden" name="konto" value={konto} />
      <input type="hidden" name="oferta" value={oferta} />
      <PoleTekstowe id={id} etykieta="Szt. na 1 szt. oferty" name="sztuk" inputMode="numeric" pattern="[0-9]{1,6}" defaultValue={String(przelicznik)} required className="pw-przelicznik" />
      <Przycisk type="submit" rozmiar="sm" wariant="glowny" ladowanie={pending} powodWylaczenia={powodWylaczenia}>
        {przycisk}
      </Przycisk>
    </form>
  )
}

/** „Odłącz” z pytaniem, które mówi, co się stanie z zamówieniami i ze stanem w sklepie. */
export function OdlaczOferte({ produkt, powiazanie, pytanie }: { produkt: string; powiazanie: string; pytanie: string[] }) {
  const [stan, akcja, pending] = useActionState(odlaczAkcja, START)
  return (
    <form action={akcja}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="produkt" value={produkt} />
      <input type="hidden" name="powiazanie" value={powiazanie} />
      <PrzyciskPotwierdz
        rozmiar="sm"
        wariant="niebezpieczny"
        ladowanie={pending}
        tytul="Odłączyć ofertę od produktu?"
        tak="Odłącz"
        pytanie={
          <>
            {pytanie.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </>
        }
      >
        Odłącz
      </PrzyciskPotwierdz>
    </form>
  )
}

/**
 * „Przepnij na ten” przy produkcie z wyszukiwarki „Przepnij na inny produkt” (wzorzec „Powiąż z ofertą”): produkt
 * docelowy wybrany z listy (id w polu ukrytym), przelicznik obok, pytanie z nazwą i SKU celu i liczbą zamówień.
 */
export function PrzepnijOferte({ produkt, powiazanie, cel, przelicznik, pytanie, etykieta }: { produkt: string; powiazanie: string; cel: string; przelicznik: number; pytanie: string[]; etykieta: string }) {
  const [stan, akcja, pending] = useActionState(przepnijAkcja, START)
  const id = `pp-${powiazanie}-${cel}`
  return (
    <form action={akcja} className="ui-wiersz-formularza" aria-label={`Przepnij ofertę na ${etykieta}`}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="produkt" value={produkt} />
      <input type="hidden" name="powiazanie" value={powiazanie} />
      <input type="hidden" name="cel" value={cel} />
      {/* pole przed przyciskiem; przycisk z pytaniem jest jedynym submitem, więc Enter w polu też pyta */}
      <PoleTekstowe id={`${id}-szt`} etykieta="Szt. na 1 szt. oferty" name="sztuk" inputMode="numeric" pattern="[0-9]{1,6}" defaultValue={String(przelicznik)} required className="pw-przelicznik" />
      <PrzyciskPotwierdz
        rozmiar="sm"
        wariant="glowny"
        ladowanie={pending}
        tytul="Przepiąć ofertę na ten produkt?"
        tak="Przepnij"
        pytanie={
          <>
            {pytanie.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </>
        }
      >
        Przepnij na ten
      </PrzyciskPotwierdz>
    </form>
  )
}

/** „Powiąż z tym towarem” przy towarze wFirmy z wyszukiwarki. */
export function WskazTowar({ produkt, towar, pytanie, powodWylaczenia }: { produkt: string; towar: string; pytanie: string[]; powodWylaczenia?: string }) {
  const [stan, akcja, pending] = useActionState(wskazTowarAkcja, START)
  return (
    <form action={akcja}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="produkt" value={produkt} />
      <input type="hidden" name="towar" value={towar} />
      <PrzyciskPotwierdz
        rozmiar="sm"
        wariant="drugorzedny"
        ladowanie={pending}
        powodWylaczenia={powodWylaczenia}
        tytul="Powiązać produkt z tym towarem wFirmy?"
        tak="Powiąż z towarem"
        pytanie={
          <>
            {pytanie.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </>
        }
      >
        Powiąż z towarem
      </PrzyciskPotwierdz>
    </form>
  )
}
