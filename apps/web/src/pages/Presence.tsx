import { Alert, Badge, Button, Card, Group, SegmentedControl, SimpleGrid, Table, Text, TextInput } from '@mantine/core'
import { IconDownload, IconInfoCircle, IconRefresh } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PresenceDto } from '@uhppote-desk/shared'
import { PageHeader } from '../components/common'
import { api, downloadQs } from '../lib/api'
import { cardLabel, fmtDateTime } from '../lib/format'

const PERIODS = ['today', '8', '24'] as const

/** Who is inside now: last granted swipe of each person on entry / exit doors (Doors → Presence). */
export function PresencePage() {
  const { t } = useTranslation()
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('today')
  const [search, setSearch] = useState('')
  const query = useQuery({
    queryKey: ['presence', period],
    queryFn: () => api.get<PresenceDto>(`/presence?period=${period}`),
    refetchInterval: 30_000,
  })
  const p = query.data
  const needle = search.trim().toLowerCase()
  const rows = (p?.inside ?? []).filter(
    (r) => !needle || `${r.name} ${r.department ?? ''} ${r.door}`.toLowerCase().includes(needle),
  )

  return (
    <>
      <PageHeader
        title={t('presence.title')}
        description={t('presence.description')}
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void query.refetch()}>
              {t('common.refresh')}
            </Button>
            <Button
              component="a"
              href={`/api/presence/export.csv${downloadQs({ period })}`}
              leftSection={<IconDownload size={16} />}
            >
              {t('common.exportCsv')}
            </Button>
          </>
        }
      />
      <Group mb="md" justify="space-between">
        <SegmentedControl
          value={period}
          onChange={(v) => setPeriod(v as (typeof PERIODS)[number])}
          data={PERIODS.map((v) => ({ value: v, label: t(`presence.period.${v}`) }))}
        />
        <TextInput placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
      </Group>
      {p && p.exitDoors === 0 && (
        <Alert color="yellow" icon={<IconInfoCircle size={18} />} mb="md">
          {t('presence.noExitDoors')}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="md">
        <Card withBorder>
          <Text size="sm" c="dimmed">
            {t('presence.insideNow')}
          </Text>
          <Text fz={32} fw={700} data-testid="presence-count">
            {p?.inside.length ?? '—'}
          </Text>
        </Card>
        <Card withBorder>
          <Text size="sm" c="dimmed">
            {t('presence.left')}
          </Text>
          <Text fz={32} fw={700}>
            {p?.leftCount ?? '—'}
          </Text>
        </Card>
        <Card withBorder>
          <Text size="sm" c="dimmed">
            {t('presence.doors')}
          </Text>
          <Text size="sm" mt={6}>
            {t('presence.doorsValue', { entry: p?.entryDoors ?? 0, exit: p?.exitDoors ?? 0 })}
          </Text>
          {p && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('presence.since', { time: fmtDateTime(p.since) })}
            </Text>
          )}
        </Card>
      </SimpleGrid>
      <Card withBorder>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('presence.colPerson')}</Table.Th>
              <Table.Th>{t('presence.colDepartment')}</Table.Th>
              <Table.Th>{t('presence.colCard')}</Table.Th>
              <Table.Th>{t('presence.colDoor')}</Table.Th>
              <Table.Th>{t('presence.colSince')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.personId}>
                <Table.Td fw={500}>{r.name}</Table.Td>
                <Table.Td>{r.department ?? '—'}</Table.Td>
                <Table.Td>{cardLabel(r.card)}</Table.Td>
                <Table.Td>
                  <Badge variant="light">{r.door}</Badge>
                </Table.Td>
                <Table.Td>{fmtDateTime(r.timestamp)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {p && rows.length === 0 && (
          <Text c="dimmed" ta="center" py="md">
            {t('presence.empty')}
          </Text>
        )}
      </Card>
    </>
  )
}
