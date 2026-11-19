'use client'
// „Drukuj kartę” w menu „Więcej” karty zamówienia: serwer druku (stanowisko użytkownika) albo
// „Pobierz PDF” (ten sam formularz co lista zamówień, POST /api/wydruki/karty). Karta z odbiorcą wg uprawnień
// zlecającego (robi to wydruk karty). Drukowanie karty zamówienia „Do realizacji” zaczyna zbieranie (T7).
// zamówienie wysłane, anulowane albo bez towaru do zebrania dostaje wydruk informacyjny (bez kodu karty).
import { GrupaMenu, POZYCJA_MENU, Przycisk } from '@/app/ui'
import { DrukujNaStanowisku, useStanowiskaDruku } from '../../_komponenty/druk'

export function DrukujKarte({ orderId }: { orderId: string }) {
  const stanowiska = useStanowiskaDruku()
  return (
    <GrupaMenu tytul="Karta zbierania">
      <DrukujNaStanowisku typ="karta" ids={[orderId]} etykieta="Drukuj kartę" stanowiska={stanowiska} informacyjne />
      <form method="post" action="/api/wydruki/karty" target="_blank">
        <input type="hidden" name="z" value={orderId} />
        <input type="hidden" name="informacyjne" value="1" />
        <Przycisk type="submit" wariant="cichy" className={POZYCJA_MENU}>
          Pobierz PDF karty
        </Przycisk>
      </form>
    </GrupaMenu>
  )
}
