// Ustawienia → Użytkownicy: osoby tej firmy, rola, dodatkowe uprawnienia, stan dostępu; dodanie osoby.
// Tylko z uprawnieniem `uzytkownicy` (inni dostają 404). Zmiany działają od następnego żądania danej osoby.
// w hostingu „Dodaj osobę” = zaproszenie, a pod listą sekcja „Zaproszenia” (otwarte, „Cofnij”). Lista
// pokazuje aktywność w tej firmie, nie globalne logowanie konta.
// osoby w tabeli (`Tabela`), rola i uprawnienia w oknie „Szczegóły”, „Dodaj osobę” nad tabelą (≤ 3 pola),
// wyniki jako toasty.
import { notFound } from 'next/navigation'
import { Karta, NaglowekStrony, Odznaka, Tabela, type KolumnaTabeli, type WierszTabeli } from '@/app/ui'
import { ROLE_LABEL, type Permission } from '@/lib/auth/uprawnienia'
import { requirePermission } from '@/lib/panel/kontekst'
import { isHosted, listInvitations, listMembers, switchRefusal } from '@/lib/panel/uzytkownicy'
import { DodajOsobe } from './dodaj'
import { CofnijZaproszenie, SzczegolyOsoby } from './osoba'

export const metadata = { title: 'Użytkownicy' }

/** „+2 dołożone, −1 odebrane” względem zestawu roli (tabela osób i lista zaproszeń). */
function RoznicaRoli({ extra, denied }: { extra: number; denied: number }) {
  return <span className="small">{[extra ? `+${extra} dołożone` : '', denied ? `−${denied} odebrane` : ''].filter(Boolean).join(', ')}</span>
}

const DT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' })

const KOLUMNY: KolumnaTabeli[] = [
  { klucz: 'osoba', etykieta: 'Osoba' },
  { klucz: 'rola', etykieta: 'Rola' },
  { klucz: 'dodatkowe', etykieta: 'Inaczej niż w roli' },
  { klucz: 'aktywnosc', etykieta: 'Ostatnio aktywny' },
  { klucz: 'dostep', etykieta: 'Dostęp' },
  { klucz: 'akcje', etykieta: 'Szczegóły' },
]

export default async function Uzytkownicy() {
  const ctx = await requirePermission('uzytkownicy')
  const actor = { userId: ctx.user.id, organizationId: ctx.organization.organizationId }
  const hosted = isHosted()
  const [list, invitations] = await Promise.all([listMembers(actor), hosted ? listInvitations(actor) : Promise.resolve(null)])
  // uprawnienie odebrane w chwili między sesją a odczytem — 404 jak bez uprawnienia, nie błąd 500
  if (!list) notFound()
  const allowed = [...ctx.permissions] as Permission[]
  const ownerActor = ctx.organization.role === 'WLASCICIEL'
  const me = { role: ctx.organization.role, perms: ctx.permissions }
  const wiersze: WierszTabeli[] = list.map((m) => {
    // właściciela zmienia tylko właściciel (po roli, nie po zbiorze uprawnień); ponowne sprawdzenie pod blokadą:
    // lib/panel/uzytkownicy.ts
    const wider = m.role === 'WLASCICIEL' && !ownerActor
    const switchable = !m.self && switchRefusal({ role: m.role, permissions: m.extra, deniedPermissions: m.denied }, me, !m.active) === null
    return {
      id: m.userId,
      etykieta: m.name,
      ...(m.active ? {} : { ton: 'uwaga' as const }),
      komorki: {
        osoba: (
          <span className="osoba-kto">
            <b>{m.name}</b>
            {m.self && (
              <Odznaka rozmiar="sm" ton="info">
                to Ty
              </Odznaka>
            )}
            <span className="small muted zawijaj">{m.email}</span>
          </span>
        ),
        rola: <Odznaka ton={m.role === 'WLASCICIEL' ? 'akcent' : 'neutralny'}>{ROLE_LABEL[m.role]}</Odznaka>,
        dodatkowe: m.extra.length || m.denied.length ? <RoznicaRoli extra={m.extra.length} denied={m.denied.length} /> : <span className="muted">jak w roli</span>,
        aktywnosc: <span className="small">{m.lastSeenAt ? DT.format(m.lastSeenAt) : 'jeszcze nie był aktywny'}</span>,
        dostep: m.accountBlocked ? (
          <Odznaka ton="blad">konto zablokowane</Odznaka>
        ) : m.active ? (
          <Odznaka ton="sukces">aktywny</Odznaka>
        ) : (
          <Odznaka ton="ostrzezenie">wyłączony</Odznaka>
        ),
        akcje: <SzczegolyOsoby osoba={m} allowed={allowed} ownerActor={ownerActor} tylkoWlasciciel={wider} przelacznik={switchable} />,
      },
    }
  })
  return (
    <>
      <NaglowekStrony
        tytul="Użytkownicy i uprawnienia"
        podtytul={`Osoby z dostępem do firmy ${ctx.organization.name}. Rola daje zestaw uprawnień; w „Szczegóły” każde uprawnienie osoby można zaznaczyć albo odznaczyć. Wyłączenie dostępu nie kasuje konta ani historii.`}
        akcje={<DodajOsobe allowed={allowed} ownerActor={ownerActor} hosted={hosted} />}
      />

      <div className="stack">
        <Tabela id="uzytkownicy" etykieta="Osoby z dostępem do firmy" kolumny={KOLUMNY} wiersze={wiersze} />

        {hosted && invitations && (
          <Karta tytul="Zaproszenia" opis="Czekają na przyjęcie; link ważny 7 dni">
            {invitations.length === 0 ? (
              <p className="small muted">Brak otwartych zaproszeń.</p>
            ) : (
              <ul className="osoba-zaproszenia">
                {invitations.map((z) => (
                  <li key={z.id}>
                    <div>
                      <b className="zawijaj">{z.email}</b> <Odznaka rozmiar="sm">{ROLE_LABEL[z.role]}</Odznaka>
                      {(z.extra.length > 0 || z.denied.length > 0) && (
                        <span className="small muted">
                          {' '}
                          <RoznicaRoli extra={z.extra.length} denied={z.denied.length} />
                        </span>
                      )}
                      <div className="small muted">
                        zaprasza {z.invitedBy} · ważne do {DT.format(z.expiresAt)}
                      </div>
                    </div>
                    {(z.role !== 'WLASCICIEL' || ownerActor) && <CofnijZaproszenie id={z.id} email={z.email} />}
                  </li>
                ))}
              </ul>
            )}
          </Karta>
        )}
      </div>
    </>
  )
}
