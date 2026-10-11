import { Badge, Card, Code, Group, Pagination, Table, Text, TextInput, Tooltip } from '@mantine/core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PageHeader } from '../components/common'
import { api, qs } from '../lib/api'
import { fmtDateTime } from '../lib/format'

interface AuditEntry {
  id: number
  at: string
  operatorName: string | null
  action: string
  target: string | null
  details: unknown
  outcome: 'ok' | 'error'
  error: string | null
}

const PAGE = 100

export function AuditPage() {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const audit = useQuery({
    queryKey: ['audit', action, page],
    queryFn: () => api.get<{ rows: AuditEntry[]; total: number }>(`/audit${qs({ action, limit: PAGE, offset: (page - 1) * PAGE })}`),
    placeholderData: keepPreviousData,
  })
  return (
    <>
      <PageHeader title="Registro operazioni" description="Tutte le modifiche e i comandi inviati ai controller, con operatore ed esito" />
      <Card withBorder>
        <TextInput placeholder="Filtra per azione (es. open-door, sync, login)" value={action} onChange={(e) => { setAction(e.currentTarget.value); setPage(1) }} mb="md" w={360} />
        <Table.ScrollContainer minWidth={800}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Data/ora</Table.Th>
                <Table.Th>Operatore</Table.Th>
                <Table.Th>Azione</Table.Th>
                <Table.Th>Oggetto</Table.Th>
                <Table.Th>Esito</Table.Th>
                <Table.Th>Dettagli</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(audit.data?.rows ?? []).map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td className="mono">{fmtDateTime(a.at)}</Table.Td>
                  <Table.Td>{a.operatorName ?? 'sistema'}</Table.Td>
                  <Table.Td className="mono">{a.action}</Table.Td>
                  <Table.Td className="mono">{a.target ?? ''}</Table.Td>
                  <Table.Td>
                    {a.outcome === 'ok' ? (
                      <Badge color="green" variant="light">
                        ok
                      </Badge>
                    ) : (
                      <Tooltip label={a.error} multiline w={300}>
                        <Badge color="red" variant="light">
                          errore
                        </Badge>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td maw={400}>
                    {a.details !== null && (
                      <Code block style={{ maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                        {JSON.stringify(a.details)}
                      </Code>
                    )}
                    {a.error && (
                      <Text size="xs" c="red">
                        {a.error}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group justify="space-between" mt="md">
          <Text size="sm" c="dimmed">
            {audit.data?.total ?? 0} operazioni
          </Text>
          <Pagination total={Math.max(1, Math.ceil((audit.data?.total ?? 0) / PAGE))} value={page} onChange={setPage} />
        </Group>
      </Card>
    </>
  )
}
