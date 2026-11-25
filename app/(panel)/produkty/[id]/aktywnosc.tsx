// Karta produktu, nagłówek: „Wyłącz produkt” / „Włącz produkt” z potwierdzeniem (zlecenie).
// Przeszkody wyłączenia (aktywna oferta, rezerwacja, otwarte zamówienie, aktywny zestaw) liczone przy wyświetleniu:
// przycisk wyłączony z powodem; akcja serwera sprawdza je jeszcze raz przy zapisie.
import { Przycisk, PrzyciskPotwierdz } from '@/app/ui'
import { ustawAktywnoscProduktu } from './aktywnosc-akcje'

export function AktywnoscProduktu({ productId, aktywny, przeszkody, stan }: { productId: string; aktywny: boolean; przeszkody: string[]; stan: number | null }) {
  if (aktywny && przeszkody.length)
    return (
      <div className="np-head-actions">
        <Przycisk rozmiar="sm" powodWylaczenia={`Nie można wyłączyć: produkt ${przeszkody.join('; ')}`}>
          Wyłącz produkt
        </Przycisk>
      </div>
    )
  return (
    <form action={ustawAktywnoscProduktu} className="np-head-actions">
      <input type="hidden" name="produkt" value={productId} />
      <input type="hidden" name="aktywny" value={aktywny ? 'nie' : 'tak'} />
      {aktywny ? (
        <PrzyciskPotwierdz
          rozmiar="sm"
          wariant="niebezpieczny"
          tytul="Wyłączyć produkt?"
          tak="Wyłącz produkt"
          pytanie={`Produkt zniknie z listy (zakładka „Wyłączone” go pokaże), z kafli kompletności i raportów, nie da się go dodać do zamówienia ani powiązać z ofertą. Nic nie jest kasowane${stan ? `: stan ${stan} zostaje w magazynie` : ''}, a „Włącz produkt” cofa zmianę. Zmiana trafi do historii produktu.`}
        >
          Wyłącz produkt
        </PrzyciskPotwierdz>
      ) : (
        <PrzyciskPotwierdz rozmiar="sm" tytul="Włączyć produkt?" tak="Włącz produkt" pytanie="Produkt wróci na listę, do kafli kompletności i raportów, i da się go znów powiązać z ofertą. Zmiana trafi do historii produktu.">
          Włącz produkt
        </PrzyciskPotwierdz>
      )}
    </form>
  )
}
