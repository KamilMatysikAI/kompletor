// Konta panelu (kod systemowy). Hasło startowe generuje skrypt i wypisuje WYŁĄCZNIE na terminal
// (nie do pliku, nie do logu); osoba zmienia je później (zmiana hasła w panelu: /ustawienia/haslo;
// zapomniane hasło: `haslo` niżej). Każda zmiana hasła wylogowuje wszystkie sesje tej osoby.
//
//   npm run uzytkownik -- dodaj --email anna@firma.pl --imie "Anna" --firma moja-firma --rola WLASCICIEL
//   npm run uzytkownik -- dodaj --email jan@firma.pl --imie "Jan" --firma moja-firma --rola BIURO \
//        --uprawnienia zamowienia.anuluj_po_fakturze,zamowienia.oznacz_oplacone,zwroty.pieniadze,produkty.zatwierdzanie
//   npm run uzytkownik -- dostep --email anna@firma.pl --firma inna-firma --rola WLASCICIEL   (kolejna firma, hosting;
//        bez --uprawnienia dodatkowe uprawnienia zostają bez zmian, --uprawnienia "" je czyści)
//   npm run uzytkownik -- odbierz --email osoba@firma.pl --firma moja-firma
//   npm run uzytkownik -- haslo --email osoba@firma.pl        (nowe hasło startowe, wylogowanie wszystkich sesji;
//        przy pierwszym logowaniu panel wymusza jego zmianę)
//   npm run uzytkownik -- lista [--firma moja-firma]
//   npm run uzytkownik -- sprzataj                           (usuwa wygasłe sesje oraz wygasłe i cofnięte zaproszenia)
// Hosting (APP_MODE=hosted): `dodaj` i `dostep` to narzędzia obsługi instalacji, nie firm — dołączają konto do firmy
// bez zgody osoby. Firmy dodają ludzi zaproszeniami w panelu (docs/konta-i-zaproszenia.md).
import 'dotenv/config'
import type { MemberRole } from '@prisma/client'
import { createSystemClient } from '../lib/db'
import { generatePassword } from '../lib/auth/hasla'
import { addPersonAtomic, grantMembership, purgeExpiredSessions, revokeMembership, setPassword } from '../lib/auth/sesje'
import { purgeInvitations } from '../lib/auth/zaproszenia'
import { sprzatajResety } from '../lib/auth/reset-hasla'
import { isPermission, PERMISSIONS } from '../lib/auth/uprawnienia'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const ROLES: MemberRole[] = ['WLASCICIEL', 'BIURO', 'MAGAZYN']

function role(): MemberRole {
  const r = (arg('--rola') ?? '').toUpperCase()
  if (!ROLES.includes(r as MemberRole)) throw new Error(`Podaj --rola: ${ROLES.join(' | ')}`)
  return r as MemberRole
}

function permissions(): string[] | undefined {
  const raw = arg('--uprawnienia')
  if (raw === undefined) return undefined // bez flagi: dostep nie zmienia dodatkowych uprawnień
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = list.filter((p) => !isPermission(p))
  if (bad.length) throw new Error(`Nieznane uprawnienia: ${bad.join(', ')}. Dostępne: ${Object.keys(PERMISSIONS).join(', ')}`)
  return list
}

async function orgId(sys: ReturnType<typeof createSystemClient>, slug: string | undefined): Promise<string> {
  if (!slug) throw new Error('Podaj --firma <slug>')
  const o = await sys.organization.findUnique({ where: { slug } })
  if (!o) throw new Error(`Nie ma firmy ${slug} (npm run org:list)`)
  return o.id
}

function printPassword(email: string, password: string): void {
  // Tylko terminal. Nie przekierowuj wyjścia do pliku.
  process.stdout.write(`\nKonto: ${email}\nHasło startowe: ${password}\nPrzekaż je osobiście albo innym kanałem niż e-mail z loginem.\n\n`)
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  const sys = createSystemClient({ poolMax: 1 })
  try {
    if (cmd === 'dodaj') {
      const email = arg('--email')
      const name = arg('--imie')
      if (!email || !name) throw new Error('Podaj --email i --imie')
      const organizationId = await orgId(sys, arg('--firma'))
      const r = role()
      const perms = permissions()
      // wspólna funkcja z Ustawieniami → Użytkownicy; istniejące konto dostaje tylko dostęp do firmy
      const res = await addPersonAtomic(sys, { email, name, organizationId, role: r, permissions: perms })
      if (!res.ok) throw new Error(`${email} ma już dostęp do tej firmy (zmiana roli: dostep)`)
      console.log(`[uzytkownik] dodany ${email} w firmie ${organizationId} jako ${r}${perms?.length ? ` + ${perms.join(', ')}` : ''}`)
      if (res.password) printPassword(email, res.password)
      else console.log('[uzytkownik] konto już istniało — dostęp do firmy nadany, hasło bez zmian')
      return 0
    }
    if (cmd === 'dostep') {
      const email = arg('--email')
      if (!email) throw new Error('Podaj --email')
      const organizationId = await orgId(sys, arg('--firma'))
      await grantMembership(sys, { email, organizationId, role: role(), permissions: permissions() })
      console.log(`[uzytkownik] ${email}: dostęp do ${organizationId} zapisany`)
      return 0
    }
    if (cmd === 'odbierz') {
      const email = arg('--email')
      if (!email) throw new Error('Podaj --email')
      await revokeMembership(sys, email, await orgId(sys, arg('--firma')))
      console.log(`[uzytkownik] ${email}: dostęp odebrany (sesje w tej firmie przestają działać przy następnym żądaniu)`)
      return 0
    }
    if (cmd === 'haslo') {
      const email = arg('--email')
      if (!email) throw new Error('Podaj --email')
      const password = generatePassword()
      await setPassword(sys, email, password)
      console.log(`[uzytkownik] ${email}: nowe hasło, wszystkie sesje wylogowane`)
      printPassword(email, password)
      return 0
    }
    if (cmd === 'lista') {
      const slug = arg('--firma')
      const where = slug ? { organizationId: await orgId(sys, slug) } : {}
      const rows = await sys.membership.findMany({ where, include: { user: { select: { email: true, name: true, active: true, lastLoginAt: true } } }, orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }] })
      for (const m of rows)
        console.log(
          `${m.organizationId}\t${m.user.email}\t${m.user.name}\t${m.role}${m.permissions.length ? `+${m.permissions.join(',')}` : ''}${m.deniedPermissions.length ? `-${m.deniedPermissions.join(',')}` : ''}\t${m.active && m.user.active ? 'aktywny' : 'wyłączony'}\t${m.user.lastLoginAt?.toISOString() ?? 'nie logował się'}`,
        )
      return 0
    }
    if (cmd === 'sprzataj') {
      console.log(`[uzytkownik] usunięte wygasłe sesje: ${await purgeExpiredSessions(sys)}`)
      console.log(`[uzytkownik] usunięte wygasłe i cofnięte zaproszenia: ${await purgeInvitations(sys)}`)
      console.log(`[uzytkownik] usunięte stare linki resetu hasła: ${await sprzatajResety(sys)}`)
      return 0
    }
    console.error('Użycie: tsx scripts/uzytkownik.ts dodaj | dostep | odbierz | haslo | lista | sprzataj (opis na górze pliku)')
    return 2
  } finally {
    await sys.$disconnect()
  }
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[uzytkownik] błąd:', e instanceof Error ? e.message : e)
    process.exit(1)
  },
)
