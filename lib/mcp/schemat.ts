// Mały walidator JSON Schema dla schematów narzędzi MCP. Jedno źródło: ten sam schemat idzie do klienta
// w `tools/list` (`inputSchema`, `outputSchema`) i sprawdza argumenty przed `run`, a w testach — wynik narzędzia.
// Obsługuje tylko słowa kluczowe, których używają nasze narzędzia (type, enum, properties, required,
// additionalProperties: false, items, min/maxLength, minimum/maximum, min/maxItems, pattern, description). Nieznane
// słowo kluczowe w schemacie narzędzia = błąd w testach (`assertSupportedSchema`), żeby nie udawać walidacji.

export type JsonSchema = {
  type?: SchemaType | SchemaType[]
  description?: string
  enum?: readonly (string | number | boolean | null)[]
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: false | JsonSchema
  items?: JsonSchema
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  examples?: readonly unknown[]
}

type SchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null'

const SUPPORTED = new Set(['type', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'examples'])

function typeOf(v: unknown): SchemaType {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v as SchemaType
}

/** Lista błędów (pusta = zgodne). Ścieżka jak `pozycje[1].ilosc`. */
export function validate(schema: JsonSchema, value: unknown, path = ''): string[] {
  const at = path || 'argumenty'
  const errors: string[] = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const t = typeOf(value)
    const ok = types.includes(t) || (t === 'integer' && types.includes('number'))
    if (!ok) return [`${at}: oczekiwany typ ${types.join(' albo ')}`]
  }
  if (schema.enum && !schema.enum.includes(value as never)) errors.push(`${at}: dozwolone wartości ${schema.enum.join(', ')}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: co najmniej ${schema.minLength} znaków`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: najwyżej ${schema.maxLength} znaków`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: zły format`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: najmniej ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: najwyżej ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: co najmniej ${schema.minItems} pozycji`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: najwyżej ${schema.maxItems} pozycji`)
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (!(k in o) || o[k] === undefined) errors.push(`${path ? `${path}.` : ''}${k}: pole wymagane`)
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties?.[k]
      const p = path ? `${path}.${k}` : k
      if (sub) errors.push(...validate(sub, v, p))
      else if (schema.additionalProperties === false) errors.push(`${p.slice(0, 60)}: nieznane pole`)
      else if (schema.additionalProperties) errors.push(...validate(schema.additionalProperties, v, p))
    }
  }
  return errors
}

/** Rzuca, gdy schemat używa słowa kluczowego, którego `validate` nie rozumie (strażnik w testach). */
export function assertSupportedSchema(schema: JsonSchema, path = '#'): void {
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) throw new Error(`${path}: nieobsługiwane słowo kluczowe ${k}`)
  for (const [k, v] of Object.entries(schema.properties ?? {})) assertSupportedSchema(v, `${path}/properties/${k}`)
  if (schema.items) assertSupportedSchema(schema.items, `${path}/items`)
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties, `${path}/additionalProperties`)
}
