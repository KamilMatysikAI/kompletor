'use client'
// Koszyki: formularze ekranu. Walidacja po stronie serwera (lib/koszyki), wynik przez toast.
import { useActionState } from 'react'
import { Przycisk, PrzyciskPotwierdz, PoleLiczbowe, PoleTekstowe, Przelacznik, ToastPoAkcji } from '@/app/ui'
import { dodaj, przypiszKoszyki, ustawWymagany, usun, zwolnij, type StanKoszykow } from './akcje'

const START: StanKoszykow = { komunikat: null }

export function DodajKoszyki({ pierwsze, powod }: { pierwsze: boolean; powod: string | null }) {
  const [s, action, pending] = useActionState(dodaj, START)
  return (
    <form action={action} className="koszyki-dodaj" aria-label="Dodaj koszyki">
      <ToastPoAkcji stan={s} />
      <PoleLiczbowe id="k-ile" name="ile" etykieta="Ile koszyków dodać" defaultValue={pierwsze ? 10 : 1} min={1} max={50} pomoc="Kolejne litery: A, B, C…" />
      <PoleTekstowe id="k-nazwy" name="nazwy" etykieta="Albo własne nazwy" opcjonalne placeholder="np. W1 W2 W3" autoComplete="off" pomoc="Litery i cyfry bez spacji, do 8 znaków; kolejne nazwy oddziel spacją (W1 W2)" />
      <Przycisk type="submit" wariant={pierwsze ? 'glowny' : 'drugorzedny'} ladowanie={pending} powodWylaczenia={powod}>
        Dodaj koszyki
      </Przycisk>
    </form>
  )
}

export function Wymagany({ wlaczony, powod }: { wlaczony: boolean; powod: string | null }) {
  const [s, action, pending] = useActionState(ustawWymagany, START)
  return (
    <form action={action} aria-label="Skan koszyka na stanowisku">
      <ToastPoAkcji stan={s} />
      <input type="hidden" name="wymagany" value={wlaczony ? 'nie' : 'tak'} />
      <Przelacznik
        id="k-wymagany"
        etykieta="Wymagaj skanu koszyka przed „Spakowano”"
        pomoc={powod ?? 'Pakujący musi zeskanować koszyk, w którym leży zamówienie. Bez koszyków to ustawienie nic nie zmienia.'}
        checked={wlaczony}
        disabled={pending || !!powod}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      />
    </form>
  )
}

export function Zwolnij({ id, nazwa, numer }: { id: string; nazwa: string; numer: string }) {
  const [s, action, pending] = useActionState(zwolnij, START)
  return (
    <form action={action} className="inline">
      <ToastPoAkcji stan={s} />
      <input type="hidden" name="id" value={id} />
      <PrzyciskPotwierdz rozmiar="sm" disabled={pending} tytul={`Zwolnić koszyk ${nazwa}?`} pytanie={`Zamówienie ${numer} przestanie być przypisane do tego koszyka (samo zamówienie się nie zmienia).`} tak="Zwolnij koszyk">
        Zwolnij
      </PrzyciskPotwierdz>
    </form>
  )
}

export function Usun({ id, nazwa, powod }: { id: string; nazwa: string; powod: string | null }) {
  const [s, action, pending] = useActionState(usun, START)
  return (
    <form action={action} className="inline">
      <ToastPoAkcji stan={s} />
      <input type="hidden" name="id" value={id} />
      {powod ? (
        <Przycisk rozmiar="sm" wariant="cichy" powodWylaczenia={powod}>
          Usuń
        </Przycisk>
      ) : (
        <PrzyciskPotwierdz rozmiar="sm" wariant="niebezpieczny" disabled={pending} tytul={`Usunąć koszyk ${nazwa}?`} pytanie="Kod tego koszyka przestanie działać na stanowisku." tak="Usuń koszyk">
          Usuń
        </PrzyciskPotwierdz>
      )}
    </form>
  )
}

export function PrzypiszKoszyki({ ids, ileBez, wolnych }: { ids: string[]; ileBez: number; wolnych: number }) {
  const [s, action, pending] = useActionState(przypiszKoszyki, START)
  const powod = ileBez === 0 ? 'Każde zamówienie z listy ma już koszyk' : wolnych === 0 ? 'Brak wolnych koszyków (Pakowanie → Koszyki)' : null
  return (
    <form action={action} className="inline">
      <ToastPoAkcji stan={s} />
      <input type="hidden" name="z" value={ids.join(',')} />
      <Przycisk type="submit" wariant="glowny" ladowanie={pending} powodWylaczenia={powod}>
        Przypisz wolne koszyki ({Math.min(ileBez, wolnych)})
      </Przycisk>
    </form>
  )
}
