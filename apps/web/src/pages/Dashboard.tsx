import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconAlertTriangle, IconDoorEnter, IconLock, IconLockOpen } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { ControllerDto, ControllerLiveState, DoorDto, EventDto } from '@uhppote-desk/shared'
import { EventsTable, PageHeader } from '../components/common'
import i18n from '../i18n'
import { api, notifyError, notifyOk } from '../lib/api'
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
  const state = live?.doors.find((d) => d.door === door.door)
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
          <Button size="xs" variant="light" style={{ flexShrink: 0 }} leftSection={<IconDoorEnter size={14} />} disabled={!live?.online} onClick={() => openDoorWithConfirm(door)}>
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
    <Card withBorder shadow="xs">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Title order={4} style={{ cursor: 'pointer' }} onClick={() => navigate(`/controller/${c.id}`)}>
            {c.name}
          </Title>
          <Badge color={online ? 'green' : 'red'}>{online ? t('common.online') : t('common.offline')}</Badge>
          {live?.fireAlarm && <Badge color="red">{t('dashboard.fireAlarm')}</Badge>}
          {live?.forceLock && <Badge color="orange">{t('dashboard.forcedLock')}</Badge>}
        </Group>
        <Text size="xs" c="dimmed">
          S/N {c.serial} · {c.host ?? t('controllers.broadcast')}
          {drift !== null && drift !== undefined && Math.abs(drift) > 30 ? ` · ${t('dashboard.clockDrift', { n: drift })}` : ''}
        </Text>
      </Group>
      {!online && live?.lastError && (
        <Alert color="red" variant="light" mb="xs" icon={<IconAlertTriangle size={16} />}>
          {live.lastError}
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
  const latest = useQuery({ queryKey: ['events', 'latest'], queryFn: () => api.get<{ rows: EventDto[] }>('/events?limit=15') })

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.description')} />
      {controllers.data?.length === 0 && (
        <Alert color="blue" mb="md" title={t('dashboard.noControllersTitle')}>
          {can('admin') ? (
            <Group gap="xs">
              <Text size="sm">{t('dashboard.noControllersAdmin')}</Text>
              <Button variant="subtle" size="compact-sm" onClick={() => navigate('/controller')}>
                {t('dashboard.goToControllers')}
              </Button>
            </Group>
          ) : (
            t('dashboard.noControllersUser')
          )}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, lg: 2 }} mb="lg">
        {controllers.data?.map((c) => <ControllerCard key={c.id} c={c} live={live.states[c.id]} canOpen={can('operator')} />)}
      </SimpleGrid>
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
