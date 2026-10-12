import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import webpush from 'web-push'
import { mobileSettingsSchema, type MobileSettings } from '@uhppote-desk/shared'
import { HttpError } from '../auth/auth.js'
import type { Db } from '../db/database.js'

const SETTINGS_KEY = 'mobile'
const VAPID_KEY = 'vapid'
/** How long a fingerprint/Face ID challenge stays valid. */
const CHALLENGE_TTL_MS = 2 * 60_000

/** Where the browser sees the app: relying party id (host name) and origin, for WebAuthn. */
export interface RelyingParty {
  rpID: string
  origin: string
}

interface Challenge {
  value: string
  expires: number
}

/**
 * Mobile app settings, the VAPID keys of the push notifications, and fingerprint/Face ID
 * (WebAuthn, one platform credential per remembered device).
 */
export class MobileService {
  private readonly challenges = new Map<string, Challenge>()

  constructor(private readonly db: Db) {}

  settings(): MobileSettings {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])
    const parsed = mobileSettingsSchema.safeParse(row ? JSON.parse(row.value) : {})
    return parsed.success ? parsed.data : mobileSettingsSchema.parse({})
  }

  saveSettings(s: MobileSettings): void {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [SETTINGS_KEY, JSON.stringify(s)],
    )
  }

  /** VAPID keys of this installation, generated on first use. */
  vapidKeys(): { publicKey: string; privateKey: string } {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [VAPID_KEY])
    if (row) return JSON.parse(row.value) as { publicKey: string; privateKey: string }
    const keys = webpush.generateVAPIDKeys()
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [VAPID_KEY, JSON.stringify(keys)])
    return keys
  }

  // --- challenges ---------------------------------------------------------------------------------

  private putChallenge(key: string, value: string): void {
    const now = Date.now()
    for (const [k, c] of this.challenges) if (c.expires < now) this.challenges.delete(k)
    this.challenges.set(key, { value, expires: now + CHALLENGE_TTL_MS })
  }

  /** Takes (and consumes) a challenge: each one is valid for one verification only. */
  private takeChallenge(key: string): string {
    const c = this.challenges.get(key)
    this.challenges.delete(key)
    if (!c || c.expires < Date.now()) throw new HttpError(403, 'biometricFailed')
    return c.value
  }

  // --- fingerprint / Face ID ------------------------------------------------------------------------

  hasBiometric(deviceId: number): boolean {
    return !!this.db.get('SELECT 1 FROM webauthn_credentials WHERE device_id = ?', [deviceId])
  }

  async registrationOptions(
    rp: RelyingParty,
    deviceId: number,
    user: { username: string; displayName: string },
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: 'UHPPOTE Desk',
      rpID: rp.rpID,
      userName: user.username,
      userDisplayName: user.displayName,
      attestationType: 'none',
      // the authenticator of this phone, with the user verified (fingerprint, face, PIN of the phone)
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
    })
    this.putChallenge(`reg:${deviceId}`, options.challenge)
    return options
  }

  async verifyRegistration(rp: RelyingParty, deviceId: number, response: RegistrationResponseJSON): Promise<void> {
    const expectedChallenge = this.takeChallenge(`reg:${deviceId}`)
    let verified
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      })
    } catch {
      throw new HttpError(403, 'biometricFailed')
    }
    if (!verified.verified) throw new HttpError(403, 'biometricFailed')
    const c = verified.registrationInfo.credential
    this.db.tx(() => {
      this.db.run('DELETE FROM webauthn_credentials WHERE device_id = ?', [deviceId])
      this.db.run(
        'INSERT INTO webauthn_credentials (id, device_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)',
        [c.id, deviceId, c.publicKey, c.counter, JSON.stringify(c.transports ?? [])],
      )
    })
  }

  removeBiometric(deviceId: number): void {
    this.db.run('DELETE FROM webauthn_credentials WHERE device_id = ?', [deviceId])
  }

  private credential(deviceId: number) {
    const r = this.db.get<{ id: string; public_key: Uint8Array; counter: number; transports: string }>(
      'SELECT * FROM webauthn_credentials WHERE device_id = ?',
      [deviceId],
    )
    if (!r) throw new HttpError(400, 'biometricNotRegistered')
    return {
      id: r.id,
      publicKey: new Uint8Array(r.public_key),
      counter: r.counter,
      transports: JSON.parse(r.transports) as string[],
    }
  }

  /** Challenge to open a door with fingerprint/Face ID, bound to the device and the door. */
  async openOptions(
    rp: RelyingParty,
    deviceId: number,
    doorId: number,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const cred = this.credential(deviceId)
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: [{ id: cred.id, transports: cred.transports }],
      userVerification: 'required',
    })
    this.putChallenge(`open:${deviceId}:${doorId}`, options.challenge)
    return options
  }

  /** Verifies the fingerprint/Face ID confirmation of a door opening; throws 403 if it is not valid. */
  async verifyOpen(
    rp: RelyingParty,
    deviceId: number,
    doorId: number,
    response: AuthenticationResponseJSON,
  ): Promise<void> {
    const expectedChallenge = this.takeChallenge(`open:${deviceId}:${doorId}`)
    const cred = this.credential(deviceId)
    if (response.id !== cred.id) throw new HttpError(403, 'biometricFailed')
    let verified
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: cred,
        requireUserVerification: true,
      })
    } catch {
      throw new HttpError(403, 'biometricFailed')
    }
    if (!verified.verified) throw new HttpError(403, 'biometricFailed')
    this.db.run('UPDATE webauthn_credentials SET counter = ? WHERE id = ?', [
      verified.authenticationInfo.newCounter,
      cred.id,
    ])
  }
}
