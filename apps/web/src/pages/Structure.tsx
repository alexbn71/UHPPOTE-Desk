import { Button, Card, Group, Modal, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { treeOptions, treePath, useDepartments, useZones, type TreeNode } from '../lib/queries'

function TreeEditor({ title, description, endpoint, queryKey, nodes, canEdit }: { title: string; description: string; endpoint: string; queryKey: string; nodes: TreeNode[]; canEdit: boolean }) {
  const qc = useQueryClient()
  const [edit, setEdit] = useState<{ id: number | null; name: string; parentId: string | null } | null>(null)

  const save = async () => {
    if (!edit) return
    try {
      const body = { name: edit.name, parentId: edit.parentId ? Number(edit.parentId) : null }
      if (edit.id) await api.put(`${endpoint}/${edit.id}`, body)
      else await api.post(endpoint, body)
      setEdit(null)
      void qc.invalidateQueries({ queryKey: [queryKey] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (n: TreeNode) =>
    modals.openConfirmModal({
      title: `Elimina «${n.name}»`,
      children: <Text size="sm">Verranno eliminati anche gli eventuali sotto-elementi.</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`${endpoint}/${n.id}`)
          .then(() => qc.invalidateQueries({ queryKey: [queryKey] }))
          .catch(notifyError),
    })

  const sorted = [...nodes].sort((a, b) => treePath(nodes, a.id).localeCompare(treePath(nodes, b.id)))

  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <div>
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        </div>
        {canEdit && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit({ id: null, name: '', parentId: null })}>
            Aggiungi
          </Button>
        )}
      </Group>
      <Table>
        <Table.Tbody>
          {sorted.map((n) => (
            <Table.Tr key={n.id}>
              <Table.Td>{treePath(nodes, n.id)}</Table.Td>
              <Table.Td w={80}>
                {canEdit && (
                  <Group gap={0} justify="flex-end">
                    <IconButton label="Modifica" onClick={() => setEdit({ id: n.id, name: n.name, parentId: n.parentId ? String(n.parentId) : null })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label="Elimina" color="red" onClick={() => remove(n)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {nodes.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" py="md">
          Nessun elemento
        </Text>
      )}
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Modifica' : 'Nuovo'}>
        {edit && (
          <Stack>
            <TextInput label="Nome" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })} autoFocus />
            <Select
              label="Appartiene a"
              clearable
              data={treeOptions(nodes).filter((o) => o.value !== String(edit.id))}
              value={edit.parentId}
              onChange={(v) => setEdit({ ...edit, parentId: v })}
            />
            <Button onClick={() => void save()} disabled={!edit.name.trim()}>
              Salva
            </Button>
          </Stack>
        )}
      </Modal>
    </Card>
  )
}

export function StructurePage() {
  const { can } = useAuth()
  const departments = useDepartments()
  const zones = useZones()
  return (
    <>
      <PageHeader title="Reparti e zone" />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <TreeEditor
          title="Reparti"
          description="Organizzazione del personale (usata per filtri e report presenze)"
          endpoint="/departments"
          queryKey="departments"
          nodes={departments.data ?? []}
          canEdit={can('operator')}
        />
        <TreeEditor
          title="Zone"
          description="Raggruppamento dei controller; gli operatori possono essere limitati a specifiche zone"
          endpoint="/zones"
          queryKey="zones"
          nodes={zones.data ?? []}
          canEdit={can('admin')}
        />
      </SimpleGrid>
    </>
  )
}
