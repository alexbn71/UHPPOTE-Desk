import { ActionIcon, Alert, Button, Card, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconEdit, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconButton, PageHeader, WeekdaysInput, weekdaysText } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate, today } from '../lib/format'
import { useTimeProfiles, type TimeProfile } from '../lib/queries'

export function TimeProfilesPage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const profiles = useTimeProfiles()
  const [edit, setEdit] = useState<(TimeProfile & { isNew: boolean }) | null>(null)

  const nextId = () => {
    const used = new Set((profiles.data ?? []).map((p) => p.id))
    for (let i = 2; i <= 254; i++) if (!used.has(i)) return i
    return 254
  }

  const save = async () => {
    if (!edit) return
    try {
      const { isNew: _n, id, ...body } = edit
      const r = await api.put<{ pushErrors: { controllerId: number; error: string }[] }>(`/time-profiles/${id}`, body)
      notifyOk('Fascia oraria salvata e inviata ai controller')
      notifyPush(r)
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['time-profiles'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (p: TimeProfile) =>
    modals.openConfirmModal({
      title: `Elimina fascia ${p.id}`,
      children: <Text size="sm">Eliminare «{p.name}»?</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<{ pushErrors: { controllerId: number; error: string }[] }>(`/time-profiles/${p.id}`)
          .then((r) => {
            notifyPush(r)
            void qc.invalidateQueries({ queryKey: ['time-profiles'] })
          })
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title="Fasce orarie"
        description="Intervalli di tempo (ID 2-254) in cui un permesso è valido. Una fascia può concatenarne un'altra per aggiungere giorni/orari."
        actions={
          can('admin') && (
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() =>
                setEdit({
                  isNew: true,
                  id: nextId(),
                  name: '',
                  validFrom: today(),
                  validTo: '2099-12-31',
                  weekdays: [true, true, true, true, true, false, false],
                  segments: [{ start: '08:00', end: '18:00' }],
                  linkedTo: null,
                })
              }
            >
              Nuova fascia
            </Button>
          )
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>ID</Table.Th>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Giorni</Table.Th>
              <Table.Th>Orari</Table.Th>
              <Table.Th>Validità</Table.Th>
              <Table.Th>Collegata a</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(profiles.data ?? []).map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>{p.id}</Table.Td>
                <Table.Td>{p.name}</Table.Td>
                <Table.Td>{weekdaysText(p.weekdays)}</Table.Td>
                <Table.Td>{p.segments.map((s) => `${s.start}-${s.end}`).join(', ')}</Table.Td>
                <Table.Td>
                  {fmtDate(p.validFrom)} – {fmtDate(p.validTo)}
                </Table.Td>
                <Table.Td>{p.linkedTo ?? '—'}</Table.Td>
                <Table.Td>
                  {can('admin') && (
                    <Group gap={0} justify="flex-end">
                      <IconButton label="Modifica" onClick={() => setEdit({ ...p, isNew: false })}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label="Elimina" color="red" onClick={() => remove(p)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {profiles.data?.length === 0 && (
          <Text c="dimmed" ta="center" py="md">
            Nessuna fascia oraria: i permessi «Sempre» non ne hanno bisogno.
          </Text>
        )}
      </Card>
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? 'Nuova fascia oraria' : `Fascia oraria ${edit?.id}`} size="lg">
        {edit && (
          <Stack>
            <SimpleGrid cols={2}>
              <NumberInput label="ID (2-254)" min={2} max={254} value={edit.id} onChange={(v) => setEdit({ ...edit, id: Number(v) })} disabled={!edit.isNew} />
              <TextInput label="Nome" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
              <DateInput label="Valida dal" valueFormat="DD/MM/YYYY" value={edit.validFrom} onChange={(v) => v && setEdit({ ...edit, validFrom: v })} />
              <DateInput label="Valida al" valueFormat="DD/MM/YYYY" value={edit.validTo} onChange={(v) => v && setEdit({ ...edit, validTo: v })} />
            </SimpleGrid>
            <WeekdaysInput label="Giorni" value={edit.weekdays} onChange={(w) => setEdit({ ...edit, weekdays: w })} />
            <Text size="sm" fw={500}>
              Orari (massimo 3 intervalli)
            </Text>
            {edit.segments.map((s, i) => (
              <Group key={i}>
                <TextInput placeholder="08:00" value={s.start} onChange={(e) => setEdit({ ...edit, segments: edit.segments.map((x, j) => (j === i ? { ...x, start: e.currentTarget.value } : x)) })} w={100} />
                <Text>–</Text>
                <TextInput placeholder="12:00" value={s.end} onChange={(e) => setEdit({ ...edit, segments: edit.segments.map((x, j) => (j === i ? { ...x, end: e.currentTarget.value } : x)) })} w={100} />
                <ActionIcon variant="subtle" color="red" onClick={() => setEdit({ ...edit, segments: edit.segments.filter((_, j) => j !== i) })}>
                  <IconX size={16} />
                </ActionIcon>
              </Group>
            ))}
            {edit.segments.length < 3 && (
              <Button variant="subtle" size="xs" w="fit-content" onClick={() => setEdit({ ...edit, segments: [...edit.segments, { start: '13:00', end: '17:00' }] })}>
                + Aggiungi intervallo
              </Button>
            )}
            <Select
              label="Concatena la fascia"
              description="Se il passaggio non rientra in questa fascia viene verificata la fascia collegata"
              clearable
              data={(profiles.data ?? []).filter((p) => p.id !== edit.id).map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` }))}
              value={edit.linkedTo ? String(edit.linkedTo) : null}
              onChange={(v) => setEdit({ ...edit, linkedTo: v ? Number(v) : null })}
            />
            <Alert variant="light">Al salvataggio tutte le fasce orarie vengono reinviate a tutti i controller.</Alert>
            <Button onClick={() => void save()} disabled={!edit.name}>
              Salva
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
