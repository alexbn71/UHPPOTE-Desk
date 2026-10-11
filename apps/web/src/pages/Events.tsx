import { Button, Card, Group, Pagination, Select, SimpleGrid, Text, TextInput } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { EventDto } from '@uhppote-desk/shared'
import { EventsTable, PageHeader } from '../components/common'
import { api, qs } from '../lib/api'
import { addDays, today } from '../lib/format'
import { useControllers, usePeople } from '../lib/queries'

const PAGE = 100

export function EventsPage() {
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
    queryFn: () => api.get<{ rows: EventDto[]; total: number }>(`/events${qs({ ...filter, limit: PAGE, offset: (page - 1) * PAGE })}`),
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader
        title="Storico eventi"
        description="Passaggi, eventi porta e allarmi registrati (raccolti automaticamente dai controller)"
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void query.refetch()}>
              Aggiorna
            </Button>
            <Button component="a" href={`/api/events/export.csv${qs(filter)}`} leftSection={<IconDownload size={16} />}>
              Esporta CSV
            </Button>
          </>
        }
      />
      <Card withBorder mb="md">
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
          <DateInput label="Dal" value={from} onChange={(v) => { setFrom(v); setPage(1) }} valueFormat="DD/MM/YYYY" clearable />
          <DateInput label="Al" value={to} onChange={(v) => { setTo(v); setPage(1) }} valueFormat="DD/MM/YYYY" clearable />
          <Select
            label="Controller"
            clearable
            data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            value={controllerId}
            onChange={(v) => { setControllerId(v); setPage(1) }}
          />
          <Select
            label="Persona"
            clearable
            searchable
            data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName} (${p.code})` }))}
            value={personId}
            onChange={(v) => { setPersonId(v); setPage(1) }}
          />
          <Select
            label="Esito"
            clearable
            data={[
              { value: 'true', label: 'Consentiti' },
              { value: 'false', label: 'Negati' },
            ]}
            value={granted}
            onChange={(v) => { setGranted(v); setPage(1) }}
          />
          <Select
            label="Tipo"
            clearable
            data={[
              { value: '1', label: 'Tessera' },
              { value: '2', label: 'Porta' },
              { value: '3', label: 'Allarme' },
            ]}
            value={type}
            onChange={(v) => { setType(v); setPage(1) }}
          />
          <TextInput label="Numero tessera" value={card} onChange={(e) => { setCard(e.currentTarget.value.replace(/\D/g, '')); setPage(1) }} />
        </SimpleGrid>
      </Card>
      <Card withBorder>
        <EventsTable events={query.data?.rows ?? []} />
        <Group justify="space-between" mt="md">
          <Text size="sm" c="dimmed">
            {query.data?.total ?? 0} eventi
          </Text>
          <Pagination total={Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE))} value={page} onChange={setPage} />
        </Group>
      </Card>
    </>
  )
}
