import { Avatar, Badge, Card, Grid, Group, Select, Stack, Switch, Text, Title } from '@mantine/core'
import { IconUser } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EventsTable, GrantedBadge, PageHeader } from '../components/common'
import { useCodes } from '../lib/codes'
import { fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

/** Live monitor of swipes, with the photo of the last person (like the original software's "Monitor"). */
export function MonitorPage() {
  const { t } = useTranslation()
  const codes = useCodes()
  const live = useLive()
  const controllers = useControllers()
  const [controllerId, setControllerId] = useState<string | null>(null)
  const [onlySwipes, setOnlySwipes] = useState(false)

  const events = useMemo(
    () =>
      live.events.filter(
        (e) => (!controllerId || e.controllerId === Number(controllerId)) && (!onlySwipes || e.type === 1),
      ),
    [live.events, controllerId, onlySwipes],
  )
  const last = events.find((e) => e.type === 1)

  return (
    <>
      <PageHeader
        title={t('monitor.title')}
        description={t('monitor.description')}
        actions={
          <>
            <Select
              placeholder={t('monitor.allControllers')}
              clearable
              data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
              value={controllerId}
              onChange={setControllerId}
              w={220}
            />
            <Switch
              label={t('monitor.swipesOnly')}
              checked={onlySwipes}
              onChange={(e) => setOnlySwipes(e.currentTarget.checked)}
            />
          </>
        }
      />
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card withBorder>
            <Title order={5} mb="sm">
              {t('monitor.lastSwipe')}
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
                  {last.personName ?? t('monitor.unregisteredCard')}
                </Text>
                <Text c="dimmed">{t('monitor.cardN', { n: last.card })}</Text>
                <GrantedBadge granted={last.granted} />
                <Text size="sm">{codes.reason(last.reason)}</Text>
                <Group gap="xs">
                  <Badge variant="light">{last.doorName ?? t('common.doorN', { n: last.door })}</Badge>
                  <Badge variant="outline">{codes.direction(last.direction)}</Badge>
                </Group>
                <Text size="sm" className="mono">
                  {fmtDateTime(last.timestamp)}
                </Text>
              </Stack>
            ) : (
              <Text c="dimmed" ta="center" py="xl">
                {t('monitor.waiting')}
              </Text>
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Card withBorder>
            <Title order={5} mb="sm">
              {t('monitor.sessionEvents', { n: events.length })}
            </Title>
            <EventsTable events={events} />
          </Card>
        </Grid.Col>
      </Grid>
    </>
  )
}
