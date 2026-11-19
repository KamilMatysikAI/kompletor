-- Kontrola przed `prisma migrate deploy` (docker/entrypoint.sh, funkcja kontrola_migracji_bazowej).
-- Baza założona na starszej historii migracji (wiersze w _prisma_migrations bez wykonanej migracji bazowej
-- 00000000000000_baza) dostałaby od `migrate deploy` cały schemat od nowa na istniejących tabelach: błąd 42710,
-- a potem P3009 przy każdym restarcie. Wtedy wyjątek KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ i entrypoint kończy start
-- z poleceniem naprawy, zanim Prisma cokolwiek zapisze. Pusta baza (bez tabeli albo bez wierszy) przechodzi.
-- Dwa osobne IF: w jednym wyrażeniu Postgres planuje podzapytanie na nieistniejącej tabeli i pusta baza kończy się
-- błędem zamiast przejść. Nazwa tabeli bez schematu: Prisma trzyma ją w schemacie z adresu bazy (search_path).
DO $$
BEGIN
  IF to_regclass('_prisma_migrations') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name <> '00000000000000_baza')
     AND NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '00000000000000_baza' AND finished_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KOMPLETOR_BRAK_MIGRACJI_BAZOWEJ';
  END IF;
END $$;
