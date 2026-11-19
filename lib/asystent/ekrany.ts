// „Pomoc do tego ekranu”: bez importów serwerowych, więc działa też w dymku asystenta po stronie przeglądarki.
/**
 * „Pomoc do tego ekranu”: rozdział Pomocy dla ścieżki panelu. Najdłuższy pasujący przedrostek wygrywa
 * (`/ustawienia/agenci-ai` przed `/ustawienia`, `/zamowienia/nowe` przed kartą `/zamowienia/<id>`). Ekran bez
 * własnego rozdziału = null. `kotwica` = sekcja rozdziału (sprawdzana testem z treścią Pomocy).
 */
export const POMOC_EKRANOW: readonly { sciezka: string; slug: string; nazwa: string; kotwica?: string }[] = [
  { sciezka: '/pulpit', slug: 'pierwsze-kroki', nazwa: 'Pierwsze kroki' },
  { sciezka: '/zamowienia', slug: 'lista-zamowien', nazwa: 'Lista zamówień' },
  { sciezka: '/zamowienia/', slug: 'karta-zamowienia', nazwa: 'Karta zamówienia' },
  { sciezka: '/zamowienia/nowe', slug: 'karta-zamowienia', nazwa: 'Dodaj zamówienie', kotwica: 'dodaj-zamowienie-zamowienie-reczne' },
  { sciezka: '/pakowanie', slug: 'pakowanie', nazwa: 'Pakowanie' },
  { sciezka: '/przesylki', slug: 'przesylki', nazwa: 'Przesyłki' },
  { sciezka: '/produkty', slug: 'produkty', nazwa: 'Produkty' },
  { sciezka: '/braki', slug: 'rezerwacje', nazwa: 'Rezerwacje i braki' },
  { sciezka: '/rozjazdy', slug: 'synchronizacja-stanow', nazwa: 'Synchronizacja stanów' },
  { sciezka: '/faktury', slug: 'dokumenty-sprzedazy', nazwa: 'Dokumenty sprzedaży' },
  { sciezka: '/zwroty', slug: 'zwroty-i-reklamacje', nazwa: 'Zwroty i reklamacje' },
  { sciezka: '/raporty', slug: 'raporty', nazwa: 'Raporty' },
  { sciezka: '/ustawienia', slug: 'konfiguracja', nazwa: 'Konfiguracja' },
  { sciezka: '/ustawienia/agenci-ai', slug: 'agenci-ai', nazwa: 'Agenci AI' },
  { sciezka: '/ustawienia/statusy', slug: 'statusy', nazwa: 'Statusy' },
  { sciezka: '/ustawienia/automaty', slug: 'automatyczne-akcje', nazwa: 'Automatyczne akcje' },
  { sciezka: '/ustawienia/poczta', slug: 'poczta', nazwa: 'Poczta' },
  { sciezka: '/ustawienia/powiadomienia', slug: 'powiadomienia', nazwa: 'Powiadomienia' },
  { sciezka: '/ustawienia/dane-klientow', slug: 'dane-klienta', nazwa: 'Dane klienta' },
  { sciezka: '/ustawienia/dokumenty', slug: 'dokumenty-sprzedazy', nazwa: 'Dokumenty sprzedaży' },
  { sciezka: '/ustawienia/rezerwacje', slug: 'rezerwacje', nazwa: 'Rezerwacje' },
  { sciezka: '/ustawienia/przeprowadzka', slug: 'migracja-z-baselinkera', nazwa: 'Przeprowadzka' },
  { sciezka: '/ustawienia/integracje', slug: 'integracje', nazwa: 'Integracje' },
  { sciezka: '/ustawienia/kanaly', slug: 'integracje', nazwa: 'Integracje' },
]

export function pomocEkranu(sciezka: string): { href: string; nazwa: string } | null {
  const s = sciezka.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/'
  let best: (typeof POMOC_EKRANOW)[number] | null = null
  for (const p of POMOC_EKRANOW) {
    const pasuje = p.sciezka.endsWith('/') ? s.startsWith(p.sciezka) && s.length > p.sciezka.length : s === p.sciezka || s.startsWith(`${p.sciezka}/`)
    if (pasuje && (!best || p.sciezka.length > best.sciezka.length)) best = p
  }
  return best ? { href: `/pomoc/${best.slug}${best.kotwica ? `#${best.kotwica}` : ''}`, nazwa: best.nazwa } : null
}
