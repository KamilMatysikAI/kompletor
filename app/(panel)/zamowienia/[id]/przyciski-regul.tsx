// przyciski automatycznych akcji firmy na karcie zamówienia (Ustawienia → Automatyczne akcje, zdarzenie
// „Kliknięto przycisk”, miejsce „Karta zamówienia”). Tylko reguły, których warunki pasują do zamówienia; krok przesyłki
// przy wyłączonym nadawaniu = przycisk widoczny, nieaktywny, z powodem. Klucz kliknięcia z renderu (podwójne kliknięcie
// = jedno wykonanie).
import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { Przycisk } from '@/app/ui'
import { przyciskiZamowienia } from '@/lib/automaty/silnik'
import { przyciskReguly } from './akcje-automaty'

export async function PrzyciskiRegul({ db, orderId, mozna }: { db: PrismaClient; orderId: string; mozna: boolean }) {
  const lista = await przyciskiZamowienia(db, orderId, 'karta').catch(() => [])
  if (!lista.length) return null
  return (
    <section className="kz-przyciski-regul" aria-label="Przyciski automatycznych akcji">
      {lista.map((p) => (
        <form key={p.regulaId} action={przyciskReguly}>
          <input type="hidden" name="zamowienie" value={orderId} />
          <input type="hidden" name="regula" value={p.regulaId} />
          <input type="hidden" name="klucz" value={randomBytes(12).toString('hex')} />
          <Przycisk type="submit" rozmiar="sm" powodWylaczenia={!mozna ? 'Przyciski automatycznych akcji wymagają uprawnienia do zmian etapu zamówienia.' : p.powod}>
            {p.etykieta}
          </Przycisk>
        </form>
      ))}
    </section>
  )
}
