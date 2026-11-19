// Strefa magazynu w karcie produktu: skąd się wzięła (reguła firmy / ręcznie) i zmiana dla osób
// z uprawnieniem ustawień. Dane podaje ekran (requireSession), zapis robi akcja ustawStrefe.
// lista stref z ustawień firmy (Ustawienia → Strefy magazynu); firma bez stref widzi tylko odnośnik.
import { Karta, Przycisk, PrzyciskLink, Wybor } from '@/app/ui'
import type { ProductZoneInfo } from '@/lib/pakowanie/dane'
import { sortZones, zoneColor, zoneName } from '@/lib/pakowanie/strefy'
import { ustawStrefe } from './akcje'

export function StrefaProduktu({ productId, info, canEdit }: { productId: string; info: ProductZoneInfo; canEdit: boolean }) {
  if (!info.zones.length)
    return (
      <Karta tytul="Strefa magazynu" opis="Firma nie ma stref magazynu, więc pakowanie nie filtruje po strefie." akcje={canEdit ? <PrzyciskLink href="/ustawienia/strefy" rozmiar="sm">Ustaw strefy</PrzyciskLink> : undefined} />
    )
  const label = zoneName(info.zones, info.zone) ?? 'bez strefy'
  const why = info.source === 'RECZNIE' ? 'ustawiona ręcznie' : info.source === 'REGULA' ? 'z reguły firmy' : 'żadna reguła nie pasuje'
  const zReguly = zoneName(info.zones, info.byRule)
  return (
    <Karta tytul="Strefa magazynu" opis="Kolejka pakowania filtruje po strefie" akcje={canEdit ? <PrzyciskLink href="/ustawienia/strefy" rozmiar="sm" wariant="cichy">Strefy i reguły</PrzyciskLink> : undefined}>
      <p>
        {info.zone ? <span className={`zone z-${zoneColor(info.zones, info.zone)}`}>{label}</span> : <b>{label}</b>} <span className="muted small">· {why}</span>
      </p>
      {canEdit && (
        <form action={ustawStrefe} className="filters">
          <input type="hidden" name="produkt" value={productId} />
          <Wybor
            id="strefa-produktu"
            etykieta="Strefa produktu"
            name="strefa"
            defaultValue={info.manual ?? ''}
            opcje={[{ wartosc: '', etykieta: `z reguły firmy (${zReguly ?? 'bez strefy'})` }, ...sortZones(info.zones).map((z) => ({ wartosc: z.key, etykieta: `ręcznie: ${z.name}` }))]}
          />
          <Przycisk type="submit">Zapisz strefę</Przycisk>
        </form>
      )}
    </Karta>
  )
}
