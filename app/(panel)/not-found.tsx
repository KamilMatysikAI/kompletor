import Link from 'next/link'

export default function NieZnaleziono() {
  return (
    <div className="empty">
      <h2>Nie ma takiej strony albo rekordu</h2>
      <p className="muted">
        Adres mógł się zmienić albo rekord należy do innej firmy. <Link href="/pulpit">Wróć na pulpit</Link>
      </p>
    </div>
  )
}
