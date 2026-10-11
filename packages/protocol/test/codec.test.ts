import { describe, expect, it } from 'vitest'
import { Reader, Writer } from '../src/codec/bytes.js'
import {
  CodecError,
  decode,
  decodeListenerEvent,
  encode,
  fromRaw24,
  FunctionCode,
  isValidWiegand26,
  joinWiegand26,
  splitWiegand26,
  toRaw24,
} from '../src/index.js'

describe('codifiche BCD', () => {
  it('data: round trip e valori assenti', () => {
    const w = new Writer(0x50, 1).date(12, '2026-10-11')
    expect(w.buf.subarray(12, 16).toString('hex')).toBe('20261011')
    const r = new Reader(w.buf)
    expect(r.date(12)).toBe('2026-10-11')
    expect(r.date(16)).toBeNull()
  })

  it('datetime: round trip', () => {
    const w = new Writer(0x30, 1).datetime(8, '2026-02-28 23:59:07')
    expect(w.buf.subarray(8, 15).toString('hex')).toBe('20260228235907')
    expect(new Reader(w.buf).datetime(8)).toBe('2026-02-28 23:59:07')
  })

  it('rifiuta date e ore inesistenti', () => {
    expect(() => new Writer(0x50, 1).date(12, '2026-02-30')).toThrow(CodecError)
    expect(() => new Writer(0x50, 1).date(12, '26-1-1')).toThrow(CodecError)
    expect(() => new Writer(0x30, 1).datetime(8, '2026-01-01 24:00:00')).toThrow(CodecError)
    expect(() => new Writer(0x88, 1).hhmm(24, '25:00')).toThrow(CodecError)
  })

  it('HHmm accetta ore a una cifra e 24:00', () => {
    const w = new Writer(0x88, 1).hhmm(24, '8:30').hhmm(26, '24:00')
    expect(w.buf.subarray(24, 28).toString('hex')).toBe('08302400')
  })

  it('decodifica BCD non valido come null (tollerante)', () => {
    const buf = Buffer.alloc(64)
    buf[0] = 0x17
    buf.write('2026ab01', 12, 'hex')
    expect(new Reader(buf).date(12)).toBeNull()
  })

  it('PIN a 24 bit e range', () => {
    const w = new Writer(0x50, 1).pin24(24, 999999)
    expect(new Reader(w.buf).pin24(24)).toBe(999999)
    expect(() => new Writer(0x50, 1).pin24(24, 1_000_000)).toThrow(CodecError)
  })

  it('versione firmware BCD', () => {
    const buf = Buffer.alloc(64)
    buf[26] = 0x06
    buf[27] = 0x62
    expect(new Reader(buf).version(26)).toBe('v6.62')
  })
})

describe('validazioni encoder', () => {
  it('porta fuori range', () => {
    expect(() => encode.openDoor(1, 0)).toThrow(CodecError)
    expect(() => encode.openDoor(1, 5)).toThrow(CodecError)
  })

  it('profilo orario: ID e profilo collegato', () => {
    const base = {
      from: '2026-01-01',
      to: '2026-12-31',
      weekdays: [true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
      segments: [{ start: '08:00', end: '17:00' }],
    }
    expect(() => encode.setTimeProfile(1, { ...base, id: 1, linkedTo: 0 })).toThrow(CodecError)
    expect(() => encode.setTimeProfile(1, { ...base, id: 255, linkedTo: 0 })).toThrow(CodecError)
    expect(() => encode.setTimeProfile(1, { ...base, id: 2, linkedTo: 1 })).toThrow(CodecError)
    expect(() =>
      encode.setTimeProfile(1, { ...base, id: 2, linkedTo: 0, segments: [base.segments[0]!, base.segments[0]!, base.segments[0]!, base.segments[0]!] }),
    ).toThrow(CodecError)
  })

  it('interblocco: solo valori ammessi', () => {
    for (const v of [0, 1, 2, 3, 4, 8]) expect(() => encode.setInterlock(1, v)).not.toThrow()
    for (const v of [5, 6, 7, 9]) expect(() => encode.setInterlock(1, v)).toThrow(CodecError)
  })

  it('first-card: modalità attiva non può essere "solo first-card"', () => {
    expect(() =>
      encode.setFirstCard(1, { door: 1, start: '08:00', end: '18:00', activeMode: 3, inactiveMode: 0, weekdays: [true, true, true, true, true, true, true] }),
    ).toThrow(CodecError)
  })

  it('tessera: numero 0 e 0xFFFFFFFF rifiutati', () => {
    const card = { from: '2026-01-01', to: '2026-12-31', doors: [1, 0, 0, 0] as [number, number, number, number], pin: 0, firstCard: [false, false, false, false] as [boolean, boolean, boolean, boolean] }
    expect(() => encode.putCard(1, { ...card, card: 0 })).toThrow(CodecError)
    expect(() => encode.putCard(1, { ...card, card: 0xffffffff })).toThrow(CodecError)
  })
})

describe('decoder', () => {
  it('rifiuta pacchetti di dimensione errata o function code diverso', () => {
    expect(() => decode.getTime(Buffer.alloc(63))).toThrow(CodecError)
    const pkt = encode.getStatus(1)
    expect(() => decode.getTime(pkt)).toThrow(CodecError)
  })

  it('evento listener con SOM 0x19 (firmware v6.62)', () => {
    const pkt = encode.getStatus(405419896)
    pkt[0] = 0x19
    pkt.writeUInt32LE(42, 8)
    pkt[12] = 1
    const s = decodeListenerEvent(pkt)
    expect(s?.controller).toBe(405419896)
    expect(s?.event?.index).toBe(42)
  })

  it('SOM 0x19 accettato solo per gli eventi', () => {
    const pkt = encode.getTime(1)
    pkt[0] = 0x19
    expect(() => decode.getTime(pkt)).toThrow(CodecError)
    expect(decodeListenerEvent(Buffer.alloc(64))).toBeNull()
  })

  it('relè: bitmask completa (corregge il difetto della libreria npm)', () => {
    const pkt = encode.getStatus(1)
    pkt[1] = FunctionCode.GetStatus
    pkt[49] = 0b1010
    expect(decode.getStatus(pkt).relayUnlocked).toEqual([false, true, false, true])
  })
})

describe('Wiegand-26', () => {
  it('split/join', () => {
    expect(splitWiegand26(10058400)).toEqual({ facility: 100, number: 58400 })
    expect(joinWiegand26(100, 58400)).toBe(10058400)
    expect(isValidWiegand26(10058400)).toBe(true)
    expect(isValidWiegand26(25665536)).toBe(false) // numero 65536 > 65535
    expect(isValidWiegand26(25600001)).toBe(false) // facility 256
  })

  it('conversione da/verso valore a 24 bit', () => {
    const raw = (100 << 16) | 58400
    expect(fromRaw24(raw)).toBe(10058400)
    expect(toRaw24(10058400)).toBe(raw)
  })
})
