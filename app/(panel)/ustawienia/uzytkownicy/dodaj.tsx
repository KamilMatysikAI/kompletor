'use client'
// Dodanie osoby. Hasło startowe nowego konta jest pokazane tylko raz — po odświeżeniu strony znika.
// w hostingu zaproszenie zamiast konta (bez imienia — osoba poda je sama); link też tylko raz.
// przycisk „Dodaj osobę” nad tabelą otwiera okno z najwyżej trzema polami (imię i nazwisko, e-mail, rola).
// Pod rolą rozwijana lista „Dokładne uprawnienia”: wstępnie zestaw roli, każde pole da się zaznaczyć albo odznaczyć;
// zaproszenie (albo nowe konto) niesie ten zestaw. Wynik (hasło, link) zostaje w oknie do zamknięcia.
import { useActionState, useEffect, useState } from 'react'
import type { MemberRole } from '@prisma/client'
import { Modal, PoleTekstowe, Przycisk, useToast } from '@/app/ui'
import { uprawnieniaRoli, type Permission } from '@/lib/auth/uprawnienia'
import { dodajOsobe, type DodajState } from './akcje'
import { RolaIUprawnienia, zestawStartowy } from './rola'

const START: DodajState = { error: null, created: null, invited: null, info: null, round: 0 }

/** Domyślna rola nowej osoby: magazyn, a gdy tej roli nie wolno nadać — pierwsza, którą wolno (serwer sprawdza to i tak). */
function startRole(allowed: Permission[]): MemberRole {
  const roles: MemberRole[] = ['MAGAZYN', 'BIURO']
  return roles.find((r) => [...uprawnieniaRoli(r)].every((p) => allowed.includes(p))) ?? 'MAGAZYN'
}

export function DodajOsobe({ allowed, ownerActor, hosted = false }: { allowed: Permission[]; ownerActor: boolean; hosted?: boolean }) {
  const [state, action, pending] = useActionState(dodajOsobe, START)
  const [otwarte, setOtwarte] = useState(false)
  // wynik zostaje w oknie do zamknięcia; nowe otwarcie po udanym dodaniu = pusty formularz
  const [pokazanaRunda, setPokazanaRunda] = useState(0)
  const toast = useToast()
  // konto już istniało (dodany sam dostęp): nic do pokazania raz, więc toast i zamknięcie okna
  useEffect(() => {
    if (state.round > pokazanaRunda && state.info) {
      toast.sukces(state.info)
      setPokazanaRunda(state.round)
      setOtwarte(false)
    }
  }, [state, pokazanaRunda, toast])
  const wynik = state.round > pokazanaRunda && (state.created || state.invited)
  const zamknij = () => {
    setOtwarte(false)
    setPokazanaRunda(state.round)
  }
  const tytul = hosted ? 'Zaproś osobę' : 'Dodaj osobę'
  return (
    <>
      <Przycisk wariant="glowny" onClick={() => setOtwarte(true)}>
        {tytul}
      </Przycisk>
      <Modal
        otwarty={otwarte}
        onZamknij={zamknij}
        szeroki
        tytul={tytul}
        stopka={
          wynik ? (
            <Przycisk wariant="glowny" onClick={zamknij} data-fokus="">
              Gotowe
            </Przycisk>
          ) : (
            <>
              <Przycisk onClick={zamknij}>Anuluj</Przycisk>
              <Przycisk type="submit" form="nowa-osoba" wariant="glowny" ladowanie={pending}>
                {hosted ? 'Utwórz zaproszenie' : 'Dodaj osobę'}
              </Przycisk>
            </>
          )
        }
      >
        {wynik ? (
          <Wynik state={state} />
        ) : (
          // po udanym dodaniu formularz startuje od nowa (key)
          <form id="nowa-osoba" key={state.round} action={action} aria-label={tytul} className="stack">
            <p className="small muted">
              {hosted ? 'Osoba dostaje link i sama przyjmuje zaproszenie.' : 'Nowe konto dostaje hasło startowe pokazane jeden raz.'} Rola zaznacza zestaw
              uprawnień; w „Dokładne uprawnienia” możesz zaznaczyć albo odznaczyć każde z nich.
            </p>
            {!hosted && <PoleTekstowe id="n-imie" name="imie" etykieta="Imię i nazwisko" maxLength={120} required autoComplete="off" data-fokus="" />}
            <PoleTekstowe
              id="n-email"
              name="email"
              type="email"
              etykieta="E-mail (login)"
              maxLength={254}
              required
              autoComplete="off"
              blad={state.error ?? undefined}
              {...(hosted ? { 'data-fokus': '' } : {})}
            />
            <RolaIUprawnienia id="n" role={startRole(allowed)} effective={[...zestawStartowy(startRole(allowed), new Set(), allowed)]} allowed={allowed} ownerActor={ownerActor} zwijane />
          </form>
        )}
      </Modal>
    </>
  )
}

function Wynik({ state }: { state: DodajState }) {
  if (state.created)
    return (
      <div className="banner leaf-soft" role="status">
        <div className="osoba-wynik">
          Konto <b className="zawijaj">{state.created.email}</b> założone. Hasło startowe: <b className="mono osoba-haslo">{state.created.password}</b>
          <p className="small">Pokazujemy je tylko teraz. Przekaż je osobiście albo innym kanałem niż e-mail z loginem; po zalogowaniu osoba zmienia je w Ustawieniach → Zespół i dostęp → Zmiana hasła.</p>
        </div>
      </div>
    )
  if (state.invited)
    return (
      <div className="banner leaf-soft" role="status">
        <div className="osoba-wynik">
          Zaproszenie dla <b className="zawijaj">{state.invited.email}</b> gotowe, ważne 7 dni.
          {state.invited.link ? (
            <>
              {' '}
              Link do przekazania:
              <div className="mono osoba-link">{state.invited.link}</div>
              <p className="small">
                Pokazujemy go tylko teraz. Wyślij go tej osobie (np. e-mailem). Dostęp powstanie dopiero, gdy go przyjmie; do tego czasu zaproszenie widać pod tabelą i można je
                cofnąć.
              </p>
            </>
          ) : (
            ' Link wysłaliśmy na ten adres.'
          )}
        </div>
      </div>
    )
  return null
}
