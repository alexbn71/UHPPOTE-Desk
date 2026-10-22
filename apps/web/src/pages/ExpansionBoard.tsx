import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ControllerSettings,
  ExpansionBoardReadDto,
  ExpansionBoardSettings,
  ExpansionRelaySettings,
  ExpansionVerificationDto,
} from '@uhppote-desk/shared'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'

/** Bits of the relay "events" mask, in the order of the vendor software. */
const EVENTS = [
  ['threat', 0x01],
  ['openTooLong', 0x02],
  ['forcedOpen', 0x04],
  ['forcedLock', 0x08],
  ['invalidCard', 0x10],
  ['fire', 0x20],
] as const

const SIGNALS = [
  ['lockRelay', 0x01],
  ['doorSensor', 0x02],
  ['pushButton', 0x04],
  ['forceLock', 0x08],
  ['extA1', 0x10],
  ['extA2', 0x20],
  ['extA3', 0x40],
  ['extFire', 0x80],
] as const

const ARM = 16

/** Vendor "extended functions" that change how the controller raises the alarms. */
const ALARM_OPTIONS = ['openTooLongAlarm', 'invalidCardAlarmAfter3', 'duressAfterCard'] as const
const MODES = [1, 2, 3, 4, 5] as const

function RelayCard({
  n,
  relay,
  onChange,
  readOnly,
}: {
  n: number
  relay: ExpansionRelaySettings
  onChange: (r: ExpansionRelaySettings) => void
  readOnly: boolean
}) {
  const { t } = useTranslation()
  const arm = relay.source === ARM
  const usesSignals = relay.mode === 4 || relay.mode === 5
  const usesDuration = relay.mode === 1 || relay.mode === 2
  const toggle = (field: 'events' | 'signals', bit: number, on: boolean) =>
    onChange({ ...relay, [field]: on ? relay[field] | bit : relay[field] & ~bit })
  return (
    <Card withBorder padding="sm" data-testid={`expansion-relay-${n}`}>
      <Switch
        label={t('expansion.relayN', { n })}
        checked={relay.active}
        disabled={readOnly}
        onChange={(e) => onChange({ ...relay, active: e.currentTarget.checked })}
      />
      {relay.active && (
        <Stack mt="xs" gap="xs">
          <Group grow>
            <Select
              label={t('expansion.source')}
              data={[
                ...[0, 1, 2, 3].map((d) => ({ value: String(d), label: t('common.doorN', { n: d + 1 }) })),
                { value: String(ARM), label: t('expansion.sourceArm') },
              ]}
              value={String(relay.source)}
              onChange={(v) => onChange({ ...relay, source: Number(v) as ExpansionRelaySettings['source'] })}
              readOnly={readOnly}
              allowDeselect={false}
            />
            <Select
              label={t('expansion.mode')}
              data={MODES.map((m) => ({ value: String(m), label: t(`expansion.modes.${m}`) }))}
              value={String(relay.mode)}
              onChange={(v) => onChange({ ...relay, mode: Number(v) })}
              readOnly={readOnly}
              allowDeselect={false}
            />
          </Group>
          {arm ? (
            <Text size="sm" c="dimmed">
              {t('expansion.armHint')}
            </Text>
          ) : (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('expansion.events')}
              </Text>
              <SimpleGrid cols={2} spacing={4}>
                {EVENTS.map(([key, bit]) => (
                  <Checkbox
                    key={key}
                    size="xs"
                    label={t(`expansion.eventNames.${key}`)}
                    checked={(relay.events & bit) !== 0}
                    disabled={readOnly}
                    onChange={(e) => toggle('events', bit, e.currentTarget.checked)}
                  />
                ))}
              </SimpleGrid>
              {relay.events === 0 && !usesSignals && (
                <Text size="xs" c="orange">
                  {t('expansion.noEvents')}
                </Text>
              )}
            </Stack>
          )}
          {usesSignals && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('expansion.signals')}
              </Text>
              <SimpleGrid cols={2} spacing={4}>
                {SIGNALS.map(([key, bit]) => (
                  <Checkbox
                    key={key}
                    size="xs"
                    label={t(`expansion.signalNames.${key}`)}
                    checked={(relay.signals & bit) !== 0}
                    disabled={readOnly}
                    onChange={(e) => toggle('signals', bit, e.currentTarget.checked)}
                  />
                ))}
              </SimpleGrid>
            </Stack>
          )}
          {usesDuration && (
            <NumberInput
              label={t('expansion.duration')}
              min={0}
              max={6553}
              value={relay.duration}
              onChange={(v) => onChange({ ...relay, duration: Number(v) || 0 })}
              readOnly={readOnly}
            />
          )}
        </Stack>
      )}
    </Card>
  )
}

