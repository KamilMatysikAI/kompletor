// Ustawienia → Statusy zamówień: statusy własne firmy (nazwa, nazwa dla klienta, kolor, grupa,
// etap pracy, przewoźnicy, widoczność) i grupy panelu listy zamówień, jeden zapis na ekran. Status w sklepie dla
// statusu firmy: ekran konta kanału, sekcja „Zapis do sklepu”. Tylko z uprawnieniem `ustawienia`.
import { NaglowekStrony, PrzyciskLink } from '@/app/ui'
import { requirePermission } from '@/lib/panel/kontekst'
import { ustawieniaStatusow } from '@/lib/panel/statusy-firmy-dane'
import { FormularzStatusow } from './formularz'

export const metadata = { title: 'Statusy zamówień' }

export default async function StatusyZamowien() {
  const ctx = await requirePermission('ustawienia')
  const { statusy, grupy } = await ustawieniaStatusow(ctx.db)
  return (
    <>
      <NaglowekStrony
        tytul="Statusy zamówień"
        podtytul="Nazwy i kolory, które zespół widzi na liście i karcie zamówienia. Kompletor przenosi zamówienia między etapami sam, status firmy to nazwa etapu."
        akcje={
          <PrzyciskLink href="/zamowienia" wariant="cichy">
            Zamówienia
          </PrzyciskLink>
        }
      />
      <FormularzStatusow statusy={statusy} grupy={grupy} />
    </>
  )
}
