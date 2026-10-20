/**
 * Utilities for Wiegand-26 card numbers.
 * The controller stores the number as facility × 100000 + number (e.g. 10058400 = facility 100, number 58400).
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
  if (!Number.isInteger(facility) || facility < 0 || facility > 255)
    throw new RangeError(`invalid facility code: ${facility}`)
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new RangeError(`invalid card number: ${number}`)
  return facility * 100000 + number
}

/**
 * Converts the raw 24-bit value (without parity) read by a Wiegand-26 reader to the controller format.
 * Useful for cards printed with the 10-digit decimal code (24-bit value).
 */
export function fromRaw24(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffff) throw new RangeError(`invalid 24-bit value: ${raw}`)
  return joinWiegand26((raw >>> 16) & 0xff, raw & 0xffff)
}

export function toRaw24(card: number): number {
  const { facility, number } = splitWiegand26(card)
  return ((facility & 0xff) << 16) | (number & 0xffff)
}
