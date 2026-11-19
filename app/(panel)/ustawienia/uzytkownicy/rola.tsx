'use client'
// Rola i uprawnienia osoby. Rola jest punktem startu: wybór roli zaznacza jej zestaw domyślny,
// a każde uprawnienie da się potem zaznaczyć albo odznaczyć (także całą grupę). Przy uprawnieniu widać, czy jest
// „dołożone” albo „odebrane” względem roli; „Przywróć zestaw roli” wraca do zestawu domyślnego. Formularz wysyła pełny
// zaznaczony zestaw (`zestaw=pelny`), a serwer wylicza z niego dołożone i odebrane i sprawdza wszystkie bezpieczniki
// jeszcze raz pod blokadą (lib/panel/uzytkownicy.ts).
// Uprawnień, których osoba zmieniająca sama nie ma, nie da się ani nadać, ani odebrać: pole jest wyłączone i zostaje
// takie, jak jest u osoby. Rola Właściciel ma zawsze komplet (nic się jej nie odbiera).
// `zwijane` = lista w rozwijanej sekcji (okno „Zaproś osobę” / „Dodaj osobę”: domyślnie same trzy pola).
import { useState } from 'react'
import type { MemberRole } from '@prisma/client'
import { ALL_PERMISSIONS, brakujaceZaleznosci, GRUPY_UPRAWNIEN, PERMISSIONS, ROLE_LABEL, uprawnieniaRoli, type Permission } from '@/lib/auth/uprawnienia'

const ROLES: MemberRole[] = ['WLASCICIEL', 'BIURO', 'MAGAZYN']

export const OPIS_ROLI: Record<MemberRole, string> = {
  WLASCICIEL: 'wszystko, także ustawienia i użytkownicy',
  BIURO: 'zamówienia, dane klientów, braki towaru',
  MAGAZYN: 'pakowanie i kurier, bez pełnych danych klientów',
}

/**
 * Zestaw po wyborze roli albo „Przywróć zestaw roli”: zestaw roli, a uprawnienia, których zmieniający nie ma, zostają
 * takie, jak są u osoby (nie da się ich ani nadać, ani odebrać).
 */
export function zestawStartowy(role: MemberRole, obecne: ReadonlySet<Permission>, allowed: readonly Permission[]): Set<Permission> {
  const zRoli = uprawnieniaRoli(role)
  if (role === 'WLASCICIEL') return zRoli
  return new Set(ALL_PERMISSIONS.filter((p) => (allowed.includes(p) ? zRoli.has(p) : obecne.has(p))))
}

/** Różnica zaznaczonego zestawu względem roli: dołożone i odebrane (kolejność jak na ekranie). */
export function roznicaWzgledemRoli(role: MemberRole, zestaw: ReadonlySet<Permission>): { dolozone: Permission[]; odebrane: Permission[] } {
  const zRoli = uprawnieniaRoli(role)
  return { dolozone: ALL_PERMISSIONS.filter((p) => zestaw.has(p) && !zRoli.has(p)), odebrane: ALL_PERMISSIONS.filter((p) => zRoli.has(p) && !zestaw.has(p)) }
}

