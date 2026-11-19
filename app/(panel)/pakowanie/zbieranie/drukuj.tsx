'use client'
// Lista zbierania: druk z przeglądarki (style druku w panel.css chowają menu i przyciski).
import { Przycisk } from '@/app/ui'

export function DrukujListe() {
  return (
    <Przycisk onClick={() => window.print()} className="zb-drukuj">
      Drukuj listę
    </Przycisk>
  )
}
