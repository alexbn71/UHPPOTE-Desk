import { BarChart, MatrixChart, Sparkline } from '@mantine/charts'
import { Box, Card, Group, SimpleGrid, Text, ThemeIcon, Title, useComputedColorScheme } from '@mantine/core'
import { IconCircleCheck, IconCircleX, IconDoor, IconServer } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControllerDto, ControllerLiveState, EventStatsDto } from '@uhppote-desk/shared'
import { api } from '../lib/api'

const GRANTED = 'teal.6'
const DENIED = 'red.6'

export const useEventStats = () =>
  useQuery({
    queryKey: ['events', 'stats'],
    queryFn: () => api.get<EventStatsDto>('/events/stats'),
    refetchInterval: 60_000,
  })

function StatTile({
  label,
  value,
  icon,
  color,
  trend,
  trendLabel,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  color: string
  trend?: number[]
  trendLabel?: string
}) {
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Text size="xs" c="dimmed" fw={500}>
            {label}
          </Text>
          <Text fw={700} fz={28} lh={1.2}>
            {value}
          </Text>
        </div>
        <ThemeIcon variant="light" color={color.split('.')[0]} size="lg" radius="md">
          {icon}
        </ThemeIcon>
      </Group>
      {trend && (
        <Box mt={6}>
          <Sparkline h={32} data={trend} color={color} curveType="monotone" fillOpacity={0.25} strokeWidth={2} />
          <Text size="10px" c="dimmed">
            {trendLabel}
          </Text>
        </Box>
      )}
    </Card>
  )
}

/** Today's counts, doors open now and controllers online. */
export function StatTiles({
  stats,
  controllers,
  states,
}: {
  stats?: EventStatsDto
  controllers: ControllerDto[]
  states: Record<number, ControllerLiveState>
}) {
  const { t } = useTranslation()
  const today = stats?.daily.at(-1)
  const enabled = controllers.filter((c) => c.enabled)
  const online = enabled.filter((c) => states[c.id]?.online ?? c.online).length
  const activeDoors = enabled.flatMap((c) => c.doors.filter((d) => d.active).map((d) => ({ c, d })))
  const openDoors = activeDoors.filter(({ c, d }) => states[c.id]?.doors.find((s) => s.door === d.door)?.open).length
  return (
    <SimpleGrid cols={{ base: 2, md: 4 }} spacing="sm" mb="lg">
      <StatTile
        label={t('dashboard.statGranted')}
        value={today?.granted ?? '—'}
        icon={<IconCircleCheck size={20} />}
        color={GRANTED}
        trend={stats?.daily.map((d) => d.granted)}
        trendLabel={t('dashboard.statTrend')}
      />
      <StatTile
        label={t('dashboard.statDenied')}
        value={today?.denied ?? '—'}
        icon={<IconCircleX size={20} />}
        color={DENIED}
        trend={stats?.daily.map((d) => d.denied)}
        trendLabel={t('dashboard.statTrend')}
      />
      <StatTile
        label={t('dashboard.statDoorsOpen')}
        value={`${openDoors}/${activeDoors.length}`}
        icon={<IconDoor size={20} />}
        color={openDoors ? 'orange.6' : 'gray.6'}
      />
      <StatTile
        label={t('dashboard.statOnline')}
        value={`${online}/${enabled.length}`}
        icon={<IconServer size={20} />}
        color={online < enabled.length ? 'red.6' : 'green.6'}
      />
    </SimpleGrid>
  )
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {title}
      </Title>
      {children}
    </Card>
  )
}

function Empty() {
  const { t } = useTranslation()
  return (
    <Text size="sm" c="dimmed" ta="center" py="xl">
      {t('dashboard.noSwipes')}
    </Text>
  )
}

const hasSwipes = (rows: { granted: number; denied: number }[]) => rows.some((r) => r.granted + r.denied > 0)

/** Hourly swipes of the last 24 hours and swipes per door of the last 7 days. */
export function ActivityCharts({ stats }: { stats: EventStatsDto }) {
  const { t } = useTranslation()
  const series = [
    { name: 'granted', label: t('dashboard.granted'), color: GRANTED },
    { name: 'denied', label: t('dashboard.denied'), color: DENIED },
  ]
  const hourly = stats.hourly.map((h) => ({ ...h, label: `${h.hour.slice(11, 13)}:00` }))
  const doors = stats.byDoor.map((d) => ({
    ...d,
    label: d.doorName ?? `${d.controllerName} · ${t('common.doorN', { n: d.door })}`,
  }))
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} mb="lg">
      <ChartCard title={t('dashboard.chartHourly')}>
        {hasSwipes(hourly) ? (
          <BarChart
            h={220}
            data={hourly}
            dataKey="label"
            type="stacked"
            series={series}
            withLegend
            legendProps={{ verticalAlign: 'bottom' }}
            gridAxis="x"
            tickLine="none"
            maxBarWidth={18}
            xAxisProps={{ interval: 2 }}
            yAxisProps={{ allowDecimals: false, width: 32 }}
          />
        ) : (
          <Empty />
        )}
      </ChartCard>
      <ChartCard title={t('dashboard.chartByDoor')}>
        {doors.length ? (
          <BarChart
            h={Math.max(160, 60 + doors.length * 34)}
            data={doors}
            dataKey="label"
            type="stacked"
            orientation="vertical"
            series={series}
            withLegend
            legendProps={{ verticalAlign: 'bottom' }}
            gridAxis="y"
            tickLine="none"
            maxBarWidth={20}
            xAxisProps={{ allowDecimals: false }}
            yAxisProps={{ width: 130 }}
          />
        ) : (
          <Empty />
        )}
      </ChartCard>
    </SimpleGrid>
  )
}

/** Granted swipes per weekday and hour of the last 4 weeks. */
export function WeekHoursChart({ stats }: { stats: EventStatsDto }) {
  const { t, i18n } = useTranslation()
  const dark = useComputedColorScheme('light') === 'dark'
  const weekday = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { weekday: 'short' })
  // 2024-01-01 was a Monday
  const days = Array.from({ length: 7 }, (_, i) => weekday.format(new Date(2024, 0, 1 + i)))
  const hours = Array.from({ length: 24 }, (_, h) => String(h))
  const data = days.flatMap((day, w) =>
    hours.map((hour, h) => ({
      x: hour,
      y: day,
      value: stats.weekHours.find((c) => c.weekday === w && c.hour === h)?.count ?? null,
    })),
  )
  const max = Math.max(1, ...stats.weekHours.map((c) => c.count))
  return (
    <ChartCard title={t('dashboard.chartWeekHours')}>
      {stats.weekHours.length ? (
        <Box style={{ overflowX: 'auto' }}>
          <MatrixChart
            data={data}
            xLabels={hours}
            yLabels={days}
            domain={[1, max]}
            colors={dark ? ['blue.9', 'blue.7', 'blue.5', 'blue.3'] : ['blue.2', 'blue.4', 'blue.6', 'blue.8']}
            cellSize={26}
            gap={2}
            yLabelsWidth={44}
            xLabelsHeight={24}
            xLabelsRotation={0}
            xLabelsPosition="top"
            withXLabels
            withYLabels
            withLegend
            legendLabels={[t('dashboard.fewer'), t('dashboard.more')]}
            getTooltipLabel={(c) => `${c.y} ${c.x}:00 · ${t('dashboard.accessesN', { n: c.value ?? 0 })}`}
          />
        </Box>
      ) : (
        <Empty />
      )}
    </ChartCard>
  )
}
