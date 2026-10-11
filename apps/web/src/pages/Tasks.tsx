import { Badge, Button, Card, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TASK_LABELS } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput, weekdaysText } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate, today } from '../lib/format'
import { useControllers } from '../lib/queries'

interface Task {
  id: number
  controllerId: number
  door: number
  task: number
  validFrom: string
  validTo: string
  weekdays: boolean[]
  startTime: string
  moreCards: number
  enabled: boolean
}

export function TasksPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const controllers = useControllers()
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<Task[]>('/tasks') })
  const [edit, setEdit] = useState<Partial<Task> & Omit<Task, 'id'> & { id?: number } | null>(null)
  const ctrlName = (id: number) => controllers.data?.find((c) => c.id === id)?.name ?? `#${id}`

  const save = async () => {
    if (!edit) return
    try {
      const { id, ...body } = edit
      const r = id ? await api.put<{ pushError: string | null }>(`/tasks/${id}`, body) : await api.post<{ pushError: string | null }>('/tasks', body)
      if (r.pushError) notifyError(new Error(`Salvato, ma non inviato al controller: ${r.pushError}`))
      else notifyOk('Task salvato e inviato al controller')
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (t: Task) =>
    modals.openConfirmModal({
      title: 'Elimina task',
      children: <Text size="sm">Eliminare il task «{TASK_LABELS[t.task]}» delle {t.startTime}?</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/tasks/${t.id}`)
          .then(() => qc.invalidateQueries({ queryKey: ['tasks'] }))
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title="Task programmati"
        description="Azioni eseguite automaticamente dal controller a un orario (es. porta aperta di giorno, chiusa la notte)"
        actions={
          can('admin') && (
            <Button
              leftSection={<IconPlus size={16} />}
              disabled={!controllers.data?.length}
              onClick={() =>
                setEdit({
                  controllerId: controllers.data![0]!.id,
                  door: 1,
                  task: 1,
                  validFrom: today(),
                  validTo: '2099-12-31',
                  weekdays: [true, true, true, true, true, false, false],
                  startTime: '08:00',
                  moreCards: 0,
                  enabled: true,
                })
              }
            >
              Nuovo task
            </Button>
          )
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Controller</Table.Th>
              <Table.Th>Porta</Table.Th>
              <Table.Th>Ora</Table.Th>
              <Table.Th>Azione</Table.Th>
              <Table.Th>Giorni</Table.Th>
              <Table.Th>Validità</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(tasks.data ?? []).map((t) => (
              <Table.Tr key={t.id} opacity={t.enabled ? 1 : 0.5}>
                <Table.Td>{ctrlName(t.controllerId)}</Table.Td>
                <Table.Td>{t.door}</Table.Td>
                <Table.Td className="mono">{t.startTime}</Table.Td>
                <Table.Td>
                  {TASK_LABELS[t.task]} {!t.enabled && <Badge color="gray">disattivato</Badge>}
                </Table.Td>
                <Table.Td>{weekdaysText(t.weekdays)}</Table.Td>
                <Table.Td>
                  {fmtDate(t.validFrom)} – {fmtDate(t.validTo)}
                </Table.Td>
                <Table.Td>
                  {can('admin') && (
                    <Group gap={0} justify="flex-end">
                      <IconButton label="Modifica" onClick={() => setEdit(t)}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label="Elimina" color="red" onClick={() => remove(t)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {tasks.data?.length === 0 && (
          <Text c="dimmed" ta="center" py="md">
            Nessun task programmato
          </Text>
        )}
      </Card>
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Modifica task' : 'Nuovo task'}>
        {edit && (
          <Stack>
            <SimpleGrid cols={2}>
              <Select
                label="Controller"
                data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                value={String(edit.controllerId)}
                onChange={(v) => setEdit({ ...edit, controllerId: Number(v) })}
              />
              <Select label="Porta" data={['1', '2', '3', '4']} value={String(edit.door)} onChange={(v) => setEdit({ ...edit, door: Number(v) })} />
            </SimpleGrid>
            <Select
              label="Azione"
              data={Object.entries(TASK_LABELS).map(([v, l]) => ({ value: v, label: l }))}
              value={String(edit.task)}
              onChange={(v) => setEdit({ ...edit, task: Number(v) })}
            />
            {edit.task === 8 && (
              <NumberInput label="Numero tessere richieste" min={0} max={255} value={edit.moreCards} onChange={(v) => setEdit({ ...edit, moreCards: Number(v) || 0 })} />
            )}
            <TextInput label="Ora di esecuzione (HH:mm)" value={edit.startTime} onChange={(e) => setEdit({ ...edit, startTime: e.currentTarget.value })} w={160} />
            <WeekdaysInput label="Giorni" value={edit.weekdays} onChange={(w) => setEdit({ ...edit, weekdays: w })} />
            <SimpleGrid cols={2}>
              <DateInput label="Dal" valueFormat="DD/MM/YYYY" value={edit.validFrom} onChange={(v) => v && setEdit({ ...edit, validFrom: v })} />
              <DateInput label="Al" valueFormat="DD/MM/YYYY" value={edit.validTo} onChange={(v) => v && setEdit({ ...edit, validTo: v })} />
            </SimpleGrid>
            <Switch label="Attivo" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.currentTarget.checked })} />
            <Button onClick={() => void save()}>Salva e invia</Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
