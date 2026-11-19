// Numer nadania przesyłki: link do strony śledzenia przewoźnika (nowa karta), gdy serwer podał adres śledzenia
// (`linkSledzeniaPanelu`); w innym razie sam tekst. Bez stanu i hooków, więc działa w komponentach serwera i klienta.
// Kliknięcie linku w wierszu listy nie otwiera karty zamówienia (wiersze pomijają kliknięcia w linki).
export function NumerNadania({ numer, href, className }: { numer: string; href: string | null | undefined; className?: string }) {
  if (!href) return <span className={className}>{numer}</span>
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" title="Śledzenie przesyłki na stronie przewoźnika (nowa karta)">
      {numer}
      <span className="sr"> (otwiera się w nowej karcie)</span>
    </a>
  )
}
