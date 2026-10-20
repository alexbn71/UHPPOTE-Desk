import { Button, Card, Group, Pagination, Select, SimpleGrid, Text, TextInput } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EventDto } from '@uhppote-desk/shared'
import { EventsTable, PageHeader } from '../components/common'
import { api, downloadQs, qs } from '../lib/api'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, addDays, today } from '../lib/format'
import { useControllers, usePeople } from '../lib/queries'

const PAGE = 100

export function EventsPage() {
  const { t } = useTranslation()
  const codes = useCodes()
  const controllers = useControllers()
  const people = usePeople()
  const [from, setFrom] = useState<string | null>(addDays(today(), -7))
  const [to, setTo] = useState<string | null>(today())
  const [controllerId, setControllerId] = useState<string | null>(null)
  const [personId, setPersonId] = useState<string | null>(null)
  const [granted, setGranted] = useState<string | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [card, setCard] = useState('')
  const [page, setPage] = useState(1)

  const filter = { from, to, controllerId, personId, granted, type, card: card || undefined }
  const query = useQuery({
    queryKey: ['events', filter, page],
    queryFn: () =>
      api.get<{ rows: EventDto[]; total: number }>(
        `/events${qs({ ...filter, limit: PAGE, offset: (page - 1) * PAGE })}`,
      ),
    placeholderData: keepPreviousData,
  })
  const reset = () => setPage(1)

  return (
    <>
      <PageHeader
        title={t('events.title')}
        description={t('events.description')}
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void query.refetch()}>
              {t('common.refresh')}
            </Button>
            <Button
              component="a"
              href={`/api/events/export.csv${downloadQs(filter)}`}
              leftSection={<IconDownload size={16} />}
            >
              {t('common.exportCsv')}
            </Button>
          </>
        }
      />
      <Card withBorder mb="md">
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
          <DateInput
            label={t('events.from')}
            value={from}
            onChange={(v) => {
              setFrom(v)
              reset()
            }}
            valueFormat={DATE_INPUT_FORMAT}
            clearable
          />
          <DateInput
            label={t('events.to')}
            value={to}
            onChange={(v) => {
              setTo(v)
              reset()
            }}
            valueFormat={DATE_INPUT_FORMAT}
            clearable
          />
          <Select
            label={t('common.controller')}
            clearable
            data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            value={controllerId}
            onChange={(v) => {
              setControllerId(v)
              reset()
            }}
          />
          <Select
            label={t('common.person')}
            clearable
            searchable
            data={(people.data ?? []).map((p) => ({
              value: String(p.id),
              label: `${p.lastName} ${p.firstName} (${p.code})`,
            }))}
            value={personId}
            onChange={(v) => {
              setPersonId(v)
              reset()
            }}
          />
          <Select
            label={t('events.outcome')}
            clearable
            data={[
              { value: 'true', label: t('events.granted') },
              { value: 'false', label: t('events.denied') },
            ]}
            value={granted}
            onChange={(v) => {
              setGranted(v)
              reset()
            }}
          />
          <Select
            label={t('common.type')}
            clearable
            data={[1, 2, 3].map((n) => ({ value: String(n), label: codes.eventType(n) }))}
            value={type}
            onChange={(v) => {
              setType(v)
              reset()
            }}
          />
          <TextInput
            label={t('events.cardNumber')}
            value={card}
            onChange={(e) => {
              setCard(e.currentTarget.value.replace(/\D/g, ''))
              reset()
            }}
          />
        </SimpleGrid>
      </Card>
      <Card withBorder>
        <EventsTable events={query.data?.rows ?? []} />
        <Group justify="space-between" mt="md">
          <Text size="sm" c="dimmed">
            {t('events.count', { n: query.data?.total ?? 0 })}
          </Text>
          <Pagination total={Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE))} value={page} onChange={setPage} />
        </Group>
      </Card>
    </>
  )
}
