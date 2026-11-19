// GET /api/wydruki/stan — stanowiska druku firmy i stan ich drukarek: nagłówek /pakowanie i /stanowisko
// (odpytywanie co 30 s) oraz wybór stanowiska przy „Drukuj”. Sesja i `panel.podglad`, tylko klient firmy z sesji.
// Bez sesji albo bez uprawnienia: 200 z pustą listą — komponent nic nie pokazuje i nie ma błędu w konsoli przeglądarki.
import { stanowiskaDlaPanelu } from '@/lib/druk/panel'
import { requirePermissionApi } from '@/lib/stanowisko/sesja-api'

export const dynamic = 'force-dynamic'

const BEZ_CACHE = { 'Cache-Control': 'private, no-store' }

export async function GET(): Promise<Response> {
  const ctx = await requirePermissionApi('panel.podglad')
  if (ctx instanceof Response) return Response.json({ stanowiska: [] }, { headers: BEZ_CACHE })
  return Response.json({ stanowiska: await stanowiskaDlaPanelu(ctx.db) }, { headers: BEZ_CACHE })
}
