import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconEdit, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, PageHeader, WeekdaysInput } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, fmtDate, today } from '../lib/format'
import { useTimeProfiles, type TimeProfile } from '../lib/queries'

type PushResult = { pushErrors: { controllerId: number; error: string }[] }

export function TimeProfilesPage() {
  const { t } = useTranslation()
  const codes = useCodes()
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
      const r = await api.put<PushResult>(`/time-profiles/${id}`, body)
      notifyOk(t('timeProfiles.saved'))
      notifyPush(r)
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['time-profiles'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (p: TimeProfile) =>
    modals.openConfirmModal({
      title: t('timeProfiles.deleteTitle', { id: p.id }),
      children: <Text size="sm">{t('timeProfiles.deleteConfirm', { name: p.name })}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<PushResult>(`/time-profiles/${p.id}`)
          .then((r) => {
            notifyPush(r)
            void qc.invalidateQueries({ queryKey: ['time-profiles'] })
          })
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title={t('timeProfiles.title')}
        description={t('timeProfiles.description')}
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
              {t('timeProfiles.new')}
            </Button>
          )
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('timeProfiles.colId')}</Table.Th>
              <Table.Th>{t('timeProfiles.colName')}</Table.Th>
              <Table.Th>{t('timeProfiles.colDays')}</Table.Th>
              <Table.Th>{t('timeProfiles.colHours')}</Table.Th>
              <Table.Th>{t('timeProfiles.colValidity')}</Table.Th>
              <Table.Th>{t('timeProfiles.colLinked')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(profiles.data ?? []).map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>{p.id}</Table.Td>
                <Table.Td>{p.name}</Table.Td>
                <Table.Td>{codes.weekdaysText(p.weekdays)}</Table.Td>
                <Table.Td>{p.segments.map((s) => `${s.start}-${s.end}`).join(', ')}</Table.Td>
                <Table.Td>
                  {fmtDate(p.validFrom)} – {fmtDate(p.validTo)}
                </Table.Td>
                <Table.Td>{p.linkedTo ?? '—'}</Table.Td>
                <Table.Td>
                  {can('admin') && (
                    <Group gap={0} justify="flex-end">
                      <IconButton label={t('common.edit')} onClick={() => setEdit({ ...p, isNew: false })}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label={t('common.delete')} color="red" onClick={() => remove(p)}>
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
            {t('timeProfiles.none')}
          </Text>
        )}
      </Card>
      <Modal
        opened={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.isNew ? t('timeProfiles.newTitle') : t('timeProfiles.editTitle', { id: edit?.id })}
        size="lg"
      >
        {edit && (
          <Stack>
            <SimpleGrid cols={2}>
              <NumberInput
                label={t('timeProfiles.id')}
                min={2}
                max={254}
                value={edit.id}
                onChange={(v) => setEdit({ ...edit, id: Number(v) })}
                disabled={!edit.isNew}
              />
              <TextInput
                label={t('common.name')}
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })}
              />
              <DateInput
                label={t('timeProfiles.validFrom')}
                valueFormat={DATE_INPUT_FORMAT}
                value={edit.validFrom}
                onChange={(v) => v && setEdit({ ...edit, validFrom: v })}
              />
              <DateInput
                label={t('timeProfiles.validTo')}
                valueFormat={DATE_INPUT_FORMAT}
                value={edit.validTo}
                onChange={(v) => v && setEdit({ ...edit, validTo: v })}
              />
            </SimpleGrid>
            <WeekdaysInput
              label={t('common.days')}
              value={edit.weekdays}
              onChange={(w) => setEdit({ ...edit, weekdays: w })}
            />
            <Text size="sm" fw={500}>
              {t('timeProfiles.segments')}
            </Text>
            {edit.segments.map((s, i) => (
              <Group key={i}>
                <TextInput
                  placeholder="08:00"
                  value={s.start}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      segments: edit.segments.map((x, j) => (j === i ? { ...x, start: e.currentTarget.value } : x)),
                    })
                  }
                  w={100}
                />
                <Text>–</Text>
                <TextInput
                  placeholder="12:00"
                  value={s.end}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      segments: edit.segments.map((x, j) => (j === i ? { ...x, end: e.currentTarget.value } : x)),
                    })
                  }
                  w={100}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => setEdit({ ...edit, segments: edit.segments.filter((_, j) => j !== i) })}
                  aria-label={t('common.remove')}
                >
                  <IconX size={16} />
                </ActionIcon>
              </Group>
            ))}
            {edit.segments.length < 3 && (
              <Button
                variant="subtle"
                size="xs"
                w="fit-content"
                onClick={() => setEdit({ ...edit, segments: [...edit.segments, { start: '13:00', end: '17:00' }] })}
              >
                {t('timeProfiles.addSegment')}
              </Button>
            )}
            <Select
              label={t('timeProfiles.linkTo')}
              description={t('timeProfiles.linkHint')}
              clearable
              data={(profiles.data ?? [])
                .filter((p) => p.id !== edit.id)
                .map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` }))}
              value={edit.linkedTo ? String(edit.linkedTo) : null}
              onChange={(v) => setEdit({ ...edit, linkedTo: v ? Number(v) : null })}
            />
            <Alert variant="light">{t('timeProfiles.pushInfo')}</Alert>
            <Button onClick={() => void save()} disabled={!edit.name}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
