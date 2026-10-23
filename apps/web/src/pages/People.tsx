import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  FileButton,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { useDebouncedValue } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { IconFileImport, IconPhoto, IconPlus, IconSearch, IconTrash, IconUser } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PersonDto } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { PlatesEditor } from '../components/PlatesEditor'
import i18n from '../i18n'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, addDays, cardLabel, fmtDate, isValidCard, today } from '../lib/format'
import {
  treeOptions,
  useControllers,
  useDepartments,
  useShifts,
  useTimeProfiles,
  type Permission,
} from '../lib/queries'

type PersonForm = Omit<PersonDto, 'id' | 'departmentName' | 'hasPhoto' | 'cards'>
type PushResult = { pushErrors: { controllerId: number; error: string }[] }

const emptyPerson = (): PersonForm => ({
  code: '',
  firstName: '',
  lastName: '',
  departmentId: null,
  email: '',
  phone: '',
  notes: '',
  pin: 0,
  validFrom: today(),
  validTo: addDays(today(), 3650),
  active: true,
  shiftId: null,
})

function PermissionsEditor({ personId, readOnly }: { personId: number; readOnly: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const controllers = useControllers()
  const profiles = useTimeProfiles()
  const person = useQuery({
    queryKey: ['person', personId],
    queryFn: () => api.get<PersonDto & { permissions: Permission[] }>(`/people/${personId}`),
  })
  const [perms, setPerms] = useState<Map<number, Permission>>(new Map())
  const [busy, setBusy] = useState(false)
  const controllerName = (id: number) => controllers.data?.find((c) => c.id === id)?.name ?? `#${id}`

  useEffect(() => {
    if (person.data) setPerms(new Map(person.data.permissions.map((p) => [p.doorId, p])))
  }, [person.data])

  const profileOptions = [
    { value: 'always', label: t('people.permAlways') },
    ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` })),
  ]

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.put<PushResult>(`/people/${personId}/permissions`, {
        permissions: [...perms.values()].map((p) => ({
          doorId: p.doorId,
          profileId: p.profileId,
          firstCard: p.firstCard,
        })),
      })
      notifyOk(t('people.permissionsSaved'))
      notifyPush(r, controllerName)
      void qc.invalidateQueries({ queryKey: ['person', personId] })
      void qc.invalidateQueries({ queryKey: ['permissions'] })
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack>
      {(controllers.data ?? []).map((c) => (
        <Card withBorder key={c.id} padding="sm">
          <Text fw={600} mb="xs">
            {c.name}
          </Text>
          <Table>
            <Table.Tbody>
              {c.doors.map((d) => {
                const p = perms.get(d.id)
                return (
                  <Table.Tr key={d.id}>
                    <Table.Td>
                      <Checkbox
                        label={d.name}
                        checked={!!p}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = new Map(perms)
                          if (e.currentTarget.checked)
                            next.set(d.id, { personId, doorId: d.id, profileId: null, firstCard: false })
                          else next.delete(d.id)
                          setPerms(next)
                        }}
                      />
                    </Table.Td>
                    <Table.Td w={220}>
                      {p && (
                        <Select
                          size="xs"
                          data={profileOptions}
                          value={p.profileId === null ? 'always' : String(p.profileId)}
                          disabled={readOnly}
                          onChange={(v) =>
                            setPerms(
                              new Map(perms).set(d.id, { ...p, profileId: !v || v === 'always' ? null : Number(v) }),
                            )
                          }
                        />
                      )}
                    </Table.Td>
                    <Table.Td w={140}>
                      {p && (
                        <Checkbox
                          size="xs"
                          label={t('people.firstCard')}
                          checked={p.firstCard}
                          disabled={readOnly}
                          onChange={(e) =>
                            setPerms(new Map(perms).set(d.id, { ...p, firstCard: e.currentTarget.checked }))
                          }
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Card>
      ))}
      {!readOnly && (
        <Button onClick={save} loading={busy}>
          {t('people.savePermissions')}
        </Button>
      )}
    </Stack>
  )
}

function CardsEditor({ person, readOnly, onChange }: { person: PersonDto; readOnly: boolean; onChange: () => void }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const [number, setNumber] = useState<number | string>('')
  const unknown = useQuery({
    queryKey: ['cards-unknown'],
    queryFn: () => api.get<{ card: number; timestamp: string }[]>('/cards/unknown?minutes=10'),
    refetchInterval: 3000,
    enabled: !readOnly,
  })

  const add = async (n: number) => {
    try {
      const r = await api.post<PushResult>('/cards', { number: n, personId: person.id })
      notifyOk(t('people.cardAssigned', { n }))
      notifyPush(r)
      setNumber('')
      onChange()
    } catch (err) {
      notifyError(err)
    }
  }

  const replace = (cardId: number, old: number) => {
    let value = ''
    modals.openConfirmModal({
      title: i18n.t('people.replaceTitle', { n: old }),
      children: (
        <Stack>
          <Text size="sm">{i18n.t('people.replaceInfo')}</Text>
          <TextInput label={i18n.t('people.replaceNewNumber')} onChange={(e) => (value = e.currentTarget.value)} />
        </Stack>
      ),
      labels: { confirm: i18n.t('people.replaceConfirm'), cancel: i18n.t('common.cancel') },
      onConfirm: () =>
        api
          .post<PushResult>(`/cards/${cardId}/replace`, { newNumber: Number(value) })
          .then((r) => {
            notifyOk(i18n.t('people.replaced'))
            notifyPush(r)
            onChange()
          })
          .catch(notifyError),
    })
  }

  const remove = (cardId: number, n: number) =>
    modals.openConfirmModal({
      title: i18n.t('people.deleteCardTitle'),
      children: <Text size="sm">{i18n.t('people.deleteCardConfirm', { n })}</Text>,
      labels: { confirm: i18n.t('common.delete'), cancel: i18n.t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<PushResult>(`/cards/${cardId}`)
          .then((r) => {
            notifyPush(r)
            onChange()
          })
          .catch(notifyError),
    })

  return (
    <Stack>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('people.cardNumberCol')}</Table.Th>
            <Table.Th>{t('people.cardStatusCol')}</Table.Th>
            <Table.Th>{t('people.cardSinceCol')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {person.cards.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td className="mono">{cardLabel(c.number)}</Table.Td>
              <Table.Td>
                <Badge color={c.status === 'active' ? 'green' : c.status === 'lost' ? 'red' : 'gray'} variant="light">
                  {codes.cardStatus(c.status)}
                </Badge>
              </Table.Td>
              <Table.Td>{fmtDate(c.createdAt)}</Table.Td>
              <Table.Td>
                {!readOnly && (
                  <Group gap={4} justify="flex-end">
                    {c.status === 'active' && (
                      <Button size="compact-xs" variant="light" color="orange" onClick={() => replace(c.id, c.number)}>
                        {t('people.lostButton')}
                      </Button>
                    )}
                    <IconButton label={t('common.delete')} color="red" onClick={() => remove(c.id, c.number)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {!readOnly && (
        <>
          <Group align="flex-end">
            <NumberInput
              label={t('people.addCard')}
              description={t('people.addCardHint')}
              value={number}
              onChange={setNumber}
              hideControls
              allowDecimal={false}
              w={260}
            />
            <Button disabled={!number} onClick={() => void add(Number(number))}>
              {t('common.add')}
            </Button>
          </Group>
          <Alert variant="light" title={t('people.readerTitle')}>
            {t('people.readerHint')}
            <Group gap="xs" mt="xs">
              {(unknown.data ?? []).map((u) =>
                isValidCard(u.card) ? (
                  <Button key={u.card} size="compact-sm" variant="outline" onClick={() => void add(u.card)}>
                    {cardLabel(u.card)}
                  </Button>
                ) : (
                  <Tooltip key={u.card} label={t('errors.invalidCardNumber')} multiline w={260}>
                    <Button
                      size="compact-sm"
                      variant="outline"
                      color="gray"
                      data-disabled
                      onClick={(e) => e.preventDefault()}
                    >
                      {cardLabel(u.card)}
                    </Button>
                  </Tooltip>
                ),
              )}
              {unknown.data?.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('people.readerNone')}
                </Text>
              )}
            </Group>
          </Alert>
        </>
      )}
    </Stack>
  )
}

function PersonDrawer({ person, opened, onClose }: { person: PersonDto | null; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = useAuth()
  const readOnly = !can('operator')
  const departments = useDepartments()
  const shifts = useShifts()
  const [form, setForm] = useState<PersonForm>(emptyPerson())
  const [busy, setBusy] = useState(false)
  const [photoKey, setPhotoKey] = useState(0)
  const current = useQuery({
    queryKey: ['person', person?.id],
    queryFn: () => api.get<PersonDto>(`/people/${person!.id}`),
    enabled: !!person,
  })

  useEffect(() => {
    if (!opened) return
    if (person) {
      const { id: _id, departmentName: _d, hasPhoto: _h, cards: _c, ...rest } = person
      setForm(rest)
    } else setForm(emptyPerson())
  }, [person, opened])

  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['people'] })
    void qc.invalidateQueries({ queryKey: ['person', person?.id] })
  }

  const save = async () => {
    setBusy(true)
    try {
      if (person) {
        const r = await api.put<PushResult>(`/people/${person.id}`, form)
        notifyPush(r)
        notifyOk(t('people.updated'))
      } else {
        await api.post('/people', form)
        notifyOk(t('people.created'))
      }
      refresh()
      if (!person) onClose()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const uploadPhoto = async (file: File | null) => {
    if (!file || !person) return
    try {
      await api.upload(`/people/${person.id}/photo`, file, 'PUT')
      setPhotoKey((k) => k + 1)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const p = current.data ?? person
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={person ? `${person.lastName} ${person.firstName}` : t('people.new')}
    >
      <Tabs defaultValue="details">
        <Tabs.List mb="md">
          <Tabs.Tab value="details">{t('people.tabDetails')}</Tabs.Tab>
          <Tabs.Tab value="cards" disabled={!person}>
            {p ? t('people.tabCardsN', { n: p.cards.length }) : t('people.tabCards')}
          </Tabs.Tab>
          <Tabs.Tab value="permissions" disabled={!person}>
            {t('people.tabPermissions')}
          </Tabs.Tab>
          <Tabs.Tab value="plates" disabled={!person}>
            {t('people.tabPlates')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="details">
          <Stack>
            {person && (
              <Group>
                <Avatar src={p?.hasPhoto ? `/api/people/${person.id}/photo?k=${photoKey}` : null} size={96} radius="md">
                  <IconUser size={48} />
                </Avatar>
                {!readOnly && (
                  <FileButton onChange={(f) => void uploadPhoto(f)} accept="image/jpeg,image/png,image/webp">
                    {(props) => (
                      <Button {...props} variant="light" leftSection={<IconPhoto size={16} />}>
                        {t('people.uploadPhoto')}
                      </Button>
                    )}
                  </FileButton>
                )}
              </Group>
            )}
            <SimpleGrid cols={2}>
              <TextInput
                label={t('people.code')}
                required
                value={form.code}
                onChange={(e) => set('code', e.currentTarget.value)}
                readOnly={readOnly}
              />
              <Select
                label={t('people.department')}
                clearable
                searchable
                data={treeOptions(departments.data)}
                value={form.departmentId ? String(form.departmentId) : null}
                onChange={(v) => set('departmentId', v ? Number(v) : null)}
                readOnly={readOnly}
              />
              <TextInput
                label={t('people.lastName')}
                required
                value={form.lastName}
                onChange={(e) => set('lastName', e.currentTarget.value)}
                readOnly={readOnly}
              />
              <TextInput
                label={t('people.firstName')}
                value={form.firstName}
                onChange={(e) => set('firstName', e.currentTarget.value)}
                readOnly={readOnly}
              />
              <TextInput
                label={t('people.email')}
                value={form.email}
                onChange={(e) => set('email', e.currentTarget.value)}
                readOnly={readOnly}
              />
              <TextInput
                label={t('people.phone')}
                value={form.phone}
                onChange={(e) => set('phone', e.currentTarget.value)}
                readOnly={readOnly}
              />
              <DateInput
                label={t('people.validFrom')}
                valueFormat={DATE_INPUT_FORMAT}
                value={form.validFrom}
                onChange={(v) => v && set('validFrom', v)}
                readOnly={readOnly}
              />
              <DateInput
                label={t('people.validTo')}
                valueFormat={DATE_INPUT_FORMAT}
                value={form.validTo}
                onChange={(v) => v && set('validTo', v)}
                readOnly={readOnly}
              />
              <NumberInput
                label={t('people.pin')}
                description={t('people.pinHint')}
                min={0}
                max={999999}
                value={form.pin}
                onChange={(v) => set('pin', Number(v) || 0)}
                readOnly={readOnly}
                hideControls
              />
              <Select
                label={t('people.shift')}
                clearable
                data={(shifts.data ?? []).map((s) => ({
                  value: String(s.id),
                  label: `${s.name} (${s.startTime}-${s.endTime})`,
                }))}
                value={form.shiftId ? String(form.shiftId) : null}
                onChange={(v) => set('shiftId', v ? Number(v) : null)}
                readOnly={readOnly}
              />
            </SimpleGrid>
            <Textarea
              label={t('people.notes')}
              value={form.notes}
              onChange={(e) => set('notes', e.currentTarget.value)}
              readOnly={readOnly}
              autosize
              minRows={2}
            />
            <Switch
              label={t('people.activeSwitch')}
              checked={form.active}
              onChange={(e) => set('active', e.currentTarget.checked)}
              disabled={readOnly}
            />
            {!readOnly && (
              <Button onClick={save} loading={busy}>
                {person ? t('people.saveChanges') : t('people.create')}
              </Button>
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="cards">{p && <CardsEditor person={p} readOnly={readOnly} onChange={refresh} />}</Tabs.Panel>
        <Tabs.Panel value="permissions">
          {person && <PermissionsEditor personId={person.id} readOnly={readOnly} />}
        </Tabs.Panel>
        <Tabs.Panel value="plates">{person && <PlatesEditor personId={person.id} readOnly={readOnly} />}</Tabs.Panel>
      </Tabs>
    </Drawer>
  )
}

export function PeoplePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = useAuth()
  const [search, setSearch] = useState('')
  const [debounced] = useDebouncedValue(search, 300)
  const people = useQuery({
    queryKey: ['people', debounced],
    queryFn: () => api.get<PersonDto[]>(`/people${debounced ? `?search=${encodeURIComponent(debounced)}` : ''}`),
  })
  const [selected, setSelected] = useState<PersonDto | null>(null)
  const [opened, setOpened] = useState(false)

  const importCsv = async (file: File | null) => {
    if (!file) return
    try {
      const r = await api.upload<{
        created: number
        updated: number
        cards: number
        errors: { row: number; error: string; code?: string; params?: Record<string, string | number> }[]
      }>('/people/import', file)
      modals.open({
        title: t('people.importResult'),
        children: (
          <Stack>
            <Text>{t('people.importSummary', { created: r.created, updated: r.updated, cards: r.cards })}</Text>
            {r.errors.length > 0 && (
              <Alert color="orange" title={t('people.importErrors', { n: r.errors.length })}>
                {r.errors.slice(0, 20).map((e) => (
                  <Text size="sm" key={e.row}>
                    {t('people.importRow', {
                      row: e.row,
                      error: e.code
                        ? t(`errors.${e.code}` as 'errors.generic', { ...e.params, defaultValue: e.error })
                        : e.error,
                    })}
                  </Text>
                ))}
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              {t('people.importHint')}
            </Text>
          </Stack>
        ),
      })
      void qc.invalidateQueries({ queryKey: ['people'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (p: PersonDto) =>
    modals.openConfirmModal({
      title: t('people.deleteTitle'),
      children: <Text size="sm">{t('people.deleteConfirm', { name: `${p.lastName} ${p.firstName}`.trim() })}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<PushResult>(`/people/${p.id}`)
          .then((r) => {
            notifyPush(r)
            void qc.invalidateQueries({ queryKey: ['people'] })
          })
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title={t('people.title')}
        description={t('people.description')}
        actions={
          can('operator') && (
            <>
              <FileButton onChange={(f) => void importCsv(f)} accept=".csv,text/csv">
                {(props) => (
                  <Button {...props} variant="default" leftSection={<IconFileImport size={16} />}>
                    {t('people.importCsv')}
                  </Button>
                )}
              </FileButton>
              <Button
                leftSection={<IconPlus size={16} />}
                onClick={() => {
                  setSelected(null)
                  setOpened(true)
                }}
              >
                {t('people.new')}
              </Button>
            </>
          )
        }
      />
      <Card withBorder>
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t('people.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          mb="md"
        />
        <Table.ScrollContainer minWidth={700}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('people.colCode')}</Table.Th>
                <Table.Th>{t('people.colName')}</Table.Th>
                <Table.Th>{t('people.colDepartment')}</Table.Th>
                <Table.Th>{t('people.colCards')}</Table.Th>
                <Table.Th>{t('people.colValidity')}</Table.Th>
                <Table.Th>{t('people.colStatus')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(people.data ?? []).map((p) => (
                <Table.Tr
                  key={p.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSelected(p)
                    setOpened(true)
                  }}
                >
                  <Table.Td className="mono">{p.code}</Table.Td>
                  <Table.Td>
                    {p.lastName} {p.firstName}
                  </Table.Td>
                  <Table.Td>{p.departmentName ?? '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {p.cards.map((c) => (
                        <Badge
                          key={c.id}
                          variant="light"
                          color={c.status === 'active' ? 'blue' : 'gray'}
                          className="mono"
                        >
                          {c.number}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {fmtDate(p.validFrom)} – {fmtDate(p.validTo)}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={p.active ? 'green' : 'gray'} variant="light">
                      {p.active ? t('people.active') : t('people.inactive')}
                    </Badge>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    {can('operator') && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => remove(p)}
                        aria-label={t('common.delete')}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {people.data?.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            {t('people.none')}
          </Text>
        )}
      </Card>
      <PersonDrawer person={selected} opened={opened} onClose={() => setOpened(false)} />
    </>
  )
}
