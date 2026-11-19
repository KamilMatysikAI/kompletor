'use client'
// Szczegóły osoby w oknie: rola i uprawnienia w grupach, przełącznik dostępu. Wynik jako toast, błąd zapisu
// pod polem roli (okno zostaje otwarte). Wyłączenie dostępu najpierw pyta. Sprawdzenia uprawnień: serwer
// (lib/panel/uzytkownicy.ts); ekran tylko nie pokazuje przycisków, których i tak nie wolno użyć.
import { useActionState, useEffect, useState } from 'react'
import type { MemberRole } from '@prisma/client'
import { Modal, Przycisk, PrzyciskPotwierdz, ToastPoAkcji } from '@/app/ui'
import { permissionsOf, type Permission } from '@/lib/auth/uprawnienia'
import { cofnijZaproszenie, przelaczDostep, zapiszOsobe, type StanOsoby } from './akcje'
import { RolaIUprawnienia } from './rola'

export function SzczegolyOsoby({
  osoba,
  allowed,
  ownerActor,
  tylkoWlasciciel,
  przelacznik,
}: {
  osoba: { userId: string; name: string; email: string; role: MemberRole; extra: Permission[]; denied: Permission[]; active: boolean; self: boolean }
  allowed: Permission[]
  ownerActor: boolean
  /** osobę może zmienić tylko właściciel (zmieniający nim nie jest) */
  tylkoWlasciciel: boolean
  /** można włączyć albo wyłączyć dostęp */
  przelacznik: boolean
}) {
  const [otwarte, setOtwarte] = useState(false)
  const [stan, akcja, trwa] = useActionState<StanOsoby, FormData>(zapiszOsobe, {})
  const [stanD, akcjaD, trwaD] = useActionState<StanOsoby, FormData>(przelaczDostep, {})
  // po udanym zapisie okno się zamyka (wynik w toaście); przy błędzie zostaje z komunikatem pod rolą.
  // osobny efekt na każdą akcję, bo stary sukces drugiej akcji nie może zamknąć okna przy nowym błędzie
  useEffect(() => {
    if (stan.ok) setOtwarte(false)
  }, [stan])
  useEffect(() => {
    if (stanD.ok) setOtwarte(false)
  }, [stanD])
  const formId = `osoba-${osoba.userId}`
  return (
    <>
      <ToastPoAkcji stan={stan} bledy={false} />
      <ToastPoAkcji stan={stanD} />
      <Przycisk rozmiar="sm" onClick={() => setOtwarte(true)} aria-label={`Szczegóły: ${osoba.name}`}>
        Szczegóły
      </Przycisk>
      <Modal
        otwarty={otwarte}
        onZamknij={() => setOtwarte(false)}
        szeroki
        tytul={osoba.name}
        stopka={
          tylkoWlasciciel ? (
            <Przycisk onClick={() => setOtwarte(false)}>Zamknij</Przycisk>
          ) : (
            <>
              <Przycisk onClick={() => setOtwarte(false)}>Anuluj</Przycisk>
              <Przycisk type="submit" form={formId} wariant="glowny" ladowanie={trwa}>
                Zapisz
              </Przycisk>
            </>
          )
        }
      >
        <p className="small muted zawijaj">{osoba.email}</p>
        {/* key: po zapisie okno otwiera się z wartościami z bazy, nie z poprzednich kliknięć */}
        <form id={formId} key={`${osoba.role}-${osoba.extra.join()}-${osoba.denied.join()}`} action={akcja} aria-label={`Rola i uprawnienia: ${osoba.name}`}>
          <input type="hidden" name="osoba" value={osoba.userId} />
          <RolaIUprawnienia
            id={formId}
            role={osoba.role}
            effective={[...permissionsOf({ role: osoba.role, permissions: osoba.extra, deniedPermissions: osoba.denied })]}
            allowed={allowed}
            ownerActor={ownerActor}
            locked={tylkoWlasciciel}
          />
          {stan.ok === false && (
            <p className="ui-blad" role="alert">
              {stan.komunikat}
            </p>
          )}
          {tylkoWlasciciel && <p className="small muted">Tę osobę może zmienić tylko właściciel.</p>}
        </form>
        {przelacznik && (
          <form action={akcjaD} className="osoba-dostep">
            <input type="hidden" name="osoba" value={osoba.userId} />
            <input type="hidden" name="dostep" value={osoba.active ? 'wylacz' : 'wlacz'} />
            <h3 className="osoba-grupa-tytul">Dostęp do firmy</h3>
            {osoba.active ? (
              <PrzyciskPotwierdz
                wariant="niebezpieczny"
                rozmiar="sm"
                ladowanie={trwaD}
                tytul={`Wyłączyć dostęp: ${osoba.name}?`}
                pytanie="Osoba zostanie wylogowana z tej firmy. Konto i historia zostają; dostęp włączysz ponownie tym samym przyciskiem."
                tak="Wyłącz dostęp"
              >
                Wyłącz dostęp do firmy
              </PrzyciskPotwierdz>
            ) : (
              <Przycisk type="submit" rozmiar="sm" ladowanie={trwaD}>
                Włącz dostęp ponownie
              </Przycisk>
            )}
          </form>
        )}
      </Modal>
    </>
  )
}

/** „Cofnij” zaproszenie (hosting): wynik jako toast. */
export function CofnijZaproszenie({ id, email }: { id: string; email: string }) {
  const [stan, akcja, trwa] = useActionState<StanOsoby, FormData>(cofnijZaproszenie, {})
  return (
    <form action={akcja}>
      <ToastPoAkcji stan={stan} />
      <input type="hidden" name="zaproszenie" value={id} />
      <PrzyciskPotwierdz
        wariant="niebezpieczny"
        rozmiar="sm"
        ladowanie={trwa}
        tytul={`Cofnąć zaproszenie dla ${email}?`}
        pytanie="Link z zaproszenia przestanie działać."
        tak="Cofnij zaproszenie"
      >
        Cofnij
      </PrzyciskPotwierdz>
    </form>
  )
}
