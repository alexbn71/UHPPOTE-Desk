import { Avatar, Badge, Card, Grid, Group, Select, Stack, Switch, Text, Title } from '@mantine/core'
import { IconUser } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { DIRECTION_LABELS, reasonLabel } from '@uhppote-desk/shared'
import { EventsTable, GrantedBadge, PageHeader } from '../components/common'
import { fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

/** Monitor in tempo reale dei passaggi, con foto dell'ultima persona (come il "Monitor" del software originale). */
export function MonitorPage() {
  const live = useLive()
  const controllers = useControllers()
  const [controllerId, setControllerId] = useState<string | null>(null)
  const [onlySwipes, setOnlySwipes] = useState(false)

  const events = useMemo(
    () =>
      live.events.filter((e) => (!controllerId || e.controllerId === Number(controllerId)) && (!onlySwipes || e.type === 1)),
    [live.events, controllerId, onlySwipes],
  )
  const last = events.find((e) => e.type === 1)

  return (
    <>
      <PageHeader
        title="Monitor"
        description="Passaggi e allarmi in tempo reale (gli eventi compaiono appena ricevuti dal controller)"
        actions={
          <>
            <Select
              placeholder="Tutti i controller"
              clearable
              data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
              value={controllerId}
              onChange={setControllerId}
              w={220}
            />
            <Switch label="Solo passaggi tessera" checked={onlySwipes} onChange={(e) => setOnlySwipes(e.currentTarget.checked)} />
          </>
        }
      />
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card withBorder>
            <Title order={5} mb="sm">
              Ultimo passaggio
            </Title>
            {last ? (
              <Stack align="center" gap="xs">
                {last.personId ? (
                  <Avatar src={`/api/people/${last.personId}/photo`} size={160} radius="md">
                    <IconUser size={80} />
                  </Avatar>
                ) : (
                  <Avatar size={160} radius="md">
                    <IconUser size={80} />
                  </Avatar>
                )}
                <Text fw={700} size="xl" ta="center">
                  {last.personName ?? 'Tessera non registrata'}
                </Text>
                <Text c="dimmed">Tessera {last.card}</Text>
                <GrantedBadge granted={last.granted} />
                <Text size="sm">{reasonLabel(last.reason)}</Text>
                <Group gap="xs">
                  <Badge variant="light">{last.doorName ?? `Porta ${last.door}`}</Badge>
                  <Badge variant="outline">{DIRECTION_LABELS[last.direction] ?? '—'}</Badge>
                </Group>
                <Text size="sm" className="mono">
                  {fmtDateTime(last.timestamp)}
                </Text>
              </Stack>
            ) : (
              <Text c="dimmed" ta="center" py="xl">
                In attesa di passaggi…
              </Text>
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Card withBorder>
            <Title order={5} mb="sm">
              Eventi della sessione ({events.length})
            </Title>
            <EventsTable events={events} />
          </Card>
        </Grid.Col>
      </Grid>
    </>
  )
}
