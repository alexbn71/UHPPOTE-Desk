import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { broadcastOf, buildEnv, primaryIPv4, toShell } from '../rootfs/usr/local/lib/uhppote-addon/options.mjs'

const network = {
  interfaces: [
    { interface: 'docker0', primary: false, ipv4: { address: ['172.30.32.1/23'] } },
    { interface: 'end0', primary: true, ipv4: { address: ['192.168.1.10/24'] } },
  ],
}
const mqtt = { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'secret' }

describe('Home Assistant add-on options', () => {
  it('broadcast and primary address', () => {
    expect(broadcastOf('192.168.1.10/24')).toBe('192.168.1.255')
    expect(broadcastOf('10.1.2.3/16')).toBe('10.1.255.255')
    expect(broadcastOf('10.1.2.3/32')).toBe('10.1.2.3')
    expect(broadcastOf('nonsense')).toBeNull()
    expect(primaryIPv4(network)).toBe('192.168.1.10/24')
    expect(primaryIPv4({ interfaces: [] })).toBeNull()
  })

  it('defaults: addresses from the host network, MQTT from the Supervisor', () => {
    const env = buildEnv({
      options: { mqtt_enabled: true, mqtt_door_control: true, mqtt_language: 'it', log_level: 'info' },
      mqtt,
      network,
    })
    expect(env).toMatchObject({
      HTTP_PORT: '8080',
      UHPPOTE_LISTEN: '0.0.0.0:60001',
      UHPPOTE_LISTENER_PUBLIC: '192.168.1.10:60001',
      UHPPOTE_BROADCAST: '192.168.1.255:60000',
      MQTT_URL: 'mqtt://core-mosquitto:1883',
      MQTT_USERNAME: 'addons',
      MQTT_PASSWORD: 'secret',
      MQTT_DOOR_CONTROL: 'true',
      MQTT_LANGUAGE: 'it',
      LOG_LEVEL: 'info',
    })
    expect(env.ADMIN_PASSWORD).toBeUndefined()
  })

  it('explicit options win; MQTT off; port mapping', () => {
    const env = buildEnv({
      options: {
        admin_password: 'pw',
        event_destination: '10.0.0.5:60001',
        discovery_broadcast: '10.0.0.255:60000',
        mqtt_enabled: false,
        public_url: 'https://doors.example.com',
        secure_cookies: true,
        packet_debug: true,
      },
      mqtt,
      network,
      ports: { '8080/tcp': 8099, '60001/udp': null },
    })
    expect(env).toMatchObject({
      ADMIN_PASSWORD: 'pw',
      UHPPOTE_LISTENER_PUBLIC: '10.0.0.5:60001',
      UHPPOTE_BROADCAST: '10.0.0.255:60000',
      HTTP_PORT: '8099',
      UHPPOTE_LISTEN: '0.0.0.0:60001',
      PUBLIC_URL: 'https://doors.example.com',
      SECURE_COOKIES: 'true',
      UHPPOTE_DEBUG: 'true',
    })
    expect(env.MQTT_URL).toBeUndefined()
  })

  it('without a Supervisor nothing is guessed', () => {
    const env = buildEnv({ options: {} })
    expect(env.UHPPOTE_LISTENER_PUBLIC).toBeUndefined()
    expect(env.UHPPOTE_BROADCAST).toBeUndefined()
    expect(env.MQTT_URL).toBeUndefined()
  })

  it('shell output keeps any character of the values', () => {
    const value = `it's "quoted" $HOME \`x\` \\ end`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-'))
    const script = path.join(dir, 'env.sh')
    fs.writeFileSync(script, toShell({ ADMIN_PASSWORD: value }) + '\nprintf %s "$ADMIN_PASSWORD"\n')
    expect(execFileSync('sh', [script], { encoding: 'utf8' })).toBe(value)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
