// Klucze REST API ze sklepu WooCommerce po „Połącz z WooCommerce” (lib/kanaly/woo-autoryzacja.ts).
// POST wysyła serwer sklepu (wc-auth), nie przeglądarka: bez sesji panelu i bez hasła Basic, więc ścieżka jest otwarta
// w obu bramkach proxy.ts. Bramką jest podpisany, jednorazowy `user_id` z terminem. Odpowiedź inna niż 200 =
// WooCommerce kasuje klucz po swojej stronie (nic nie zostaje w sklepie bez naszego zapisu). Treść żądania nie trafia
// do logów ani odpowiedzi; odpowiedź ma tylko kod wyniku.
import { prismaForOrg } from '@/lib/db'
import { przyjmijKluczeWoo } from '@/lib/kanaly/woo-autoryzacja'

export const dynamic = 'force-dynamic'

const MAX_BODY = 8 * 1024

const odp = (status: number, kod: string) => Response.json({ ok: status === 200, kod }, { status, headers: { 'Cache-Control': 'no-store' } })

async function czytajCialo(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(len) && len > MAX_BODY) return undefined
  if (!req.body) return undefined
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return undefined
    }
    parts.push(value)
  }
  // Tylko JSON: WooCommerce `WC_Auth::post_consumer_data` wysyła `wp_json_encode`
  // z `Content-Type: application/json`; zapasowy formularz poszerzał wejście trasy bez sesji bez potrzeby.
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    return undefined
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = await czytajCialo(req)
  if (body === undefined) return odp(400, 'zly-ksztalt')
  try {
    const w = await przyjmijKluczeWoo(body, { env: process.env, db: prismaForOrg })
    return odp(w.status, w.kod)
  } catch {
    // np. baza chwilowo niedostępna: sklep pokaże błąd i skasuje klucz, właściciel kliknie „Połącz” jeszcze raz
    return odp(500, 'blad')
  }
}

export function GET(): Response {
  return odp(405, 'tylko-post')
}
