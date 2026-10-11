/**
 * Utility per numeri tessera Wiegand-26.
 * Il controller memorizza il numero come facility × 100000 + numero (es. 10058400 = facility 100, numero 58400).
 */

export interface Wiegand26 {
  facility: number
  number: number
}

export function isValidWiegand26(card: number): boolean {
  if (!Number.isInteger(card) || card <= 0) return false
  const facility = Math.floor(card / 100000)
  const number = card % 100000
  return facility <= 255 && number <= 65535
}

export function splitWiegand26(card: number): Wiegand26 {
  return { facility: Math.floor(card / 100000), number: card % 100000 }
}

export function joinWiegand26(facility: number, number: number): number {
  if (!Number.isInteger(facility) || facility < 0 || facility > 255) throw new RangeError(`facility code non valido: ${facility}`)
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new RangeError(`numero tessera non valido: ${number}`)
  return facility * 100000 + number
}

/**
 * Converte il valore grezzo a 24 bit (senza parità) letto da un lettore Wiegand-26 nel formato del controller.
 * Utile per tessere che riportano stampato il codice decimale a 10 cifre (valore a 24 bit).
 */
export function fromRaw24(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffff) throw new RangeError(`valore a 24 bit non valido: ${raw}`)
  return joinWiegand26((raw >>> 16) & 0xff, raw & 0xffff)
}

export function toRaw24(card: number): number {
  const { facility, number } = splitWiegand26(card)
  return ((facility & 0xff) << 16) | (number & 0xffff)
}
