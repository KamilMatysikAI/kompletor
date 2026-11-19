-- Migracja bazowa publicznego wydania Kompletora: cały schemat w jednym kroku (tabele, typy, indeksy, funkcje,
-- RLS i uprawnienia roli aplikacji). Wygenerowana z pełnej historii migracji przez pg_dump --schema-only.
-- Bazy założone przed publicznym wydaniem: NIE wykonywać, tylko `npx prisma migrate resolve --applied 00000000000000_baza`
-- (schemat już jest), dopiero potem wdrożenie obrazu z tego repo.

-- Rola aplikacji: klient firmy pracuje jako logistyka_app (RLS izoluje firmy). pg_dump nie zapisuje ról, więc
-- tworzy ją ten blok (idempotentnie), a właściciel bazy dostaje prawo SET ROLE logistyka_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistyka_app') THEN
    CREATE ROLE logistyka_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'logistyka_app', 'MEMBER') THEN
    EXECUTE format('GRANT logistyka_app TO %I', current_user);
  END IF;
END $$;

--
-- PostgreSQL database dump
--

--
-- Name: ActionMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActionMode" AS ENUM (
    'SUCHO',
    'PRACA'
);

--
-- Name: ActionState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActionState" AS ENUM (
    'PLANNED',
    'SKIPPED',
    'DONE'
);

--
-- Name: ActionTarget; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ActionTarget" AS ENUM (
    'ZAMOWIENIE',
    'PRODUKT'
);

--
-- Name: Carrier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."Carrier" AS ENUM (
    'PACZKOMATY',
    'DPD',
    'DPD_EMPIK',
    'ALLEGRO',
    'OSOBISTY',
    'BRAK',
    'BEZ_WYSYLKI',
    'INPOST_KURIER',
    'ORLEN_PACZKA',
    'GLS',
    'POCZTA_POLSKA'
);

--
-- Name: Channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."Channel" AS ENUM (
    'WOO',
    'ALLEGRO',
    'EMPIK',
    'EASYTOOLS',
    'BL_INNE',
    'RECZNE',
    'AI',
    'SHOPER',
    'PRESTASHOP',
    'IDOSELL'
);

--
-- Name: ChannelMode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ChannelMode" AS ENUM (
    'CIEN',
    'PRACA'
);

--
-- Name: ChannelWriteKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ChannelWriteKind" AS ENUM (
    'STATUS',
    'NADANIE'
);

--
-- Name: ChannelWriteState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ChannelWriteState" AS ENUM (
    'OCZEKUJE',
    'WYSYLANIE',
    'WYSLANE',
    'CIEN',
    'NIEJEDNOZNACZNY',
    'BLAD'
);

--
-- Name: CustomerDataSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CustomerDataSource" AS ENUM (
    'KANAL',
    'RECZNE',
    'PRZEPROWADZKA'
);

--
-- Name: ImportStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ImportStatus" AS ENUM (
    'RUNNING',
    'OK',
    'PARTIAL',
    'FAILED'
);

--
-- Name: InvoiceState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."InvoiceState" AS ENUM (
    'SENDING',
    'UNKNOWN',
    'ISSUED',
    'FAILED'
);

--
-- Name: JobStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."JobStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'DONE',
    'FAILED'
);

--
-- Name: MappingSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MappingSource" AS ENUM (
    'BL_LINK',
    'BL_ORDERS',
    'SKU',
    'NONE',
    'OVERRIDE',
    'MANUAL',
    'CONFIG'
);

--
-- Name: MappingState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MappingState" AS ENUM (
    'MAPPED',
    'UNMAPPED',
    'AMBIGUOUS'
);

--
-- Name: McpCallResult; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."McpCallResult" AS ENUM (
    'OK',
    'ODMOWA',
    'BLAD',
    'LIMIT'
);

--
-- Name: McpCallSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."McpCallSource" AS ENUM (
    'KLUCZ',
    'PANEL'
);

--
-- Name: MemberRole; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MemberRole" AS ENUM (
    'WLASCICIEL',
    'BIURO',
    'MAGAZYN'
);

--
-- Name: MovementSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MovementSource" AS ENUM (
    'WFIRMA_SYNC',
    'OWN_INVOICE',
    'BL_INVOICE',
    'OWN_CORRECTION',
    'ISSUED_WITHOUT_DOCUMENT',
    'STOCK_MISSING',
    'INITIAL_IMPORT',
    'OWN_DISPATCH',
    'OWN_RETURN'
);

--
-- Name: OrderPaymentKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OrderPaymentKind" AS ENUM (
    'WPLATA',
    'DOPLATA',
    'ZWROT'
);

--
-- Name: OrderStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OrderStatus" AS ENUM (
    'NOWE',
    'DO_REALIZACJI',
    'ZBIERANIE',
    'ZEBRANE',
    'SPAKOWANE',
    'DO_WYSLANIA',
    'DO_ODBIORU',
    'WYSLANE',
    'ODEBRANE',
    'ANULOWANE',
    'DO_WYJASNIENIA',
    'REKLAMACJA'
);

--
-- Name: OutboxKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."OutboxKind" AS ENUM (
    'AVAILABLE_CHANGED',
    'ALLOCATE',
    'WFIRMA_READ',
    'FORCE_PUSH'
);

--
-- Name: PackDrillFixState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PackDrillFixState" AS ENUM (
    'OPEN',
    'CLOSED',
    'WITHDRAWN'
);

--
-- Name: PackDrillOutcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PackDrillOutcome" AS ENUM (
    'SPAKOWANE',
    'NIE_SPAKOWANO'
);

--
-- Name: PaymentState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PaymentState" AS ENUM (
    'UNPAID',
    'PAID',
    'COD',
    'PARTIAL'
);

--
-- Name: PendingState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PendingState" AS ENUM (
    'IN_FLIGHT',
    'APPLIED',
    'CONFIRMED',
    'CANCELLED',
    'MANUAL'
);

--
-- Name: PendingType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PendingType" AS ENUM (
    'OWN_INVOICE',
    'BL_INVOICE',
    'ISSUED_WITHOUT_DOCUMENT',
    'STOCK_MISSING',
    'DAMAGED_RETURN'
);

--
-- Name: PrintFileFormat; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PrintFileFormat" AS ENUM (
    'pdf',
    'zpl'
);

--
-- Name: PrintJobSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PrintJobSource" AS ENUM (
    'PANEL',
    'TEST',
    'ZAPAS'
);

--
-- Name: PrintJobStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PrintJobStatus" AS ENUM (
    'PRZYGOTOWANIE',
    'OCZEKUJE',
    'OK',
    'BLAD',
    'WYGASLO'
);

--
-- Name: PrintJobType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."PrintJobType" AS ENUM (
    'karta',
    'lista',
    'spis',
    'etykieta'
);

--
-- Name: ProductDataSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductDataSource" AS ENUM (
    'RECZNE',
    'KANAL',
    'CSV',
    'BL',
    'WFIRMA'
);

--
-- Name: ProductKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ProductKind" AS ENUM (
    'STOCKED',
    'BUNDLE',
    'DIGITAL'
);

--
-- Name: ReservationState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReservationState" AS ENUM (
    'ACTIVE',
    'CONSUMING',
    'CONSUMED',
    'RELEASED'
);

--
-- Name: ReturnDisposition; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReturnDisposition" AS ENUM (
    'NA_STAN',
    'USZKODZONE',
    'BRAK'
);

--
-- Name: ReturnKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReturnKind" AS ENUM (
    'ZWROT',
    'KOREKTA',
    'REKLAMACJA'
);

--
-- Name: ReturnStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReturnStatus" AS ENUM (
    'ZGLOSZONY',
    'PRZYJETY',
    'KOREKTA',
    'ZAKONCZONY',
    'ODRZUCONY'
);

--
-- Name: ShipmentState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShipmentState" AS ENUM (
    'TWORZENIE',
    'UTWORZONA',
    'NIEJEDNOZNACZNA',
    'BLAD',
    'ANULOWANA'
);

--
-- Name: ShipmentTrackState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShipmentTrackState" AS ENUM (
    'UTWORZONA',
    'PRZEKAZANA',
    'W_DRODZE',
    'W_DORECZENIU',
    'W_PUNKCIE',
    'DORECZONA',
    'NIEUDANE_DORECZENIE',
    'ZWROT',
    'PROBLEM',
    'ANULOWANA',
    'NIEZNANY'
);

--
-- Name: ShippingModule; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShippingModule" AS ENUM (
    'BASE_COURIER',
    'WYSYLAM_Z_ALLEGRO',
    'BRAK',
    'INPOST_SHIPX',
    'DPD_BEZPOSREDNIO',
    'ORLEN_PACZKA',
    'GLS_ADE',
    'POCZTA_POLSKA'
);

--
-- Name: ShortageAction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShortageAction" AS ENUM (
    'WYSLIJ_RESZTE',
    'DOSLIJ',
    'POCZEKAJ',
    'ZAMIEN'
);

--
-- Name: ShortageState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ShortageState" AS ENUM (
    'OPEN',
    'SHIP_LATER',
    'RESOLVED',
    'REFUND_PENDING',
    'REFUNDED',
    'COD_REDUCED',
    'CANCELLED'
);

--
-- Name: StockImportState; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."StockImportState" AS ENUM (
    'W_TOKU',
    'GOTOWE',
    'ODRZUCONE',
    'NIEUDANE',
    'BEZ_WYNIKU',
    'NIEODCZYTANY'
);

--
-- Name: StockSource; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."StockSource" AS ENUM (
    'KOMPLETOR',
    'WFIRMA'
);

--
-- Name: Unit; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."Unit" AS ENUM (
    'SZT',
    'KG'
);

--
-- Name: automaty_najstarsza_transakcja(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.automaty_najstarsza_transakcja() RETURNS timestamp with time zone
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT min(a.xact_start)
  FROM pg_catalog.pg_stat_activity a
  WHERE a.datname = current_database()
    AND a.state <> 'idle'
    AND a.xact_start IS NOT NULL
    AND a.backend_type = 'client backend'
    AND a.pid <> pg_backend_pid()
    AND a.xact_start > now() - interval '15 minutes'
$$;

--
-- Name: rejestr_synchronizacji_uniewaznij(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rejestr_synchronizacji_uniewaznij() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM "ChannelSyncState" s
  WHERE s."organizationId" = OLD."organizationId" AND s."channel" = OLD."channel"
    AND s."channelAccountId" = OLD."channelAccountId" AND s."offerExternalId" = OLD."externalId";
  RETURN NULL;
END
$$;

--
-- Name: AiUsage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AiUsage" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    feature text NOT NULL,
    model text NOT NULL,
    "inputTokens" integer NOT NULL,
    "outputTokens" integer NOT NULL,
    "costGrosze" integer NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "AiUsage_nonneg" CHECK ((("inputTokens" >= 0) AND ("outputTokens" >= 0) AND ("costGrosze" >= 0)))
);

--
-- Name: Alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Alert" (
    id text NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    message text NOT NULL,
    "dedupeKey" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    data jsonb
);

--
-- Name: AlertDelivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AlertDelivery" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "alertId" text NOT NULL,
    kind text NOT NULL,
    "group" text NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone,
    "lastAttemptAt" timestamp(3) without time zone,
    "sentAt" timestamp(3) without time zone,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "AlertDelivery_state" CHECK ((state = ANY (ARRAY['SENDING'::text, 'SENT'::text, 'FAILED'::text, 'UNCERTAIN'::text])))
);

--
-- Name: ApiKey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ApiKey" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    "tokenHash" text NOT NULL,
    scopes text[],
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastUsedAt" timestamp(3) without time zone,
    "revokedAt" timestamp(3) without time zone,
    accounts jsonb,
    CONSTRAINT "ApiKey_obsluga_osobno" CHECK (((NOT ('obsluga:odczyt'::text = ANY (scopes))) OR (cardinality(scopes) = 1))),
    CONSTRAINT "ApiKey_scopes" CHECK (((scopes IS NOT NULL) AND (scopes <@ ARRAY['stany:odczyt'::text, 'zamowienia:odczyt'::text, 'zamowienia:zapis'::text, 'produkty:odczyt'::text, 'raporty:odczyt'::text, 'mcp:odczyt'::text, 'obsluga:odczyt'::text])))
);

--
-- Name: AuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AuditLog" (
    id text NOT NULL,
    entity text NOT NULL,
    "entityId" text NOT NULL,
    "actorId" text NOT NULL,
    before jsonb,
    after jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: AutomationCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AutomationCursor" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "lastAt" timestamp(3) without time zone NOT NULL,
    "lastId" text DEFAULT ''::text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: AutomationGroup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AutomationGroup" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    collapsed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "presetKey" text
);

--
-- Name: AutomationRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AutomationRule" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "groupId" text,
    name text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    event text NOT NULL,
    conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    "buttonLabel" text,
    "buttonPlaces" text[] DEFAULT ARRAY[]::text[],
    hidden boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "presetKey" text,
    description text
);

--
-- Name: AutomationRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AutomationRun" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "ruleId" text NOT NULL,
    "orderId" text NOT NULL,
    occasion text NOT NULL,
    event text NOT NULL,
    chain integer DEFAULT 0 NOT NULL,
    result text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: BlInvoiceSnapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlInvoiceSnapshot" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "blInvoiceId" integer NOT NULL,
    "blOrderId" integer NOT NULL,
    number text NOT NULL,
    "externalNumber" text,
    kind text,
    "dateAdd" timestamp(3) without time zone NOT NULL,
    "fetchedAt" timestamp(3) without time zone NOT NULL,
    "orderId" text,
    "appliedAt" timestamp(3) without time zone,
    outcome text,
    attempts integer DEFAULT 0 NOT NULL,
    "lastError" text,
    lines jsonb,
    "paymentName" text,
    "totalGross" numeric(12,2),
    "totalNet" numeric(12,2)
);

--
-- Name: BlJournalCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlJournalCursor" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "lastLogId" bigint DEFAULT 0 NOT NULL,
    "lastReadAt" timestamp(3) without time zone,
    "lastEventAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: BlOrderSnapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlOrderSnapshot" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "blOrderId" integer NOT NULL,
    "orderSource" text NOT NULL,
    "orderSourceId" text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalRef" text,
    "statusId" integer NOT NULL,
    "statusName" text,
    "deliveryMethod" text,
    "paymentDone" numeric(12,2),
    "dateAdd" timestamp(3) without time zone NOT NULL,
    "dateConfirmed" timestamp(3) without time zone,
    "fetchedAt" timestamp(3) without time zone NOT NULL,
    confirmed boolean,
    "totalGross" numeric(12,2),
    "statusChangedAt" timestamp(3) without time zone,
    "statusChangedToId" integer
);

--
-- Name: BlProduct; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BlProduct" (
    id text NOT NULL,
    "inventoryId" text NOT NULL,
    "parentId" text,
    sku text,
    ean text,
    name text NOT NULL,
    "isBundle" boolean DEFAULT false NOT NULL,
    "bundleProducts" jsonb,
    "taxRate" numeric(5,2),
    "priceGross" numeric(12,2),
    "stockAccounting" numeric(14,4),
    "stockBl" numeric(14,4),
    links jsonb,
    "wfirmaGoodIdLink" text,
    "productId" text,
    "importRunId" text NOT NULL,
    "importedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    locations jsonb,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: BundleComponent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BundleComponent" (
    "bundleId" text NOT NULL,
    "componentId" text NOT NULL,
    "qtyBase" integer NOT NULL,
    "priceShare" numeric(6,4),
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    CONSTRAINT "BundleComponent_qty_pos" CHECK (("qtyBase" > 0))
);

--
-- Name: CarrierPickup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CarrierPickup" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    carrier public."Carrier" NOT NULL,
    weekdays integer[],
    "pickupMinute" integer NOT NULL,
    "promiseUntilMinute" integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    example boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "CarrierPickup_minutes" CHECK (((("pickupMinute" >= 0) AND ("pickupMinute" <= 1439)) AND (("promiseUntilMinute" >= 0) AND ("promiseUntilMinute" <= 1439)))),
    CONSTRAINT "CarrierPickup_weekdays" CHECK (((weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]) AND (weekdays IS NOT NULL)))
);

--
-- Name: CarrierPickupEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CarrierPickupEvent" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    carrier public."Carrier" NOT NULL,
    "pickupDay" text NOT NULL,
    "arrivedAt" timestamp(3) without time zone NOT NULL,
    "actorId" text NOT NULL,
    "actorName" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: CarrierPickupShipping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CarrierPickupShipping" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "eventId" text NOT NULL,
    carrier public."Carrier" NOT NULL,
    state text NOT NULL,
    moved integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '[]'::jsonb NOT NULL,
    "doneAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "skippedPreview" integer DEFAULT 0 NOT NULL
);

--
-- Name: CarrierRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CarrierRule" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    priority integer NOT NULL,
    channel public."Channel",
    pattern text,
    carrier public."Carrier" NOT NULL,
    "shippingModule" public."ShippingModule" NOT NULL,
    "adapterKey" text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: ChannelAccountStatus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelAccountStatus" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "createdInPanel" boolean DEFAULT false NOT NULL,
    "testRequestedAt" timestamp(3) without time zone,
    "testCheckedAt" timestamp(3) without time zone,
    "testOk" boolean,
    "testMessage" text,
    "offersRequestedAt" timestamp(3) without time zone,
    "offersRunId" text,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "testMetaKeys" jsonb
);