export function RolaIUprawnienia({
  id,
  role: initialRole,
  effective,
  allowed,
  ownerActor,
  locked = false,
  zwijane = false,
}: {
  id: string
  role: MemberRole
  /** uprawnienia osoby teraz (dla nowej osoby: zestaw startowej roli) */
  effective: Permission[]
  allowed: Permission[]
  ownerActor: boolean
  locked?: boolean
  zwijane?: boolean
}) {
  const obecne = new Set(effective)
  const [role, setRole] = useState<MemberRole>(initialRole)
  const [zestaw, setZestaw] = useState<Set<Permission>>(() => (initialRole === 'WLASCICIEL' ? uprawnieniaRoli('WLASCICIEL') : new Set(effective)))
  const wlasciciel = role === 'WLASCICIEL'
  const zRoli = uprawnieniaRoli(role)
  const { dolozone, odebrane } = roznicaWzgledemRoli(role, zestaw)
  const zmienne = (p: Permission) => !locked && !wlasciciel && allowed.includes(p)
  const ustaw = (p: Permission, on: boolean) =>
    setZestaw((z) => {
      const n = new Set(z)
      if (on) n.add(p)
      else n.delete(p)
      return n
    })
  const wybierzRole = (r: MemberRole) => {
    setRole(r)
    setZestaw(zestawStartowy(r, obecne, allowed))
  }
  const brakPodgladu = brakujaceZaleznosci(zestaw).length > 0
  const podsumowanie = wlasciciel
    ? 'Właściciel ma zawsze wszystkie uprawnienia.'
    : dolozone.length || odebrane.length
      ? `Inaczej niż w roli: ${[dolozone.length ? `${dolozone.length} dołożone` : '', odebrane.length ? `${odebrane.length} odebrane` : ''].filter(Boolean).join(', ')}.`
      : 'Zestaw roli bez zmian.'

  const lista = (
    <div className="osoba-uprawnienia-pudlo">
      <div className="osoba-upr-pasek">
        <p className="small" id={`${id}-roznica`} aria-live="polite">
          <b>
            {zestaw.size} z {ALL_PERMISSIONS.length}
          </b>{' '}
          uprawnień. {podsumowanie}
        </p>
        {!wlasciciel && !locked && (dolozone.length > 0 || odebrane.length > 0) && (
          <button type="button" className="btn small" onClick={() => setZestaw(zestawStartowy(role, obecne, allowed))}>
            Przywróć zestaw roli
          </button>
        )}
      </div>
      {brakPodgladu && (
        <p className="ui-blad small" role="alert">
          Bez „{PERMISSIONS['panel.podglad']}” pozostałe uprawnienia nic nie dają: osoba nie otworzy panelu.
        </p>
      )}
      <fieldset className="osoba-uprawnienia" disabled={locked} aria-describedby={`${id}-roznica`}>
        <legend className="lbl">Uprawnienia</legend>
        {GRUPY_UPRAWNIEN.map((g) => {
          const doZmiany = g.uprawnienia.filter(zmienne)
          const wszystkie = doZmiany.length > 0 && doZmiany.every((p) => zestaw.has(p))
          return (
            <div className="osoba-grupa" key={g.tytul} role="group" aria-labelledby={`${id}-g-${g.tytul}`}>
              <div className="osoba-grupa-naglowek">
                <h3 className="osoba-grupa-tytul" id={`${id}-g-${g.tytul}`}>
                  {g.tytul}{' '}
                  <span className="muted">
                    ({g.uprawnienia.filter((p) => zestaw.has(p)).length}/{g.uprawnienia.length})
                  </span>
                </h3>
                {doZmiany.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={`${wszystkie ? 'Odznacz' : 'Zaznacz'} grupę ${g.tytul}`}
                    onClick={() =>
                      setZestaw((z) => {
                        const n = new Set(z)
                        for (const p of doZmiany) if (wszystkie) n.delete(p)
                        else n.add(p)
                        return n
                      })
                    }
                  >
                    {wszystkie ? 'Odznacz grupę' : 'Zaznacz grupę'}
                  </button>
                )}
              </div>
              {g.uprawnienia.map((p) => {
                const ma = zestaw.has(p)
                const znacznik = wlasciciel ? null : ma && !zRoli.has(p) ? 'dołożone' : !ma && zRoli.has(p) ? 'odebrane' : null
                return (
                  <label key={p} className="small osoba-upr" data-uprawnienie={p} data-roznica={znacznik ?? undefined}>
                    <input type="checkbox" checked={ma} disabled={!zmienne(p)} onChange={(e) => ustaw(p, e.target.checked)} />
                    <span>
                      {PERMISSIONS[p]}
                      {znacznik && <span className={`osoba-upr-roznica${znacznik === 'odebrane' ? ' odebrane' : ''}`}> {znacznik}</span>}
                      {!locked && !wlasciciel && !allowed.includes(p) && <span className="muted"> (nie masz tego uprawnienia, zostaje bez zmian)</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          )
        })}
      </fieldset>
    </div>
  )

  return (
    <>
      <div className="field osoba-rola">
        <label htmlFor={`${id}-rola`}>Rola (punkt startu)</label>
        <select className="input" id={`${id}-rola`} name="rola" value={role} onChange={(e) => wybierzRole(e.target.value as MemberRole)} disabled={locked} aria-describedby={`${id}-rola-opis`}>
          {ROLES.map((r) => (
            <option key={r} value={r} disabled={r !== initialRole && r === 'WLASCICIEL' && !ownerActor}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <p className="ui-pomoc" id={`${id}-rola-opis`}>
          {ROLE_LABEL[role]}: {OPIS_ROLI[role]}.{!wlasciciel && ' Rola zaznacza swój zestaw; niżej możesz zaznaczyć albo odznaczyć każde uprawnienie.'}
        </p>
      </div>
      {/* pełny zaznaczony zestaw; serwer wylicza z niego dołożone i odebrane względem roli */}
      <input type="hidden" name="zestaw" value="pelny" />
      {[...zestaw].map((p) => (
        <input key={p} type="hidden" name="uprawnienia" value={p} />
      ))}
      {zwijane ? (
        <details className="osoba-upr-zwijane">
          <summary>
            Dokładne uprawnienia: {zestaw.size} z {ALL_PERMISSIONS.length}
            {!wlasciciel && (dolozone.length > 0 || odebrane.length > 0) ? ', inaczej niż w roli' : ''}
          </summary>
          {lista}
        </details>
      ) : (
        lista
      )}
    </>
  )
}
