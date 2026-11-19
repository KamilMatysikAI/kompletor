// odznaka i jej trzy zastosowania z jedną mapą stanów (lib/panel/statusy.ts). Status zamówienia ma
// jeden wygląd w całym panelu: pigułka z kropką w tonie etapu, opcjonalnie z przewoźnikiem w drugim polu.
import type { Carrier, ChannelMode, OrderStatus, PaymentState } from '@prisma/client'
import type { CSSProperties, ReactNode } from 'react'
import { CARRIER_LABEL } from '@/lib/panel/format'
import { KOLORY_STATUSOW, STAN_PLATNOSCI, statusZamowienia, trybKanalu, type EtykietaStatusuFirmy, type KolorStatusu, type Ton } from '@/lib/panel/statusy'

export function Odznaka({ ton = 'neutralny', kropka, rozmiar = 'md', title, children, className }: { ton?: Ton; kropka?: boolean; rozmiar?: 'sm' | 'md'; title?: string; children: ReactNode; className?: string }) {
  return (
    <span className={['ui-odznaka', kropka ? 'ui-kropka' : '', rozmiar === 'sm' ? 'ui-sm' : '', className].filter(Boolean).join(' ')} data-ton={ton} title={title}>
      {children}
    </span>
  )
}

/** kolory statusu firmy jako zmienne CSS pigułki (`.ui-sf` w komponenty.css). */
export function stylKoloru(kolor: KolorStatusu): CSSProperties {
  const k = KOLORY_STATUSOW[kolor] ?? KOLORY_STATUSOW.szary
  return { '--sf-tekst': k.tekst, '--sf-tlo': k.tlo } as CSSProperties
}

/** Pigułka statusu firmy (nazwa i kolor firmy; w podpowiedzi etap rdzenia). */
export function StatusFirmy({ etykieta, rozmiar }: { etykieta: Pick<EtykietaStatusuFirmy, 'nazwa' | 'kolor' | 'bazowy'>; rozmiar?: 'sm' | 'md' }) {
  return (
    <span className={['ui-odznaka', 'ui-kropka', 'ui-sf', rozmiar === 'sm' ? 'ui-sm' : ''].filter(Boolean).join(' ')} style={stylKoloru(etykieta.kolor)} title={etykieta.nazwa === etykieta.bazowy ? undefined : `Etap: ${etykieta.bazowy}`}>
      {etykieta.nazwa}
    </span>
  )
}

/**
 * Status zamówienia (+ przewoźnik, gdy podany i nie „bez przewoźnika”). Z `firmy` (status firmy,
 * `etykietaStatusuFirmy`) pigułka ma nazwę i kolor firmy; status firmy z przewoźnikiem w nazwie nie dubluje go obok.
 */
export function StatusZamowienia({ status, przewoznik, rozmiar, firmy }: { status: OrderStatus; przewoznik?: Carrier | null; rozmiar?: 'sm' | 'md'; firmy?: EtykietaStatusuFirmy | null }) {
  if (firmy?.klucz) {
    const cf = !firmy.zPrzewoznikiem && przewoznik && przewoznik !== 'BRAK' ? CARRIER_LABEL[przewoznik] : null
    return (
      <span className="ui-status">
        <StatusFirmy etykieta={firmy} rozmiar={rozmiar} />
        {cf && <span className="ui-status-c">{cf}</span>}
      </span>
    )
  }
  const s = statusZamowienia(status)
  const c = przewoznik && przewoznik !== 'BRAK' ? CARRIER_LABEL[przewoznik] : null
  return (
    <span className="ui-status">
      <Odznaka ton={s.ton} kropka rozmiar={rozmiar}>
        {s.etykieta}
      </Odznaka>
      {c && <span className="ui-status-c">{c}</span>}
    </span>
  )
}

/** Tryb konta kanału: „Tylko podgląd” / „Aktywny” / „Aktywny bez stanów” / „Mieszany” / „Wyłączony” (słownik UI zamiast „cień” / „praca”). */
export function TrybKanalu({ tryb, aktywne = true, rozmiar }: { tryb: ChannelMode | 'BEZ_STANOW' | 'MIESZANY'; aktywne?: boolean; rozmiar?: 'sm' | 'md' }) {
  const t = trybKanalu(tryb, aktywne)
  return (
    <Odznaka ton={t.ton} rozmiar={rozmiar} title={t.opis}>
      {t.etykieta}
    </Odznaka>
  )
}

export function StanPlatnosci({ stan, rozmiar }: { stan: PaymentState; rozmiar?: 'sm' | 'md' }) {
  const s = STAN_PLATNOSCI[stan]
  return (
    <Odznaka ton={s.ton} rozmiar={rozmiar}>
      {s.etykieta}
    </Odznaka>
  )
}
