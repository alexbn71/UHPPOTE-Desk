/** Licence plate text as stored and shown: upper case, letters and digits only ("ab 123-cd" → "AB123CD"). */
export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Characters that plate readers commonly confuse, mapped to one form (as AgentDVR's "Normalize" option). */
const LOOKALIKE: Record<string, string> = { B: '8', O: '0', I: '1', Z: '2', S: '5' }

/**
 * Key used to compare plates: the normalised text with look-alike letters turned into digits, so that a reading
 * matches whether or not the reader confused B/8, O/0, I/1, Z/2, S/5.
 */
export function plateMatchKey(text: string): string {
  return normalizePlate(text).replace(/[BOIZS]/g, (c) => LOOKALIKE[c]!)
}

/** Shortest reading taken as a plate (shorter texts are noise from the reader). */
export const MIN_PLATE_LENGTH = 5

/**
 * The plates in what a reader sent: several readings separated by commas, semicolons, bars or spaces. Readings
 * shorter than MIN_PLATE_LENGTH or without a digit are dropped: they are object labels ("car", "person") or noise.
 */
export function plateReadings(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,;|\s]+/)) {
    const p = normalizePlate(part)
    if (p.length >= MIN_PLATE_LENGTH && /\d/.test(p) && !out.includes(p)) out.push(p)
  }
  return out
}
