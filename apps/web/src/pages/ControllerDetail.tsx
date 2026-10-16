import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Grid,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconAlertTriangle, IconClock, IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import type { ControllerDto, ControllerSettings } from '@uhppote-desk/shared'
import { ANTIPASSBACK_MODES, FIRST_CARD_MODES, INTERLOCK_MODES } from '@uhppote-desk/shared'
import { ControllerStatusBadge, PageHeader, WeekdaysInput } from '../components/common'
import { api, errorMessage, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { fmtDate, fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { ControllerFormFields, controllerBody, type ControllerForm } from './Controllers'

interface Info {
  device: { controller: number; address: string; netmask: string; gateway: string; mac: string; version: string; date: string | null }
  time: string | null
  status: {
    doorOpen: boolean[]
    buttonPressed: boolean[]
    relayUnlocked: boolean[]
    forceLock: boolean
    fireAlarm: boolean
    systemError: number
    specialInfo: number
    event: { index: number; card: number; door: number; granted: boolean; reason: number; timestamp: string | null } | null
  }
  listener: { address: string; port: number; interval: number }
  cards: number
  eventIndex: number
  antipassback: number
  doors: { door: number; mode: number; delay: number }[]
}

function Diagnostics({ id }: { id: number }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const info = useQuery({ queryKey: ['controller-info', id], queryFn: () => api.get<Info>(`/controllers/${id}/info`), retry: false })
  const { can } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)

  const action = async (name: string, fn: () => Promise<string>) => {
    setBusy(name)
    try {
      notifyOk(await fn())
      void info.refetch()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(null)
    }
  }

  if (info.isError) {
    return (
      <Alert color="red" icon={<IconAlertTriangle />} title={t('controllerDetail.unreachable')}>
        {errorMessage(info.error)}
        <Button mt="sm" size="xs" variant="light" onClick={() => void info.refetch()}>
          {t('controllerDetail.retry')}
        </Button>
      </Alert>
    )
  }
  const d = info.data
  return (
    <Stack>
      <Group>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={info.isFetching} onClick={() => void info.refetch()}>
          {t('controllerDetail.reread')}
        </Button>
        {can('operator') && (
          <>
            <Button
              variant="default"
              leftSection={<IconClock size={16} />}
              loading={busy === 'time'}
              onClick={() => void action('time', async () => (await api.post(`/controllers/${id}/time-sync`), t('controllerDetail.timeSynced')))}
            >
              {t('controllerDetail.syncTime')}
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              loading={busy === 'collect'}
              onClick={() =>
                void action('collect', async () => {
                  const r = await api.post<{ collected: number; skipped: number }>(`/controllers/${id}/collect`)
                  return r.skipped
                    ? t('controllerDetail.collectedSkipped', { n: r.collected, skipped: r.skipped })
                    : t('controllerDetail.collected', { n: r.collected })
                })
              }
            >
              {t('controllerDetail.collect')}
            </Button>
          </>
        )}
      </Group>
      {d && (
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder>
              <Title order={5} mb="xs">
                {t('controllerDetail.device')}
              </Title>
              <Table>
                <Table.Tbody>
                  {[
                    [t('controllerDetail.serial'), d.device.controller],
                    [t('controllerDetail.ip'), `${d.device.address} / ${d.device.netmask}`],
                    [t('controllerDetail.gateway'), d.device.gateway],
                    [t('controllerDetail.mac'), d.device.mac],
                    [t('controllerDetail.firmware'), t('controllerDetail.firmwareValue', { version: d.device.version, date: fmtDate(d.device.date) })],
                    [t('controllerDetail.controllerTime'), fmtDateTime(d.time)],
                    [t('controllerDetail.storedCards'), d.cards],
                    [
                      t('controllerDetail.lastEvent'),
                      d.status.event
                        ? t('controllerDetail.lastEventValue', { index: d.status.event.index, reason: codes.reason(d.status.event.reason), time: fmtDateTime(d.status.event.timestamp) })
                        : t('common.none'),
                    ],
                    [t('controllerDetail.bookmark'), d.eventIndex],
                    [
                      t('controllerDetail.listener'),
                      `${d.listener.address}:${d.listener.port}${d.listener.interval ? ` ${t('controllerDetail.listenerAutosend', { n: d.listener.interval })}` : ''}`,
                    ],
                    [t('controllerDetail.antipassback'), codes.antipassback(d.antipassback)],
                    [t('controllerDetail.systemError'), d.status.systemError],
                  ].map(([k, v]) => (
                    <Table.Tr key={String(k)}>
                      <Table.Td c="dimmed" w={200}>
                        {k}
                      </Table.Td>
                      <Table.Td className="mono">{String(v)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder>
              <Title order={5} mb="xs">
                {t('controllerDetail.doorsTitle')}
              </Title>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('common.door')}</Table.Th>
                    <Table.Th>{t('controllerDetail.colMode')}</Table.Th>
                    <Table.Th>{t('controllerDetail.colDelay')}</Table.Th>
                    <Table.Th>{t('controllerDetail.colSensor')}</Table.Th>
                    <Table.Th>{t('controllerDetail.colRelay')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.doors.map((door, i) => (
                    <Table.Tr key={door.door}>
                      <Table.Td>{door.door}</Table.Td>
                      <Table.Td>{codes.doorMode(door.mode)}</Table.Td>
                      <Table.Td>{t('common.seconds', { n: door.delay })}</Table.Td>
                      <Table.Td>
                        <Badge color={d.status.doorOpen[i] ? 'orange' : 'teal'} variant="light">
                          {d.status.doorOpen[i] ? t('dashboard.doorOpen') : t('dashboard.doorClosed')}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{d.status.relayUnlocked[i] ? t('controllerDetail.unlocked') : t('controllerDetail.locked')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {(d.status.fireAlarm || d.status.forceLock) && (
                <Alert color="red" mt="sm">
                  {d.status.fireAlarm && t('controllerDetail.fireAlarmActive')} {d.status.forceLock && t('controllerDetail.forcedLockActive')}
                </Alert>
              )}
            </Card>
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  )
}

function Network({ c }: { c: ControllerDto }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [form, setForm] = useState<ControllerForm>({ ...c, serial: c.serial, host: c.host ?? '', zoneId: c.zoneId ? String(c.zoneId) : null })
  const [ip, setIp] = useState({ address: c.host ?? '', netmask: '255.255.255.0', gateway: '' })
  const [listener, setListener] = useState({ address: '', port: 60001, interval: 0 })

  const save = async () => {
    try {
      await api.put(`/controllers/${c.id}`, controllerBody(form))
      notifyOk(t('controllerDetail.updated'))
      void qc.invalidateQueries({ queryKey: ['controllers'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const setIpAddress = () =>
    modals.openConfirmModal({
      title: t('controllerDetail.sendIpTitle'),
      children: <Text size="sm">{t('controllerDetail.sendIpConfirm', ip)}</Text>,
      labels: { confirm: t('controllerDetail.sendIpButton'), cancel: t('common.cancel') },
      confirmProps: { color: 'orange' },
      onConfirm: () =>
        api
          .post<{ verified: boolean }>(`/controllers/${c.id}/set-ip`, ip)
          .then((r) => {
            if (r.verified) notifyOk(t('controllerDetail.ipVerified'))
            else notifyError(new Error(t('controllerDetail.ipNotVerified')))
            void qc.invalidateQueries({ queryKey: ['controllers'] })
          })
          .catch(notifyError),
    })

  const remove = () =>
    modals.openConfirmModal({
      title: t('controllerDetail.removeTitle'),
      children: <Text size="sm">{t('controllerDetail.removeInfo')}</Text>,
      labels: { confirm: t('common.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/controllers/${c.id}`)
          .then(() => {
            void qc.invalidateQueries({ queryKey: ['controllers'] })
            navigate('/controllers')
          })
          .catch(notifyError),
    })

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }}>
      <Card withBorder>
        <Title order={5} mb="sm">
          {t('controllerDetail.appConfig')}
        </Title>
        <Stack>
          <ControllerFormFields form={form} setForm={setForm} />
          <Group>
            <Button onClick={() => void save()}>{t('common.save')}</Button>
            <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={remove}>
              {t('common.remove')}
            </Button>
          </Group>
        </Stack>
      </Card>
      <Stack>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('controllerDetail.ipTitle')}
          </Title>
          <Stack>
            <SimpleGrid cols={3}>
              <TextInput label={t('controllerDetail.listenerIp')} value={ip.address} onChange={(e) => setIp({ ...ip, address: e.currentTarget.value })} />
              <TextInput label={t('controllerDetail.netmask')} value={ip.netmask} onChange={(e) => setIp({ ...ip, netmask: e.currentTarget.value })} />
              <TextInput label={t('controllerDetail.gateway')} value={ip.gateway} onChange={(e) => setIp({ ...ip, gateway: e.currentTarget.value })} />
            </SimpleGrid>
            <Button variant="light" color="orange" onClick={setIpAddress} disabled={!ip.address || !ip.netmask || !ip.gateway}>
              {t('controllerDetail.sendIp')}
            </Button>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('controllerDetail.listenerTitle')}
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            {t('controllerDetail.listenerInfo')}
          </Text>
          <Group>
            <Button
              variant="light"
              onClick={() =>
                api
                  .post<{ changed: boolean }>(`/controllers/${c.id}/listener`, null)
                  .then((r) => notifyOk(r.changed ? t('controllerDetail.listenerUpdated') : t('controllerDetail.listenerAlreadyOk')))
                  .catch(notifyError)
              }
            >
              {t('controllerDetail.listenerAuto')}
            </Button>
          </Group>
          <SimpleGrid cols={3} mt="sm">
            <TextInput label={t('controllerDetail.listenerIp')} value={listener.address} onChange={(e) => setListener({ ...listener, address: e.currentTarget.value })} />
            <NumberInput label={t('controllerDetail.listenerPort')} value={listener.port} onChange={(v) => setListener({ ...listener, port: Number(v) })} hideControls />
            <NumberInput label={t('controllerDetail.listenerInterval')} value={listener.interval} min={0} max={255} onChange={(v) => setListener({ ...listener, interval: Number(v) })} />
          </SimpleGrid>
          <Button
            mt="sm"
            variant="default"
            disabled={!listener.address}
            onClick={() =>
              api
                .post(`/controllers/${c.id}/listener`, listener)
                .then(() => notifyOk(t('controllerDetail.listenerSet')))
                .catch(notifyError)
            }
          >
            {t('controllerDetail.listenerManual')}
          </Button>
        </Card>
      </Stack>
    </SimpleGrid>
  )
}

function AdvancedSettings({ id }: { id: number }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const { can } = useAuth()
  const settings = useQuery({ queryKey: ['settings', id], queryFn: () => api.get<ControllerSettings>(`/controllers/${id}/settings`) })
  const [s, setS] = useState<ControllerSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const readOnly = !can('admin')
  useEffect(() => {
    if (settings.data) setS(settings.data)
  }, [settings.data])
  if (!s) return null

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/controllers/${id}/settings`, s)
      notifyOk(t('controllerDetail.settingsSaved'))
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const fcDefault = { enabled: true, start: '08:00', end: '18:00', activeMode: 0, inactiveMode: 3, weekdays: [true, true, true, true, true, false, false] }

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('controllerDetail.rulesTitle')}
          </Title>
          <Stack>
            <Select
              label={t('controllerDetail.interlock')}
              description={t('controllerDetail.interlockHint')}
              data={INTERLOCK_MODES.map((m) => ({ value: String(m), label: codes.interlock(m) }))}
              value={String(s.interlock)}
              onChange={(v) => setS({ ...s, interlock: Number(v) as ControllerSettings['interlock'] })}
              readOnly={readOnly}
            />
            <Select
              label={t('controllerDetail.antipassback')}
              description={t('controllerDetail.antipassbackHint')}
              data={ANTIPASSBACK_MODES.map((m) => ({ value: String(m), label: codes.antipassback(m) }))}
              value={String(s.antipassback)}
              onChange={(v) => setS({ ...s, antipassback: Number(v) })}
              readOnly={readOnly}
            />
            <Switch label={t('controllerDetail.specialEvents')} checked={s.recordSpecialEvents} onChange={(e) => setS({ ...s, recordSpecialEvents: e.currentTarget.checked })} disabled={readOnly} />
            <Switch label={t('controllerDetail.pcControl')} checked={s.pcControl} onChange={(e) => setS({ ...s, pcControl: e.currentTarget.checked })} disabled={readOnly} />
            <NumberInput
              label={t('controllerDetail.autosend')}
              min={0}
              max={255}
              value={s.listenerInterval}
              onChange={(v) => setS({ ...s, listenerInterval: Number(v) || 0 })}
              readOnly={readOnly}
            />
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('controllerDetail.keypadsTitle')}
          </Title>
          <Stack>
            <Group>
              {[0, 1, 2, 3].map((i) => (
                <Checkbox
                  key={i}
                  label={t('controllerDetail.keypadN', { n: i + 1 })}
                  checked={s.keypads[i]}
                  disabled={readOnly}
                  onChange={(e) => {
                    const k = [...s.keypads]
                    k[i] = e.currentTarget.checked
                    setS({ ...s, keypads: k })
                  }}
                />
              ))}
            </Group>
            {[0, 1, 2, 3].map((i) => (
              <TagsInput
                key={i}
                label={t('controllerDetail.passcodesN', { n: i + 1 })}
                maxTags={4}
                value={s.passcodes[i].map(String)}
                disabled={readOnly}
                onChange={(v) => {
                  const p = s.passcodes.map((x) => [...x])
                  p[i] = v.map((x) => Number(x.replace(/\D/g, ''))).filter((n) => n > 0 && n <= 999999)
                  setS({ ...s, passcodes: p })
                }}
              />
            ))}
          </Stack>
        </Card>
      </SimpleGrid>
      <Card withBorder>
        <Title order={5} mb="sm">
          {t('controllerDetail.firstCardTitle')}
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {[0, 1, 2, 3].map((i) => {
            const fc = s.firstCard[i]
            const setFc = (v: ControllerSettings['firstCard'][number]) => {
              const all = [...s.firstCard]
              all[i] = v
              setS({ ...s, firstCard: all })
            }
            return (
              <Card key={i} withBorder padding="sm">
                <Switch
                  label={t('common.doorN', { n: i + 1 })}
                  checked={!!fc?.enabled}
                  disabled={readOnly}
                  onChange={(e) => setFc(e.currentTarget.checked ? { ...fcDefault, ...(fc ?? {}), enabled: true } : fc ? { ...fc, enabled: false } : null)}
                />
                {fc?.enabled && (
                  <Stack mt="xs" gap="xs">
                    <Group grow>
                      <TextInput label={t('controllerDetail.fcFrom')} value={fc.start} onChange={(e) => setFc({ ...fc, start: e.currentTarget.value })} readOnly={readOnly} />
                      <TextInput label={t('controllerDetail.fcTo')} value={fc.end} onChange={(e) => setFc({ ...fc, end: e.currentTarget.value })} readOnly={readOnly} />
                    </Group>
                    <Group grow>
                      <Select
                        label={t('controllerDetail.fcActive')}
                        data={FIRST_CARD_MODES.filter((m) => m !== 3).map((m) => ({ value: String(m), label: codes.firstCardMode(m) }))}
                        value={String(fc.activeMode)}
                        onChange={(v) => setFc({ ...fc, activeMode: Number(v) })}
                        readOnly={readOnly}
                      />
                      <Select
                        label={t('controllerDetail.fcInactive')}
                        data={FIRST_CARD_MODES.map((m) => ({ value: String(m), label: codes.firstCardMode(m) }))}
                        value={String(fc.inactiveMode)}
                        onChange={(v) => setFc({ ...fc, inactiveMode: Number(v) })}
                        readOnly={readOnly}
                      />
                    </Group>
                    <WeekdaysInput value={fc.weekdays} onChange={(w) => setFc({ ...fc, weekdays: w })} />
                  </Stack>
                )}
              </Card>
            )
          })}
        </SimpleGrid>
      </Card>
      {!readOnly && (
        <Button onClick={() => void save()} loading={busy}>
          {t('controllerDetail.saveAndSend')}
        </Button>
      )}
    </Stack>
  )
}

function Maintenance({ c }: { c: ControllerDto }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const [confirm, setConfirm] = useState('')
  const history = useQuery({
    queryKey: ['sync-history', c.id],
    queryFn: () => api.get<{ id: number; kind: string; startedAt: string; status: string; summary: string | null; operator: string | null }[]>(`/controllers/${c.id}/sync/history`),
  })
  return (
    <Stack>
      <Card withBorder>
        <Title order={5} mb="xs">
          {t('controllerDetail.syncHistory')}
        </Title>
        <Table>
          <Table.Tbody>
            {(history.data ?? []).map((h) => (
              <Table.Tr key={h.id}>
                <Table.Td>{fmtDateTime(h.startedAt)}</Table.Td>
                <Table.Td>{h.operator ?? t('common.system')}</Table.Td>
                <Table.Td>
                  <Badge color={h.status === 'ok' ? 'green' : h.status === 'error' ? 'red' : 'blue'}>{codes.syncStatus(h.status)}</Badge>
                </Table.Td>
                <Table.Td>
                  <Code>{h.summary}</Code>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Card withBorder style={{ borderColor: 'var(--mantine-color-red-6)' }}>
        <Title order={5} c="red" mb="xs">
          {t('controllerDetail.resetTitle')}
        </Title>
        <Text size="sm" mb="sm">
          {t('controllerDetail.resetInfo', { serial: c.serial })}
        </Text>
        <Group>
          <TextInput value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} placeholder={t('controllerDetail.resetPlaceholder')} />
          <Button
            color="red"
            disabled={confirm !== String(c.serial)}
            onClick={() =>
              api
                .post<{ cardsBackup: unknown[]; backupFile: string }>(`/controllers/${c.id}/restore-defaults`, { confirm })
                .then((r) => notifyOk(t('controllerDetail.resetDone', { n: r.cardsBackup.length, file: r.backupFile })))
                .catch(notifyError)
            }
          >
            {t('controllerDetail.resetButton')}
          </Button>
        </Group>
      </Card>
    </Stack>
  )
}

export function ControllerDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams()
  const cid = Number(id)
  const { can } = useAuth()
  const live = useLive()
  const controller = useQuery({ queryKey: ['controller', cid], queryFn: () => api.get<ControllerDto>(`/controllers/${cid}`) })
  const c = controller.data
  if (!c) return null
  const online = live.states[c.id]?.online ?? c.online
  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <>
            S/N {c.serial} · {c.host ?? t('controllers.broadcast')} · <ControllerStatusBadge enabled={c.enabled} online={online} />
          </>
        }
      />
      <Tabs defaultValue="diagnostics" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="diagnostics">{t('controllerDetail.tabDiagnostics')}</Tabs.Tab>
          {can('admin') && <Tabs.Tab value="network">{t('controllerDetail.tabNetwork')}</Tabs.Tab>}
          <Tabs.Tab value="advanced">{t('controllerDetail.tabAdvanced')}</Tabs.Tab>
          {can('admin') && <Tabs.Tab value="maintenance">{t('controllerDetail.tabMaintenance')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="diagnostics">
          <Diagnostics id={cid} />
        </Tabs.Panel>
        <Tabs.Panel value="network">
          <Network c={c} />
        </Tabs.Panel>
        <Tabs.Panel value="advanced">
          <AdvancedSettings id={cid} />
        </Tabs.Panel>
        <Tabs.Panel value="maintenance">
          <Maintenance c={c} />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
