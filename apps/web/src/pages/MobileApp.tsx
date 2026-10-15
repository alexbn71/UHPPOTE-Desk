import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  MultiSelect,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core'
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { IconDoor, IconFingerprint, IconLogout, IconSettings, IconHistory, IconLockOpen } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type {
  EventDto,
  Language,
  MobileConfigDto,
  MobileDoorDto,
  PushPreferencesDto,
  WebhookEvent,
} from '@uhppote-desk/shared'
import { LANGUAGES, WEBHOOK_EVENTS } from '@uhppote-desk/shared'
import { GrantedBadge } from '../components/common'
import { Credits } from '../components/Credits'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { isStandalone, pushSupported, vapidKey } from '../lib/device'
import { fmtDate, fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'

type Tab = 'doors' | 'events' | 'settings'

/** Mobile app (/m): open doors, latest events, push notifications and fingerprint/Face ID of this device. */
export function MobileApp() {
  const { t } = useTranslation()
  const live = useLive()
  const [tab, setTab] = useState<Tab>('doors')
  const config = useQuery({ queryKey: ['mobile-config'], queryFn: () => api.get<MobileConfigDto>('/mobile/config') })

  return (
    <Box mih="100dvh" bg="var(--mantine-color-body)" pb={84}>
      <Group
        justify="space-between"
        px="md"
        py="sm"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--mantine-color-body)',
          borderBottom: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Group gap="xs">
          <img src="/icon.svg" width={28} height={28} alt="" />
          <Title order={4}>{t('app.name')}</Title>
        </Group>
        <Badge color={live.connected ? 'green' : 'red'} variant="dot">
          {live.connected ? t('common.live') : t('common.offline')}
        </Badge>
      </Group>
      <Box p="md">
        {!config.data ? (
          <Group justify="center" mt="xl">
            <Loader />
          </Group>
        ) : tab === 'doors' ? (
          <DoorsTab config={config.data} />
        ) : tab === 'events' ? (
          <EventsTab />
        ) : (
          <SettingsTab config={config.data} />
        )}
        <Credits />
      </Box>
      <Box
        px="md"
        py="xs"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'var(--mantine-color-body)',
          borderTop: '1px solid var(--mantine-color-default-border)',
          paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
        }}
      >
        <SegmentedControl
          fullWidth
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          data={[
            { value: 'doors', label: <TabLabel icon={<IconDoor size={18} />} text={t('mobile.tabDoors')} /> },
            { value: 'events', label: <TabLabel icon={<IconHistory size={18} />} text={t('mobile.tabEvents')} /> },
            { value: 'settings', label: <TabLabel icon={<IconSettings size={18} />} text={t('mobile.tabSettings')} /> },
          ]}
        />
      </Box>
    </Box>
  )
}

function TabLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <Stack gap={0} align="center">
      {icon}
      <Text size="xs">{text}</Text>
    </Stack>
  )
}

// --- doors ------------------------------------------------------------------------------------------