--
-- Name: ChannelConfig; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelConfig" (
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    name text NOT NULL,
    "stockMode" public."ChannelMode" DEFAULT 'CIEN'::public."ChannelMode" NOT NULL,
    "statusMode" public."ChannelMode" DEFAULT 'CIEN'::public."ChannelMode" NOT NULL,
    "trackingMode" public."ChannelMode" DEFAULT 'CIEN'::public."ChannelMode" NOT NULL,
    "publishMode" public."ChannelMode" DEFAULT 'CIEN'::public."ChannelMode" NOT NULL,
    "defaultSafetyBuffer" integer DEFAULT 0 NOT NULL,
    "goBy" text,
    "goAt" timestamp(3) without time zone,
    "goRef" text,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "blStorageId" text,
    "adapterKey" text NOT NULL,
    "allowMassOffUntil" timestamp(3) without time zone,
    config jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: ChannelCursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelCursor" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "adapterKey" text NOT NULL,
    cursor text,
    "retryIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "coverageFrom" timestamp(3) without time zone,
    "firstPollAt" timestamp(3) without time zone,
    "lastPollStartedAt" timestamp(3) without time zone,
    "lastPollFinishedAt" timestamp(3) without time zone,
    "lastOkAt" timestamp(3) without time zone,
    "failingSince" timestamp(3) without time zone,
    "lastError" text,
    stats jsonb,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: ChannelHealth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelHealth" (
    channel public."Channel" NOT NULL,
    "failingSince" timestamp(3) without time zone,
    "lastOkAt" timestamp(3) without time zone,
    "lastBatchAt" timestamp(3) without time zone,
    "needsFullSync" boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "channelAccountId" text NOT NULL,
    "lastPassAt" timestamp(3) without time zone,
    "lastPassSent" integer DEFAULT 0 NOT NULL,
    "lastPassSkipped" integer DEFAULT 0 NOT NULL
);

--
-- Name: ChannelOffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelOffer" (
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalId" text NOT NULL,
    "productId" text NOT NULL,
    "qtyBasePerOffer" integer DEFAULT 1 NOT NULL,
    "safetyBuffer" integer,
    "lastPushedQty" integer,
    "lastPushedAt" timestamp(3) without time zone,
    "lastSeenQty" integer,
    active boolean DEFAULT true NOT NULL,
    "mappingSource" public."MappingSource" DEFAULT 'NONE'::public."MappingSource" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "deactivatedByImportAt" timestamp(3) without time zone,
    "needsApproval" boolean DEFAULT false NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: ChannelOfferImport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelOfferImport" (
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalId" text NOT NULL,
    sku text,
    ean text,
    name text,
    state public."MappingState" NOT NULL,
    source public."MappingSource" NOT NULL,
    "blProductIds" text[],
    "productId" text,
    "sales90dQty" integer DEFAULT 0 NOT NULL,
    "sales90dOrders" integer DEFAULT 0 NOT NULL,
    "lastSoldAt" timestamp(3) without time zone,
    notes text[],
    "importRunId" text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: ChannelOfferRead; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelOfferRead" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalId" text NOT NULL,
    sku text,
    ean text,
    name text,
    qty integer,
    active boolean DEFAULT true NOT NULL,
    state text NOT NULL,
    note text,
    "runId" text NOT NULL,
    "seenAt" timestamp(3) without time zone NOT NULL,
    "imageUrls" text[] DEFAULT ARRAY[]::text[],
    "priceGross" numeric(12,2),
    "vatRate" text
);

--
-- Name: ChannelOrderPoll; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelOrderPoll" (
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "startedAt" timestamp(3) without time zone NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    ok boolean DEFAULT false NOT NULL,
    error text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: ChannelOrderSnapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelOrderSnapshot" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalId" text NOT NULL,
    "channelNumber" text,
    revision text NOT NULL,
    "channelStatus" text NOT NULL,
    lifecycle text NOT NULL,
    "paymentState" public."PaymentState" NOT NULL,
    "totalGross" numeric(12,2) NOT NULL,
    currency text NOT NULL,
    "deliveryMethod" text,
    "lineCount" integer NOT NULL,
    warnings text[],
    "createdAtChannel" timestamp(3) without time zone NOT NULL,
    "firstSeenAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone NOT NULL,
    "ingestedRevision" text,
    "ingestOutcome" text,
    "skipReason" text,
    "orderId" text,
    "lastError" text,
    "errorCount" integer DEFAULT 0 NOT NULL,
    "blOrderId" integer,
    "blStatusId" integer,
    "blCheckedAt" timestamp(3) without time zone,
    "revisionSeenAt" timestamp(3) without time zone
);

--
-- Name: ChannelPushLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelPushLog" (
    id text NOT NULL,
    "offerId" text NOT NULL,
    channel public."Channel" NOT NULL,
    mode public."ChannelMode" NOT NULL,
    "targetQty" integer NOT NULL,
    "delayMs" integer NOT NULL,
    "createdAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "channelAccountId" text NOT NULL
);

--
-- Name: ChannelStockImport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelStockImport" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalRef" text NOT NULL,
    reference text NOT NULL,
    wierszy integer NOT NULL,
    state public."StockImportState" DEFAULT 'W_TOKU'::public."StockImportState" NOT NULL,
    przyjete integer,
    odrzucone integer,
    "kodyOdrzuconych" jsonb DEFAULT '[]'::jsonb NOT NULL,
    proby integer DEFAULT 0 NOT NULL,
    "nextCheckAt" timestamp(3) without time zone NOT NULL,
    "checkedAt" timestamp(3) without time zone,
    "doneAt" timestamp(3) without time zone,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "odczytWstrzymanyDo" timestamp(3) without time zone,
    uwaga text
);

--
-- Name: ChannelSyncState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelSyncState" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "offerExternalId" text NOT NULL,
    "contentHash" text,
    qty integer,
    "syncedAt" timestamp(3) without time zone,
    reference text,
    failures integer DEFAULT 0 NOT NULL,
    "lastError" text,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: ChannelWrite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ChannelWrite" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    kind public."ChannelWriteKind" NOT NULL,
    key text NOT NULL,
    "channelStatus" text,
    carrier text,
    "trackingUrl" text,
    mode public."ChannelMode" NOT NULL,
    state public."ChannelWriteState" DEFAULT 'OCZEKUJE'::public."ChannelWriteState" NOT NULL,
    reference text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone NOT NULL,
    "lockedAt" timestamp(3) without time zone,
    "lastError" text,
    result text,
    "createdAt" timestamp(3) without time zone NOT NULL,
    "doneAt" timestamp(3) without time zone
);

--
-- Name: CustomerDataSettings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CustomerDataSettings" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "zapisWCieniu" boolean DEFAULT false NOT NULL,
    "retencjaZFakturaLat" integer DEFAULT 5 NOT NULL,
    "retencjaBezFakturyMiesiecy" integer DEFAULT 36 NOT NULL,
    "trybRetencji" text DEFAULT 'RAPORT'::text NOT NULL,
    "ostatniPrzebiegAt" timestamp(3) without time zone,
    "ostatniPoTerminie" integer,
    "ostatnioUsunieto" integer,
    "updatedById" text,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: ImportIssue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ImportIssue" (
    id text NOT NULL,
    "runId" text NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    message text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: ImportRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ImportRun" (
    id text NOT NULL,
    kind text NOT NULL,
    status public."ImportStatus" DEFAULT 'RUNNING'::public."ImportStatus" NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    stats jsonb,
    error text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "reportMarkdown" text
);

--
-- Name: InboundEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."InboundEvent" (
    id text NOT NULL,
    source text NOT NULL,
    "eventKey" text NOT NULL,
    "receivedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "processedAt" timestamp(3) without time zone,
    error text,
    outcome text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: IntegrationHealth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IntegrationHealth" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "integrationKey" text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    "consecutiveFailures" integer DEFAULT 0 NOT NULL,
    "lastFailureAt" timestamp(3) without time zone,
    "lastError" text,
    "lastOkAt" timestamp(3) without time zone,
    "disabledAt" timestamp(3) without time zone,
    "disabledReason" text,
    "enableRequestedAt" timestamp(3) without time zone,
    "enableError" text,
    "enabledAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: IntegrationRateBucket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IntegrationRateBucket" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "integrationKey" text NOT NULL,
    scope text NOT NULL,
    tokens double precision NOT NULL,
    granted boolean DEFAULT true NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: IntegrationSecret; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."IntegrationSecret" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    channel public."Channel",
    "channelAccountId" text,
    name text NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    "authTag" bytea NOT NULL,
    "keyVersion" integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "IntegrationSecret_account_both" CHECK (((channel IS NULL) = ("channelAccountId" IS NULL)))
);

--
-- Name: Invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Invitation" (
    id text NOT NULL,
    "organizationId" text NOT NULL,
    email text NOT NULL,
    role public."MemberRole" NOT NULL,
    permissions text[] DEFAULT ARRAY[]::text[],
    "invitedById" text NOT NULL,
    "tokenHash" text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "acceptedAt" timestamp(3) without time zone,
    "acceptedById" text,
    "revokedAt" timestamp(3) without time zone,
    delivered boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deniedPermissions" text[] DEFAULT ARRAY[]::text[]
);

--
-- Name: InvoiceAttempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."InvoiceAttempt" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "packageNo" integer NOT NULL,
    "attemptNo" integer NOT NULL,
    "idExternal" text NOT NULL,
    state public."InvoiceState" DEFAULT 'SENDING'::public."InvoiceState" NOT NULL,
    "wfirmaDocId" text,
    "findTries" integer DEFAULT 0 NOT NULL,
    "nextFindAt" timestamp(3) without time zone,
    payload jsonb,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    number text,
    "documentOnly" boolean DEFAULT false NOT NULL
);

--
-- Name: InvoiceDryRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."InvoiceDryRun" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "blInvoiceId" integer NOT NULL,
    "orderId" text NOT NULL,
    "orderNumber" text NOT NULL,
    day text NOT NULL,
    result text NOT NULL,
    scope text NOT NULL,
    categories text[],
    diffs jsonb DEFAULT '[]'::jsonb NOT NULL,
    "oursGrossGr" integer NOT NULL,
    "oursNetGr" integer NOT NULL,
    "checkedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: InvoiceNumberSeries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."InvoiceNumberSeries" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    code text NOT NULL,
    pattern text NOT NULL,
    "resetPeriod" text NOT NULL,
    "periodKey" text NOT NULL,
    "lastNo" integer NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Job" (
    id text NOT NULL,
    kind text NOT NULL,
    payload jsonb,
    status public."JobStatus" DEFAULT 'PENDING'::public."JobStatus" NOT NULL,
    "runAfter" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "maxAttempts" integer DEFAULT 5 NOT NULL,
    "lastError" text,
    "lockedAt" timestamp(3) without time zone,
    "lockedBy" text,
    "dedupeKey" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: KsefInvoiceDraft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."KsefInvoiceDraft" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "packageNo" integer NOT NULL,
    status text NOT NULL,
    numer text,
    "seriaKod" text,
    "wersjaSchemy" text NOT NULL,
    xml text,
    "xmlSha256" text,
    "bruttoGr" integer NOT NULL,
    "nettoGr" integer NOT NULL,
    problems jsonb DEFAULT '[]'::jsonb NOT NULL,
    walidacja jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "dataWystawienia" text,
    "fakturaRef" text,
    "korygowanaId" text,
    "ksefNumer" text,
    "lastError" text,
    proby integer DEFAULT 0 NOT NULL,
    "przyjetaAt" timestamp(3) without time zone,
    "returnId" text DEFAULT ''::text NOT NULL,
    rodzaj text DEFAULT 'VAT'::text NOT NULL,
    "sesjaRef" text,
    srodowisko text,
    upo text,
    "wysylkaOd" timestamp(3) without time zone,
    "hasheWyslane" text[] DEFAULT ARRAY[]::text[],
    "invoiceHash" text,
    "nastepnaProbaOd" timestamp(3) without time zone,
    "ponowieniaAuto" integer DEFAULT 0 NOT NULL,
    "probyOdczytu" integer DEFAULT 0 NOT NULL,
    "probyUzupelnienia" integer DEFAULT 0 NOT NULL,
    przyczyna text,
    "wytworzonaAt" timestamp(3) without time zone
);

--
-- Name: MailDelivery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MailDelivery" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "dedupeKey" text NOT NULL,
    kind text NOT NULL,
    "plannedActionId" text,
    state text NOT NULL,
    recipient text,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone,
    "lastAttemptAt" timestamp(3) without time zone,
    "sentAt" timestamp(3) without time zone,
    "messageId" text,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: MailSettings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MailSettings" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "enabledAt" timestamp(3) without time zone,
    host text,
    port integer,
    security text DEFAULT 'STARTTLS'::text NOT NULL,
    username text,
    "fromEmail" text,
    "fromName" text,
    "officeEmail" text,
    senders jsonb DEFAULT '{}'::jsonb NOT NULL,
    "lastError" text,
    "lastErrorAt" timestamp(3) without time zone,
    "loginRejectedAt" timestamp(3) without time zone,
    "updatedById" text,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "bounceEnabled" boolean DEFAULT false NOT NULL,
    "imapHost" text,
    "imapPort" integer,
    "imapSecurity" text DEFAULT 'TLS'::text NOT NULL,
    "imapUsername" text,
    "imapFolder" text DEFAULT 'INBOX'::text NOT NULL,
    "bounceAddress" text,
    "bounceState" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "bounceCount" integer DEFAULT 0 NOT NULL,
    "bounceLastRunAt" timestamp(3) without time zone,
    "bounceLastError" text,
    "bounceLastErrorAt" timestamp(3) without time zone,
    "bounceLoginRejectedAt" timestamp(3) without time zone,
    "bounceRev" integer DEFAULT 0 NOT NULL
);

--
-- Name: MailTemplate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."MailTemplate" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    kind text NOT NULL,
    subject text,
    preheader text,
    heading text,
    blocks jsonb,
    "updatedById" text,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: McpCall; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."McpCall" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    source public."McpCallSource" NOT NULL,
    "apiKeyId" text,
    "userId" text,
    tool text NOT NULL,
    result public."McpCallResult" NOT NULL,
    "durationMs" integer NOT NULL,
    items integer,
    params text[],
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "McpCall_nonneg" CHECK ((("durationMs" >= 0) AND ((items IS NULL) OR (items >= 0)))),
    CONSTRAINT "McpCall_params" CHECK (((params IS NOT NULL) AND (cardinality(params) <= 20))),
    CONSTRAINT "McpCall_source" CHECK ((((source = 'KLUCZ'::public."McpCallSource") AND ("apiKeyId" IS NOT NULL)) OR ((source = 'PANEL'::public."McpCallSource") AND ("userId" IS NOT NULL))))
);

--
-- Name: Membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Membership" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "userId" text NOT NULL,
    role public."MemberRole" NOT NULL,
    permissions text[] DEFAULT ARRAY[]::text[],
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone,
    "deniedPermissions" text[] DEFAULT ARRAY[]::text[]
);

--
-- Name: NotificationSettings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."NotificationSettings" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "enabledAt" timestamp(3) without time zone,
    "zulipSite" text,
    "zulipBotEmail" text,
    routes jsonb DEFAULT '{}'::jsonb NOT NULL,
    "lastError" text,
    "lastErrorAt" timestamp(3) without time zone,
    "updatedById" text,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Order" (
    id text NOT NULL,
    channel public."Channel" NOT NULL,
    "channelAccountId" text NOT NULL,
    "externalId" text NOT NULL,
    "externalRevision" text,
    "channelStatusRank" integer,
    status public."OrderStatus" DEFAULT 'NOWE'::public."OrderStatus" NOT NULL,
    "statusBeforeClarify" public."OrderStatus",
    carrier public."Carrier",
    "shippingModule" public."ShippingModule",
    "deliveryMethod" text,
    "paymentState" public."PaymentState" NOT NULL,
    "paymentMethod" text NOT NULL,
    "totalGross" numeric(12,2) NOT NULL,
    "wantInvoiceNip" boolean DEFAULT false NOT NULL,
    "termsSeasonMode" boolean,
    "remindAt" timestamp(3) without time zone,
    "reminderSentAt" timestamp(3) without time zone,
    "reservationDeadline" timestamp(3) without time zone,
    "shortageWaitUntil" timestamp(3) without time zone,
    "pendingAction" text,
    "cancelReason" text,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    "parentOrderId" text,
    "packageNo" integer DEFAULT 1 NOT NULL,
    "blOrderId" integer,
    "createdAtChannel" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "channelNumber" text,
    "shippingCostGross" numeric(12,2),
    "sourceLabel" text,
    "companyStatus" text,
    "stockReleaseAt" timestamp(3) without time zone,
    "stockReleasedAt" timestamp(3) without time zone
);

--
-- Name: OrderBulkAction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderBulkAction" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    "orderIds" text[],
    state text DEFAULT 'CZEKA'::text NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    ok integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    results jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdBy" text NOT NULL,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    CONSTRAINT "OrderBulkAction_kind" CHECK ((kind = ANY (ARRAY['STATUS'::text, 'PRZESYLKI'::text, 'ETYKIETY'::text, 'PRZESYLKI_DRUK'::text, 'PRZESYLKI_ANULUJ'::text]))),
    CONSTRAINT "OrderBulkAction_state" CHECK ((state = ANY (ARRAY['CZEKA'::text, 'TRWA'::text, 'GOTOWE'::text, 'BLAD'::text])))
);

