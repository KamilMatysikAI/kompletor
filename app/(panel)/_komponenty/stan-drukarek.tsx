'use client'
// Stan drukarek stanowisk druku w nagłówku /pakowanie i /stanowisko. Odpytuje co 30 s sesyjną trasę
// GET /api/wydruki/stan (`panel.podglad`, klient firmy z sesji). Firma bez stanowisk albo osoba bez uprawnienia: nic
// (trasa odpowiada wtedy pustą listą, więc w konsoli przeglądarki nie ma błędu). Program druku bez raportu od 3 minut =
// „brak stanu od N min” zamiast drukarek z nieaktualnym stanem.
// pokazuje stanowisko wybrane na tym urządzeniu (wybór raz, ta sama pamięć co przy „Drukuj”) i drukarki,
// których ono naprawdę używa według przypisań, także na innych komputerach; rodzaj wydruku bez drukarki = czerwony
// znacznik z powodem.
import { opisRoli } from '@/lib/druk/role'
import { useStanowiskaDruku, useWybraneStanowisko, type DrukarkaStanu, type UzywanaDrukarkaStanu } from './druk'

const ODSWIEZ_MS = 30_000

const TON: Record<DrukarkaStanu['stan'], string> = { DOSTEPNA: 'leaf', OFFLINE: 'red', BLAD: 'red' }
const STAN: Record<DrukarkaStanu['stan'], string> = { DOSTEPNA: 'dostępna', OFFLINE: 'offline', BLAD: 'błąd' }
const TYP: Record<string, string> = { karta: 'karty', lista: 'lista', spis: 'spis', etykieta: 'etykiety' }

function Drukarka({ u }: { u: UzywanaDrukarkaStanu }) {
  const co = u.typy.map((t) => TYP[t] ?? t).join(', ')
  const gdzie = `${u.wlasna ? '' : `${u.stanowisko}: `}${opisRoli(u.rola)}`
  if (u.blad)
    return (
      <span className="chip red" title={u.blad} style={{ whiteSpace: 'normal' }}>
        {co} → {gdzie}: {u.wlasna && !u.drukarka ? 'brak drukarki' : 'nie wydrukuje'}
      </span>
    )
  if (!u.agentDziala)
    return (
      <span className="chip red" title="Program druku nie wysyła stanu — komputer wyłączony, brak internetu albo program nie działa" style={{ whiteSpace: 'normal' }}>
        {co} → {gdzie}: {u.minutOdRaportu === null ? 'program druku jeszcze się nie zgłosił' : `brak stanu od ${u.minutOdRaportu} min`}
      </span>
    )
  const d = u.drukarka
  if (!d) return <span className="chip amber">{co} → {gdzie}: brak drukarki</span>
  const kolejka = d.zleceniaWKolejce ? ` · w kolejce Windows: ${d.zleceniaWKolejce}` : ''
  const ton = d.stan === 'DOSTEPNA' && d.komunikat ? 'amber' : TON[d.stan]
  return (
    <span className={`chip ${ton}`} title={`${u.stanowisko}: ${d.nazwa} (${d.rola})${d.komunikat ? ` — ${d.komunikat}` : ''}`} style={{ whiteSpace: 'normal' }}>
      {co} → {gdzie}: {STAN[d.stan]}
      {d.komunikat && d.stan !== 'DOSTEPNA' ? ` — ${d.komunikat}` : ''}
      {kolejka}
    </span>
  )
}

export function StanDrukarek() {
  const stanowiska = useStanowiskaDruku(ODSWIEZ_MS)
  const [wybrane, wybierz] = useWybraneStanowisko(stanowiska)
  if (!stanowiska?.length) return null
  const s = stanowiska.find((x) => x.id === wybrane) ?? stanowiska[0]!
  // starszy serwer bez `uzywane` (podczas wdrożenia): jak dotąd, drukarki tego komputera
  const uzywane = s.uzywane ?? []
  return (
    <div className="chips" role="status" aria-label="Stan drukarek" style={{ alignItems: 'center' }}>
      {stanowiska.length > 1 ? (
        <select className="input druk-stan-wybor" aria-label="Twoje stanowisko druku" value={s.id} onChange={(e) => wybierz(e.target.value)}>
          {stanowiska.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="small" style={{ fontWeight: 600 }}>
          {s.name}:
        </span>
      )}
      {uzywane.length === 0 ? (
        <span className="chip amber">brak drukarek w konfiguracji programu druku</span>
      ) : (
        uzywane.map((u) => <Drukarka key={`${u.stanowiskoId}-${u.rola}`} u={u} />)
      )}
    </div>
  )
}
