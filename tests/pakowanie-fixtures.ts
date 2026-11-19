// przykładowy harmonogram odbiorów do testów kolejki (DPD 13:00, InPost 14:30, Allegro 15:00, oznaczony jako
// przykładowy). Seed ACME ma godziny właściciela (lib/pakowanie/harmonogram.ts: ACME_PICKUPS).
import type { PickupScheduleT } from '@/lib/pakowanie/harmonogram'

export const PRZYKLADOWE_ODBIORY: PickupScheduleT[] = [
  { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true, example: true },
  { carrier: 'DPD_EMPIK', weekdays: [1, 2, 3, 4, 5], pickupMinute: 13 * 60, promiseUntilMinute: 12 * 60, active: true, example: true },
  { carrier: 'PACZKOMATY', weekdays: [1, 2, 3, 4, 5], pickupMinute: 14 * 60 + 30, promiseUntilMinute: 13 * 60 + 30, active: true, example: true },
  { carrier: 'ALLEGRO', weekdays: [1, 2, 3, 4, 5], pickupMinute: 15 * 60, promiseUntilMinute: 14 * 60, active: true, example: true },
]