--
-- Name: OrderCardPrint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderCardPrint" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "orderCode" text NOT NULL,
    "printNo" integer NOT NULL,
    "printedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "printedBy" text NOT NULL,
    "dryRun" boolean NOT NULL,
    lines jsonb NOT NULL
);

--
-- Name: OrderCustomer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderCustomer" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "keyVersion" integer NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    "authTag" bytea NOT NULL,
    "emailHash" text,
    "phoneHash" text,
    "nipHash" text,
    source public."CustomerDataSource" NOT NULL,
    "fetchedAt" timestamp(3) without time zone NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    "retainUntil" timestamp(3) without time zone,
    "purgedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    country text,
    CONSTRAINT "OrderCustomer_country" CHECK (((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text)))
);

--
-- Name: OrderEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderEvent" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    kind text NOT NULL,
    "actorId" text NOT NULL,
    data jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: OrderLine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderLine" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "externalLineId" text NOT NULL,
    "offerId" text,
    "productId" text,
    qty integer NOT NULL,
    "qtyRejected" integer DEFAULT 0 NOT NULL,
    "unitPriceGross" numeric(12,2) NOT NULL,
    "vatRate" text,
    removed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "channelName" text,
    "channelSku" text,
    "channelEan" text,
    "qtyChannel" integer
);

--
-- Name: OrderNote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderNote" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    body text NOT NULL,
    "actorId" text NOT NULL,
    "showOnCard" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "editedAt" timestamp(3) without time zone,
    CONSTRAINT "OrderNote_body_len" CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000)))
);

--
-- Name: OrderPayment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderPayment" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    kind public."OrderPaymentKind" NOT NULL,
    amount numeric(12,2) NOT NULL,
    method text,
    "paidAt" timestamp(3) without time zone NOT NULL,
    "actorId" text NOT NULL,
    "exportedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "OrderPayment_amount_positive" CHECK ((amount > (0)::numeric))
);

--
-- Name: OrderStatusDef; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderStatusDef" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    "customerName" text,
    color text DEFAULT 'szary'::text NOT NULL,
    "groupKey" text,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "baseStatus" public."OrderStatus" NOT NULL,
    carriers public."Carrier"[] DEFAULT ARRAY[]::public."Carrier"[],
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: OrderStatusGroup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrderStatusGroup" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    collapsed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Organization" (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "Organization_id_format" CHECK ((id ~ '^[a-z0-9_-]{1,64}$'::text))
);

--
-- Name: OrganizationLogo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OrganizationLogo" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    plik text NOT NULL,
    ekran bytea NOT NULL,
    druk bytea NOT NULL,
    zrodlo text DEFAULT 'panel'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: OutboxEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."OutboxEvent" (
    id text NOT NULL,
    kind public."OutboxKind" NOT NULL,
    "productId" text NOT NULL,
    version integer,
    "createdAt" timestamp(3) without time zone NOT NULL,
    "processedAt" timestamp(3) without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "lastError" text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "offerId" text
);

--
-- Name: PackBasket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PackBasket" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    "orderId" text,
    "assignedAt" timestamp(3) without time zone,
    "assignedById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: PackDrill; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PackDrill" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "printId" text,
    "actorId" text NOT NULL,
    "startedAt" timestamp(3) without time zone NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    outcome public."PackDrillOutcome",
    "parcelSize" text,
    lines jsonb
);

--
-- Name: PackDrillFix; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PackDrillFix" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "drillId" text NOT NULL,
    "orderId" text NOT NULL,
    "orderLineId" text NOT NULL,
    "productId" text NOT NULL,
    "qtyBase" integer NOT NULL,
    "actorId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    state public."PackDrillFixState" DEFAULT 'OPEN'::public."PackDrillFixState" NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "closedBy" text,
    "withdrawnAt" timestamp(3) without time zone,
    "withdrawnBy" text
);

--
-- Name: PackingZoneDef; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PackingZoneDef" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    color text DEFAULT 'szary'::text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: PasswordReset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PasswordReset" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "organizationId" text NOT NULL,
    "tokenHash" text NOT NULL,
    "sealedToken" bytea,
    "sealedIv" bytea,
    "sealedTag" bytea,
    "keyVersion" integer,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "usedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: PendingMovement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingMovement" (
    id text NOT NULL,
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    delta integer NOT NULL,
    type public."PendingType" NOT NULL,
    state public."PendingState" NOT NULL,
    "sentAt" timestamp(3) without time zone NOT NULL,
    "effectiveAt" timestamp(3) without time zone,
    "wfirmaDocId" text,
    "wzQty" integer,
    "orderId" text,
    "invoiceId" text,
    "confirmedAt" timestamp(3) without time zone,
    "idempotencyKey" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "nextWzReadAt" timestamp(3) without time zone,
    "wzTries" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "PendingMovement_delta_neg" CHECK ((delta < 0))
);

--
-- Name: PlannedAction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PlannedAction" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    rule text NOT NULL,
    "targetType" public."ActionTarget" NOT NULL,
    "targetId" text NOT NULL,
    occasion text NOT NULL,
    mode public."ActionMode" NOT NULL,
    state public."ActionState" DEFAULT 'PLANNED'::public."ActionState" NOT NULL,
    reason text,
    vars jsonb DEFAULT '{}'::jsonb NOT NULL,
    "dueAt" timestamp(3) without time zone NOT NULL,
    "resolvedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: PreparedShipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PreparedShipment" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "packageNo" integer NOT NULL,
    "adapterKey" text NOT NULL,
    carrier public."Carrier" NOT NULL,
    "courierCode" text,
    "parcelSize" text,
    "sideXCm" integer,
    "sideYCm" integer,
    "sideZCm" integer,
    "weightKg" numeric(8,3),
    "codAmount" numeric(12,2),
    problems jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: PrintJob; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PrintJob" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "stationId" text NOT NULL,
    type public."PrintJobType" NOT NULL,
    source public."PrintJobSource" NOT NULL,
    role text NOT NULL,
    format public."PrintFileFormat" NOT NULL,
    copies integer DEFAULT 1 NOT NULL,
    status public."PrintJobStatus" DEFAULT 'PRZYGOTOWANIE'::public."PrintJobStatus" NOT NULL,
    "idempotencyKey" text,
    "fallbackOfId" text,
    summary text,
    "resultMessage" text,
    "resultPrinter" text,
    "reportedAt" timestamp(3) without time zone,
    "requestedBy" text,
    "orderIds" text[] DEFAULT ARRAY[]::text[],
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: PrintJobFile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PrintJobFile" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "jobId" text NOT NULL,
    format public."PrintFileFormat" NOT NULL,
    data bytea NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: PrintStation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PrintStation" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    "tokenHash" text,
    "tokenCreatedAt" timestamp(3) without time zone,
    routing jsonb DEFAULT '{}'::jsonb NOT NULL,
    printers jsonb DEFAULT '[]'::jsonb NOT NULL,
    "agentVersion" text,
    "lastReportAt" timestamp(3) without time zone,
    "disabledAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Product" (
    id text NOT NULL,
    sku text NOT NULL,
    kind public."ProductKind" NOT NULL,
    unit public."Unit" NOT NULL,
    "groupId" text,
    "wfirmaGoodId" text,
    "wfirmaType" text,
    "nameAccounting" text NOT NULL,
    "priceNet" numeric(12,2),
    "priceGross" numeric(12,2),
    "vatRate" text,
    "purchasePriceNet" numeric(12,4),
    "wfirmaSyncedAt" timestamp(3) without time zone,
    "wfirmaHash" text,
    ean text,
    title text NOT NULL,
    description text,
    details jsonb,
    "lowStockThreshold" integer,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "packingZone" text,
    "dataSource" public."ProductDataSource" DEFAULT 'RECZNE'::public."ProductDataSource" NOT NULL,
    "heightCm" numeric(7,1),
    "lengthCm" numeric(7,1),
    "weightG" integer,
    "widthCm" numeric(7,1),
    CONSTRAINT "Product_dims_nonneg" CHECK (((("lengthCm" IS NULL) OR ("lengthCm" >= (0)::numeric)) AND (("widthCm" IS NULL) OR ("widthCm" >= (0)::numeric)) AND (("heightCm" IS NULL) OR ("heightCm" >= (0)::numeric)))),
    CONSTRAINT "Product_weightG_nonneg" CHECK ((("weightG" IS NULL) OR ("weightG" >= 0)))
);

--
-- Name: ProductImage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProductImage" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "productId" text NOT NULL,
    "position" integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    bytes integer NOT NULL,
    "sourceUrl" text,
    "actorId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ProductImage_position_nonneg" CHECK (("position" >= 0))
);

--
-- Name: ProductImageData; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProductImageData" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "imageId" text NOT NULL,
    "productId" text NOT NULL,
    "full" bytea NOT NULL,
    mini bytea NOT NULL,
    druk bytea NOT NULL,
    zrodlo text DEFAULT 'panel'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "archivedAt" timestamp(3) without time zone,
    CONSTRAINT "ProductImageData_rozmiar" CHECK ((((octet_length("full") >= 1) AND (octet_length("full") <= 15728640)) AND ((octet_length(mini) >= 1) AND (octet_length(mini) <= 1048576)) AND ((octet_length(druk) >= 1) AND (octet_length(druk) <= 1048576)))),
    CONSTRAINT "ProductImageData_zrodlo" CHECK ((zrodlo = ANY (ARRAY['panel'::text, 'dysk'::text])))
);
ALTER TABLE ONLY public."ProductImageData" ALTER COLUMN "full" SET STORAGE EXTERNAL;
ALTER TABLE ONLY public."ProductImageData" ALTER COLUMN mini SET STORAGE EXTERNAL;
ALTER TABLE ONLY public."ProductImageData" ALTER COLUMN druk SET STORAGE EXTERNAL;

--
-- Name: ProductZoneRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ProductZoneRule" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    priority integer NOT NULL,
    pattern text NOT NULL,
    zone text NOT NULL,
    example boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Reservation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Reservation" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "orderLineId" text NOT NULL,
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    "qtyBase" integer NOT NULL,
    state public."ReservationState" DEFAULT 'ACTIVE'::public."ReservationState" NOT NULL,
    "releasedReason" text,
    "invoiceId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "consumedAt" timestamp(3) without time zone,
    "releasedAt" timestamp(3) without time zone,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    CONSTRAINT "Reservation_qty_pos" CHECK (("qtyBase" > 0))
);

--
-- Name: ReservationPolicy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReservationPolicy" (
    "seasonMode" boolean DEFAULT false NOT NULL,
    "normalReminderBusinessDays" integer DEFAULT 2 NOT NULL,
    "normalReleaseBusinessDays" integer DEFAULT 5 NOT NULL,
    "seasonReminderBusinessDays" integer DEFAULT 1 NOT NULL,
    "seasonReleaseBusinessDays" integer DEFAULT 3 NOT NULL,
    "allOutOfStockWaitBusinessDays" integer DEFAULT 3 NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "failedOnlinePaymentHoldHours" integer DEFAULT 2 NOT NULL,
    "failedOnlinePaymentReminderDays" integer DEFAULT 1 NOT NULL
);

--
-- Name: Return; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Return" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    kind public."ReturnKind" DEFAULT 'ZWROT'::public."ReturnKind" NOT NULL,
    status public."ReturnStatus" DEFAULT 'ZGLOSZONY'::public."ReturnStatus" NOT NULL,
    "invoiceDocId" text,
    note text,
    "correctionTry" integer DEFAULT 0 NOT NULL,
    "correctionState" public."InvoiceState",
    "correctionDocId" text,
    "findTries" integer DEFAULT 0 NOT NULL,
    "nextFindAt" timestamp(3) without time zone,
    "lastError" text,
    "receivedAt" timestamp(3) without time zone,
    "closedAt" timestamp(3) without time zone,
    "moneyRefundedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "createdBy" text,
    "externalId" text,
    reason text,
    source text DEFAULT 'PANEL'::text NOT NULL,
    CONSTRAINT "Return_source" CHECK ((source = ANY (ARRAY['PANEL'::text, 'ALLEGRO'::text])))
);

--
-- Name: ReturnLine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReturnLine" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "returnId" text NOT NULL,
    "orderLineId" text NOT NULL,
    "productId" text NOT NULL,
    qty integer NOT NULL,
    disposition public."ReturnDisposition",
    "pzQty" integer,
    "pzConfirmedAt" timestamp(3) without time zone,
    CONSTRAINT "ReturnLine_pz_nonneg" CHECK ((("pzQty" IS NULL) OR ("pzQty" >= 0))),
    CONSTRAINT "ReturnLine_qty_pos" CHECK ((qty > 0))
);

--
-- Name: ReturnPhoto; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReturnPhoto" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "returnId" text NOT NULL,
    content bytea NOT NULL,
    mime text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ReturnPhoto_mime" CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/webp'::text]))),
    CONSTRAINT "ReturnPhoto_rozmiar" CHECK (((octet_length(content) >= 1) AND (octet_length(content) <= 5242880)))
);
ALTER TABLE ONLY public."ReturnPhoto" ALTER COLUMN content SET STORAGE EXTERNAL;

--
-- Name: Session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Session" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "organizationId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "userAgent" text
);

--
-- Name: ShadowDailyCheck; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ShadowDailyCheck" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    kind text NOT NULL,
    day text NOT NULL,
    final boolean NOT NULL,
    ok boolean NOT NULL,
    "checkedAt" timestamp(3) without time zone NOT NULL,
    stats jsonb NOT NULL
);

--
-- Name: ShadowJobState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ShadowJobState" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    job text NOT NULL,
    "lastOkAt" timestamp(3) without time zone NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Shipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Shipment" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "packageNo" integer NOT NULL,
    reference text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    state public."ShipmentState" DEFAULT 'TWORZENIE'::public."ShipmentState" NOT NULL,
    "adapterKey" text NOT NULL,
    carrier public."Carrier" NOT NULL,
    "parcelSize" text,
    "weightKg" numeric(8,3),
    "codAmount" numeric(12,2),
    "externalRef" text,
    "trackingNumber" text,
    "labelFormat" text,
    "labelCiphertext" bytea,
    "labelIv" bytea,
    "labelAuthTag" bytea,
    "labelKeyVersion" integer,
    "labelFetchedAt" timestamp(3) without time zone,
    "labelError" text,
    "lastError" text,
    "failureKind" text,
    "requestedBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "carrierStatus" text,
    "trackedAt" timestamp(3) without time zone,
    "accountSuffix" text,
    "trackingStoppedAt" timestamp(3) without time zone,
    "trackingUnknownSince" timestamp(3) without time zone,
    "deliveredAt" timestamp(3) without time zone,
    "handedOverAt" timestamp(3) without time zone,
    "nextTrackAt" timestamp(3) without time zone,
    "trackState" public."ShipmentTrackState",
    "trackStateSince" timestamp(3) without time zone,
    "trackFailures" integer DEFAULT 0 NOT NULL,
    "trackRulesPending" boolean DEFAULT false NOT NULL,
    "trackRulesAt" timestamp(3) without time zone,
    "trackRulesFailures" integer DEFAULT 0 NOT NULL,
    "extraNo" integer DEFAULT 0 NOT NULL,
    "extraKind" text,
    "extraReason" text,
    "extraRuleId" text,
    "extraCostNet" numeric(12,2),
    CONSTRAINT "Shipment_attempt" CHECK ((attempt >= 1)),
    CONSTRAINT "Shipment_extra" CHECK (((("extraNo" = 0) AND ("extraKind" IS NULL) AND ("extraReason" IS NULL) AND ("extraRuleId" IS NULL) AND ("extraCostNet" IS NULL)) OR (("extraNo" >= 1) AND ("extraKind" = ANY (ARRAY['DOSYLKA'::text, 'ZASTEPCZA'::text, 'DODATKOWA'::text])) AND ("extraReason" IS NOT NULL) AND (length(btrim("extraReason")) >= 5) AND (("extraCostNet" IS NULL) OR ("extraCostNet" >= (0)::numeric))))),
    CONSTRAINT "Shipment_failureKind" CHECK ((("failureKind" IS NULL) OR ("failureKind" = ANY (ARRAY['PRZEJSCIOWY'::text, 'TRWALY'::text, 'NIEJEDNOZNACZNY'::text])))),
    CONSTRAINT "Shipment_label" CHECK (((("labelCiphertext" IS NULL) AND ("labelIv" IS NULL) AND ("labelAuthTag" IS NULL) AND ("labelKeyVersion" IS NULL)) OR (("labelCiphertext" IS NOT NULL) AND ("labelIv" IS NOT NULL) AND ("labelAuthTag" IS NOT NULL) AND ("labelKeyVersion" IS NOT NULL) AND ("labelFormat" IS NOT NULL)))),
    CONSTRAINT "Shipment_labelFormat" CHECK ((("labelFormat" IS NULL) OR ("labelFormat" = ANY (ARRAY['PDF'::text, 'ZPL'::text]))))
);

