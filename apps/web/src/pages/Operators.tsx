import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconEdit, IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OperatorDto, Role } from '@uhppote-desk/shared'
import { ROLES } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError } from '../lib/api'
import { useCodes } from '../lib/codes'
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
  const { t } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const zones = useZones()
  const operators = useQuery({ queryKey: ['operators'], queryFn: () => api.get<OperatorDto[]>('/operators') })
  const [form, setForm] = useState<Form | null>(null)
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null)

  const save = async () => {
    if (!form) return
    try {
      const body = {
        username: form.username,
        displayName: form.displayName,
        role: form.role,
        active: form.active,
        password: form.password || undefined,
        zoneIds: form.zoneIds.map(Number),
      }
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
      title: t('operators.resetTitle', { user: o.username }),
      children: <Text size="sm">{t('operators.resetInfo')}</Text>,
      labels: { confirm: t('operators.resetPassword'), cancel: t('common.cancel') },
      onConfirm: () =>
        api
          .post<{ password: string }>(`/operators/${o.id}/reset-password`)
          .then((r) => setGenerated({ username: o.username, password: r.password }))
          .catch(notifyError),
    })

  const remove = (o: OperatorDto) =>
    modals.openConfirmModal({
      title: t('operators.deleteTitle', { user: o.username }),
      children: <Text size="sm">{t('operators.deleteInfo')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
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
        title={t('operators.title')}
        description={t('operators.description')}
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() =>
              setForm({ username: '', displayName: '', role: 'operator', active: true, password: '', zoneIds: [] })
            }
          >
            {t('operators.new')}
          </Button>
        }
      />
      {generated && (
        <Alert
          color="blue"
          withCloseButton
          onClose={() => setGenerated(null)}
          mb="md"
          title={t('operators.tempPasswordTitle')}
        >
          <Code>{t('operators.tempPassword', { user: generated.username, password: generated.password })}</Code>
        </Alert>
      )}
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('operators.colUser')}</Table.Th>
              <Table.Th>{t('operators.colName')}</Table.Th>
              <Table.Th>{t('operators.colRole')}</Table.Th>
              <Table.Th>{t('operators.colZones')}</Table.Th>
              <Table.Th>{t('operators.colLastLogin')}</Table.Th>
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
                    {codes.role(o.role)}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {o.zoneIds.length
                    ? o.zoneIds.map((z) => zones.data?.find((x) => x.id === z)?.name ?? z).join(', ')
                    : t('operators.allZones')}
                </Table.Td>
                <Table.Td>{fmtDateTime(o.lastLoginAt)}</Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end">
                    <IconButton
                      label={t('common.edit')}
                      onClick={() => setForm({ ...o, password: '', zoneIds: o.zoneIds.map(String) })}
                    >
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label={t('operators.resetPassword')} onClick={() => resetPassword(o)}>
                      <IconKey size={16} />
                    </IconButton>
                    <IconButton label={t('common.delete')} color="red" onClick={() => remove(o)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Modal
        opened={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t('operators.editTitle') : t('operators.newTitle')}
      >
        {form && (
          <Stack>
            <TextInput
              label={t('operators.username')}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.currentTarget.value })}
            />
            <TextInput
              label={t('operators.displayName')}
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.currentTarget.value })}
            />
            <Select
              label={t('operators.role')}
              data={ROLES.map((r) => ({ value: r, label: codes.role(r) }))}
              value={form.role}
              onChange={(v) => setForm({ ...form, role: (v as Role) ?? 'viewer' })}
            />
            <MultiSelect
              label={t('operators.zones')}
              description={t('operators.zonesHint')}
              data={treeOptions(zones.data)}
              value={form.zoneIds}
              onChange={(v) => setForm({ ...form, zoneIds: v })}
            />
            <PasswordInput
              label={form.id ? t('operators.passwordNew') : t('operators.passwordOptional')}
              description={t('operators.passwordHint')}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
            />
            <Switch
              label={t('operators.activeSwitch')}
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.currentTarget.checked })}
            />
            <Button onClick={() => void save()} disabled={!form.username || !form.displayName}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
