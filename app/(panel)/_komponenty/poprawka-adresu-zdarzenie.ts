// zdarzenie okna po udanej poprawce adresu albo punktu odbioru. Bloki, które trzymają stan z chwili
// otwarcia (nadanie przesyłki, formularz poprawki), odświeżają się po nim bez F5. Ogłasza je też „Zatwierdź”
// podziału adresu przez asystenta AI, więc formularz poprawki słucha zdarzeń z innych miejsc karty.
const ZDARZENIE_ADRES_POPRAWIONY = 'kompletor-adres-poprawiony'

/** Daje znać blokom tego zamówienia, że odbiorca się zmienił. */
export function ogloszPoprawkeAdresu(orderId: string): void {
  window.dispatchEvent(new CustomEvent<string>(ZDARZENIE_ADRES_POPRAWIONY, { detail: orderId }))
}

/** Subskrypcja zdarzenia dla jednego zamówienia; zwraca funkcję wypisania (do sprzątania w `useEffect`). */
export function naPoprawkeAdresu(orderId: string, f: () => void): () => void {
  const sluchacz = (e: Event) => {
    if ((e as CustomEvent<string>).detail === orderId) f()
  }
  window.addEventListener(ZDARZENIE_ADRES_POPRAWIONY, sluchacz)
  return () => window.removeEventListener(ZDARZENIE_ADRES_POPRAWIONY, sluchacz)
}
