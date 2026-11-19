// Ustawienia → Strefy magazynu: strefy firmy i reguły przypisania produktów, jeden zapis.
// Ręczna strefa produktu: karta produktu (sekcja „Strefa magazynu”). Filtry stref: ekran Pakowanie.
// Tylko z uprawnieniem `ustawienia`.
import { NaglowekStrony, PrzyciskLink } from '@/app/ui'
import { ustawieniaStref } from '@/lib/pakowanie/strefy-dane'
import { requirePermission } from '@/lib/panel/kontekst'
import { FormularzStref } from './formularz'

export const metadata = { title: 'Strefy magazynu' }

export default async function StrefyMagazynu() {
  const ctx = await requirePermission('ustawienia')
  const { strefy, reguly } = await ustawieniaStref(ctx.db)
  return (
    <>
      <NaglowekStrony
        tytul="Strefy magazynu"
        podtytul="Gdzie w magazynie stoi towar: pakowanie pozwala wybrać zamówienia jednej strefy."
        akcje={
          <PrzyciskLink href="/pakowanie" wariant="cichy">
            Pakowanie
          </PrzyciskLink>
        }
      />
      <FormularzStref strefy={strefy} reguly={reguly} />
    </>
  )
}