--
-- Name: ShipmentTrackEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ShipmentTrackEvent" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "shipmentId" text NOT NULL,
    state public."ShipmentTrackState" NOT NULL,
    "carrierCode" text DEFAULT ''::text NOT NULL,
    "carrierStatus" text,
    "occurredAt" timestamp(3) without time zone NOT NULL,
    "observedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "ShipmentTrackEvent_carrierCode_len" CHECK ((char_length("carrierCode") <= 60)),
    CONSTRAINT "ShipmentTrackEvent_carrierStatus_len" CHECK ((("carrierStatus" IS NULL) OR (char_length("carrierStatus") <= 60)))
);

--
-- Name: Shortage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Shortage" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "orderLineId" text NOT NULL,
    "productId" text NOT NULL,
    "qtyBase" integer NOT NULL,
    state public."ShortageState" DEFAULT 'OPEN'::public."ShortageState" NOT NULL,
    "reservationId" text,
    note text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "resolvedAt" timestamp(3) without time zone,
    "resolvedBy" text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    CONSTRAINT "Shortage_qty_pos" CHECK (("qtyBase" > 0))
);

--
-- Name: ShortageDecision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ShortageDecision" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    id text NOT NULL,
    "orderId" text NOT NULL,
    "orderLineId" text NOT NULL,
    action public."ShortageAction" NOT NULL,
    "replacementProductId" text,
    "dryRun" boolean NOT NULL,
    "actorId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: Stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Stock" (
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    "wfirmaCount" integer NOT NULL,
    "wfirmaReadAt" timestamp(3) without time zone NOT NULL,
    "pendingDelta" integer DEFAULT 0 NOT NULL,
    physical integer NOT NULL,
    reserved integer DEFAULT 0 NOT NULL,
    "overcommitSince" timestamp(3) without time zone,
    "allocationPendingSince" timestamp(3) without time zone,
    version integer DEFAULT 0 NOT NULL,
    "overcommitListedAt" timestamp(3) without time zone,
    location text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    CONSTRAINT "Stock_pending_nonpos" CHECK (("pendingDelta" <= 0)),
    CONSTRAINT "Stock_physical_mirror" CHECK ((physical = ("wfirmaCount" + "pendingDelta"))),
    CONSTRAINT "Stock_reserved_nonneg" CHECK ((reserved >= 0))
);

--
-- Name: StockMovement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StockMovement" (
    id text NOT NULL,
    "productId" text NOT NULL,
    "warehouseId" text NOT NULL,
    "deltaPhysical" integer NOT NULL,
    source public."MovementSource" NOT NULL,
    reason text NOT NULL,
    "actorId" text NOT NULL,
    "orderId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: StockSyncJob; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."StockSyncJob" (
    "offerId" text NOT NULL,
    channel public."Channel" NOT NULL,
    "targetQty" integer NOT NULL,
    "sourceVersion" integer NOT NULL,
    "computedAt" timestamp(3) without time zone NOT NULL,
    force boolean DEFAULT false NOT NULL,
    "firstChangeAt" timestamp(3) without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone NOT NULL,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "channelAccountId" text NOT NULL
);

--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    "passwordHash" text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "failedLogins" integer DEFAULT 0 NOT NULL,
    "lockedUntil" timestamp(3) without time zone,
    "lastLoginAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "mustChangePassword" boolean DEFAULT false NOT NULL,
    gestosc text,
    "kolumnyTabel" jsonb,
    "ukryteAlerty" jsonb
);

--
-- Name: Warehouse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Warehouse" (
    id text NOT NULL,
    name text NOT NULL,
    "wfirmaWarehouseId" text,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "stockSource" public."StockSource"
);

--
-- Name: WfirmaGood; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WfirmaGood" (
    id text NOT NULL,
    code text,
    name text NOT NULL,
    type text NOT NULL,
    unit text NOT NULL,
    "vatCodeId" text,
    "vatRate" text,
    "priceNetRetail" numeric(12,2),
    "priceGrossRetail" numeric(12,2),
    "purchasePriceNet" numeric(12,4),
    count numeric(14,4),
    "warehouseId" text,
    ean text,
    visibility text,
    modified text,
    "importRunId" text NOT NULL,
    "importedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL
);

--
-- Name: WfirmaQueueState; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WfirmaQueueState" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "pausedUntil" timestamp(3) without time zone,
    "pauseReason" text,
    "fullReadDueSince" timestamp(3) without time zone,
    "fullReadPage" integer DEFAULT 0 NOT NULL,
    "fullReadSentAt" timestamp(3) without time zone,
    "lastFullReadAt" timestamp(3) without time zone,
    "findCheckOkAt" timestamp(3) without time zone,
    "findCheckFailedAt" timestamp(3) without time zone,
    "otherWhReportAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "findCheckCorrOkAt" timestamp(3) without time zone,
    "findCheckCorrFailedAt" timestamp(3) without time zone,
    "runLockId" text,
    "runLockUntil" timestamp(3) without time zone,
    "lastNightSyncAt" timestamp(3) without time zone
);

--
-- Name: WfirmaWzSnapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WfirmaWzSnapshot" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    "wfirmaDocId" text NOT NULL,
    number text NOT NULL,
    "docDate" text NOT NULL,
    "createdInWfirma" timestamp(3) without time zone NOT NULL,
    "wfirmaWarehouseId" text,
    "invoiceId" text,
    "invoiceNumber" text,
    lines jsonb NOT NULL,
    "orderId" text,
    "linkedBy" text,
    outcome text,
    candidates integer,
    "fetchedAt" timestamp(3) without time zone NOT NULL,
    "settledAt" timestamp(3) without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "lastError" text,
    "createdRaw" text,
    description text
);

--
-- Name: WzAttempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WzAttempt" (
    "organizationId" text DEFAULT current_setting('app.org_id'::text) NOT NULL,
    ref text NOT NULL,
    "orderId" text NOT NULL,
    state text NOT NULL,
    "docId" text,
    number text,
    attempts integer DEFAULT 1 NOT NULL,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

--
-- Name: AiUsage AiUsage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AiUsage"
    ADD CONSTRAINT "AiUsage_pkey" PRIMARY KEY (id);

--
-- Name: AlertDelivery AlertDelivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AlertDelivery"
    ADD CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY (id);

--
-- Name: Alert Alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Alert"
    ADD CONSTRAINT "Alert_pkey" PRIMARY KEY (id);

--
-- Name: ApiKey ApiKey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApiKey"
    ADD CONSTRAINT "ApiKey_pkey" PRIMARY KEY (id);

--
-- Name: AuditLog AuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);

--
-- Name: AutomationCursor AutomationCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationCursor"
    ADD CONSTRAINT "AutomationCursor_pkey" PRIMARY KEY ("organizationId");

--
-- Name: AutomationGroup AutomationGroup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationGroup"
    ADD CONSTRAINT "AutomationGroup_pkey" PRIMARY KEY (id);

--
-- Name: AutomationRule AutomationRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRule"
    ADD CONSTRAINT "AutomationRule_pkey" PRIMARY KEY (id);

--
-- Name: AutomationRun AutomationRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRun"
    ADD CONSTRAINT "AutomationRun_pkey" PRIMARY KEY (id);

--
-- Name: BlInvoiceSnapshot BlInvoiceSnapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlInvoiceSnapshot"
    ADD CONSTRAINT "BlInvoiceSnapshot_pkey" PRIMARY KEY ("organizationId", "blInvoiceId");

--
-- Name: BlJournalCursor BlJournalCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlJournalCursor"
    ADD CONSTRAINT "BlJournalCursor_pkey" PRIMARY KEY ("organizationId");

--
-- Name: BlOrderSnapshot BlOrderSnapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlOrderSnapshot"
    ADD CONSTRAINT "BlOrderSnapshot_pkey" PRIMARY KEY ("organizationId", "blOrderId");

--
-- Name: BlProduct BlProduct_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlProduct"
    ADD CONSTRAINT "BlProduct_pkey" PRIMARY KEY ("organizationId", id);

--
-- Name: BundleComponent BundleComponent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BundleComponent"
    ADD CONSTRAINT "BundleComponent_pkey" PRIMARY KEY ("bundleId", "componentId");

--
-- Name: CarrierPickupEvent CarrierPickupEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickupEvent"
    ADD CONSTRAINT "CarrierPickupEvent_pkey" PRIMARY KEY (id);

--
-- Name: CarrierPickupShipping CarrierPickupShipping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickupShipping"
    ADD CONSTRAINT "CarrierPickupShipping_pkey" PRIMARY KEY ("organizationId", "eventId");

--
-- Name: CarrierPickup CarrierPickup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickup"
    ADD CONSTRAINT "CarrierPickup_pkey" PRIMARY KEY ("organizationId", carrier);

--
-- Name: CarrierRule CarrierRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierRule"
    ADD CONSTRAINT "CarrierRule_pkey" PRIMARY KEY (id);

--
-- Name: ChannelAccountStatus ChannelAccountStatus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelAccountStatus"
    ADD CONSTRAINT "ChannelAccountStatus_pkey" PRIMARY KEY ("organizationId", channel, "channelAccountId");

--
-- Name: ChannelConfig ChannelConfig_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelConfig"
    ADD CONSTRAINT "ChannelConfig_pkey" PRIMARY KEY ("organizationId", channel, "channelAccountId");

--
-- Name: ChannelCursor ChannelCursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelCursor"
    ADD CONSTRAINT "ChannelCursor_pkey" PRIMARY KEY ("organizationId", channel, "channelAccountId");

--
-- Name: ChannelHealth ChannelHealth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelHealth"
    ADD CONSTRAINT "ChannelHealth_pkey" PRIMARY KEY ("organizationId", channel, "channelAccountId");

--
-- Name: ChannelOfferImport ChannelOfferImport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOfferImport"
    ADD CONSTRAINT "ChannelOfferImport_pkey" PRIMARY KEY (id);

--
-- Name: ChannelOfferRead ChannelOfferRead_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOfferRead"
    ADD CONSTRAINT "ChannelOfferRead_pkey" PRIMARY KEY (id);

--
-- Name: ChannelOffer ChannelOffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOffer"
    ADD CONSTRAINT "ChannelOffer_pkey" PRIMARY KEY (id);

--
-- Name: ChannelOrderPoll ChannelOrderPoll_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOrderPoll"
    ADD CONSTRAINT "ChannelOrderPoll_pkey" PRIMARY KEY (id);

--
-- Name: ChannelOrderSnapshot ChannelOrderSnapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOrderSnapshot"
    ADD CONSTRAINT "ChannelOrderSnapshot_pkey" PRIMARY KEY (id);

--
-- Name: ChannelPushLog ChannelPushLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelPushLog"
    ADD CONSTRAINT "ChannelPushLog_pkey" PRIMARY KEY (id);

--
-- Name: ChannelStockImport ChannelStockImport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelStockImport"
    ADD CONSTRAINT "ChannelStockImport_pkey" PRIMARY KEY (id);

--
-- Name: ChannelSyncState ChannelSyncState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelSyncState"
    ADD CONSTRAINT "ChannelSyncState_pkey" PRIMARY KEY ("organizationId", channel, "channelAccountId", "offerExternalId");

--
-- Name: ChannelWrite ChannelWrite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelWrite"
    ADD CONSTRAINT "ChannelWrite_pkey" PRIMARY KEY (id);

--
-- Name: CustomerDataSettings CustomerDataSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CustomerDataSettings"
    ADD CONSTRAINT "CustomerDataSettings_pkey" PRIMARY KEY ("organizationId");

--
-- Name: ImportIssue ImportIssue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImportIssue"
    ADD CONSTRAINT "ImportIssue_pkey" PRIMARY KEY (id);

--
-- Name: ImportRun ImportRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImportRun"
    ADD CONSTRAINT "ImportRun_pkey" PRIMARY KEY (id);

--
-- Name: InboundEvent InboundEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InboundEvent"
    ADD CONSTRAINT "InboundEvent_pkey" PRIMARY KEY (id);

--
-- Name: IntegrationHealth IntegrationHealth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationHealth"
    ADD CONSTRAINT "IntegrationHealth_pkey" PRIMARY KEY ("organizationId", "integrationKey");

--
-- Name: IntegrationRateBucket IntegrationRateBucket_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationRateBucket"
    ADD CONSTRAINT "IntegrationRateBucket_pkey" PRIMARY KEY ("organizationId", "integrationKey", scope);

--
-- Name: IntegrationSecret IntegrationSecret_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationSecret"
    ADD CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY (id);

--
-- Name: Invitation Invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_pkey" PRIMARY KEY (id);

--
-- Name: InvoiceAttempt InvoiceAttempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceAttempt"
    ADD CONSTRAINT "InvoiceAttempt_pkey" PRIMARY KEY (id);

--
-- Name: InvoiceDryRun InvoiceDryRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceDryRun"
    ADD CONSTRAINT "InvoiceDryRun_pkey" PRIMARY KEY ("organizationId", "blInvoiceId");

--
-- Name: InvoiceNumberSeries InvoiceNumberSeries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceNumberSeries"
    ADD CONSTRAINT "InvoiceNumberSeries_pkey" PRIMARY KEY ("organizationId", code, "periodKey");

--
-- Name: Job Job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Job"
    ADD CONSTRAINT "Job_pkey" PRIMARY KEY (id);

--
-- Name: KsefInvoiceDraft KsefInvoiceDraft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."KsefInvoiceDraft"
    ADD CONSTRAINT "KsefInvoiceDraft_pkey" PRIMARY KEY (id);

--
-- Name: MailDelivery MailDelivery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailDelivery"
    ADD CONSTRAINT "MailDelivery_pkey" PRIMARY KEY (id);

--
-- Name: MailSettings MailSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailSettings"
    ADD CONSTRAINT "MailSettings_pkey" PRIMARY KEY ("organizationId");

--
-- Name: MailTemplate MailTemplate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailTemplate"
    ADD CONSTRAINT "MailTemplate_pkey" PRIMARY KEY ("organizationId", kind);

--
-- Name: McpCall McpCall_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpCall"
    ADD CONSTRAINT "McpCall_pkey" PRIMARY KEY (id);

--
-- Name: Membership Membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Membership"
    ADD CONSTRAINT "Membership_pkey" PRIMARY KEY ("organizationId", "userId");

--
-- Name: NotificationSettings NotificationSettings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."NotificationSettings"
    ADD CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("organizationId");

--
-- Name: OrderBulkAction OrderBulkAction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderBulkAction"
    ADD CONSTRAINT "OrderBulkAction_pkey" PRIMARY KEY (id);

--
-- Name: OrderCardPrint OrderCardPrint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCardPrint"
    ADD CONSTRAINT "OrderCardPrint_pkey" PRIMARY KEY (id);

--
-- Name: OrderCustomer OrderCustomer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCustomer"
    ADD CONSTRAINT "OrderCustomer_pkey" PRIMARY KEY (id);

--
-- Name: OrderEvent OrderEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderEvent"
    ADD CONSTRAINT "OrderEvent_pkey" PRIMARY KEY (id);

--
-- Name: OrderLine OrderLine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_pkey" PRIMARY KEY (id);

--
-- Name: OrderNote OrderNote_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderNote"
    ADD CONSTRAINT "OrderNote_pkey" PRIMARY KEY (id);

--
-- Name: OrderPayment OrderPayment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderPayment"
    ADD CONSTRAINT "OrderPayment_pkey" PRIMARY KEY (id);

--
-- Name: OrderStatusDef OrderStatusDef_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderStatusDef"
    ADD CONSTRAINT "OrderStatusDef_pkey" PRIMARY KEY ("organizationId", key);

--
-- Name: OrderStatusGroup OrderStatusGroup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderStatusGroup"
    ADD CONSTRAINT "OrderStatusGroup_pkey" PRIMARY KEY ("organizationId", key);

--
-- Name: Order Order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);

--
-- Name: OrganizationLogo OrganizationLogo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrganizationLogo"
    ADD CONSTRAINT "OrganizationLogo_pkey" PRIMARY KEY ("organizationId");

--
-- Name: Organization Organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Organization"
    ADD CONSTRAINT "Organization_pkey" PRIMARY KEY (id);

--
-- Name: OutboxEvent OutboxEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OutboxEvent"
    ADD CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY (id);

--
-- Name: PackBasket PackBasket_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackBasket"
    ADD CONSTRAINT "PackBasket_pkey" PRIMARY KEY (id);

--
-- Name: PackDrillFix PackDrillFix_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrillFix"
    ADD CONSTRAINT "PackDrillFix_pkey" PRIMARY KEY (id);

--
-- Name: PackDrill PackDrill_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrill"
    ADD CONSTRAINT "PackDrill_pkey" PRIMARY KEY (id);

--
-- Name: PackingZoneDef PackingZoneDef_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackingZoneDef"
    ADD CONSTRAINT "PackingZoneDef_pkey" PRIMARY KEY ("organizationId", key);

--
-- Name: PasswordReset PasswordReset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PasswordReset"
    ADD CONSTRAINT "PasswordReset_pkey" PRIMARY KEY (id);

--
-- Name: PendingMovement PendingMovement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMovement"
    ADD CONSTRAINT "PendingMovement_pkey" PRIMARY KEY (id);

--
-- Name: PlannedAction PlannedAction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlannedAction"
    ADD CONSTRAINT "PlannedAction_pkey" PRIMARY KEY (id);

