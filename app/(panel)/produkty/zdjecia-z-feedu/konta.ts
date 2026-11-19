// Sklepy firmy do wyboru przy adresie feedu: konta kanałów sprzedaży (bez dostawcy AI i zamówień ręcznych).
import type { PrismaClient } from '@prisma/client'

export async function kontaSklepow(db: PrismaClient): Promise<{ kod: string; nazwa: string }[]> {
  const rows = await db.channelConfig.findMany({
    where: { channel: { notIn: ['AI', 'RECZNE'] } },
    select: { channel: true, channelAccountId: true, name: true, active: true },
    orderBy: [{ channel: 'asc' }, { name: 'asc' }],
  })
  return rows.map((r) => ({ kod: `${r.channel}:${r.channelAccountId}`, nazwa: `${r.name}${r.active ? '' : ' (wyłączony)'}` }))
}