/** What the controller really stores, read back with the vendor long-packet request. */
function ControllerCopy({
  read,
  onUse,
  readOnly,
}: {
  read: ExpansionBoardReadDto
  onUse: () => void
  readOnly: boolean
}) {
  const { t } = useTranslation()
  const sourceLabel = (s: number) =>
    s >= 0 && s <= 3 ? t('common.doorN', { n: s + 1 }) : s === ARM ? t('expansion.sourceArm') : `? (${s})`
  const eventsLabel = (bits: number) =>
    EVENTS.filter(([, bit]) => bits & bit)
      .map(([key]) => t(`expansion.eventNames.${key}`))
      .join(', ') || '—'
  return (
    <Card withBorder data-testid="expansion-read">
      <Group justify="space-between" mb="xs">
        <Title order={5}>{t('expansion.readTitle')}</Title>
        {read.mismatches === null ? (
          <Badge color="gray">{t('expansion.readNotCompared')}</Badge>
        ) : read.mismatches.length === 0 ? (
          <Badge color="green">{t('expansion.readAligned')}</Badge>
        ) : (
          <Badge color="orange">{t('expansion.readDifferent', { n: read.mismatches.length })}</Badge>
        )}
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('expansion.readOutput')}</Table.Th>
            <Table.Th>{t('expansion.source')}</Table.Th>
            <Table.Th>{t('expansion.mode')}</Table.Th>
            <Table.Th>{t('expansion.events')}</Table.Th>
            <Table.Th>{t('expansion.duration')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {read.relays.map((r, i) => (
            <Table.Tr key={i}>
              <Table.Td>{t('expansion.relayN', { n: i + 1 })}</Table.Td>
              {r.active ? (
                <>
                  <Table.Td>{sourceLabel(r.source)}</Table.Td>
                  <Table.Td>{t(`expansion.modes.${r.mode}`, { defaultValue: String(r.mode) })}</Table.Td>
                  <Table.Td>{eventsLabel(r.events)}</Table.Td>
                  <Table.Td>{r.duration}</Table.Td>
                </>
              ) : (
                <Table.Td colSpan={4}>
                  <Text size="sm" c="dimmed">
                    {t('expansion.readInactive')}
                  </Text>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="sm" mt="xs">
        {t('expansion.doorOpenTooLong')}: {read.doorOpenTooLong} · {t('expansion.duressCode')}: {read.duressCode} ·{' '}
        {t('expansion.readAlarms')}: {eventsLabel(read.alarmEvents)}
      </Text>
      <Text size="sm">
        {ALARM_OPTIONS.filter((k) => read[k])
          .map((k) => t(`expansion.${k}`))
          .join(' · ') || t('expansion.noAlarmOptions')}
      </Text>
      {!readOnly && (
        <Button mt="sm" variant="light" onClick={onUse}>
          {t('expansion.readUse')}
        </Button>
      )}
    </Card>
  )
}

export function ExpansionBoardPanel({ id }: { id: number }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', id],
    queryFn: () => api.get<ControllerSettings>(`/controllers/${id}/settings`),
  })
  const [x, setX] = useState<ExpansionBoardSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [read, setRead] = useState<ExpansionBoardReadDto | null>(null)
  const [reading, setReading] = useState(false)
  const readOnly = !can('admin')
  useEffect(() => {
    if (settings.data) setX(settings.data.expansionBoard)
  }, [settings.data])
  if (!x || !settings.data) return null

  const save = async () => {
    setBusy(true)
    try {
      // the latest saved settings + this board: the other advanced settings are not touched
      const current = await api.get<ControllerSettings>(`/controllers/${id}/settings`)
      const r = await api.put<{ expansion: ExpansionVerificationDto | null }>(`/controllers/${id}/settings`, {
        ...current,
        expansionBoard: x,
      })
      await qc.invalidateQueries({ queryKey: ['settings', id] })
      const v = r.expansion
      if (!v || v.verified) {
        notifyOk(v ? t('expansion.verified') : t('controllerDetail.settingsSaved'))
      } else {
        notifications.show({
          color: 'orange',
          autoClose: 10_000,
          message:
            v.verified === null ? t('expansion.notVerified') : t('expansion.verifyFailed', { n: v.mismatches.length }),
        })
      }
      setRead(null)
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const readFromController = async () => {
    setReading(true)
    try {
      setRead(await api.get<ExpansionBoardReadDto>(`/controllers/${id}/expansion-board`))
    } catch (err) {
      notifyError(err)
    } finally {
      setReading(false)
    }
  }

  // copies the controller configuration into the form (inactive outputs keep the form values, switched off)
  const applyRead = (r: ExpansionBoardReadDto) =>
    setX({
      ...x,
      doorOpenTooLong: r.doorOpenTooLong,
      duressCode: r.duressCode,
      openTooLongAlarm: r.openTooLongAlarm,
      invalidCardAlarmAfter3: r.invalidCardAlarmAfter3,
      duressAfterCard: r.duressAfterCard,
      relays: r.relays.map((rr, i) => (rr.active ? rr : { ...x.relays[i]!, active: false })),
    })

  const setRelay = (i: number, r: ExpansionRelaySettings) =>
    setX({ ...x, relays: x.relays.map((old, j) => (j === i ? r : old)) })

  return (
    <Stack>
      <Card withBorder>
        <Title order={5} mb="xs">
          {t('expansion.title')}
        </Title>
        <Text size="sm" mb="sm">
          {t('expansion.intro')}
        </Text>
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} mb="sm">
          {t('expansion.experimental')}
        </Alert>
        <Stack>
          <Switch
            label={t('expansion.installed')}
            description={t('expansion.installedHint')}
            checked={x.installed}
            disabled={readOnly}
            onChange={(e) => setX({ ...x, installed: e.currentTarget.checked })}
          />
          <Group grow align="flex-start">
            <NumberInput
              label={t('expansion.doorOpenTooLong')}
              description={t('expansion.doorOpenTooLongHint')}
              min={1}
              max={6553}
              value={x.doorOpenTooLong}
              onChange={(v) => setX({ ...x, doorOpenTooLong: Math.max(1, Number(v) || 1) })}
              readOnly={readOnly}
            />
            <TextInput
              label={t('expansion.duressCode')}
              description={t('expansion.duressCodeHint')}
              inputMode="numeric"
              maxLength={6}
              value={x.duressCode === null ? '' : String(x.duressCode)}
              onChange={(e) => {
                const digits = e.currentTarget.value.replace(/\D/g, '')
                setX({ ...x, duressCode: digits === '' ? null : Number(digits) })
              }}
              readOnly={readOnly}
            />
          </Group>
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              {t('expansion.alarmOptions')}
            </Text>
            {ALARM_OPTIONS.map((k) => (
              <Switch
                key={k}
                size="sm"
                label={t(`expansion.${k}`)}
                description={t(`expansion.${k}Hint`)}
                checked={x[k]}
                disabled={readOnly}
                onChange={(e) => setX({ ...x, [k]: e.currentTarget.checked })}
              />
            ))}
          </Stack>
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              {t('expansion.inputEvents')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('expansion.inputEventsHint')}
            </Text>
            <Group>
              {x.inputEvents.map((on, i) => (
                <Switch
                  key={i}
                  size="sm"
                  label={t('expansion.inputEvent', { n: i + 1 })}
                  checked={on}
                  disabled={readOnly}
                  onChange={(e) => {
                    const inputEvents = [...x.inputEvents] as typeof x.inputEvents
                    inputEvents[i] = e.currentTarget.checked
                    setX({ ...x, inputEvents })
                  }}
                />
              ))}
            </Group>
          </Stack>
          <Group>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              loading={reading}
              onClick={() => void readFromController()}
            >
              {t('expansion.read')}
            </Button>
            <Text size="xs" c="dimmed">
              {t('expansion.readHint')}
            </Text>
          </Group>
        </Stack>
      </Card>
      {read && <ControllerCopy read={read} readOnly={readOnly} onUse={() => applyRead(read)} />}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {x.relays.map((r, i) => (
          <RelayCard key={i} n={i + 1} relay={r} readOnly={readOnly} onChange={(v) => setRelay(i, v)} />
        ))}
      </SimpleGrid>
      {!readOnly && (
        <Button onClick={() => void save()} loading={busy}>
          {t('controllerDetail.saveAndSend')}
        </Button>
      )}
    </Stack>
  )
}
