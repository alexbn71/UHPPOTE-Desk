import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconBan, IconDeviceFloppy } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnomalySettings, DeniedBurstDto, InactiveCardDto, UnusualAccessDto } from '@uhppote-desk/shared'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, addDays, cardLabel, fmtDate, fmtDateTime, today } from '../lib/format'

export function AnomaliesPage() {
  const { t } = useTranslation()
  const [from, setFrom] = useState(addDays(today(), -6))
  const [to, setTo] = useState(today())
  const period = `from=${from}&to=${to}`

  return (
    <>
      <PageHeader
        title={t('anomalies.title')}
        description={t('anomalies.description')}
        actions={
          <Group gap="xs">
            <DateInput
              size="sm"
              w={140}
              valueFormat={DATE_INPUT_FORMAT}
              value={from}
              onChange={(v) => v && setFrom(v)}
              aria-label={t('common.from')}
            />
            <DateInput
              size="sm"
              w={140}
              valueFormat={DATE_INPUT_FORMAT}
              value={to}
              onChange={(v) => v && setTo(v)}
              aria-label={t('common.to')}
            />
          </Group>
        }
      />
      <Tabs defaultValue="unusual" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="unusual">{t('anomalies.tabUnusual')}</Tabs.Tab>
          <Tabs.Tab value="denied">{t('anomalies.tabDenied')}</Tabs.Tab>
          <Tabs.Tab value="inactive">{t('anomalies.tabInactive')}</Tabs.Tab>
          <Tabs.Tab value="settings">{t('anomalies.tabSettings')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="unusual">
          <UnusualTab period={period} />
        </Tabs.Panel>
        <Tabs.Panel value="denied">
          <DeniedTab period={period} />
        </Tabs.Panel>
        <Tabs.Panel value="inactive">
          <InactiveTab />
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <SettingsTab />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}

function Empty({ children }: { children: string }) {
  return (
    <Text size="sm" c="dimmed" p="md">
      {children}
    </Text>
  )
}

function UnusualTab({ period }: { period: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['anomalies', 'unusual', period],
    queryFn: () => api.get<UnusualAccessDto[]>(`/anomalies/unusual?${period}`),
  })
  const why = (u: UnusualAccessDto) =>
    u.kind === 'hour'
      ? t('anomalies.kindHour', { from: u.usualFrom ?? '?', to: u.usualTo ?? '?' })
      : u.kind === 'day'
        ? t('anomalies.kindDay')
        : t('anomalies.kindNight', { n: u.samples })
  return (
    <Card withBorder>
      {q.data?.length === 0 ? (
        <Empty>{t('anomalies.none')}</Empty>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('anomalies.colTime')}</Table.Th>
              <Table.Th>{t('anomalies.colPerson')}</Table.Th>
              <Table.Th>{t('anomalies.colDoor')}</Table.Th>
              <Table.Th>{t('anomalies.colWhy')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(q.data ?? []).map((u) => (
              <Table.Tr key={u.eventId}>
                <Table.Td>{fmtDateTime(u.timestamp)}</Table.Td>
                <Table.Td>{u.personName}</Table.Td>
                <Table.Td>{u.doorName ?? `${u.controllerName} ${u.door}`}</Table.Td>
                <Table.Td>
                  <Badge
                    variant="light"
                    color={u.kind === 'night' ? 'grape' : 'orange'}
                    style={{ textTransform: 'none' }}
                  >
                    {why(u)}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  )
}

function DeniedTab({ period }: { period: string }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const q = useQuery({
    queryKey: ['anomalies', 'denied', period],
    queryFn: () => api.get<DeniedBurstDto[]>(`/anomalies/denied?${period}`),
  })
  return (
    <Card withBorder>
      {q.data?.length === 0 ? (
        <Empty>{t('anomalies.none')}</Empty>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('anomalies.colPeriod')}</Table.Th>
              <Table.Th>{t('anomalies.colCard')}</Table.Th>
              <Table.Th>{t('anomalies.colPerson')}</Table.Th>
              <Table.Th>{t('anomalies.colDoor')}</Table.Th>
              <Table.Th>{t('anomalies.colAttempts')}</Table.Th>
              <Table.Th>{t('anomalies.colReasons')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(q.data ?? []).map((b) => (
              <Table.Tr key={`${b.card}-${b.first}`}>
                <Table.Td>
                  {fmtDateTime(b.first)} – {b.last.slice(11, 19)}
                </Table.Td>
                <Table.Td className="mono">{b.card ? cardLabel(b.card) : '—'}</Table.Td>
                <Table.Td>
                  {b.personName ?? (
                    <Text span c="dimmed">
                      {t('anomalies.unknownCard')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{b.doors.join(', ')}</Table.Td>
                <Table.Td>
                  <Badge color="red" variant="light">
                    {b.count}
                  </Badge>
                </Table.Td>
                <Table.Td>{b.reasons.map((r) => codes.reason(r)).join(', ')}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  )
}

function InactiveTab() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['anomalies', 'settings'],
    queryFn: () => api.get<AnomalySettings>('/anomalies/settings'),
  })
  const q = useQuery({
    queryKey: ['anomalies', 'inactive'],
    queryFn: () => api.get<InactiveCardDto[]>('/anomalies/inactive-cards'),
  })
  const [selected, setSelected] = useState<number[]>([])
  const rows = q.data ?? []
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const disable = () =>
    modals.openConfirmModal({
      title: t('anomalies.disableTitle', { n: selected.length }),
      children: <Text size="sm">{t('anomalies.disableInfo')}</Text>,
      labels: { confirm: t('anomalies.disableSelected', { n: selected.length }), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .post<{ disabled: number; pushErrors: { controllerId: number; error: string }[] }>(
            '/anomalies/inactive-cards/disable',
            { cardIds: selected },
          )
          .then((r) => {
            notifyOk(t('anomalies.disabledOk', { n: r.disabled }))
            notifyPush(r)
            setSelected([])
            void qc.invalidateQueries({ queryKey: ['anomalies', 'inactive'] })
            void qc.invalidateQueries({ queryKey: ['cards'] })
          })
          .catch(notifyError),
    })

  return (
    <Card withBorder>
      {rows.length === 0 && q.isSuccess ? (
        <Empty>{t('anomalies.noneInactive', { n: settings.data?.inactiveDays ?? 90 })}</Empty>
      ) : (
        <>
          {can('operator') && (
            <Group justify="flex-end" mb="sm">
              <Button
                color="red"
                variant="light"
                leftSection={<IconBan size={16} />}
                disabled={selected.length === 0}
                onClick={disable}
              >
                {t('anomalies.disableSelected', { n: selected.length })}
              </Button>
            </Group>
          )}
          <Table>
            <Table.Thead>
              <Table.Tr>
                {can('operator') && (
                  <Table.Th w={40}>
                    <Checkbox
                      aria-label={t('common.all')}
                      checked={rows.length > 0 && selected.length === rows.length}
                      indeterminate={selected.length > 0 && selected.length < rows.length}
                      onChange={(e) => setSelected(e.currentTarget.checked ? rows.map((r) => r.cardId) : [])}
                    />
                  </Table.Th>
                )}
                <Table.Th>{t('anomalies.colCard')}</Table.Th>
                <Table.Th>{t('anomalies.colPerson')}</Table.Th>
                <Table.Th>{t('anomalies.colLastUsed')}</Table.Th>
                <Table.Th>{t('anomalies.colInactive')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((c) => (
                <Table.Tr key={c.cardId}>
                  {can('operator') && (
                    <Table.Td>
                      <Checkbox
                        aria-label={String(c.number)}
                        checked={selected.includes(c.cardId)}
                        onChange={() => toggle(c.cardId)}
                      />
                    </Table.Td>
                  )}
                  <Table.Td className="mono">{cardLabel(c.number)}</Table.Td>
                  <Table.Td>
                    {c.personName ?? (
                      <Text span c="dimmed">
                        {t('anomalies.unassigned')}
                      </Text>
                    )}
                    {c.personActive === false && (
                      <Badge color="gray" variant="light" ml="xs">
                        {t('anomalies.personInactive')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {c.lastUsedAt
                      ? fmtDateTime(c.lastUsedAt)
                      : t('anomalies.neverUsed', { date: fmtDate(c.createdAt.slice(0, 10)) })}
                  </Table.Td>
                  <Table.Td>{t('anomalies.days', { n: c.daysInactive })}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Card>
  )
}

function SettingsTab() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['anomalies', 'settings'],
    queryFn: () => api.get<AnomalySettings>('/anomalies/settings'),
  })
  const [form, setForm] = useState<AnomalySettings | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])
  if (!form) return null
  const readOnly = !can('admin')
  const num = (key: keyof AnomalySettings, label: string, description?: string) => (
    <NumberInput
      label={label}
      description={description}
      value={form[key] as number}
      readOnly={readOnly}
      onChange={(v) => setForm({ ...form, [key]: Number(v) || 0 })}
    />
  )

  const save = () =>
    api
      .put('/anomalies/settings', form)
      .then(() => {
        notifyOk(t('anomalies.saved'))
        void qc.invalidateQueries({ queryKey: ['anomalies'] })
      })
      .catch(notifyError)

  return (
    <Card withBorder maw={720}>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {num('baselineDays', t('anomalies.baselineDays'))}
          {num('minSamples', t('anomalies.minSamples'), t('anomalies.minSamplesHint'))}
          {num('toleranceMinutes', t('anomalies.toleranceMinutes'), t('anomalies.toleranceHint'))}
          <Group grow align="flex-start">
            <TextInput
              label={t('anomalies.nightStart')}
              value={form.nightStart}
              readOnly={readOnly}
              onChange={(e) => setForm({ ...form, nightStart: e.currentTarget.value })}
            />
            <TextInput
              label={t('anomalies.nightEnd')}
              value={form.nightEnd}
              readOnly={readOnly}
              onChange={(e) => setForm({ ...form, nightEnd: e.currentTarget.value })}
            />
          </Group>
          {num('deniedCount', t('anomalies.deniedCount'))}
          {num('deniedWindowMinutes', t('anomalies.deniedWindow'))}
          {num('inactiveDays', t('anomalies.inactiveDays'))}
        </SimpleGrid>
        <Alert color="blue">{t('anomalies.notifyHint')}</Alert>
        {!readOnly && (
          <Group justify="flex-end">
            <Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  )
}
