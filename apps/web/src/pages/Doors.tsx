import { Badge, Button, Card, Group, Modal, NumberInput, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { IconDoorEnter, IconEdit } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { DoorDto } from '@uhppote-desk/shared'
import { DOOR_MODE_LABELS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'
import { openDoorWithConfirm } from './Dashboard'

export function DoorsPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const live = useLive()
  const controllers = useControllers()
  const [edit, setEdit] = useState<DoorDto | null>(null)

  const save = async () => {
    if (!edit) return
    try {
      const r = await api.put<{ pushError: string | null }>(`/doors/${edit.id}`, {
        name: edit.name,
        active: edit.active,
        attendance: edit.attendance,
        mode: edit.mode,
        delay: edit.delay,
      })
      if (r.pushError) notifyError(new Error(`Salvato, ma non inviato al controller: ${r.pushError}`))
      else notifyOk('Porta aggiornata')
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['controllers'] })
      void qc.invalidateQueries({ queryKey: ['doors'] })
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <>
      <PageHeader title="Porte" description="Nome, modalità di funzionamento, tempo di apertura e lettori validi per le presenze" />
      {(controllers.data ?? []).map((c) => (
        <Card withBorder key={c.id} mb="md">
          <Text fw={700} mb="xs">
            {c.name}
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>#</Table.Th>
                <Table.Th>Nome</Table.Th>
                <Table.Th>Modalità</Table.Th>
                <Table.Th>Apertura</Table.Th>
                <Table.Th>Stato</Table.Th>
                <Table.Th>Presenze</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {c.doors.map((d) => {
                const st = live.states[c.id]?.doors.find((x) => x.door === d.door)
                return (
                  <Table.Tr key={d.id} opacity={d.active ? 1 : 0.5}>
                    <Table.Td>{d.door}</Table.Td>
                    <Table.Td>{d.name}</Table.Td>
                    <Table.Td>{DOOR_MODE_LABELS[d.mode]}</Table.Td>
                    <Table.Td>{d.delay}s</Table.Td>
                    <Table.Td>{st ? <Badge color={st.open ? 'orange' : 'teal'} variant="light">{st.open ? 'Aperta' : 'Chiusa'}</Badge> : '—'}</Table.Td>
                    <Table.Td>{d.attendance ? <Badge variant="light">Sì</Badge> : '—'}</Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end">
                        {can('operator') && d.active && (
                          <Button size="compact-xs" variant="light" leftSection={<IconDoorEnter size={14} />} onClick={() => openDoorWithConfirm(d)}>
                            Apri
                          </Button>
                        )}
                        {can('admin') && (
                          <IconButton label="Modifica" onClick={() => setEdit(d)}>
                            <IconEdit size={16} />
                          </IconButton>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Card>
      ))}
      <Modal opened={!!edit} onClose={() => setEdit(null)} title="Modifica porta">
        {edit && (
          <Stack>
            <TextInput label="Nome" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
            <Select
              label="Modalità"
              data={Object.entries(DOOR_MODE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
              value={String(edit.mode)}
              onChange={(v) => setEdit({ ...edit, mode: Number(v) })}
            />
            <NumberInput label="Tempo di apertura (secondi)" min={0} max={255} value={edit.delay} onChange={(v) => setEdit({ ...edit, delay: Number(v) || 0 })} />
            <Switch label="Attiva (visibile in dashboard e permessi)" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.currentTarget.checked })} />
            <Switch label="Lettore valido per le presenze" checked={edit.attendance} onChange={(e) => setEdit({ ...edit, attendance: e.currentTarget.checked })} />
            <Button onClick={() => void save()}>Salva e invia al controller</Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