--
-- Name: PreparedShipment PreparedShipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PreparedShipment"
    ADD CONSTRAINT "PreparedShipment_pkey" PRIMARY KEY (id);

--
-- Name: PrintJobFile PrintJobFile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJobFile"
    ADD CONSTRAINT "PrintJobFile_pkey" PRIMARY KEY (id);

--
-- Name: PrintJob PrintJob_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJob"
    ADD CONSTRAINT "PrintJob_pkey" PRIMARY KEY (id);

--
-- Name: PrintStation PrintStation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintStation"
    ADD CONSTRAINT "PrintStation_pkey" PRIMARY KEY (id);

--
-- Name: ProductImageData ProductImageData_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductImageData"
    ADD CONSTRAINT "ProductImageData_pkey" PRIMARY KEY ("imageId");

--
-- Name: ProductImage ProductImage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductImage"
    ADD CONSTRAINT "ProductImage_pkey" PRIMARY KEY (id);

--
-- Name: ProductZoneRule ProductZoneRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductZoneRule"
    ADD CONSTRAINT "ProductZoneRule_pkey" PRIMARY KEY (id);

--
-- Name: Product Product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_pkey" PRIMARY KEY (id);

--
-- Name: ReservationPolicy ReservationPolicy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReservationPolicy"
    ADD CONSTRAINT "ReservationPolicy_pkey" PRIMARY KEY ("organizationId");

--
-- Name: Reservation Reservation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Reservation"
    ADD CONSTRAINT "Reservation_pkey" PRIMARY KEY (id);

--
-- Name: ReturnLine ReturnLine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnLine"
    ADD CONSTRAINT "ReturnLine_pkey" PRIMARY KEY (id);

--
-- Name: ReturnPhoto ReturnPhoto_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnPhoto"
    ADD CONSTRAINT "ReturnPhoto_pkey" PRIMARY KEY ("returnId");

--
-- Name: Return Return_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Return"
    ADD CONSTRAINT "Return_pkey" PRIMARY KEY (id);

--
-- Name: Session Session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);

--
-- Name: ShadowDailyCheck ShadowDailyCheck_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShadowDailyCheck"
    ADD CONSTRAINT "ShadowDailyCheck_pkey" PRIMARY KEY ("organizationId", kind, day);

--
-- Name: ShadowJobState ShadowJobState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShadowJobState"
    ADD CONSTRAINT "ShadowJobState_pkey" PRIMARY KEY ("organizationId", job);

--
-- Name: ShipmentTrackEvent ShipmentTrackEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShipmentTrackEvent"
    ADD CONSTRAINT "ShipmentTrackEvent_pkey" PRIMARY KEY (id);

--
-- Name: Shipment Shipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shipment"
    ADD CONSTRAINT "Shipment_pkey" PRIMARY KEY (id);

--
-- Name: ShortageDecision ShortageDecision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShortageDecision"
    ADD CONSTRAINT "ShortageDecision_pkey" PRIMARY KEY (id);

--
-- Name: Shortage Shortage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shortage"
    ADD CONSTRAINT "Shortage_pkey" PRIMARY KEY (id);

--
-- Name: StockMovement StockMovement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StockMovement"
    ADD CONSTRAINT "StockMovement_pkey" PRIMARY KEY (id);

--
-- Name: StockSyncJob StockSyncJob_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StockSyncJob"
    ADD CONSTRAINT "StockSyncJob_pkey" PRIMARY KEY ("offerId");

--
-- Name: Stock Stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Stock"
    ADD CONSTRAINT "Stock_pkey" PRIMARY KEY ("productId", "warehouseId");

--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);

--
-- Name: Warehouse Warehouse_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Warehouse"
    ADD CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("organizationId", id);

--
-- Name: WfirmaGood WfirmaGood_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaGood"
    ADD CONSTRAINT "WfirmaGood_pkey" PRIMARY KEY ("organizationId", id);

--
-- Name: WfirmaQueueState WfirmaQueueState_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaQueueState"
    ADD CONSTRAINT "WfirmaQueueState_pkey" PRIMARY KEY ("organizationId");

--
-- Name: WfirmaWzSnapshot WfirmaWzSnapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaWzSnapshot"
    ADD CONSTRAINT "WfirmaWzSnapshot_pkey" PRIMARY KEY ("organizationId", "wfirmaDocId");

--
-- Name: WzAttempt WzAttempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WzAttempt"
    ADD CONSTRAINT "WzAttempt_pkey" PRIMARY KEY ("organizationId", ref);

--
-- Name: AiUsage_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AiUsage_organizationId_createdAt_idx" ON public."AiUsage" USING btree ("organizationId", "createdAt");

--
-- Name: AlertDelivery_organizationId_alertId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AlertDelivery_organizationId_alertId_key" ON public."AlertDelivery" USING btree ("organizationId", "alertId");

--
-- Name: AlertDelivery_organizationId_lastAttemptAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AlertDelivery_organizationId_lastAttemptAt_idx" ON public."AlertDelivery" USING btree ("organizationId", "lastAttemptAt");

--
-- Name: AlertDelivery_organizationId_state_nextAttemptAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AlertDelivery_organizationId_state_nextAttemptAt_idx" ON public."AlertDelivery" USING btree ("organizationId", state, "nextAttemptAt");

--
-- Name: Alert_kind_closedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Alert_kind_closedAt_idx" ON public."Alert" USING btree (kind, "closedAt");

--
-- Name: Alert_organizationId_dedupeKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Alert_organizationId_dedupeKey_key" ON public."Alert" USING btree ("organizationId", "dedupeKey");

--
-- Name: ApiKey_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ApiKey_organizationId_createdAt_idx" ON public."ApiKey" USING btree ("organizationId", "createdAt");

--
-- Name: ApiKey_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON public."ApiKey" USING btree ("tokenHash");

--
-- Name: AuditLog_entity_entityId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_entity_entityId_idx" ON public."AuditLog" USING btree (entity, "entityId");

--
-- Name: AuditLog_organizationId_entity_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_organizationId_entity_createdAt_idx" ON public."AuditLog" USING btree ("organizationId", entity, "createdAt");

--
-- Name: AutomationGroup_organizationId_presetKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AutomationGroup_organizationId_presetKey_key" ON public."AutomationGroup" USING btree ("organizationId", "presetKey");

--
-- Name: AutomationGroup_organizationId_sortOrder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AutomationGroup_organizationId_sortOrder_idx" ON public."AutomationGroup" USING btree ("organizationId", "sortOrder");

--
-- Name: AutomationRule_organizationId_event_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AutomationRule_organizationId_event_enabled_idx" ON public."AutomationRule" USING btree ("organizationId", event, enabled);

--
-- Name: AutomationRule_organizationId_presetKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AutomationRule_organizationId_presetKey_key" ON public."AutomationRule" USING btree ("organizationId", "presetKey");

--
-- Name: AutomationRun_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AutomationRun_organizationId_createdAt_idx" ON public."AutomationRun" USING btree ("organizationId", "createdAt");

--
-- Name: AutomationRun_organizationId_orderId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AutomationRun_organizationId_orderId_createdAt_idx" ON public."AutomationRun" USING btree ("organizationId", "orderId", "createdAt");

--
-- Name: AutomationRun_organizationId_ruleId_orderId_occasion_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "AutomationRun_organizationId_ruleId_orderId_occasion_key" ON public."AutomationRun" USING btree ("organizationId", "ruleId", "orderId", occasion);

--
-- Name: BlInvoiceSnapshot_organizationId_appliedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlInvoiceSnapshot_organizationId_appliedAt_idx" ON public."BlInvoiceSnapshot" USING btree ("organizationId", "appliedAt");

--
-- Name: BlInvoiceSnapshot_organizationId_blOrderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlInvoiceSnapshot_organizationId_blOrderId_idx" ON public."BlInvoiceSnapshot" USING btree ("organizationId", "blOrderId");

--
-- Name: BlOrderSnapshot_organizationId_channel_channelAccountId_ext_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlOrderSnapshot_organizationId_channel_channelAccountId_ext_idx" ON public."BlOrderSnapshot" USING btree ("organizationId", channel, "channelAccountId", "externalRef");

--
-- Name: BlProduct_ean_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlProduct_ean_idx" ON public."BlProduct" USING btree (ean);

--
-- Name: BlProduct_sku_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BlProduct_sku_idx" ON public."BlProduct" USING btree (sku);

--
-- Name: CarrierPickupEvent_organizationId_carrier_arrivedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CarrierPickupEvent_organizationId_carrier_arrivedAt_idx" ON public."CarrierPickupEvent" USING btree ("organizationId", carrier, "arrivedAt");

--
-- Name: CarrierPickupEvent_organizationId_carrier_pickupDay_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CarrierPickupEvent_organizationId_carrier_pickupDay_key" ON public."CarrierPickupEvent" USING btree ("organizationId", carrier, "pickupDay");

--
-- Name: CarrierRule_organizationId_priority_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CarrierRule_organizationId_priority_key" ON public."CarrierRule" USING btree ("organizationId", priority);

--
-- Name: ChannelOfferImport_organizationId_channel_channelAccountId__key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelOfferImport_organizationId_channel_channelAccountId__key" ON public."ChannelOfferImport" USING btree ("organizationId", channel, "channelAccountId", "externalId");

--
-- Name: ChannelOfferImport_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelOfferImport_state_idx" ON public."ChannelOfferImport" USING btree (state);

--
-- Name: ChannelOfferRead_organizationId_channel_channelAccountId_ex_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelOfferRead_organizationId_channel_channelAccountId_ex_key" ON public."ChannelOfferRead" USING btree ("organizationId", channel, "channelAccountId", "externalId");

--
-- Name: ChannelOfferRead_organizationId_channel_channelAccountId_st_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelOfferRead_organizationId_channel_channelAccountId_st_idx" ON public."ChannelOfferRead" USING btree ("organizationId", channel, "channelAccountId", state);

--
-- Name: ChannelOffer_organizationId_channel_channelAccountId_extern_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelOffer_organizationId_channel_channelAccountId_extern_key" ON public."ChannelOffer" USING btree ("organizationId", channel, "channelAccountId", "externalId");

--
-- Name: ChannelOffer_productId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelOffer_productId_idx" ON public."ChannelOffer" USING btree ("productId");

--
-- Name: ChannelOrderPoll_channel_finishedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelOrderPoll_channel_finishedAt_idx" ON public."ChannelOrderPoll" USING btree (channel, "finishedAt");

--
-- Name: ChannelOrderSnapshot_organizationId_channel_channelAccountI_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelOrderSnapshot_organizationId_channel_channelAccountI_key" ON public."ChannelOrderSnapshot" USING btree ("organizationId", channel, "channelAccountId", "externalId");

--
-- Name: ChannelOrderSnapshot_organizationId_createdAtChannel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelOrderSnapshot_organizationId_createdAtChannel_idx" ON public."ChannelOrderSnapshot" USING btree ("organizationId", "createdAtChannel");

--
-- Name: ChannelPushLog_channel_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelPushLog_channel_createdAt_idx" ON public."ChannelPushLog" USING btree (channel, "createdAt");

--
-- Name: ChannelStockImport_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelStockImport_createdAt_idx" ON public."ChannelStockImport" USING btree ("createdAt");

--
-- Name: ChannelStockImport_organizationId_channel_channelAccountId__key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelStockImport_organizationId_channel_channelAccountId__key" ON public."ChannelStockImport" USING btree ("organizationId", channel, "channelAccountId", "externalRef");

--
-- Name: ChannelStockImport_state_nextCheckAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelStockImport_state_nextCheckAt_idx" ON public."ChannelStockImport" USING btree (state, "nextCheckAt");

--
-- Name: ChannelWrite_organizationId_channel_channelAccountId_create_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelWrite_organizationId_channel_channelAccountId_create_idx" ON public."ChannelWrite" USING btree ("organizationId", channel, "channelAccountId", "createdAt");

--
-- Name: ChannelWrite_organizationId_orderId_kind_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ChannelWrite_organizationId_orderId_kind_key_key" ON public."ChannelWrite" USING btree ("organizationId", "orderId", kind, key);

--
-- Name: ChannelWrite_organizationId_state_nextAttemptAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ChannelWrite_organizationId_state_nextAttemptAt_idx" ON public."ChannelWrite" USING btree ("organizationId", state, "nextAttemptAt");

--
-- Name: ImportIssue_runId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ImportIssue_runId_idx" ON public."ImportIssue" USING btree ("runId");

--
-- Name: InboundEvent_organizationId_source_eventKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "InboundEvent_organizationId_source_eventKey_key" ON public."InboundEvent" USING btree ("organizationId", source, "eventKey");

--
-- Name: IntegrationHealth_organizationId_disabledAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IntegrationHealth_organizationId_disabledAt_idx" ON public."IntegrationHealth" USING btree ("organizationId", "disabledAt");

--
-- Name: IntegrationSecret_org_name_firmowy_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IntegrationSecret_org_name_firmowy_key" ON public."IntegrationSecret" USING btree ("organizationId", name) WHERE (channel IS NULL);

--
-- Name: IntegrationSecret_organizationId_channel_channelAccountId_n_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IntegrationSecret_organizationId_channel_channelAccountId_n_key" ON public."IntegrationSecret" USING btree ("organizationId", channel, "channelAccountId", name);

--
-- Name: Invitation_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Invitation_expiresAt_idx" ON public."Invitation" USING btree ("expiresAt");

--
-- Name: Invitation_open_org_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Invitation_open_org_email_key" ON public."Invitation" USING btree ("organizationId", email) WHERE (("acceptedAt" IS NULL) AND ("revokedAt" IS NULL));

--
-- Name: Invitation_organizationId_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Invitation_organizationId_email_idx" ON public."Invitation" USING btree ("organizationId", email);

--
-- Name: Invitation_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON public."Invitation" USING btree ("tokenHash");

--
-- Name: InvoiceAttempt_orderId_packageNo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "InvoiceAttempt_orderId_packageNo_idx" ON public."InvoiceAttempt" USING btree ("orderId", "packageNo");

--
-- Name: InvoiceAttempt_organizationId_idExternal_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "InvoiceAttempt_organizationId_idExternal_key" ON public."InvoiceAttempt" USING btree ("organizationId", "idExternal");

--
-- Name: InvoiceDryRun_organizationId_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "InvoiceDryRun_organizationId_day_idx" ON public."InvoiceDryRun" USING btree ("organizationId", day);

--
-- Name: Job_organizationId_dedupeKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Job_organizationId_dedupeKey_key" ON public."Job" USING btree ("organizationId", "dedupeKey");

--
-- Name: Job_status_runAfter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Job_status_runAfter_idx" ON public."Job" USING btree (status, "runAfter");

--
-- Name: KsefInvoiceDraft_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "KsefInvoiceDraft_orderId_idx" ON public."KsefInvoiceDraft" USING btree ("orderId");

--
-- Name: KsefInvoiceDraft_organizationId_numer_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "KsefInvoiceDraft_organizationId_numer_key" ON public."KsefInvoiceDraft" USING btree ("organizationId", numer);

--
-- Name: KsefInvoiceDraft_organizationId_orderId_packageNo_returnId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "KsefInvoiceDraft_organizationId_orderId_packageNo_returnId_key" ON public."KsefInvoiceDraft" USING btree ("organizationId", "orderId", "packageNo", "returnId");

--
-- Name: KsefInvoiceDraft_organizationId_rodzaj_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "KsefInvoiceDraft_organizationId_rodzaj_createdAt_idx" ON public."KsefInvoiceDraft" USING btree ("organizationId", rodzaj, "createdAt");

--
-- Name: KsefInvoiceDraft_organizationId_status_nastepnaProbaOd_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "KsefInvoiceDraft_organizationId_status_nastepnaProbaOd_idx" ON public."KsefInvoiceDraft" USING btree ("organizationId", status, "nastepnaProbaOd");

--
-- Name: MailDelivery_organizationId_dedupeKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "MailDelivery_organizationId_dedupeKey_key" ON public."MailDelivery" USING btree ("organizationId", "dedupeKey");

--
-- Name: MailDelivery_organizationId_lastAttemptAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MailDelivery_organizationId_lastAttemptAt_idx" ON public."MailDelivery" USING btree ("organizationId", "lastAttemptAt");

--
-- Name: MailDelivery_organizationId_plannedActionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MailDelivery_organizationId_plannedActionId_idx" ON public."MailDelivery" USING btree ("organizationId", "plannedActionId");

--
-- Name: MailDelivery_organizationId_state_nextAttemptAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "MailDelivery_organizationId_state_nextAttemptAt_idx" ON public."MailDelivery" USING btree ("organizationId", state, "nextAttemptAt");

--
-- Name: McpCall_apiKeyId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "McpCall_apiKeyId_createdAt_idx" ON public."McpCall" USING btree ("apiKeyId", "createdAt");

--
-- Name: McpCall_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "McpCall_organizationId_createdAt_idx" ON public."McpCall" USING btree ("organizationId", "createdAt");

--
-- Name: Membership_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Membership_userId_idx" ON public."Membership" USING btree ("userId");

--
-- Name: OrderBulkAction_organizationId_createdBy_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderBulkAction_organizationId_createdBy_createdAt_idx" ON public."OrderBulkAction" USING btree ("organizationId", "createdBy", "createdAt");

--
-- Name: OrderCardPrint_organizationId_orderCode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCardPrint_organizationId_orderCode_idx" ON public."OrderCardPrint" USING btree ("organizationId", "orderCode");

