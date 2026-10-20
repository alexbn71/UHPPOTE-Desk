import { Alert, Badge, Box, Button, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconAlertTriangle, IconDoorEnter, IconLock, IconLockOpen } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { ControllerDto, ControllerLiveState, DoorDto, EventDto } from '@uhppote-desk/shared'
import { ControllerStatusBadge, EventsTable, PageHeader } from '../components/common'
import { ActivityCharts, StatTiles, useEventStats, WeekHoursChart } from '../components/DashboardStats'
import i18n from '../i18n'
import { api, errorText, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

export function openDoorWithConfirm(door: DoorDto, onDone?: () => void) {
  modals.openConfirmModal({
    title: i18n.t('dashboard.remoteOpenTitle'),
    children: <Text size="sm">{i18n.t('dashboard.remoteOpenConfirm', { name: door.name })}</Text>,
    labels: { confirm: i18n.t('dashboard.openButton'), cancel: i18n.t('common.cancel') },
    onConfirm: () =>
      api
        .post(`/doors/${door.id}/open`)
        .then(() => {
          notifyOk(i18n.t('dashboard.remoteOpenSent', { name: door.name }))
          onDone?.()
        })
        .catch(notifyError),
  })
}

function DoorTile({ door, live, canOpen }: { door: DoorDto; live?: ControllerLiveState; canOpen: boolean }) {
  const { t } = useTranslation()
  const codes = useCodes()
  // offline or disabled: the last known door state is not reliable
  const state = live?.online ? live.doors.find((d) => d.door === door.door) : undefined
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={600} size="sm">
            {door.name}
          </Text>
          <Group gap={4}>
            <Badge size="xs" variant="light" color={door.mode === 3 ? 'gray' : door.mode === 1 ? 'yellow' : 'dark'}>
              {codes.doorMode(door.mode)}
            </Badge>
            {state && (
              <Badge size="xs" color={state.open ? 'orange' : 'teal'} variant="light">
                {state.open ? t('dashboard.doorOpen') : t('dashboard.doorClosed')}
              </Badge>
            )}
            {state?.unlocked && (
              <Tooltip label={t('dashboard.relayActive')}>
                <IconLockOpen size={14} color="var(--mantine-color-orange-6)" />
              </Tooltip>
            )}
            {state && !state.unlocked && <IconLock size={14} color="var(--mantine-color-gray-6)" />}
          </Group>
        </Stack>
        {canOpen && (
          <Button
            size="xs"
            variant="light"
            style={{ flexShrink: 0 }}
            leftSection={<IconDoorEnter size={14} />}
            disabled={!live?.online}
            onClick={() => openDoorWithConfirm(door)}
          >
            {t('dashboard.openButton')}
          </Button>
        )}
      </Group>
    </Card>
  )
}

function ControllerCard({ c, live, canOpen }: { c: ControllerDto; live?: ControllerLiveState; canOpen: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const online = live?.online ?? c.online
  const drift = live?.driftSeconds
  return (
    <Card withBorder shadow="xs" style={c.enabled ? undefined : { opacity: 0.6 }}>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Title order={4} style={{ cursor: 'pointer' }} onClick={() => navigate(`/controllers/${c.id}`)}>
            {c.name}
          </Title>
          <ControllerStatusBadge enabled={c.enabled} online={online} />
          {live?.fireAlarm && <Badge color="red">{t('dashboard.fireAlarm')}</Badge>}
          {live?.forceLock && <Badge color="orange">{t('dashboard.forcedLock')}</Badge>}
        </Group>
        <Text size="xs" c="dimmed">
          S/N {c.serial} · {c.host ?? t('controllers.broadcast')}
          {drift !== null && drift !== undefined && Math.abs(drift) > 30
            ? ` · ${t('dashboard.clockDrift', { n: drift })}`
            : ''}
        </Text>
      </Group>
      {c.enabled && !online && live?.lastError && (
        <Alert color="red" variant="light" mb="xs" icon={<IconAlertTriangle size={16} />}>
          {errorText(live.lastErrorInfo ?? live.lastError)}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        {c.doors
          .filter((d) => d.active)
          .map((d) => (
            <DoorTile key={d.id} door={d} live={live} canOpen={canOpen} />
          ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="xs">
        {t('dashboard.lastContact', { time: fmtDateTime(live?.lastSeenAt ?? c.lastSeenAt) })}
      </Text>
    </Card>
  )
}

export function DashboardPage() {
  const { t } = useTranslation()
  const controllers = useControllers()
  const live = useLive()
  const { can } = useAuth()
  const navigate = useNavigate()
  const latest = useQuery({
    queryKey: ['events', 'latest'],
    queryFn: () => api.get<{ rows: EventDto[] }>('/events?limit=15'),
  })
  const stats = useEventStats()

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.description')} />
      {controllers.data?.length === 0 && (
        <Alert color="blue" mb="md" title={t('dashboard.noControllersTitle')}>
          {can('admin') ? (
            <Group gap="xs">
              <Text size="sm">{t('dashboard.noControllersAdmin')}</Text>
              <Button variant="subtle" size="compact-sm" onClick={() => navigate('/controllers')}>
                {t('dashboard.goToControllers')}
              </Button>
            </Group>
          ) : (
            t('dashboard.noControllersUser')
          )}
        </Alert>
      )}
      {!!controllers.data?.length && (
        <StatTiles stats={stats.data} controllers={controllers.data} states={live.states} />
      )}
      <SimpleGrid cols={{ base: 1, lg: 2 }} mb="lg">
        {controllers.data?.map((c) => (
          <ControllerCard key={c.id} c={c} live={live.states[c.id]} canOpen={can('operator')} />
        ))}
      </SimpleGrid>
      {!!controllers.data?.length && stats.data && (
        <>
          <ActivityCharts stats={stats.data} />
          <Box mb="lg">
            <WeekHoursChart stats={stats.data} />
          </Box>
        </>
      )}
      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={4}>{t('dashboard.latestEvents')}</Title>
          <Button variant="subtle" size="xs" onClick={() => navigate('/monitor')}>
            {t('dashboard.openMonitor')}
          </Button>
        </Group>
        <EventsTable events={latest.data?.rows ?? []} />
      </Card>
    </>
  )
}
