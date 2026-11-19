// KSeF bezpośrednio jako dostawca dokumentów sprzedaży: obecny szkic FA(3) za interfejsem.
// Tylko `przygotuj` i `przygotuj.korekte`: szkic korekty FA(3) (KOR) przy zwrocie — wysyłka do KSeF to osobne
// zadanie (adapter `ksef.fa3.v1` jest readOnly).
import type { DostawcaDokumentow } from '../dokumenty/kontrakt'
import { zbudujFa3 } from './fa3/builder'
import type { WejscieFa3 } from './fa3/typy'

export function dostawcaKsef(): DostawcaDokumentow {
  return {
    program: 'ksef',
    nazwa: 'KSeF bezpośrednio (szkic FA(3), bez wysyłki)',
    zdolnosci: ['przygotuj', 'przygotuj.korekte'],
    przygotuj(wejscie) {
      const f = zbudujFa3(wejscie as WejscieFa3)
      return { xml: f.xml, schemaVersion: f.wersjaSchemy, sumy: { nettoGr: f.sumy.nettoGr, vatGr: f.sumy.vatGr, bruttoGr: f.sumy.bruttoGr }, problems: f.problemy }
    },
    przygotujKorekte(wejscie) {
      const w = wejscie as WejscieFa3
      const f = zbudujFa3({ ...w, rodzaj: 'KOR' })
      return { xml: f.xml, schemaVersion: f.wersjaSchemy, sumy: { nettoGr: f.sumy.nettoGr, vatGr: f.sumy.vatGr, bruttoGr: f.sumy.bruttoGr }, problems: f.problemy }
    },
  }
}