--
-- Name: OrderCardPrint_organizationId_orderId_printNo_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "OrderCardPrint_organizationId_orderId_printNo_key" ON public."OrderCardPrint" USING btree ("organizationId", "orderId", "printNo");

--
-- Name: OrderCustomer_orderId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "OrderCustomer_orderId_key" ON public."OrderCustomer" USING btree ("orderId");

--
-- Name: OrderCustomer_organizationId_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCustomer_organizationId_country_idx" ON public."OrderCustomer" USING btree ("organizationId", country);

--
-- Name: OrderCustomer_organizationId_emailHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCustomer_organizationId_emailHash_idx" ON public."OrderCustomer" USING btree ("organizationId", "emailHash");

--
-- Name: OrderCustomer_organizationId_nipHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCustomer_organizationId_nipHash_idx" ON public."OrderCustomer" USING btree ("organizationId", "nipHash");

--
-- Name: OrderCustomer_organizationId_phoneHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCustomer_organizationId_phoneHash_idx" ON public."OrderCustomer" USING btree ("organizationId", "phoneHash");

--
-- Name: OrderCustomer_organizationId_retainUntil_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderCustomer_organizationId_retainUntil_idx" ON public."OrderCustomer" USING btree ("organizationId", "retainUntil");

--
-- Name: OrderEvent_orderId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON public."OrderEvent" USING btree ("orderId", "createdAt");

--
-- Name: OrderEvent_organizationId_kind_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderEvent_organizationId_kind_createdAt_idx" ON public."OrderEvent" USING btree ("organizationId", kind, "createdAt");

--
-- Name: OrderLine_orderId_externalLineId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "OrderLine_orderId_externalLineId_key" ON public."OrderLine" USING btree ("orderId", "externalLineId");

--
-- Name: OrderNote_orderId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderNote_orderId_createdAt_idx" ON public."OrderNote" USING btree ("orderId", "createdAt");

--
-- Name: OrderPayment_orderId_paidAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderPayment_orderId_paidAt_idx" ON public."OrderPayment" USING btree ("orderId", "paidAt");

--
-- Name: OrderPayment_organizationId_kind_exportedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OrderPayment_organizationId_kind_exportedAt_idx" ON public."OrderPayment" USING btree ("organizationId", kind, "exportedAt");

--
-- Name: Order_organizationId_channel_channelAccountId_externalId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Order_organizationId_channel_channelAccountId_externalId_key" ON public."Order" USING btree ("organizationId", channel, "channelAccountId", "externalId");

--
-- Name: Order_organizationId_createdAtChannel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_organizationId_createdAtChannel_idx" ON public."Order" USING btree ("organizationId", "createdAtChannel");

--
-- Name: Order_organizationId_status_carrier_companyStatus_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_organizationId_status_carrier_companyStatus_idx" ON public."Order" USING btree ("organizationId", status, carrier, "companyStatus");

--
-- Name: Order_organizationId_status_reservationDeadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_organizationId_status_reservationDeadline_idx" ON public."Order" USING btree ("organizationId", status, "reservationDeadline");

--
-- Name: Order_organizationId_totalGross_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_organizationId_totalGross_idx" ON public."Order" USING btree ("organizationId", "totalGross");

--
-- Name: Order_organizationId_updatedAt_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_organizationId_updatedAt_id_idx" ON public."Order" USING btree ("organizationId", "updatedAt", id);

--
-- Name: Order_parentOrderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Order_parentOrderId_idx" ON public."Order" USING btree ("parentOrderId");

--
-- Name: Organization_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Organization_slug_key" ON public."Organization" USING btree (slug);

--
-- Name: OutboxEvent_organizationId_kind_processedAt_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "OutboxEvent_organizationId_kind_processedAt_createdAt_idx" ON public."OutboxEvent" USING btree ("organizationId", kind, "processedAt", "createdAt");

--
-- Name: PackBasket_orderId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PackBasket_orderId_key" ON public."PackBasket" USING btree ("orderId");

--
-- Name: PackBasket_organizationId_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PackBasket_organizationId_name_key" ON public."PackBasket" USING btree ("organizationId", name);

--
-- Name: PackDrillFix_drillId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PackDrillFix_drillId_idx" ON public."PackDrillFix" USING btree ("drillId");

--
-- Name: PackDrillFix_organizationId_state_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PackDrillFix_organizationId_state_createdAt_idx" ON public."PackDrillFix" USING btree ("organizationId", state, "createdAt");

--
-- Name: PackDrill_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PackDrill_orderId_idx" ON public."PackDrill" USING btree ("orderId");

--
-- Name: PackDrill_organizationId_startedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PackDrill_organizationId_startedAt_idx" ON public."PackDrill" USING btree ("organizationId", "startedAt");

--
-- Name: PasswordReset_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PasswordReset_expiresAt_idx" ON public."PasswordReset" USING btree ("expiresAt");

--
-- Name: PasswordReset_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON public."PasswordReset" USING btree ("tokenHash");

--
-- Name: PasswordReset_userId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PasswordReset_userId_createdAt_idx" ON public."PasswordReset" USING btree ("userId", "createdAt");

--
-- Name: PendingMovement_invoiceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMovement_invoiceId_idx" ON public."PendingMovement" USING btree ("invoiceId");

--
-- Name: PendingMovement_organizationId_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PendingMovement_organizationId_idempotencyKey_key" ON public."PendingMovement" USING btree ("organizationId", "idempotencyKey");

--
-- Name: PendingMovement_productId_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingMovement_productId_state_idx" ON public."PendingMovement" USING btree ("productId", state);

--
-- Name: PlannedAction_organizationId_dueAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PlannedAction_organizationId_dueAt_idx" ON public."PlannedAction" USING btree ("organizationId", "dueAt");

--
-- Name: PlannedAction_organizationId_rule_targetId_occasion_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PlannedAction_organizationId_rule_targetId_occasion_key" ON public."PlannedAction" USING btree ("organizationId", rule, "targetId", occasion);

--
-- Name: PreparedShipment_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PreparedShipment_orderId_idx" ON public."PreparedShipment" USING btree ("orderId");

--
-- Name: PreparedShipment_organizationId_orderId_packageNo_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PreparedShipment_organizationId_orderId_packageNo_key" ON public."PreparedShipment" USING btree ("organizationId", "orderId", "packageNo");

--
-- Name: PrintJobFile_jobId_format_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PrintJobFile_jobId_format_key" ON public."PrintJobFile" USING btree ("jobId", format);

--
-- Name: PrintJob_fallbackOfId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PrintJob_fallbackOfId_key" ON public."PrintJob" USING btree ("fallbackOfId");

--
-- Name: PrintJob_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PrintJob_organizationId_createdAt_idx" ON public."PrintJob" USING btree ("organizationId", "createdAt");

--
-- Name: PrintJob_organizationId_idempotencyKey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PrintJob_organizationId_idempotencyKey_key" ON public."PrintJob" USING btree ("organizationId", "idempotencyKey");

--
-- Name: PrintJob_stationId_status_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PrintJob_stationId_status_createdAt_idx" ON public."PrintJob" USING btree ("stationId", status, "createdAt");

--
-- Name: PrintStation_organizationId_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PrintStation_organizationId_code_key" ON public."PrintStation" USING btree ("organizationId", code);

--
-- Name: PrintStation_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "PrintStation_tokenHash_key" ON public."PrintStation" USING btree ("tokenHash");

--
-- Name: ProductImageData_productId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ProductImageData_productId_idx" ON public."ProductImageData" USING btree ("productId");

--
-- Name: ProductImage_productId_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ProductImage_productId_position_idx" ON public."ProductImage" USING btree ("productId", "position");

--
-- Name: ProductImage_productId_sourceUrl_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ProductImage_productId_sourceUrl_key" ON public."ProductImage" USING btree ("productId", "sourceUrl");

--
-- Name: ProductZoneRule_organizationId_priority_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ProductZoneRule_organizationId_priority_key" ON public."ProductZoneRule" USING btree ("organizationId", priority);

--
-- Name: Product_ean_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Product_ean_idx" ON public."Product" USING btree (ean);

--
-- Name: Product_organizationId_sku_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON public."Product" USING btree ("organizationId", sku);

--
-- Name: Product_organizationId_wfirmaGoodId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Product_organizationId_wfirmaGoodId_key" ON public."Product" USING btree ("organizationId", "wfirmaGoodId");

--
-- Name: Reservation_active_line_product_wh_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Reservation_active_line_product_wh_key" ON public."Reservation" USING btree ("orderLineId", "productId", "warehouseId") WHERE (state = 'ACTIVE'::public."ReservationState");

--
-- Name: Reservation_orderId_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Reservation_orderId_state_idx" ON public."Reservation" USING btree ("orderId", state);

--
-- Name: Reservation_productId_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Reservation_productId_state_idx" ON public."Reservation" USING btree ("productId", state);

--
-- Name: ReturnLine_orderLineId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ReturnLine_orderLineId_idx" ON public."ReturnLine" USING btree ("orderLineId");

--
-- Name: ReturnLine_organizationId_disposition_pzConfirmedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ReturnLine_organizationId_disposition_pzConfirmedAt_idx" ON public."ReturnLine" USING btree ("organizationId", disposition, "pzConfirmedAt");

--
-- Name: ReturnLine_returnId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ReturnLine_returnId_idx" ON public."ReturnLine" USING btree ("returnId");

--
-- Name: Return_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Return_orderId_idx" ON public."Return" USING btree ("orderId");

--
-- Name: Return_organizationId_source_externalId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Return_organizationId_source_externalId_key" ON public."Return" USING btree ("organizationId", source, "externalId");

--
-- Name: Return_organizationId_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Return_organizationId_status_idx" ON public."Return" USING btree ("organizationId", status);

--
-- Name: Session_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_expiresAt_idx" ON public."Session" USING btree ("expiresAt");

--
-- Name: Session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId");

--
-- Name: ShipmentTrackEvent_organizationId_shipmentId_occurredAt_sta_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ShipmentTrackEvent_organizationId_shipmentId_occurredAt_sta_key" ON public."ShipmentTrackEvent" USING btree ("organizationId", "shipmentId", "occurredAt", state, "carrierCode");

--
-- Name: ShipmentTrackEvent_shipmentId_occurredAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ShipmentTrackEvent_shipmentId_occurredAt_idx" ON public."ShipmentTrackEvent" USING btree ("shipmentId", "occurredAt");

--
-- Name: Shipment_aktywna_paczka; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Shipment_aktywna_paczka" ON public."Shipment" USING btree ("organizationId", "orderId", "packageNo") WHERE ((state = ANY (ARRAY['TWORZENIE'::public."ShipmentState", 'UTWORZONA'::public."ShipmentState", 'NIEJEDNOZNACZNA'::public."ShipmentState"])) AND ("extraNo" = 0));

--
-- Name: Shipment_dodatkowa_numer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Shipment_dodatkowa_numer" ON public."Shipment" USING btree ("organizationId", "orderId", "packageNo", "extraNo") WHERE ("extraNo" >= 1);

--
-- Name: Shipment_orderId_packageNo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_orderId_packageNo_idx" ON public."Shipment" USING btree ("orderId", "packageNo");

--
-- Name: Shipment_organizationId_adapterKey_accountSuffix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_organizationId_adapterKey_accountSuffix_idx" ON public."Shipment" USING btree ("organizationId", "adapterKey", "accountSuffix");

--
-- Name: Shipment_organizationId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_organizationId_createdAt_idx" ON public."Shipment" USING btree ("organizationId", "createdAt");

--
-- Name: Shipment_organizationId_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Shipment_organizationId_reference_key" ON public."Shipment" USING btree ("organizationId", reference);

--
-- Name: Shipment_organizationId_trackingNumber_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_organizationId_trackingNumber_idx" ON public."Shipment" USING btree ("organizationId", "trackingNumber");

--
-- Name: Shipment_reguly_drogi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_reguly_drogi" ON public."Shipment" USING btree ("organizationId") WHERE "trackRulesPending";

--
-- Name: Shipment_sledzenie_termin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shipment_sledzenie_termin" ON public."Shipment" USING btree ("organizationId", "nextTrackAt") WHERE ("trackingStoppedAt" IS NULL);

--
-- Name: ShortageDecision_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ShortageDecision_orderId_idx" ON public."ShortageDecision" USING btree ("orderId");

--
-- Name: ShortageDecision_organizationId_orderLineId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "ShortageDecision_organizationId_orderLineId_key" ON public."ShortageDecision" USING btree ("organizationId", "orderLineId");

--
-- Name: Shortage_orderId_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shortage_orderId_state_idx" ON public."Shortage" USING btree ("orderId", state);

--
-- Name: Shortage_productId_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Shortage_productId_state_idx" ON public."Shortage" USING btree ("productId", state);

--
-- Name: StockMovement_productId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "StockMovement_productId_createdAt_idx" ON public."StockMovement" USING btree ("productId", "createdAt");

--
-- Name: StockSyncJob_organizationId_channel_channelAccountId_nextAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "StockSyncJob_organizationId_channel_channelAccountId_nextAt_idx" ON public."StockSyncJob" USING btree ("organizationId", channel, "channelAccountId", "nextAttemptAt");

--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);

--
-- Name: Warehouse_organizationId_wfirmaWarehouseId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Warehouse_organizationId_wfirmaWarehouseId_key" ON public."Warehouse" USING btree ("organizationId", "wfirmaWarehouseId");

--
-- Name: WfirmaGood_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WfirmaGood_code_idx" ON public."WfirmaGood" USING btree (code);

--
-- Name: WfirmaWzSnapshot_organizationId_createdInWfirma_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WfirmaWzSnapshot_organizationId_createdInWfirma_idx" ON public."WfirmaWzSnapshot" USING btree ("organizationId", "createdInWfirma");

--
-- Name: WfirmaWzSnapshot_organizationId_invoiceNumber_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WfirmaWzSnapshot_organizationId_invoiceNumber_idx" ON public."WfirmaWzSnapshot" USING btree ("organizationId", "invoiceNumber");

--
-- Name: WzAttempt_organizationId_orderId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WzAttempt_organizationId_orderId_idx" ON public."WzAttempt" USING btree ("organizationId", "orderId");

--
-- Name: ChannelOffer ChannelOffer_rejestr_usuniecie; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "ChannelOffer_rejestr_usuniecie" AFTER DELETE ON public."ChannelOffer" FOR EACH ROW EXECUTE FUNCTION public.rejestr_synchronizacji_uniewaznij();

--
-- Name: ChannelOffer ChannelOffer_rejestr_zmiana; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "ChannelOffer_rejestr_zmiana" AFTER UPDATE ON public."ChannelOffer" FOR EACH ROW WHEN (((old.active IS DISTINCT FROM new.active) OR (old."productId" IS DISTINCT FROM new."productId") OR (old."qtyBasePerOffer" IS DISTINCT FROM new."qtyBasePerOffer") OR (old."externalId" IS DISTINCT FROM new."externalId") OR (old.channel IS DISTINCT FROM new.channel) OR (old."channelAccountId" IS DISTINCT FROM new."channelAccountId"))) EXECUTE FUNCTION public.rejestr_synchronizacji_uniewaznij();

