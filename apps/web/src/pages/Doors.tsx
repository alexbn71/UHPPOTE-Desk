import { Badge, Button, Card, Group, Modal, NumberInput, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { IconDoorEnter, IconEdit } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DoorDto } from '@uhppote-desk/shared'
import { DOOR_MODES } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'
import { openDoorWithConfirm } from './Dashboard'

export function DoorsPage() {
  const { t } = useTranslation()
  const codes = useCodes()
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
      if (r.pushError) notifyError(new Error(t('doors.savedNotSent', { error: r.pushError })))
      else notifyOk(t('doors.saved'))
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['controllers'] })
      void qc.invalidateQueries({ queryKey: ['doors'] })
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <>
      <PageHeader title={t('doors.title')} description={t('doors.description')} />
      {(controllers.data ?? []).map((c) => (
        <Card withBorder key={c.id} mb="md">
          <Text fw={700} mb="xs">
            {c.name}
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('doors.colNumber')}</Table.Th>
                <Table.Th>{t('doors.colName')}</Table.Th>
                <Table.Th>{t('doors.colMode')}</Table.Th>
                <Table.Th>{t('doors.colOpening')}</Table.Th>
                <Table.Th>{t('doors.colState')}</Table.Th>
                <Table.Th>{t('doors.colAttendance')}</Table.Th>
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
                    <Table.Td>{codes.doorMode(d.mode)}</Table.Td>
                    <Table.Td>{t('common.seconds', { n: d.delay })}</Table.Td>
                    <Table.Td>
                      {st ? (
                        <Badge color={st.open ? 'orange' : 'teal'} variant="light">
                          {st.open ? t('dashboard.doorOpen') : t('dashboard.doorClosed')}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </Table.Td>
                    <Table.Td>{d.attendance ? <Badge variant="light">{t('common.yes')}</Badge> : '—'}</Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end">
                        {can('operator') && d.active && (
                          <Button size="compact-xs" variant="light" leftSection={<IconDoorEnter size={14} />} onClick={() => openDoorWithConfirm(d)}>
                            {t('doors.open')}
                          </Button>
                        )}
                        {can('admin') && (
                          <IconButton label={t('common.edit')} onClick={() => setEdit(d)}>
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
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={t('doors.editTitle')}>
        {edit && (
          <Stack>
            <TextInput label={t('common.name')} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
            <Select
              label={t('doors.mode')}
              data={DOOR_MODES.map((m) => ({ value: String(m), label: codes.doorMode(m) }))}
              value={String(edit.mode)}
              onChange={(v) => setEdit({ ...edit, mode: Number(v) })}
            />
            <NumberInput label={t('doors.delay')} min={0} max={255} value={edit.delay} onChange={(v) => setEdit({ ...edit, delay: Number(v) || 0 })} />
            <Switch label={t('doors.activeSwitch')} checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.currentTarget.checked })} />
            <Switch label={t('doors.attendanceSwitch')} checked={edit.attendance} onChange={(e) => setEdit({ ...edit, attendance: e.currentTarget.checked })} />
            <Button onClick={() => void save()}>{t('controllerDetail.saveAndSend')}</Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
