// Ustawienia → Automatyczne akcje: reguły firmy „kiedy → jeśli → zrób” w grupach, jak „Automatyczne akcje”
// w BaseLinkerze. Zakładki: reguły i grupy. Tylko z uprawnieniem `ustawienia`. Rdzeń pilnuje kolejności pracy: reguła
// ustawia tylko status, na który zamówienie może przejść (docs/automatyczne-akcje.md).
import { NaglowekStrony, PrzyciskLink, Zakladki } from '@/app/ui'
import { ekranAutomatow } from '@/lib/automaty/dane'
import { requirePermission } from '@/lib/panel/kontekst'
import { ListaAutomatow } from './lista'
import { ToastZAdresu } from '../kanaly/toast-z-adresu'

export const metadata = { title: 'Automatyczne akcje' }

export default async function AutomatyczneAkcje({ searchParams }: { searchParams: Promise<{ zakladka?: string; zapisano?: string; blad?: string }> }) {
  const ctx = await requirePermission('ustawienia')
  const { zakladka, zapisano, blad } = await searchParams
  const grupy = zakladka === 'grupy'
  const ekran = await ekranAutomatow(ctx.db)
  return (
    <>
      <NaglowekStrony
        tytul="Automatyczne akcje"
        podtytul="Co Kompletor ma zrobić sam, gdy coś dzieje się z zamówieniem: ustawić status, wysłać mail, utworzyć przesyłkę. Kompletor pilnuje kolejności pracy, więc reguła nie przeskoczy pakowania ani płatności."
        akcje={
          <>
            {/* gotowe przepływy (statusy + reguły); bez pozycji w menu */}
            <PrzyciskLink href="/ustawienia/automaty/szablony" wariant={ekran.reguly.length ? 'drugorzedny' : 'glowny'}>
              Wczytaj szablon
            </PrzyciskLink>
            <PrzyciskLink href="/ustawienia/statusy" wariant="cichy">
              Statusy zamówień
            </PrzyciskLink>
          </>
        }
      />
      <ToastZAdresu sukces={zapisano?.slice(0, 300) ?? null} blad={blad?.slice(0, 300) ?? null} zostaw={grupy ? { zakladka: 'grupy' } : undefined} />
      <Zakladki
        etykieta="Automatyczne akcje"
        zakladki={[
          { href: '/ustawienia/automaty', etykieta: 'Automatyczne akcje', aktywna: !grupy, licznik: ekran.reguly.length },
          { href: '/ustawienia/automaty?zakladka=grupy', etykieta: 'Grupy akcji', aktywna: grupy, licznik: ekran.grupy.length },
        ]}
      />
      <ListaAutomatow ekran={ekran} widok={grupy ? 'grupy' : 'reguly'} />
    </>
  )
}
