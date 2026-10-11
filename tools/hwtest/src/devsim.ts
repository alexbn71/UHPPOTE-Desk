/**
 * Simulatore di sviluppo: avvia uno o più controller UT0311-L04 emulati (FakeController) su UDP+TCP,
 * per usare l'app senza hardware. Comandi da tastiera per simulare passaggi e porte.
 *
 *   npm run sim -- [--host 0.0.0.0] [--port 60000] [--serial 405419896] [--auto 10]
 */
import readline from 'node:readline'
import { parseArgs } from 'node:util'
import { FakeController } from '@uhppote-desk/protocol/testing'

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '60000' },
    serial: { type: 'string', default: '405419896' },
    auto: { type: 'string', default: '0' },
  },
})

const fake = new FakeController({ id: Number(values.serial), host: values.host, port: Number(values.port), tcp: true })
const ep = await fake.start()
console.log(`Controller simulato ${fake.id} in ascolto su ${ep.host}:${ep.port} (UDP+TCP)`)
console.log(`Comandi: s <tessera> [porta]  = swipe   |  o <porta> / c <porta> = apri/chiudi sensore  |  b <porta> = pulsante`)
console.log(`         l = elenco tessere   |  e = ultimi eventi   |  off / on = scollega/ricollega   |  q = esci`)

const auto = Number(values.auto)
if (auto > 0) {
  setInterval(() => {
    const cards = fake.cards
    const card = cards.length && Math.random() < 0.8 ? cards[Math.floor(Math.random() * cards.length)]!.card : 10099999
    const e = fake.swipe(card, 1 + Math.floor(Math.random() * 4), Math.random() < 0.5 ? 1 : 2)
    console.log(`[auto] swipe ${card} porta ${e.door}: ${e.granted ? 'consentito' : 'negato'} (motivo ${e.reason})`)
  }, auto * 1000)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const [cmd, a, b] = line.trim().split(/\s+/)
  try {
    switch (cmd) {
      case 's': {
        const e = fake.swipe(Number(a), Number(b ?? 1))
        console.log(`evento #${e.index}: ${e.granted ? 'CONSENTITO' : 'NEGATO'} (motivo ${e.reason})`)
        break
      }
      case 'o':
      case 'c':
        fake.setDoorSensor(Number(a ?? 1), cmd === 'o')
        break
      case 'b':
        fake.pressButton(Number(a ?? 1))
        break
      case 'l':
        console.table(fake.cards)
        break
      case 'e':
        console.table(fake.events.slice(-10))
        break
      case 'off':
        fake.offline = true
        console.log('controller scollegato dalla rete (continua a registrare eventi)')
        break
      case 'on':
        fake.offline = false
        console.log('controller ricollegato')
        break
      case 'q':
        void fake.stop().then(() => process.exit(0))
        break
      default:
        if (cmd) console.log('comando sconosciuto')
    }
  } catch (err) {
    console.log(`errore: ${(err as Error).message}`)
  }
})