function DoorsTab({ config }: { config: MobileConfigDto }) {
  const { t } = useTranslation()
  const live = useLive()
  const doors = useQuery({ queryKey: ['mobile-doors'], queryFn: () => api.get<MobileDoorDto[]>('/mobile/doors') })
  const focus = Number(new URLSearchParams(location.search).get('door')) || null
  const biometric = config.openConfirmation === 'biometric'
  const needsSetup = biometric && doors.data?.some((d) => d.canOpen) && (!config.device || !config.device.biometric)

  useEffect(() => {
    if (focus && doors.data) document.getElementById(`door-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus, doors.data])

  return (
    <Stack>
      {needsSetup &&
        (config.device ? <BiometricSetup required /> : <Alert color="orange">{t('mobile.notRemembered')}</Alert>)}
      {doors.data?.length === 0 && <Text c="dimmed">{t('mobile.noDoors')}</Text>}
      {(doors.data ?? []).map((d) => {
        const state = live.states[d.controllerId]
        const door = state?.doors.find((x) => x.door === d.door)
        return (
          <Card
            key={d.id}
            id={`door-${d.id}`}
            withBorder
            padding="md"
            style={focus === d.id ? { borderColor: 'var(--mantine-color-blue-filled)', borderWidth: 2 } : undefined}
          >
            <Group justify="space-between" mb="sm" wrap="nowrap">
              <Stack gap={0}>
                <Text fw={600}>{d.name}</Text>
                <Text size="xs" c="dimmed">
                  {d.controllerName}
                </Text>
              </Stack>
              <Group gap={4}>
                {!state?.online ? (
                  <Badge color="gray">{t('mobile.offline')}</Badge>
                ) : (
                  <>
                    <Badge color={door?.open ? 'orange' : 'green'} variant="light">
                      {door?.open ? t('mobile.doorOpen') : t('mobile.doorClosed')}
                    </Badge>
                    {door?.unlocked && <Badge color="blue">{t('mobile.unlocked')}</Badge>}
                  </>
                )}
              </Group>
            </Group>
            {!d.canOpen ? (
              <Text size="sm" c="dimmed">
                {t('mobile.viewOnly')}
              </Text>
            ) : biometric ? (
              <BiometricOpen door={d} enabled={!!config.device?.biometric} />
            ) : (
              <HoldToOpen door={d} />
            )}
          </Card>
        )
      })}
    </Stack>
  )
}

const HOLD_MS = 1200

/** "Hold to open": the door opens after the button has been held down for HOLD_MS. */
function HoldToOpen({ door }: { door: MobileDoorDto }) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)
  const started = useRef(0)

  const cancel = () => {
    if (timer.current) cancelAnimationFrame(timer.current)
    timer.current = null
    setProgress(0)
  }
  const tick = () => {
    const p = Math.min(1, (Date.now() - started.current) / HOLD_MS)
    setProgress(p)
    if (p < 1) {
      timer.current = requestAnimationFrame(tick)
      return
    }
    timer.current = null
    navigator.vibrate?.(40)
    setBusy(true)
    api
      .post(`/doors/${door.id}/open`, {})
      .then(() => notifyOk(t('mobile.opened', { door: door.name })))
      .catch(notifyError)
      .finally(() => {
        setBusy(false)
        setProgress(0)
      })
  }
  const start = (e: PointerEvent) => {
    if (busy) return
    e.preventDefault()
    started.current = Date.now()
    timer.current = requestAnimationFrame(tick)
  }

  return (
    <Button
      fullWidth
      size="lg"
      leftSection={busy ? <Loader size="xs" color="white" /> : <IconLockOpen size={20} />}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        backgroundImage: `linear-gradient(90deg, var(--mantine-color-green-filled) ${progress * 100}%, transparent ${progress * 100}%)`,
        touchAction: 'none',
        userSelect: 'none',
      }}
      aria-label={`${t('mobile.hold')}: ${door.name}`}
    >
      {busy ? t('mobile.opening') : t('mobile.hold')}
    </Button>
  )
}

/** Fingerprint / Face ID confirmation, then the opening. */
function BiometricOpen({ door, enabled }: { door: MobileDoorDto; enabled: boolean }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try {
      const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        `/mobile/doors/${door.id}/challenge`,
      )
      const webauthn = await startAuthentication({ optionsJSON })
      await api.post(`/doors/${door.id}/open`, { webauthn })
      navigator.vibrate?.(40)
      notifyOk(t('mobile.opened', { door: door.name }))
    } catch (err) {
      // the user closed the fingerprint/Face ID prompt: nothing to report
      if ((err as Error).name !== 'NotAllowedError') notifyError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      fullWidth
      size="lg"
      leftSection={<IconFingerprint size={20} />}
      loading={busy}
      disabled={!enabled}
      onClick={() => void open()}
    >
      {t('mobile.openBiometric')}
    </Button>
  )
}

/** Activation of fingerprint/Face ID: required by the administrator, or optional (no login expiry). */
function BiometricSetup({ required = false }: { required?: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  if (!browserSupportsWebAuthn()) return <Alert color="red">{t('mobile.bioUnsupported')}</Alert>
  const activate = async () => {
    setBusy(true)
    try {
      const optionsJSON =
        await api.post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/mobile/biometric/options')
      const response = await startRegistration({ optionsJSON })
      await api.post('/mobile/biometric', { response })
      notifyOk(t('mobile.bioDone'))
      void qc.invalidateQueries({ queryKey: ['mobile-config'] })
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') notifyError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Alert
      color="blue"
      title={t(required ? 'mobile.bioSetupTitle' : 'mobile.bioOptionalTitle')}
      icon={<IconFingerprint />}
    >
      <Stack gap="sm">
        <Text size="sm">{t(required ? 'mobile.bioSetupText' : 'mobile.bioOptionalText')}</Text>
        <Button leftSection={<IconFingerprint size={18} />} loading={busy} onClick={() => void activate()}>
          {t('mobile.bioActivate')}
        </Button>
      </Stack>
    </Alert>
  )
}

// --- events -----------------------------------------------------------------------------------------

function EventsTab() {
  const { t } = useTranslation()
  const codes = useCodes()
  const live = useLive()
  const recent = useQuery({
    queryKey: ['events', 'mobile'],
    queryFn: () => api.get<{ rows: EventDto[] }>('/events?limit=30'),
  })
  const ids = new Set<number>()
  const rows = [...live.events, ...(recent.data?.rows ?? [])]
    .filter((e) => !ids.has(e.id) && ids.add(e.id))
    .slice(0, 40)
  return (
    <Stack gap="xs">
      <Title order={5}>{t('mobile.recent')}</Title>
      {rows.length === 0 && <Text c="dimmed">{t('mobile.noEvents')}</Text>}
      {rows.map((e) => (
        <Card key={e.id} withBorder padding="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={0}>
              <Text size="sm" fw={500}>
                {e.personName ?? (e.card ? t('notify.unknownCard', { card: e.card }) : codes.reason(e.reason))}
              </Text>
              <Text size="xs" c="dimmed">
                {e.doorName ?? e.controllerName} · {fmtDateTime(e.timestamp)}
              </Text>
              {e.type !== 1 || !e.granted ? (
                <Text size="xs" c="dimmed">
                  {codes.reason(e.reason)}
                </Text>
              ) : null}
            </Stack>
            {e.type === 1 && <GrantedBadge granted={e.granted} />}
          </Group>
        </Card>
      ))}
    </Stack>
  )
}

// --- settings ---------------------------------------------------------------------------------------

function SettingsTab({ config }: { config: MobileConfigDto }) {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const device = config.device

  const removeBiometric = () =>
    api
      .del('/mobile/biometric')
      .then(() => qc.invalidateQueries({ queryKey: ['mobile-config'] }))
      .catch(notifyError)

  return (
    <Stack>
      {!device ? (
        <Alert color="orange">{t('mobile.notRemembered')}</Alert>
      ) : (
        <>
          <Card withBorder>
            <Title order={5} mb="xs">
              {t('mobile.deviceTitle')}
            </Title>
            <SimpleGrid cols={2} spacing={4}>
              <Text size="sm" c="dimmed">
                {t('mobile.deviceName')}
              </Text>
              <Text size="sm">{device.name}</Text>
              <Text size="sm" c="dimmed">
                {t('mobile.since')}
              </Text>
              <Text size="sm">{fmtDate(device.createdAt.slice(0, 10))}</Text>
              <Text size="sm" c="dimmed">
                {t('mobile.expires')}
              </Text>
              <Text size="sm">
                {device.expiresAt ? fmtDate(device.expiresAt.slice(0, 10)) : t('mobile.neverExpires')}
              </Text>
            </SimpleGrid>
          </Card>
          {device.biometric ? (
            <Card withBorder>
              <Group justify="space-between">
                <Group gap="xs">
                  <IconFingerprint size={20} />
                  <Text size="sm">{t('mobile.bioActive')}</Text>
                </Group>
                <Button size="xs" variant="subtle" color="red" onClick={() => void removeBiometric()}>
                  {t('mobile.bioRemove')}
                </Button>
              </Group>
            </Card>
          ) : (
            <BiometricSetup required={config.openConfirmation === 'biometric'} />
          )}
          <PushSettings config={config} push={device.push} />
        </>
      )}
      {!isStandalone() && (
        <Text size="sm" c="dimmed">
          {t('mobile.install')}
        </Text>
      )}
      <Group justify="space-between">
        <Anchor size="sm" onClick={() => navigate('/')}>
          {t('mobile.fullApp')}
        </Anchor>
        <Button variant="light" color="red" leftSection={<IconLogout size={16} />} onClick={() => void logout()}>
          {t('mobile.logout')}
        </Button>
      </Group>
    </Stack>
  )
}

/** Push preferences wanted on this phone (to restore them if the browser drops the subscription). */
const WANTED_KEY = 'uhd.push.wanted'
type WantedPush = { events: WebhookEvent[]; doorIds: string[]; rules: boolean }

function loadWanted(): WantedPush | null {
  try {
    const raw = localStorage.getItem(WANTED_KEY)
    return raw ? (JSON.parse(raw) as WantedPush) : null
  } catch {
    return null
  }
}

function storeWanted(p: WantedPush | null): void {
  try {
    if (p) localStorage.setItem(WANTED_KEY, JSON.stringify(p))
    else localStorage.removeItem(WANTED_KEY)
  } catch {
    // storage unavailable: no automatic restore
  }
}

function PushSettings({ config, push }: { config: MobileConfigDto; push: PushPreferencesDto | null }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const doors = useQuery({ queryKey: ['mobile-doors'], queryFn: () => api.get<MobileDoorDto[]>('/mobile/doors') })
  const [prefs, setPrefs] = useState({
    events: push?.events ?? (['access.denied', 'alarm', 'controller.offline'] as WebhookEvent[]),
    doorIds: (push?.doorIds ?? []).map(String),
    rules: push?.rules ?? true,
  })
  const [busy, setBusy] = useState(false)
  const [lost, setLost] = useState(false)
  const supported = pushSupported()
  const denied = supported && Notification.permission === 'denied'
  const eventLabel = (e: string) =>
    t(`codes.webhookEvent.${e.replace('.', '_')}` as 'codes.webhookEvent.alarm', { defaultValue: e })
  const language = (LANGUAGES.find((l) => i18n.language.startsWith(l.code))?.code ?? 'en') as Language
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mobile-config'] })

  /** Subscribes (or updates the subscription of) this device with the chosen preferences. */
  const save = async (p = prefs, quiet = false) => {
    setBusy(true)
    try {
      if ((await Notification.requestPermission()) !== 'granted') return
      const reg = await navigator.serviceWorker.ready
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey(config.vapidPublicKey),
        }))
      await api.put('/mobile/push', {
        subscription: sub.toJSON(),
        events: p.events,
        doorIds: p.doorIds.map(Number),
        rules: p.rules,
        language,
      })
      storeWanted(p)
      setLost(false)
      if (!quiet) notifyOk(t('mobile.pushSaved'))
      refresh()
    } catch (err) {
      if (!quiet) notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  /*
   * The browser may drop the subscription by itself: e.g. installing the app moves the notifications to the
   * installed app, which on Android needs its own permission. When notifications were wanted on this phone but
   * are gone, they are restored with the same preferences, or the user is told why they cannot be.
   */
  useEffect(() => {
    if (!supported) return
    const wanted = push ? { events: push.events, doorIds: push.doorIds.map(String), rules: push.rules } : loadWanted()
    if (!wanted) return
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (sub && push) return
        if (Notification.permission === 'granted') void save(wanted, true)
        else setLost(true)
      })
    // only when the screen opens
  }, [])

  const disable = async () => {
    storeWanted(null)
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      await (await reg.pushManager.getSubscription())?.unsubscribe()
      await api.del('/mobile/push')
      refresh()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const test = () =>
    api
      .post<{ ok: boolean; error: string | null }>('/mobile/push/test')
      .then((r) => (r.ok ? notifyOk(t('mobile.pushTestOk')) : notifyError(new Error(r.error ?? '?'))))
      .catch(notifyError)

  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {t('mobile.pushTitle')}
      </Title>
      {!supported ? (
        <Text size="sm" c="dimmed">
          {t('mobile.pushUnsupported')}
        </Text>
      ) : denied || lost ? (
        <Text size="sm" c="orange">
          {t(isStandalone() ? 'mobile.pushDeniedApp' : 'mobile.pushDenied')}
        </Text>
      ) : (
        <Stack gap="sm">
          <Switch
            label={t('mobile.pushEnable')}
            checked={!!push}
            disabled={busy}
            onChange={(e) => void (e.currentTarget.checked ? save() : disable())}
          />
          {push && (
            <>
              <Checkbox.Group
                label={t('mobile.pushEvents')}
                value={prefs.events}
                onChange={(v) => setPrefs({ ...prefs, events: v as WebhookEvent[] })}
              >
                <Stack gap={6} mt={6}>
                  {WEBHOOK_EVENTS.map((e) => (
                    <Checkbox key={e} value={e} label={eventLabel(e)} />
                  ))}
                </Stack>
              </Checkbox.Group>
              <MultiSelect
                label={t('mobile.pushDoors')}
                placeholder={prefs.doorIds.length ? undefined : t('mobile.pushAllDoors')}
                data={(doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
                value={prefs.doorIds}
                onChange={(v) => setPrefs({ ...prefs, doorIds: v })}
              />
              <Switch
                label={t('mobile.pushRules')}
                checked={prefs.rules}
                onChange={(e) => setPrefs({ ...prefs, rules: e.currentTarget.checked })}
              />
              <Group grow>
                <Button loading={busy} onClick={() => void save()}>
                  {t('common.save')}
                </Button>
                <Button variant="light" onClick={() => void test()}>
                  {t('mobile.pushTest')}
                </Button>
              </Group>
              {push.lastError && (
                <Text size="xs" c="red">
                  {t('mobile.pushLastError', { error: push.lastError })}
                </Text>
              )}
            </>
          )}
        </Stack>
      )}
    </Card>
  )
}
