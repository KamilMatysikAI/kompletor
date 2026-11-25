// zdanie o przesyłce na karcie dla osoby bez nadawania (bez `pakowanie.stanowisko`):
// bez numeru i akcji, ale zgodne ze stanem (tworzy się, do sprawdzenia, utworzona).
export function tekstStanuBezNadania(stan: string | null): string {
  if (stan === 'TWORZENIE') return 'Przesyłka tworzy się u przewoźnika.'
  if (stan === 'NIEJEDNOZNACZNA') return 'Przesyłka do sprawdzenia u przewoźnika: nie wiadomo jeszcze, czy powstała.'
  return 'Przesyłka utworzona.'
}
