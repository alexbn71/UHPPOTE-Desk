import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TASK_TYPES } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, fmtDate, today } from '../lib/format'
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

type TaskForm = Omit<Task, 'id'> & { id?: number }

export function TasksPage() {
  const { t } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const { can } = useAuth()
  const controllers = useControllers()
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<Task[]>('/tasks') })
  const [edit, setEdit] = useState<TaskForm | null>(null)
  const ctrlName = (id: number) => controllers.data?.find((c) => c.id === id)?.name ?? `#${id}`

  const save = async () => {
    if (!edit) return
    try {
      const { id, ...body } = edit
      const r = id
        ? await api.put<{ pushError: string | null }>(`/tasks/${id}`, body)
        : await api.post<{ pushError: string | null }>('/tasks', body)
      if (r.pushError) notifyError(new Error(t('tasks.savedNotSent', { error: r.pushError })))
      else notifyOk(t('tasks.saved'))
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (task: Task) =>
    modals.openConfirmModal({
      title: t('tasks.deleteTitle'),
      children: (
        <Text size="sm">{t('tasks.deleteConfirm', { task: codes.task(task.task), time: task.startTime })}</Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/tasks/${task.id}`)
          .then(() => qc.invalidateQueries({ queryKey: ['tasks'] }))
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title={t('tasks.title')}
        description={t('tasks.description')}
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
              {t('tasks.new')}
            </Button>
          )
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('tasks.colController')}</Table.Th>
              <Table.Th>{t('tasks.colDoor')}</Table.Th>
              <Table.Th>{t('tasks.colTime')}</Table.Th>
              <Table.Th>{t('tasks.colAction')}</Table.Th>
              <Table.Th>{t('tasks.colDays')}</Table.Th>
              <Table.Th>{t('tasks.colValidity')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(tasks.data ?? []).map((task) => (
              <Table.Tr key={task.id} opacity={task.enabled ? 1 : 0.5}>
                <Table.Td>{ctrlName(task.controllerId)}</Table.Td>
                <Table.Td>{task.door}</Table.Td>
                <Table.Td className="mono">{task.startTime}</Table.Td>
                <Table.Td>
                  {codes.task(task.task)} {!task.enabled && <Badge color="gray">{t('tasks.disabled')}</Badge>}
                </Table.Td>
                <Table.Td>{codes.weekdaysText(task.weekdays)}</Table.Td>
                <Table.Td>
                  {fmtDate(task.validFrom)} – {fmtDate(task.validTo)}
                </Table.Td>
                <Table.Td>
                  {can('admin') && (
                    <Group gap={0} justify="flex-end">
                      <IconButton label={t('common.edit')} onClick={() => setEdit(task)}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label={t('common.delete')} color="red" onClick={() => remove(task)}>
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
            {t('tasks.none')}
          </Text>
        )}
      </Card>
      <Modal
        opened={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? t('tasks.editTitle') : t('tasks.newTitle')}
      >
        {edit && (
          <Stack>
            <SimpleGrid cols={2}>
              <Select
                label={t('common.controller')}
                data={(controllers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                value={String(edit.controllerId)}
                onChange={(v) => setEdit({ ...edit, controllerId: Number(v) })}
              />
              <Select
                label={t('common.door')}
                data={['1', '2', '3', '4']}
                value={String(edit.door)}
                onChange={(v) => setEdit({ ...edit, door: Number(v) })}
              />
            </SimpleGrid>
            <Select
              label={t('tasks.action')}
              data={TASK_TYPES.map((v) => ({ value: String(v), label: codes.task(v) }))}
              value={String(edit.task)}
              onChange={(v) => setEdit({ ...edit, task: Number(v) })}
            />
            {edit.task === 8 && (
              <NumberInput
                label={t('tasks.moreCards')}
                min={0}
                max={255}
                value={edit.moreCards}
                onChange={(v) => setEdit({ ...edit, moreCards: Number(v) || 0 })}
              />
            )}
            <TextInput
              label={t('tasks.startTime')}
              value={edit.startTime}
              onChange={(e) => setEdit({ ...edit, startTime: e.currentTarget.value })}
              w={200}
            />
            <WeekdaysInput
              label={t('common.days')}
              value={edit.weekdays}
              onChange={(w) => setEdit({ ...edit, weekdays: w })}
            />
            <SimpleGrid cols={2}>
              <DateInput
                label={t('common.from')}
                valueFormat={DATE_INPUT_FORMAT}
                value={edit.validFrom}
                onChange={(v) => v && setEdit({ ...edit, validFrom: v })}
              />
              <DateInput
                label={t('common.to')}
                valueFormat={DATE_INPUT_FORMAT}
                value={edit.validTo}
                onChange={(v) => v && setEdit({ ...edit, validTo: v })}
              />
            </SimpleGrid>
            <Switch
              label={t('tasks.activeSwitch')}
              checked={edit.enabled}
              onChange={(e) => setEdit({ ...edit, enabled: e.currentTarget.checked })}
            />
            <Button onClick={() => void save()}>{t('tasks.saveAndSend')}</Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
