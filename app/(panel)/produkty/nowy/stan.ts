// Stan formularza „Dodaj produkt”: błąd z akcji serwera, pole, którego dotyczy, i produkt
// o tym samym SKU (link „przejdź do produktu”).
export interface StanDodania {
  error: string | null
  field: string | null
  istniejacyId?: string | null
}
