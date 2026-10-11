import { Alert, Button, Card, Code, SimpleGrid, Table, Text, Title } from '@mantine/core'
import { IconDatabaseExport } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDateTime } from '../lib/format'

interface SystemInfo {
  version: string
  node: string
  hostname: string
  uptimeSec: number
  interfaces: { name: string; address: string; netmask: string }[]
  uhppote: { bindAddress: string; broadcast: string; listen: string; listenerPublic: string | null; timeoutMs: number }
  counts: { people: number; cards: number; events: number; controllers: number }
}

export function SystemPage() {
  const { can } = useAuth()
  const info = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/system/info') })
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ name: string; size: number; createdAt: string }[]>('/system/backups'), enabled: can('admin') })
  const d = info.data
  return (
    <>
      <PageHeader title="Sistema" description="Informazioni sul server, configurazione di rete e backup" />
      {d && (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder>
            <Title order={5} mb="xs">
              Server
            </Title>
            <Table>
              <Table.Tbody>
                <Table.Tr><Table.Td c="dimmed">Versione</Table.Td><Table.Td>{d.version}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Host</Table.Td><Table.Td>{d.hostname} (Node {d.node})</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Attivo da</Table.Td><Table.Td>{Math.floor(d.uptimeSec / 3600)} h {Math.floor((d.uptimeSec % 3600) / 60)} min</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Interfacce</Table.Td><Table.Td className="mono">{d.interfaces.map((i) => `${i.name}: ${i.address}/${i.netmask}`).join('\n')}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Dati</Table.Td><Table.Td>{d.counts.controllers} controller · {d.counts.people} persone · {d.counts.cards} tessere · {d.counts.events} eventi</Table.Td></Table.Tr>
              </Table.Tbody>
            </Table>
          </Card>
          <Card withBorder>
            <Title order={5} mb="xs">
              Comunicazione con i controller
            </Title>
            <Table>
              <Table.Tbody>
                <Table.Tr><Table.Td c="dimmed">Bind locale</Table.Td><Table.Td className="mono">{d.uhppote.bindAddress}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Broadcast ricerca</Table.Td><Table.Td className="mono">{d.uhppote.broadcast}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Ascolto eventi</Table.Td><Table.Td className="mono">{d.uhppote.listen}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Listener programmato</Table.Td><Table.Td className="mono">{d.uhppote.listenerPublic ?? <Text span c="orange">non impostato</Text>}</Table.Td></Table.Tr>
                <Table.Tr><Table.Td c="dimmed">Timeout</Table.Td><Table.Td>{d.uhppote.timeoutMs} ms</Table.Td></Table.Tr>
              </Table.Tbody>
            </Table>
            {!d.uhppote.listenerPublic && (
              <Alert color="orange" mt="sm">
                Imposta <Code>UHPPOTE_LISTENER_PUBLIC</Code> con l'IP del server raggiungibile dalle schede (es. 192.168.1.10:60001) per ricevere gli eventi in tempo reale.
              </Alert>
            )}
          </Card>
          {can('admin') && (
            <Card withBorder>
              <Title order={5} mb="xs">
                Backup database
              </Title>
              <Text size="sm" c="dimmed" mb="sm">
                Backup automatico giornaliero nella cartella dati del server (sottocartella backups).
              </Text>
              <Button
                leftSection={<IconDatabaseExport size={16} />}
                variant="light"
                mb="sm"
                onClick={() =>
                  void api
                    .post('/system/backups')
                    .then(() => {
                      notifyOk('Backup creato')
                      void backups.refetch()
                    })
                    .catch(notifyError)
                }
              >
                Crea backup ora
              </Button>
              <Table>
                <Table.Tbody>
                  {(backups.data ?? []).map((b) => (
                    <Table.Tr key={b.name}>
                      <Table.Td className="mono">{b.name}</Table.Td>
                      <Table.Td>{(b.size / 1024 / 1024).toFixed(1)} MB</Table.Td>
                      <Table.Td>{fmtDateTime(b.createdAt.replace('T', ' ').slice(0, 19))}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          )}
        </SimpleGrid>
      )}
    </>
  )
}
