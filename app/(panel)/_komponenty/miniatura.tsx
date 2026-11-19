// Miniatura produktu: główne zdjęcie produktu (miniatura 160 px z /api/produkty/zdjecia/<id>?w=m), a bez
// zdjęcia zaślepka z inicjałami nazwy, żeby wiersz miał stałe miejsce na zdjęcie.
import { zdjecieUrl } from '@/lib/produkty/zdjecia-url'

export function Miniatura({ title, size = 28, zdjecie }: { title: string; size?: number; zdjecie?: string | null }) {
  if (zdjecie) {
    const cls = size >= 72 ? 'pimg-lg' : size >= 40 ? 'pimg' : 'pimg pr-sm'
    return <img className={cls} src={zdjecieUrl(zdjecie, 'm')} alt="" width={size} height={size} loading="lazy" decoding="async" />
  }
  const initials = title
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w.match(/\p{L}/u)![0]!.toUpperCase())
    .join('')
  return (
    <span className="thumb" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size / 3.2)) }} aria-hidden="true" title="brak zdjęcia">
      {initials || '—'}
    </span>
  )
}
