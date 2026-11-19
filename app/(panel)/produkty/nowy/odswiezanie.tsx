'use client'
// Odświeża ekran co kilka sekund, dopóki worker sprawdza SKU w wFirmie.
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function Odswiezanie({ co = 3000 }: { co?: number }) {
  const router = useRouter()
  useEffect(() => {
    const t = setInterval(() => router.refresh(), co)
    return () => clearInterval(t)
  }, [router, co])
  return null
}
