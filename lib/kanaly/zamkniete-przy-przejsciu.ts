// Znacznik zamówienia zamkniętego punktem cięcia przy przejściu z BaseLinkera (lib/kanaly/punkt-ciecia.ts). Osobny
// moduł bez zależności, żeby mogły go używać planista zapisów do sklepów, silnik automatów i plan maili bez cykli
// importów. Zamknięcie zmienia status na „Wysłane”/„Odebrane”/„Do odbioru” i podbija `updatedAt`, a wysyłkę, maile
// i status w sklepie zrobił już BaseLinker: mechanizmy wybierające zamówienia po statusie i `updatedAt` muszą takie
// pomijać.
import type { OrderStatus, Prisma } from '@prisma/client'

/** Zdarzenie w historii zamówienia zamkniętego punktem cięcia (`data.na` = status nadany przy zamknięciu). */
export const ZAMKNIETE_PRZY_PRZEJSCIU = 'ZAMKNIETE_PRZY_PRZEJSCIU'

/** Statusy, które nadaje punkt cięcia. */
export const STATUSY_ZAMKNIECIA = ['WYSLANE', 'ODEBRANE', 'DO_ODBIORU'] as const satisfies readonly OrderStatus[]

/**
 * Fragment `where` zamówienia: bez zamkniętych przy przejściu z BaseLinkera, trwale (także po późniejszej zmianie
 * statusu). Dla maili, których okazję obsłużył BaseLinker niezależnie od dalszego statusu (faktura BL, „brak
 * płatności” sprzed przejścia, „gotowe do odbioru” nadane cięciem).
 */
export const BEZ_ZAMKNIETYCH_PRZY_PRZEJSCIU = { events: { none: { kind: ZAMKNIETE_PRZY_PRZEJSCIU } } } as const satisfies Prisma.OrderWhereInput

/**
 * Fragment `where` zamówienia: bez zamkniętych przy przejściu, które stoją dalej w stanie nadanym przez punkt cięcia
 * (status = `data.na` zdarzenia zamknięcia, bez statusu firmy; zamknięcie zeruje `companyStatus`). Ten stan ustawił
 * w sklepie BaseLinker. Późniejsza zmiana wykonana już w Kompletorze (np. ręczne „Odebrane” po „Do odbioru”, status
 * firmy w tej samej grupie) to zwykłe przejście: idzie do sklepu i do reguł czasowych jak każde inne. Powrót do
 * dokładnie tego samego stanu po drodze przez inny status znów jest pomijany (sklep i tak ma go od BaseLinkera).
 */
export const BEZ_STANU_Z_PUNKTU_CIECIA = {
  NOT: {
    OR: STATUSY_ZAMKNIECIA.map((s) => ({
      status: s,
      companyStatus: null,
      events: { some: { kind: ZAMKNIETE_PRZY_PRZEJSCIU, data: { path: ['na'], equals: s } } },
    })),
  },
} satisfies Prisma.OrderWhereInput