--
-- Name: AiUsage AiUsage_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AiUsage"
    ADD CONSTRAINT "AiUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AlertDelivery AlertDelivery_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AlertDelivery"
    ADD CONSTRAINT "AlertDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Alert Alert_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Alert"
    ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ApiKey ApiKey_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ApiKey"
    ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AuditLog AuditLog_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AutomationCursor AutomationCursor_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationCursor"
    ADD CONSTRAINT "AutomationCursor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AutomationGroup AutomationGroup_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationGroup"
    ADD CONSTRAINT "AutomationGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AutomationRule AutomationRule_groupId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRule"
    ADD CONSTRAINT "AutomationRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES public."AutomationGroup"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: AutomationRule AutomationRule_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRule"
    ADD CONSTRAINT "AutomationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AutomationRun AutomationRun_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRun"
    ADD CONSTRAINT "AutomationRun_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: AutomationRun AutomationRun_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRun"
    ADD CONSTRAINT "AutomationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AutomationRun AutomationRun_ruleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AutomationRun"
    ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public."AutomationRule"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BlInvoiceSnapshot BlInvoiceSnapshot_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlInvoiceSnapshot"
    ADD CONSTRAINT "BlInvoiceSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BlJournalCursor BlJournalCursor_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlJournalCursor"
    ADD CONSTRAINT "BlJournalCursor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BlOrderSnapshot BlOrderSnapshot_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlOrderSnapshot"
    ADD CONSTRAINT "BlOrderSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BlProduct BlProduct_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlProduct"
    ADD CONSTRAINT "BlProduct_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BlProduct BlProduct_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BlProduct"
    ADD CONSTRAINT "BlProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: BundleComponent BundleComponent_bundleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BundleComponent"
    ADD CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: BundleComponent BundleComponent_componentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BundleComponent"
    ADD CONSTRAINT "BundleComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: BundleComponent BundleComponent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BundleComponent"
    ADD CONSTRAINT "BundleComponent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: CarrierPickupEvent CarrierPickupEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickupEvent"
    ADD CONSTRAINT "CarrierPickupEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: CarrierPickupShipping CarrierPickupShipping_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickupShipping"
    ADD CONSTRAINT "CarrierPickupShipping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: CarrierPickup CarrierPickup_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierPickup"
    ADD CONSTRAINT "CarrierPickup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: CarrierRule CarrierRule_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CarrierRule"
    ADD CONSTRAINT "CarrierRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelAccountStatus ChannelAccountStatus_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelAccountStatus"
    ADD CONSTRAINT "ChannelAccountStatus_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelConfig ChannelConfig_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelConfig"
    ADD CONSTRAINT "ChannelConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelCursor ChannelCursor_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelCursor"
    ADD CONSTRAINT "ChannelCursor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelHealth ChannelHealth_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelHealth"
    ADD CONSTRAINT "ChannelHealth_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOfferImport ChannelOfferImport_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOfferImport"
    ADD CONSTRAINT "ChannelOfferImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOfferRead ChannelOfferRead_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOfferRead"
    ADD CONSTRAINT "ChannelOfferRead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOffer ChannelOffer_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOffer"
    ADD CONSTRAINT "ChannelOffer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOffer ChannelOffer_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOffer"
    ADD CONSTRAINT "ChannelOffer_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOrderPoll ChannelOrderPoll_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOrderPoll"
    ADD CONSTRAINT "ChannelOrderPoll_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelOrderSnapshot ChannelOrderSnapshot_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelOrderSnapshot"
    ADD CONSTRAINT "ChannelOrderSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelPushLog ChannelPushLog_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelPushLog"
    ADD CONSTRAINT "ChannelPushLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelStockImport ChannelStockImport_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelStockImport"
    ADD CONSTRAINT "ChannelStockImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelSyncState ChannelSyncState_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelSyncState"
    ADD CONSTRAINT "ChannelSyncState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ChannelWrite ChannelWrite_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelWrite"
    ADD CONSTRAINT "ChannelWrite_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ChannelWrite ChannelWrite_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ChannelWrite"
    ADD CONSTRAINT "ChannelWrite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: CustomerDataSettings CustomerDataSettings_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CustomerDataSettings"
    ADD CONSTRAINT "CustomerDataSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ImportIssue ImportIssue_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImportIssue"
    ADD CONSTRAINT "ImportIssue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ImportIssue ImportIssue_runId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImportIssue"
    ADD CONSTRAINT "ImportIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES public."ImportRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ImportRun ImportRun_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ImportRun"
    ADD CONSTRAINT "ImportRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: InboundEvent InboundEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InboundEvent"
    ADD CONSTRAINT "InboundEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: IntegrationHealth IntegrationHealth_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationHealth"
    ADD CONSTRAINT "IntegrationHealth_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: IntegrationRateBucket IntegrationRateBucket_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationRateBucket"
    ADD CONSTRAINT "IntegrationRateBucket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: IntegrationSecret IntegrationSecret_organizationId_channel_channelAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationSecret"
    ADD CONSTRAINT "IntegrationSecret_organizationId_channel_channelAccountId_fkey" FOREIGN KEY ("organizationId", channel, "channelAccountId") REFERENCES public."ChannelConfig"("organizationId", channel, "channelAccountId") ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: IntegrationSecret IntegrationSecret_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."IntegrationSecret"
    ADD CONSTRAINT "IntegrationSecret_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Invitation Invitation_invitedById_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Invitation Invitation_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Invitation"
    ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: InvoiceAttempt InvoiceAttempt_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceAttempt"
    ADD CONSTRAINT "InvoiceAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: InvoiceAttempt InvoiceAttempt_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceAttempt"
    ADD CONSTRAINT "InvoiceAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: InvoiceDryRun InvoiceDryRun_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceDryRun"
    ADD CONSTRAINT "InvoiceDryRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: InvoiceNumberSeries InvoiceNumberSeries_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."InvoiceNumberSeries"
    ADD CONSTRAINT "InvoiceNumberSeries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Job Job_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Job"
    ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: KsefInvoiceDraft KsefInvoiceDraft_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."KsefInvoiceDraft"
    ADD CONSTRAINT "KsefInvoiceDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: MailDelivery MailDelivery_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailDelivery"
    ADD CONSTRAINT "MailDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: MailSettings MailSettings_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailSettings"
    ADD CONSTRAINT "MailSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: MailTemplate MailTemplate_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."MailTemplate"
    ADD CONSTRAINT "MailTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: McpCall McpCall_apiKeyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpCall"
    ADD CONSTRAINT "McpCall_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES public."ApiKey"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: McpCall McpCall_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."McpCall"
    ADD CONSTRAINT "McpCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Membership Membership_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Membership"
    ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Membership Membership_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Membership"
    ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: NotificationSettings NotificationSettings_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."NotificationSettings"
    ADD CONSTRAINT "NotificationSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderBulkAction OrderBulkAction_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderBulkAction"
    ADD CONSTRAINT "OrderBulkAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderCardPrint OrderCardPrint_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCardPrint"
    ADD CONSTRAINT "OrderCardPrint_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderCardPrint OrderCardPrint_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCardPrint"
    ADD CONSTRAINT "OrderCardPrint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderCustomer OrderCustomer_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCustomer"
    ADD CONSTRAINT "OrderCustomer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderCustomer OrderCustomer_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderCustomer"
    ADD CONSTRAINT "OrderCustomer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderEvent OrderEvent_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderEvent"
    ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderEvent OrderEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderEvent"
    ADD CONSTRAINT "OrderEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderLine OrderLine_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderLine OrderLine_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderNote OrderNote_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderNote"
    ADD CONSTRAINT "OrderNote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderNote OrderNote_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderNote"
    ADD CONSTRAINT "OrderNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderPayment OrderPayment_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderPayment"
    ADD CONSTRAINT "OrderPayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: OrderPayment OrderPayment_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderPayment"
    ADD CONSTRAINT "OrderPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderStatusDef OrderStatusDef_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderStatusDef"
    ADD CONSTRAINT "OrderStatusDef_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrderStatusGroup OrderStatusGroup_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrderStatusGroup"
    ADD CONSTRAINT "OrderStatusGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Order Order_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OrganizationLogo OrganizationLogo_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OrganizationLogo"
    ADD CONSTRAINT "OrganizationLogo_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: OutboxEvent OutboxEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."OutboxEvent"
    ADD CONSTRAINT "OutboxEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PackBasket PackBasket_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackBasket"
    ADD CONSTRAINT "PackBasket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: PackBasket PackBasket_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackBasket"
    ADD CONSTRAINT "PackBasket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PackDrillFix PackDrillFix_drillId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrillFix"
    ADD CONSTRAINT "PackDrillFix_drillId_fkey" FOREIGN KEY ("drillId") REFERENCES public."PackDrill"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: PackDrillFix PackDrillFix_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrillFix"
    ADD CONSTRAINT "PackDrillFix_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PackDrillFix PackDrillFix_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrillFix"
    ADD CONSTRAINT "PackDrillFix_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PackDrill PackDrill_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrill"
    ADD CONSTRAINT "PackDrill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: PackDrill PackDrill_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackDrill"
    ADD CONSTRAINT "PackDrill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PackingZoneDef PackingZoneDef_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PackingZoneDef"
    ADD CONSTRAINT "PackingZoneDef_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PasswordReset PasswordReset_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PasswordReset"
    ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: PendingMovement PendingMovement_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingMovement"
    ADD CONSTRAINT "PendingMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PlannedAction PlannedAction_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PlannedAction"
    ADD CONSTRAINT "PlannedAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PreparedShipment PreparedShipment_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PreparedShipment"
    ADD CONSTRAINT "PreparedShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: PreparedShipment PreparedShipment_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PreparedShipment"
    ADD CONSTRAINT "PreparedShipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PrintJobFile PrintJobFile_jobId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJobFile"
    ADD CONSTRAINT "PrintJobFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES public."PrintJob"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: PrintJobFile PrintJobFile_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJobFile"
    ADD CONSTRAINT "PrintJobFile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PrintJob PrintJob_fallbackOfId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJob"
    ADD CONSTRAINT "PrintJob_fallbackOfId_fkey" FOREIGN KEY ("fallbackOfId") REFERENCES public."PrintJob"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: PrintJob PrintJob_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJob"
    ADD CONSTRAINT "PrintJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PrintJob PrintJob_stationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintJob"
    ADD CONSTRAINT "PrintJob_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES public."PrintStation"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: PrintStation PrintStation_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PrintStation"
    ADD CONSTRAINT "PrintStation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ProductImageData ProductImageData_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductImageData"
    ADD CONSTRAINT "ProductImageData_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ProductImage ProductImage_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductImage"
    ADD CONSTRAINT "ProductImage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ProductImage ProductImage_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductImage"
    ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ProductZoneRule ProductZoneRule_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ProductZoneRule"
    ADD CONSTRAINT "ProductZoneRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Product Product_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Product"
    ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ReservationPolicy ReservationPolicy_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReservationPolicy"
    ADD CONSTRAINT "ReservationPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Reservation Reservation_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Reservation"
    ADD CONSTRAINT "Reservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Reservation Reservation_orderLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Reservation"
    ADD CONSTRAINT "Reservation_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Reservation Reservation_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Reservation"
    ADD CONSTRAINT "Reservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ReturnLine ReturnLine_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnLine"
    ADD CONSTRAINT "ReturnLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ReturnLine ReturnLine_returnId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnLine"
    ADD CONSTRAINT "ReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES public."Return"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ReturnPhoto ReturnPhoto_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnPhoto"
    ADD CONSTRAINT "ReturnPhoto_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ReturnPhoto ReturnPhoto_returnId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReturnPhoto"
    ADD CONSTRAINT "ReturnPhoto_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES public."Return"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Return Return_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Return"
    ADD CONSTRAINT "Return_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Return Return_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Return"
    ADD CONSTRAINT "Return_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Session Session_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Session Session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ShadowDailyCheck ShadowDailyCheck_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShadowDailyCheck"
    ADD CONSTRAINT "ShadowDailyCheck_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ShadowJobState ShadowJobState_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShadowJobState"
    ADD CONSTRAINT "ShadowJobState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ShipmentTrackEvent ShipmentTrackEvent_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShipmentTrackEvent"
    ADD CONSTRAINT "ShipmentTrackEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ShipmentTrackEvent ShipmentTrackEvent_shipmentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShipmentTrackEvent"
    ADD CONSTRAINT "ShipmentTrackEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES public."Shipment"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Shipment Shipment_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shipment"
    ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Shipment Shipment_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shipment"
    ADD CONSTRAINT "Shipment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: ShortageDecision ShortageDecision_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShortageDecision"
    ADD CONSTRAINT "ShortageDecision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: ShortageDecision ShortageDecision_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ShortageDecision"
    ADD CONSTRAINT "ShortageDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Shortage Shortage_orderId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shortage"
    ADD CONSTRAINT "Shortage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Shortage Shortage_orderLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shortage"
    ADD CONSTRAINT "Shortage_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Shortage Shortage_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Shortage"
    ADD CONSTRAINT "Shortage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: StockMovement StockMovement_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StockMovement"
    ADD CONSTRAINT "StockMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: StockMovement StockMovement_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StockMovement"
    ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: StockSyncJob StockSyncJob_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."StockSyncJob"
    ADD CONSTRAINT "StockSyncJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Stock Stock_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Stock"
    ADD CONSTRAINT "Stock_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Stock Stock_organizationId_warehouseId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Stock"
    ADD CONSTRAINT "Stock_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES public."Warehouse"("organizationId", id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Stock Stock_productId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Stock"
    ADD CONSTRAINT "Stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES public."Product"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: Warehouse Warehouse_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Warehouse"
    ADD CONSTRAINT "Warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: WfirmaGood WfirmaGood_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaGood"
    ADD CONSTRAINT "WfirmaGood_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: WfirmaQueueState WfirmaQueueState_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaQueueState"
    ADD CONSTRAINT "WfirmaQueueState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: WfirmaWzSnapshot WfirmaWzSnapshot_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WfirmaWzSnapshot"
    ADD CONSTRAINT "WfirmaWzSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: WzAttempt WzAttempt_organizationId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WzAttempt"
    ADD CONSTRAINT "WzAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES public."Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--
-- Name: AiUsage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AiUsage" ENABLE ROW LEVEL SECURITY;

--
-- Name: Alert; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Alert" ENABLE ROW LEVEL SECURITY;

--
-- Name: AlertDelivery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AlertDelivery" ENABLE ROW LEVEL SECURITY;

--
-- Name: ApiKey; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ApiKey" ENABLE ROW LEVEL SECURITY;

--
-- Name: AuditLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: AutomationCursor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AutomationCursor" ENABLE ROW LEVEL SECURITY;

--
-- Name: AutomationGroup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AutomationGroup" ENABLE ROW LEVEL SECURITY;

--
-- Name: AutomationRule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AutomationRule" ENABLE ROW LEVEL SECURITY;

--
-- Name: AutomationRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."AutomationRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: BlInvoiceSnapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BlInvoiceSnapshot" ENABLE ROW LEVEL SECURITY;

--
-- Name: BlJournalCursor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BlJournalCursor" ENABLE ROW LEVEL SECURITY;

--
-- Name: BlOrderSnapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BlOrderSnapshot" ENABLE ROW LEVEL SECURITY;

--
-- Name: BlProduct; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BlProduct" ENABLE ROW LEVEL SECURITY;

--
-- Name: BundleComponent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."BundleComponent" ENABLE ROW LEVEL SECURITY;

--
-- Name: CarrierPickup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CarrierPickup" ENABLE ROW LEVEL SECURITY;

--
-- Name: CarrierPickupEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CarrierPickupEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: CarrierPickupShipping; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CarrierPickupShipping" ENABLE ROW LEVEL SECURITY;

--
-- Name: CarrierRule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CarrierRule" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelAccountStatus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelAccountStatus" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelConfig; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelConfig" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelCursor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelCursor" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelHealth; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelHealth" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelOffer; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelOffer" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelOfferImport; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelOfferImport" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelOfferRead; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelOfferRead" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelOrderPoll; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelOrderPoll" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelOrderSnapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelOrderSnapshot" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelPushLog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelPushLog" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelStockImport; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelStockImport" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelSyncState; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelSyncState" ENABLE ROW LEVEL SECURITY;

--
-- Name: ChannelWrite; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ChannelWrite" ENABLE ROW LEVEL SECURITY;

--
-- Name: CustomerDataSettings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."CustomerDataSettings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ImportIssue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ImportIssue" ENABLE ROW LEVEL SECURITY;

--
-- Name: ImportRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ImportRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: InboundEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."InboundEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: IntegrationHealth; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IntegrationHealth" ENABLE ROW LEVEL SECURITY;

--
-- Name: IntegrationRateBucket; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IntegrationRateBucket" ENABLE ROW LEVEL SECURITY;

--
-- Name: IntegrationSecret; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."IntegrationSecret" ENABLE ROW LEVEL SECURITY;

--
-- Name: Invitation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Invitation" ENABLE ROW LEVEL SECURITY;

--
-- Name: InvoiceAttempt; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."InvoiceAttempt" ENABLE ROW LEVEL SECURITY;

--
-- Name: InvoiceDryRun; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."InvoiceDryRun" ENABLE ROW LEVEL SECURITY;

--
-- Name: InvoiceNumberSeries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."InvoiceNumberSeries" ENABLE ROW LEVEL SECURITY;

--
-- Name: Job; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Job" ENABLE ROW LEVEL SECURITY;

--
-- Name: KsefInvoiceDraft; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."KsefInvoiceDraft" ENABLE ROW LEVEL SECURITY;

--
-- Name: MailDelivery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MailDelivery" ENABLE ROW LEVEL SECURITY;

--
-- Name: MailSettings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MailSettings" ENABLE ROW LEVEL SECURITY;

--
-- Name: MailTemplate; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."MailTemplate" ENABLE ROW LEVEL SECURITY;

--
-- Name: McpCall; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."McpCall" ENABLE ROW LEVEL SECURITY;

--
-- Name: Membership; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Membership" ENABLE ROW LEVEL SECURITY;

--
-- Name: NotificationSettings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."NotificationSettings" ENABLE ROW LEVEL SECURITY;

--
-- Name: Order; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Order" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderBulkAction; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderBulkAction" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderCardPrint; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderCardPrint" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderCustomer; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderCustomer" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderLine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderLine" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderNote; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderNote" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderPayment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderPayment" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderStatusDef; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderStatusDef" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrderStatusGroup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrderStatusGroup" ENABLE ROW LEVEL SECURITY;

--
-- Name: Organization; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Organization" ENABLE ROW LEVEL SECURITY;

--
-- Name: OrganizationLogo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OrganizationLogo" ENABLE ROW LEVEL SECURITY;

--
-- Name: OutboxEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."OutboxEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: PackBasket; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PackBasket" ENABLE ROW LEVEL SECURITY;

--
-- Name: PackDrill; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PackDrill" ENABLE ROW LEVEL SECURITY;

--
-- Name: PackDrillFix; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PackDrillFix" ENABLE ROW LEVEL SECURITY;

--
-- Name: PackingZoneDef; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PackingZoneDef" ENABLE ROW LEVEL SECURITY;

--
-- Name: PasswordReset; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PasswordReset" ENABLE ROW LEVEL SECURITY;

--
-- Name: PendingMovement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PendingMovement" ENABLE ROW LEVEL SECURITY;

