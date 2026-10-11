import { Badge, Button, Card, Group, NumberInput, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconSearch } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { CardDto } from '@uhppote-desk/shared'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { cardLabel, fmtDate, fmtDateTime } from '../lib/format'
import { usePeople } from '../lib/queries'

const STATUS = { active: ['Attiva', 'green'], lost: ['Smarrita', 'red'], disabled: ['Disattivata', 'gray'] } as const

export function CardsPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const cards = useQuery({ queryKey: ['cards', filter, search], queryFn: () => api.get<CardDto[]>(`/cards?unassigned=${filter === 'free'}&search=${encodeURIComponent(search)}`) })
  const unknown = useQuery({
    queryKey: ['cards-unknown', 'page'],
    queryFn: () => api.get<{ card: number; timestamp: string; controllerId: number; door: number }[]>('/cards/unknown?minutes=60'),
    refetchInterval: 5000,
    enabled: can('operator'),
  })
  const [batchFrom, setBatchFrom] = useState<number | string>('')
  const [batchTo, setBatchTo] = useState<number | string>('')

  const personOptions = (people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName} (${p.code})` }))
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cards'] })
    void qc.invalidateQueries({ queryKey: ['cards-unknown'] })
    void qc.invalidateQueries({ queryKey: ['people'] })
  }

  const register = (number: number) => {
    let personId: string | null = null
    modals.openConfirmModal({
      title: `Registra tessera ${number}`,
      children: <Select label="Assegna a" description="Lasciare vuoto per registrarla come libera" searchable clearable data={personOptions} onChange={(v) => (personId = v)} />,
      labels: { confirm: 'Registra', cancel: 'Annulla' },
      onConfirm: () =>
        api
          .post<{ pushErrors: { controllerId: number; error: string }[] }>('/cards', { number, personId: personId ? Number(personId) : null })
          .then((r) => {
            notifyOk(`Tessera ${number} registrata`)
            notifyPush(r)
            refresh()
          })
          .catch(notifyError),
    })
  }

  const assign = (c: CardDto, personId: string | null) =>
    api
      .put<{ pushErrors: { controllerId: number; error: string }[] }>(`/cards/${c.id}`, { number: c.number, personId: personId ? Number(personId) : null, status: c.status })
      .then((r) => {
        notifyPush(r)
        refresh()
      })
      .catch(notifyError)

  const batch = async () => {
    const from = Number(batchFrom)
    const to = Number(batchTo)
    if (!from || !to || to < from || to - from > 999) return notifyError(new Error('Intervallo non valido (massimo 1000 tessere)'))
    let ok = 0
    for (let n = from; n <= to; n++) {
      try {
        await api.post('/cards', { number: n, personId: null })
        ok++
      } catch {
        // duplicata o non valida: si prosegue
      }
    }
    notifyOk(`${ok} tessere registrate come libere`)
    refresh()
  }

  return (
    <>
      <PageHeader title="Tessere" description="Tutte le tessere registrate, libere o assegnate" />
      {can('operator') && (
        <Group align="stretch" grow mb="md">
          <Card withBorder>
            <Title order={5} mb="xs">
              Tessere lette ma non registrate (ultima ora)
            </Title>
            <Text size="sm" c="dimmed" mb="sm">
              Passa una tessera nuova su un lettore: comparirà qui e potrai registrarla.
            </Text>
            <Group gap="xs">
              {(unknown.data ?? []).map((u) => (
                <Button key={u.card} variant="outline" size="xs" onClick={() => register(u.card)}>
                  {cardLabel(u.card)} · {fmtDateTime(u.timestamp).slice(11)}
                </Button>
              ))}
              {unknown.data?.length === 0 && <Text size="sm" c="dimmed">Nessuna</Text>}
            </Group>
          </Card>
          <Card withBorder>
            <Title order={5} mb="xs">
              Inserimento in serie
            </Title>
            <Group align="flex-end">
              <NumberInput label="Dal numero" value={batchFrom} onChange={setBatchFrom} hideControls allowDecimal={false} />
              <NumberInput label="Al numero" value={batchTo} onChange={setBatchTo} hideControls allowDecimal={false} />
              <Button onClick={() => void batch()}>Registra</Button>
            </Group>
          </Card>
        </Group>
      )}
      <Card withBorder>
        <Group mb="md">
          <SegmentedControl
            value={filter}
            onChange={setFilter}
            data={[
              { value: 'all', label: 'Tutte' },
              { value: 'free', label: 'Libere' },
            ]}
          />
          <TextInput leftSection={<IconSearch size={16} />} placeholder="Numero tessera" value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        </Group>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Numero (facility, codice)</Table.Th>
                <Table.Th>Assegnata a</Table.Th>
                <Table.Th>Stato</Table.Th>
                <Table.Th>Registrata il</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(cards.data ?? []).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td className="mono">{cardLabel(c.number)}</Table.Td>
                  <Table.Td w={320}>
                    {can('operator') ? (
                      <Select size="xs" searchable clearable data={personOptions} value={c.personId ? String(c.personId) : null} onChange={(v) => void assign(c, v)} placeholder="Libera" />
                    ) : (
                      (c.personName ?? '—')
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS[c.status][1]} variant="light">
                      {STATUS[c.status][0]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{fmtDate(c.createdAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Stack>{cards.data?.length === 0 && <Text c="dimmed" ta="center" py="md">Nessuna tessera</Text>}</Stack>
      </Card>
    </>
  )
}
