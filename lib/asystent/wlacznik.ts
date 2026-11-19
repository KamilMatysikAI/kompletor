// Wyłącznik asystenta „Zapytaj” dla layoutu panelu: odczyt konfiguracji konta AI firmy. Domyślnie wyłączony; błąd
// odczytu = wyłączony (dymek to dodatek, nie może zepsuć panelu). Włączony bez klucza dostawcy AI = też bez dymka
// (każda osoba dostawałaby tylko komunikat o braku klucza); właściciel widzi powód w Ustawieniach → Agenci AI.
import type { PrismaClient } from '@prisma/client'
import { dostawcaAiFirmy, zrodloKluczaAi } from '../ai'
import { appModeOf } from '../organizacje'

export async function asystentWlaczony(db: PrismaClient, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    const d = await dostawcaAiFirmy(db)
    if (!d.asystent) return false
    return (await zrodloKluczaAi(db, d.accountId, { env, envFallback: appModeOf(env) === 'self-host' })) !== null
  } catch (e) {
    console.error(`[asystent] odczyt wyłącznika: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
