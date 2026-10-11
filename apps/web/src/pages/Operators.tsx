import { Alert, Badge, Button, Card, Code, Group, Modal, MultiSelect, PasswordInput, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconEdit, IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { OperatorDto, Role } from '@uhppote-desk/shared'
import { ROLE_LABELS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { treeOptions, useZones } from '../lib/queries'

interface Form {
  id?: number
  username: string
  displayName: string
  role: Role
  active: boolean
  password: string
  zoneIds: string[]
}

export function OperatorsPage() {
  const qc = useQueryClient()
  const zones = useZones()
  const operators = useQuery({ queryKey: ['operators'], queryFn: () => api.get<OperatorDto[]>('/operators') })
  const [form, setForm] = useState<Form | null>(null)
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null)

  const save = async () => {
    if (!form) return
    try {
      const body = { username: form.username, displayName: form.displayName, role: form.role, active: form.active, password: form.password || undefined, zoneIds: form.zoneIds.map(Number) }
      if (form.id) await api.put(`/operators/${form.id}`, body)
      else {
        const r = await api.post<{ password?: string }>('/operators', body)
        if (r.password) setGenerated({ username: form.username, password: r.password })
      }
      setForm(null)
      void qc.invalidateQueries({ queryKey: ['operators'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const resetPassword = (o: OperatorDto) =>
    modals.openConfirmModal({
      title: `Reimposta password di ${o.username}`,
      children: <Text size="sm">Verrà generata una password temporanea da cambiare al primo accesso.</Text>,
      labels: { confirm: 'Reimposta', cancel: 'Annulla' },
      onConfirm: () =>
        api
          .post<{ password: string }>(`/operators/${o.id}/reset-password`)
          .then((r) => setGenerated({ username: o.username, password: r.password }))
          .catch(notifyError),
    })

  const remove = (o: OperatorDto) =>
    modals.openConfirmModal({
      title: `Elimina ${o.username}`,
      children: <Text size="sm">L'operatore verrà eliminato (le sue operazioni restano nel registro).</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/operators/${o.id}`)
          .then(() => qc.invalidateQueries({ queryKey: ['operators'] }))
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title="Operatori"
        description="Utenti dell'applicazione. Amministratore: tutto; Operatore: anagrafica, permessi, apertura porte, sincronizzazione; Sola lettura: consultazione."
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ username: '', displayName: '', role: 'operator', active: true, password: '', zoneIds: [] })}>
            Nuovo operatore
          </Button>
        }
      />
      {generated && (
        <Alert color="blue" withCloseButton onClose={() => setGenerated(null)} mb="md" title="Password temporanea">
          Utente <b>{generated.username}</b>: <Code>{generated.password}</Code> — comunicarla all'interessato; dovrà cambiarla al primo accesso.
        </Alert>
      )}
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Utente</Table.Th>
              <Table.Th>Nome</Table.Th>
              <Table.Th>Ruolo</Table.Th>
              <Table.Th>Zone</Table.Th>
              <Table.Th>Ultimo accesso</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(operators.data ?? []).map((o) => (
              <Table.Tr key={o.id} opacity={o.active ? 1 : 0.5}>
                <Table.Td className="mono">{o.username}</Table.Td>
                <Table.Td>{o.displayName}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={o.role === 'admin' ? 'red' : o.role === 'operator' ? 'blue' : 'gray'}>
                    {ROLE_LABELS[o.role]}
                  </Badge>
                </Table.Td>
                <Table.Td>{o.zoneIds.length ? o.zoneIds.map((z) => zones.data?.find((x) => x.id === z)?.name ?? z).join(', ') : 'Tutte'}</Table.Td>
                <Table.Td>{fmtDateTime(o.lastLoginAt)}</Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end">
                    <IconButton label="Modifica" onClick={() => setForm({ ...o, password: '', zoneIds: o.zoneIds.map(String) })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label="Reimposta password" onClick={() => resetPassword(o)}>
                      <IconKey size={16} />
                    </IconButton>
                    <IconButton label="Elimina" color="red" onClick={() => remove(o)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Modal opened={!!form} onClose={() => setForm(null)} title={form?.id ? 'Modifica operatore' : 'Nuovo operatore'}>
        {form && (
          <Stack>
            <TextInput label="Nome utente" value={form.username} onChange={(e) => setForm({ ...form, username: e.currentTarget.value })} />
            <TextInput label="Nome visualizzato" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.currentTarget.value })} />
            <Select label="Ruolo" data={Object.entries(ROLE_LABELS).map(([v, l]) => ({ value: v, label: l }))} value={form.role} onChange={(v) => setForm({ ...form, role: (v as Role) ?? 'viewer' })} />
            <MultiSelect
              label="Limita alle zone"
              description="Vuoto = tutti i controller. Vale per apertura porte e sincronizzazione."
              data={treeOptions(zones.data)}
              value={form.zoneIds}
              onChange={(v) => setForm({ ...form, zoneIds: v })}
            />
            <PasswordInput
              label={form.id ? 'Nuova password (opzionale)' : 'Password (opzionale)'}
              description="Se vuota viene generata una password temporanea"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
            />
            <Switch label="Attivo" checked={form.active} onChange={(e) => setForm({ ...form, active: e.currentTarget.checked })} />
            <Button onClick={() => void save()} disabled={!form.username || !form.displayName}>
              Salva
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
