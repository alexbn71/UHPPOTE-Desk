import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconAlertTriangle, IconDoorEnter, IconLock, IconLockOpen } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { ControllerDto, ControllerLiveState, DoorDto, EventDto } from '@uhppote-desk/shared'
import { DOOR_MODE_LABELS } from '@uhppote-desk/shared'
import { EventsTable, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

export function openDoorWithConfirm(door: DoorDto, onDone?: () => void) {
  modals.openConfirmModal({
    title: 'Apertura remota',
    children: <Text size="sm">Aprire la porta «{door.name}»?</Text>,
    labels: { confirm: 'Apri', cancel: 'Annulla' },
    onConfirm: () =>
      api
        .post(`/doors/${door.id}/open`)
        .then(() => {
          notifyOk(`Comando di apertura inviato a «${door.name}»`)
          onDone?.()
        })
        .catch(notifyError),
  })
}

function DoorTile({ door, live, canOpen }: { door: DoorDto; live?: ControllerLiveState; canOpen: boolean }) {
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
              {DOOR_MODE_LABELS[door.mode]}
            </Badge>
            {state && (
              <Badge size="xs" color={state.open ? 'orange' : 'teal'} variant="light">
                {state.open ? 'Aperta' : 'Chiusa'}
              </Badge>
            )}
            {state?.unlocked && (
              <Tooltip label="Relè attivo (serratura sbloccata)">
                <IconLockOpen size={14} color="var(--mantine-color-orange-6)" />
              </Tooltip>
            )}
            {state && !state.unlocked && <IconLock size={14} color="var(--mantine-color-gray-6)" />}
          </Group>
        </Stack>
        {canOpen && (
          <Button size="xs" variant="light" style={{ flexShrink: 0 }} leftSection={<IconDoorEnter size={14} />} disabled={!live?.online} onClick={() => openDoorWithConfirm(door)}>
            Apri
          </Button>
        )}
      </Group>
    </Card>
  )
}

function ControllerCard({ c, live, canOpen }: { c: ControllerDto; live?: ControllerLiveState; canOpen: boolean }) {
  const navigate = useNavigate()
  const online = live?.online ?? c.online
  return (
    <Card withBorder shadow="xs">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Title order={4} style={{ cursor: 'pointer' }} onClick={() => navigate(`/controller/${c.id}`)}>
            {c.name}
          </Title>
          <Badge color={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Badge>
          {live?.fireAlarm && <Badge color="red">Allarme incendio</Badge>}
          {live?.forceLock && <Badge color="orange">Blocco forzato</Badge>}
        </Group>
        <Text size="xs" c="dimmed">
          S/N {c.serial} · {c.host ?? 'broadcast'}
          {live?.driftSeconds !== null && live?.driftSeconds !== undefined && Math.abs(live.driftSeconds) > 30 ? ` · deriva ora ${live.driftSeconds}s` : ''}
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
        Ultimo contatto: {fmtDateTime(live?.lastSeenAt ?? c.lastSeenAt)}
      </Text>
    </Card>
  )
}

export function DashboardPage() {
  const controllers = useControllers()
  const live = useLive()
  const { can } = useAuth()
  const navigate = useNavigate()
  const latest = useQuery({ queryKey: ['events', 'latest'], queryFn: () => api.get<{ rows: EventDto[] }>('/events?limit=15') })

  return (
    <>
      <PageHeader title="Dashboard" description="Stato dei controller e degli ultimi passaggi" />
      {controllers.data?.length === 0 && (
        <Alert color="blue" mb="md" title="Nessun controller configurato">
          {can('admin') ? (
            <>
              Aggiungi il primo controller dalla pagina{' '}
              <Button variant="subtle" size="compact-sm" onClick={() => navigate('/controller')}>
                Controller
              </Button>
              (ricerca automatica in rete disponibile).
            </>
          ) : (
            'Chiedi a un amministratore di configurare i controller.'
          )}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, lg: 2 }} mb="lg">
        {controllers.data?.map((c) => <ControllerCard key={c.id} c={c} live={live.states[c.id]} canOpen={can('operator')} />)}
      </SimpleGrid>
      <Card withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={4}>Ultimi eventi</Title>
          <Button variant="subtle" size="xs" onClick={() => navigate('/monitor')}>
            Apri monitor
          </Button>
        </Group>
        <EventsTable events={latest.data?.rows ?? []} />
      </Card>
    </>
  )
}