--
-- Name: PlannedAction; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PlannedAction" ENABLE ROW LEVEL SECURITY;

--
-- Name: PreparedShipment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PreparedShipment" ENABLE ROW LEVEL SECURITY;

--
-- Name: PrintJob; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PrintJob" ENABLE ROW LEVEL SECURITY;

--
-- Name: PrintJobFile; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PrintJobFile" ENABLE ROW LEVEL SECURITY;

--
-- Name: PrintStation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."PrintStation" ENABLE ROW LEVEL SECURITY;

--
-- Name: Product; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Product" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProductImage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProductImage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProductImageData; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProductImageData" ENABLE ROW LEVEL SECURITY;

--
-- Name: ProductZoneRule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ProductZoneRule" ENABLE ROW LEVEL SECURITY;

--
-- Name: Reservation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Reservation" ENABLE ROW LEVEL SECURITY;

--
-- Name: ReservationPolicy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ReservationPolicy" ENABLE ROW LEVEL SECURITY;

--
-- Name: Return; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Return" ENABLE ROW LEVEL SECURITY;

--
-- Name: ReturnLine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ReturnLine" ENABLE ROW LEVEL SECURITY;

--
-- Name: ReturnPhoto; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ReturnPhoto" ENABLE ROW LEVEL SECURITY;

--
-- Name: Session; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Session" ENABLE ROW LEVEL SECURITY;

--
-- Name: ShadowDailyCheck; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ShadowDailyCheck" ENABLE ROW LEVEL SECURITY;

--
-- Name: ShadowJobState; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ShadowJobState" ENABLE ROW LEVEL SECURITY;

--
-- Name: Shipment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Shipment" ENABLE ROW LEVEL SECURITY;

--
-- Name: ShipmentTrackEvent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ShipmentTrackEvent" ENABLE ROW LEVEL SECURITY;

--
-- Name: Shortage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Shortage" ENABLE ROW LEVEL SECURITY;

--
-- Name: ShortageDecision; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."ShortageDecision" ENABLE ROW LEVEL SECURITY;

--
-- Name: Stock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Stock" ENABLE ROW LEVEL SECURITY;

--
-- Name: StockMovement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StockMovement" ENABLE ROW LEVEL SECURITY;

--
-- Name: StockSyncJob; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."StockSyncJob" ENABLE ROW LEVEL SECURITY;

--
-- Name: User; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

--
-- Name: Warehouse; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."Warehouse" ENABLE ROW LEVEL SECURITY;

--
-- Name: WfirmaGood; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."WfirmaGood" ENABLE ROW LEVEL SECURITY;

--
-- Name: WfirmaQueueState; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."WfirmaQueueState" ENABLE ROW LEVEL SECURITY;

--
-- Name: WfirmaWzSnapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."WfirmaWzSnapshot" ENABLE ROW LEVEL SECURITY;

--
-- Name: WzAttempt; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."WzAttempt" ENABLE ROW LEVEL SECURITY;

--
-- Name: Invitation no_app_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY no_app_access ON public."Invitation" USING (false) WITH CHECK (false);

--
-- Name: PasswordReset no_app_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY no_app_access ON public."PasswordReset" USING (false) WITH CHECK (false);

--
-- Name: Session no_app_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY no_app_access ON public."Session" USING (false) WITH CHECK (false);

--
-- Name: User no_app_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY no_app_access ON public."User" USING (false) WITH CHECK (false);

--
-- Name: AiUsage org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AiUsage" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Alert org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Alert" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AlertDelivery org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AlertDelivery" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ApiKey org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ApiKey" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AuditLog org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AuditLog" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AutomationCursor org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AutomationCursor" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AutomationGroup org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AutomationGroup" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AutomationRule org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AutomationRule" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: AutomationRun org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."AutomationRun" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: BlInvoiceSnapshot org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."BlInvoiceSnapshot" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: BlJournalCursor org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."BlJournalCursor" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: BlOrderSnapshot org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."BlOrderSnapshot" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: BlProduct org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."BlProduct" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: BundleComponent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."BundleComponent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: CarrierPickup org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."CarrierPickup" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: CarrierPickupEvent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."CarrierPickupEvent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: CarrierPickupShipping org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."CarrierPickupShipping" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: CarrierRule org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."CarrierRule" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelAccountStatus org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelAccountStatus" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelConfig org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelConfig" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelCursor org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelCursor" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelHealth org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelHealth" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelOffer org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelOffer" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelOfferImport org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelOfferImport" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelOfferRead org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelOfferRead" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelOrderPoll org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelOrderPoll" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelOrderSnapshot org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelOrderSnapshot" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelPushLog org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelPushLog" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelStockImport org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelStockImport" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelSyncState org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelSyncState" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ChannelWrite org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ChannelWrite" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: CustomerDataSettings org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."CustomerDataSettings" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ImportIssue org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ImportIssue" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ImportRun org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ImportRun" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: InboundEvent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."InboundEvent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: IntegrationHealth org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."IntegrationHealth" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: IntegrationRateBucket org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."IntegrationRateBucket" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: IntegrationSecret org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."IntegrationSecret" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: InvoiceAttempt org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."InvoiceAttempt" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: InvoiceDryRun org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."InvoiceDryRun" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: InvoiceNumberSeries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."InvoiceNumberSeries" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Job org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Job" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: KsefInvoiceDraft org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."KsefInvoiceDraft" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: MailDelivery org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."MailDelivery" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: MailSettings org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."MailSettings" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: MailTemplate org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."MailTemplate" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: McpCall org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."McpCall" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Membership org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Membership" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: NotificationSettings org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."NotificationSettings" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Order org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Order" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderBulkAction org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderBulkAction" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderCardPrint org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderCardPrint" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderCustomer org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderCustomer" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderEvent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderEvent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderLine org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderLine" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderNote org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderNote" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderPayment org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderPayment" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderStatusDef org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderStatusDef" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OrderStatusGroup org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrderStatusGroup" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Organization org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Organization" USING ((id = current_setting('app.org_id'::text, true))) WITH CHECK ((id = current_setting('app.org_id'::text, true)));

--
-- Name: OrganizationLogo org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OrganizationLogo" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: OutboxEvent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."OutboxEvent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PackBasket org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PackBasket" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PackDrill org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PackDrill" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PackDrillFix org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PackDrillFix" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PackingZoneDef org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PackingZoneDef" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PendingMovement org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PendingMovement" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PlannedAction org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PlannedAction" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PreparedShipment org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PreparedShipment" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PrintJob org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PrintJob" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PrintJobFile org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PrintJobFile" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: PrintStation org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."PrintStation" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Product org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Product" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ProductImage org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ProductImage" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ProductImageData org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ProductImageData" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ProductZoneRule org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ProductZoneRule" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Reservation org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Reservation" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ReservationPolicy org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ReservationPolicy" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Return org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Return" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ReturnLine org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ReturnLine" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ReturnPhoto org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ReturnPhoto" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ShadowDailyCheck org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ShadowDailyCheck" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ShadowJobState org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ShadowJobState" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Shipment org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Shipment" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ShipmentTrackEvent org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ShipmentTrackEvent" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Shortage org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Shortage" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: ShortageDecision org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."ShortageDecision" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Stock org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Stock" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: StockMovement org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."StockMovement" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: StockSyncJob org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."StockSyncJob" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: Warehouse org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."Warehouse" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: WfirmaGood org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."WfirmaGood" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: WfirmaQueueState org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."WfirmaQueueState" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: WfirmaWzSnapshot org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."WfirmaWzSnapshot" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: WzAttempt org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public."WzAttempt" USING (("organizationId" = current_setting('app.org_id'::text, true))) WITH CHECK (("organizationId" = current_setting('app.org_id'::text, true)));

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO logistyka_app;

--
-- Name: FUNCTION automaty_najstarsza_transakcja(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.automaty_najstarsza_transakcja() FROM PUBLIC;
GRANT ALL ON FUNCTION public.automaty_najstarsza_transakcja() TO logistyka_app;

--
-- Name: TABLE "AiUsage"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AiUsage" TO logistyka_app;

--
-- Name: TABLE "Alert"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Alert" TO logistyka_app;

--
-- Name: TABLE "AlertDelivery"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AlertDelivery" TO logistyka_app;

--
-- Name: TABLE "ApiKey"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public."ApiKey" TO logistyka_app;

--
-- Name: TABLE "AuditLog"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AuditLog" TO logistyka_app;

--
-- Name: TABLE "AutomationCursor"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AutomationCursor" TO logistyka_app;

--
-- Name: TABLE "AutomationGroup"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AutomationGroup" TO logistyka_app;

--
-- Name: TABLE "AutomationRule"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AutomationRule" TO logistyka_app;

--
-- Name: TABLE "AutomationRun"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."AutomationRun" TO logistyka_app;

--
-- Name: TABLE "BlInvoiceSnapshot"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BlInvoiceSnapshot" TO logistyka_app;

--
-- Name: TABLE "BlJournalCursor"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BlJournalCursor" TO logistyka_app;

--
-- Name: TABLE "BlOrderSnapshot"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BlOrderSnapshot" TO logistyka_app;

--
-- Name: TABLE "BlProduct"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BlProduct" TO logistyka_app;

--
-- Name: TABLE "BundleComponent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."BundleComponent" TO logistyka_app;

--
-- Name: TABLE "CarrierPickup"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CarrierPickup" TO logistyka_app;

--
-- Name: TABLE "CarrierPickupEvent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public."CarrierPickupEvent" TO logistyka_app;

--
-- Name: TABLE "CarrierPickupShipping"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public."CarrierPickupShipping" TO logistyka_app;

--
-- Name: TABLE "CarrierRule"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CarrierRule" TO logistyka_app;

--
-- Name: TABLE "ChannelAccountStatus"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelAccountStatus" TO logistyka_app;

--
-- Name: TABLE "ChannelConfig"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelConfig" TO logistyka_app;

--
-- Name: TABLE "ChannelCursor"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelCursor" TO logistyka_app;

--
-- Name: TABLE "ChannelHealth"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelHealth" TO logistyka_app;

--
-- Name: TABLE "ChannelOffer"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelOffer" TO logistyka_app;

--
-- Name: TABLE "ChannelOfferImport"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelOfferImport" TO logistyka_app;

--
-- Name: TABLE "ChannelOfferRead"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelOfferRead" TO logistyka_app;

--
-- Name: TABLE "ChannelOrderPoll"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelOrderPoll" TO logistyka_app;

--
-- Name: TABLE "ChannelOrderSnapshot"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelOrderSnapshot" TO logistyka_app;

--
-- Name: TABLE "ChannelPushLog"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelPushLog" TO logistyka_app;

--
-- Name: TABLE "ChannelStockImport"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelStockImport" TO logistyka_app;

--
-- Name: TABLE "ChannelSyncState"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelSyncState" TO logistyka_app;

--
-- Name: TABLE "ChannelWrite"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ChannelWrite" TO logistyka_app;

--
-- Name: TABLE "CustomerDataSettings"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."CustomerDataSettings" TO logistyka_app;

--
-- Name: TABLE "ImportIssue"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ImportIssue" TO logistyka_app;

--
-- Name: TABLE "ImportRun"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ImportRun" TO logistyka_app;

--
-- Name: TABLE "InboundEvent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."InboundEvent" TO logistyka_app;

--
-- Name: TABLE "IntegrationHealth"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."IntegrationHealth" TO logistyka_app;

--
-- Name: TABLE "IntegrationRateBucket"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."IntegrationRateBucket" TO logistyka_app;

--
-- Name: TABLE "IntegrationSecret"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."IntegrationSecret" TO logistyka_app;

--
-- Name: TABLE "InvoiceAttempt"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."InvoiceAttempt" TO logistyka_app;

--
-- Name: TABLE "InvoiceDryRun"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."InvoiceDryRun" TO logistyka_app;

--
-- Name: TABLE "InvoiceNumberSeries"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."InvoiceNumberSeries" TO logistyka_app;

--
-- Name: TABLE "Job"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Job" TO logistyka_app;

--
-- Name: TABLE "KsefInvoiceDraft"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."KsefInvoiceDraft" TO logistyka_app;

--
-- Name: TABLE "MailDelivery"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."MailDelivery" TO logistyka_app;

--
-- Name: TABLE "MailSettings"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."MailSettings" TO logistyka_app;

--
-- Name: TABLE "MailTemplate"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."MailTemplate" TO logistyka_app;

--
-- Name: TABLE "McpCall"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public."McpCall" TO logistyka_app;

--
-- Name: TABLE "Membership"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public."Membership" TO logistyka_app;

--
-- Name: TABLE "NotificationSettings"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."NotificationSettings" TO logistyka_app;

--
-- Name: TABLE "Order"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Order" TO logistyka_app;

--
-- Name: TABLE "OrderBulkAction"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderBulkAction" TO logistyka_app;

--
-- Name: TABLE "OrderCardPrint"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderCardPrint" TO logistyka_app;

--
-- Name: TABLE "OrderCustomer"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderCustomer" TO logistyka_app;

--
-- Name: TABLE "OrderEvent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderEvent" TO logistyka_app;

--
-- Name: TABLE "OrderLine"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderLine" TO logistyka_app;

--
-- Name: TABLE "OrderNote"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderNote" TO logistyka_app;

--
-- Name: TABLE "OrderPayment"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderPayment" TO logistyka_app;

--
-- Name: TABLE "OrderStatusDef"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderStatusDef" TO logistyka_app;

--
-- Name: TABLE "OrderStatusGroup"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrderStatusGroup" TO logistyka_app;

--
-- Name: TABLE "Organization"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public."Organization" TO logistyka_app;

--
-- Name: COLUMN "Organization".name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(name) ON TABLE public."Organization" TO logistyka_app;

--
-- Name: COLUMN "Organization".settings; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(settings) ON TABLE public."Organization" TO logistyka_app;

--
-- Name: COLUMN "Organization"."updatedAt"; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE("updatedAt") ON TABLE public."Organization" TO logistyka_app;

--
-- Name: TABLE "OrganizationLogo"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OrganizationLogo" TO logistyka_app;

--
-- Name: TABLE "OutboxEvent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."OutboxEvent" TO logistyka_app;

--
-- Name: TABLE "PackBasket"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PackBasket" TO logistyka_app;

--
-- Name: TABLE "PackDrill"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PackDrill" TO logistyka_app;

--
-- Name: TABLE "PackDrillFix"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PackDrillFix" TO logistyka_app;

--
-- Name: TABLE "PackingZoneDef"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PackingZoneDef" TO logistyka_app;

--
-- Name: TABLE "PendingMovement"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PendingMovement" TO logistyka_app;

--
-- Name: TABLE "PlannedAction"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PlannedAction" TO logistyka_app;

--
-- Name: TABLE "PreparedShipment"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PreparedShipment" TO logistyka_app;

--
-- Name: TABLE "PrintJob"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PrintJob" TO logistyka_app;

--
-- Name: TABLE "PrintJobFile"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PrintJobFile" TO logistyka_app;

--
-- Name: TABLE "PrintStation"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."PrintStation" TO logistyka_app;

--
-- Name: TABLE "Product"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Product" TO logistyka_app;

--
-- Name: TABLE "ProductImage"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ProductImage" TO logistyka_app;

--
-- Name: TABLE "ProductImageData"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ProductImageData" TO logistyka_app;

--
-- Name: TABLE "ProductZoneRule"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ProductZoneRule" TO logistyka_app;

--
-- Name: TABLE "Reservation"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Reservation" TO logistyka_app;

--
-- Name: TABLE "ReservationPolicy"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ReservationPolicy" TO logistyka_app;

--
-- Name: TABLE "Return"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Return" TO logistyka_app;

--
-- Name: TABLE "ReturnLine"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ReturnLine" TO logistyka_app;

--
-- Name: TABLE "ReturnPhoto"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ReturnPhoto" TO logistyka_app;

--
-- Name: TABLE "ShadowDailyCheck"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ShadowDailyCheck" TO logistyka_app;

--
-- Name: TABLE "ShadowJobState"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ShadowJobState" TO logistyka_app;

--
-- Name: TABLE "Shipment"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Shipment" TO logistyka_app;

--
-- Name: TABLE "ShipmentTrackEvent"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ShipmentTrackEvent" TO logistyka_app;

--
-- Name: TABLE "Shortage"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Shortage" TO logistyka_app;

--
-- Name: TABLE "ShortageDecision"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."ShortageDecision" TO logistyka_app;

--
-- Name: TABLE "Stock"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Stock" TO logistyka_app;

--
-- Name: TABLE "StockMovement"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."StockMovement" TO logistyka_app;

--
-- Name: TABLE "StockSyncJob"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."StockSyncJob" TO logistyka_app;

--
-- Name: TABLE "Warehouse"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."Warehouse" TO logistyka_app;

--
-- Name: TABLE "WfirmaGood"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."WfirmaGood" TO logistyka_app;

--
-- Name: TABLE "WfirmaQueueState"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."WfirmaQueueState" TO logistyka_app;

--
-- Name: TABLE "WfirmaWzSnapshot"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."WfirmaWzSnapshot" TO logistyka_app;

--
-- Name: TABLE "WzAttempt"; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public."WzAttempt" TO logistyka_app;

--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO logistyka_app;

--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO logistyka_app;

--
-- PostgreSQL database dump complete
--
