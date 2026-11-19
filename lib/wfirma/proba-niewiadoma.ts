// Warunek „próba faktury z niewiadomym wynikiem” mieszka w rdzeniu (karta zamówienia i adapter wFirmy liczą go
// tak samo, a rdzeń nie importuje z lib/wfirma). Ten plik zostaje jako wejście dla adaptera.
export { PROBA_NIEWIADOMA, probaNiewiadoma } from '../rdzen/proba-niewiadoma'
