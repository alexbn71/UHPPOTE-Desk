/**
 * Home Assistant add-on: turns the add-on options (/data/options.json) and what the Supervisor knows (MQTT broker,
 * host network, port mapping) into the environment variables of UHPPOTE Desk, printed as `export` lines for the
 * start script. Runs without a Supervisor too (local tests): the missing parts are simply left out.
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const LANGUAGES = ['en', 'it', 'es', 'fr', 'de']

/** Broadcast address of an IPv4 network in CIDR form ("192.168.1.10/24" → "192.168.1.255"). */
export function broadcastOf(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr ?? '')
  if (!m) return null
  const prefix = Number(m[5])
  if (prefix < 0 || prefix > 32) return null
  const ip = m.slice(1, 5).reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const bc = (ip | ~mask) >>> 0
  return [24, 16, 8, 0].map((s) => (bc >>> s) & 255).join('.')
}

/** IPv4 address (CIDR) of the primary interface of the host, from the Supervisor's /network/info. */
export function primaryIPv4(network) {
  const interfaces = network?.interfaces ?? []
  const iface =
    interfaces.find((i) => i.primary && i.ipv4?.address?.length) ?? interfaces.find((i) => i.ipv4?.address?.length)
  return iface?.ipv4.address[0] ?? null
}

/**
 * Environment of UHPPOTE Desk.
 * @param {{ options: Record<string, unknown>, mqtt?: object|null, network?: object|null, ports?: Record<string, number|null>|null }} input
 */
export function buildEnv({ options = {}, mqtt = null, network = null, ports = null }) {
  const env = {}
  const httpPort = ports?.['8080/tcp'] || 8080
  const eventPort = ports?.['60001/udp'] || 60001
  env.HTTP_PORT = String(httpPort)
  env.UHPPOTE_LISTEN = `0.0.0.0:${eventPort}`

  const cidr = primaryIPv4(network)
  const hostIp = cidr?.split('/')[0] ?? null
  const destination = String(options.event_destination ?? '').trim() || (hostIp ? `${hostIp}:${eventPort}` : '')
  if (destination) env.UHPPOTE_LISTENER_PUBLIC = destination
  const broadcast =
    String(options.discovery_broadcast ?? '').trim() || (cidr && broadcastOf(cidr) ? `${broadcastOf(cidr)}:60000` : '')
  if (broadcast) env.UHPPOTE_BROADCAST = broadcast

  const password = String(options.admin_password ?? '')
  if (password) env.ADMIN_PASSWORD = password

  if (options.mqtt_enabled !== false && mqtt?.host) {
    env.MQTT_URL = `${mqtt.ssl ? 'mqtts' : 'mqtt'}://${mqtt.host}:${mqtt.port ?? (mqtt.ssl ? 8883 : 1883)}`
    if (mqtt.username) env.MQTT_USERNAME = String(mqtt.username)
    if (mqtt.password) env.MQTT_PASSWORD = String(mqtt.password)
    env.MQTT_DOOR_CONTROL = options.mqtt_door_control === false ? 'false' : 'true'
    env.MQTT_LANGUAGE = LANGUAGES.includes(options.mqtt_language) ? options.mqtt_language : 'en'
  }

  const publicUrl = String(options.public_url ?? '').trim()
  if (publicUrl) env.PUBLIC_URL = publicUrl
  if (options.secure_cookies === true) env.SECURE_COOKIES = 'true'
  if (options.packet_debug === true) env.UHPPOTE_DEBUG = 'true'
  if (['debug', 'info', 'warn', 'error'].includes(options.log_level)) env.LOG_LEVEL = options.log_level
  // the database and the backups live in /data, which Home Assistant includes in its own backups
  env.PUID = '0'
  env.PGID = '0'
  return env
}

/** Shell `export` lines (values in single quotes, safe for any character). */
export function toShell(env) {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}='${String(v).replaceAll("'", `'\\''`)}'`)
    .join('\n')
}

async function supervisor(path) {
  const token = process.env.SUPERVISOR_TOKEN
  if (!token) return null
  try {
    const r = await fetch(`http://supervisor${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    return (await r.json()).data ?? null
  } catch {
    return null
  }
}

async function main() {
  const file = process.env.ADDON_OPTIONS ?? '/data/options.json'
  const options = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const [mqtt, network, self] = await Promise.all([
    supervisor('/services/mqtt'),
    supervisor('/network/info'),
    supervisor('/addons/self/info'),
  ])
  const env = buildEnv({ options, mqtt, network, ports: self?.network ?? null })
  const log = (m) => process.stderr.write(`add-on: ${m}\n`)
  log(`web interface on port ${env.HTTP_PORT}, events on ${env.UHPPOTE_LISTEN}`)
  log(`event destination for the controllers: ${env.UHPPOTE_LISTENER_PUBLIC ?? 'not set (events only by polling)'}`)
  log(`discovery broadcast: ${env.UHPPOTE_BROADCAST ?? 'default'}`)
  log(
    env.MQTT_URL
      ? `Home Assistant integration: MQTT broker ${env.MQTT_URL}`
      : 'Home Assistant integration: off (no MQTT broker)',
  )
  process.stdout.write(toShell(env) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
