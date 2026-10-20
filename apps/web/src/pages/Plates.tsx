import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Image,
  Modal,
  NumberInput,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { IconCopy, IconEdit, IconKey, IconPhoto, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PlateDto, PlateReadDto, PlateReaderDto, PlateReaderKeyDto } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, qs } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate, fmtDateTime } from '../lib/format'
import { useDoors } from '../lib/queries'

/** Licence plates: readings with photos, the plates of people and guests, the cameras (administrators). */
export function PlatesPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  return (
    <>
      <PageHeader title={t('plates.title')} description={t('plates.description')} />
      <Tabs defaultValue="reads" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="reads">{t('plates.tabReads')}</Tabs.Tab>
          <Tabs.Tab value="plates">{t('plates.tabPlates')}</Tabs.Tab>
          {can('admin') && <Tabs.Tab value="readers">{t('plates.tabReaders')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="reads">
          <ReadsTab />
        </Tabs.Panel>
        <Tabs.Panel value="plates">
          <PlatesTab />
        </Tabs.Panel>
        {can('admin') && (
          <Tabs.Panel value="readers">
            <ReadersTab />
          </Tabs.Panel>
        )}
      </Tabs>
      <Text size="xs" c="dimmed" mt="xs">
        {t('plates.docs')}
      </Text>
    </>
  )
}

const PAGE = 50

function OutcomeBadge({ r }: { r: PlateReadDto }) {
  const { t } = useTranslation()
  return (
    <Stack gap={2}>
      <Badge variant="light" color={r.outcome === 'granted' ? 'green' : r.outcome === 'error' ? 'orange' : 'red'}>
        {t(`codes.plateOutcome.${r.outcome}`)}
      </Badge>
      {r.outcome === 'granted' && !r.opened && (
        <Text size="xs" c="dimmed">
          {t('plates.notOpened')}
        </Text>
      )}
    </Stack>
  )
}

function ReadsTab() {
  const { t } = useTranslation()
  const [outcome, setOutcome] = useState<'all' | 'granted' | 'denied'>('all')
  const [search, setSearch] = useState('')
  const [debounced] = useDebouncedValue(search, 300)
  const [page, setPage] = useState(1)
  const [photo, setPhoto] = useState<PlateReadDto | null>(null)
  const reads = useQuery({
    queryKey: ['plate-reads', outcome, debounced, page],
    queryFn: () =>
      api.get<{ rows: PlateReadDto[]; total: number }>(
        `/plates/reads${qs({
          outcome: outcome === 'all' ? null : outcome,
          search: debounced,
          limit: PAGE,
          offset: (page - 1) * PAGE,
        })}`,
      ),
    refetchInterval: 10_000,
  })

  return (
    <>
      <Group mb="md">
        <SegmentedControl
          value={outcome}
          onChange={(v) => {
            setOutcome(v as typeof outcome)
            setPage(1)
          }}
          data={[
            { value: 'all', label: t('plates.filterAll') },
            { value: 'granted', label: t('plates.filterGranted') },
            { value: 'denied', label: t('plates.filterDenied') },
          ]}
        />
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t('plates.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value)
            setPage(1)
          }}
        />
      </Group>
      <Card withBorder>
        <Table.ScrollContainer minWidth={800}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('plates.colPhoto')}</Table.Th>
                <Table.Th>{t('plates.colAt')}</Table.Th>
                <Table.Th>{t('plates.colPlate')}</Table.Th>
                <Table.Th>{t('plates.colOwner')}</Table.Th>
                <Table.Th>{t('plates.colOutcome')}</Table.Th>
                <Table.Th>{t('plates.colReader')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {reads.data?.rows.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text size="sm" c="dimmed">
                      {t('plates.noReads')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {(reads.data?.rows ?? []).map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td w={112}>
                    {r.hasPhoto ? (
                      <UnstyledButton onClick={() => setPhoto(r)} aria-label={t('plates.colPhoto')}>
                        <Image src={`/api/plates/reads/${r.id}/photo`} w={96} h={54} radius="sm" fit="cover" alt="" />
                      </UnstyledButton>
                    ) : (
                      <IconPhoto size={20} color="var(--mantine-color-dimmed)" />
                    )}
                  </Table.Td>
                  <Table.Td>{fmtDateTime(r.at)}</Table.Td>
                  <Table.Td>
                    <Text className="mono" fw={600}>
                      {r.plate}
                    </Text>
                    {r.raw !== r.plate && (
                      <Text size="xs" c="dimmed">
                        {t('plates.raw', { raw: r.raw })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {r.ownerName ? (
                      r.guestPassId ? (
                        t('plates.ownerGuest', { name: r.ownerName })
                      ) : (
                        r.ownerName
                      )
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <OutcomeBadge r={r} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{r.readerName}</Text>
                    {r.doorName && (
                      <Text size="xs" c="dimmed">
                        {r.doorName}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Group justify="center" mt="md">
        <Pagination total={Math.max(1, Math.ceil((reads.data?.total ?? 0) / PAGE))} value={page} onChange={setPage} />
      </Group>
      <Modal
        opened={!!photo}
        onClose={() => setPhoto(null)}
        size="xl"
        title={photo ? t('plates.photoTitle', { plate: photo.plate, time: fmtDateTime(photo.at) }) : ''}
      >
        {photo && <Image src={`/api/plates/reads/${photo.id}/photo`} alt={photo.plate} radius="sm" />}
      </Modal>
    </>
  )
}

function PlatesTab() {
  const { t } = useTranslation()
  const plates = useQuery({ queryKey: ['plates'], queryFn: () => api.get<PlateDto[]>('/plates') })
  return (
    <Card withBorder>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('plates.colPlate')}</Table.Th>
            <Table.Th>{t('plates.colOwner')}</Table.Th>
            <Table.Th>{t('plates.colNote')}</Table.Th>
            <Table.Th>{t('people.cardSinceCol')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {plates.data?.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text size="sm" c="dimmed">
                  {t('plates.noPlates')}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {(plates.data ?? []).map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td className="mono">{p.plate}</Table.Td>
              <Table.Td>{p.personName ?? (p.guestName ? t('plates.ownerGuest', { name: p.guestName }) : '—')}</Table.Td>
              <Table.Td>{p.note}</Table.Td>
              <Table.Td>{fmtDate(p.createdAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

interface ReaderForm {
  id?: number
  name: string
  doorId: string | null
  snapshotUrl: string
  debounceSeconds: number
  openDoor: boolean
  enabled: boolean
}

function ReadersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const doors = useDoors()
  const readers = useQuery({ queryKey: ['plate-readers'], queryFn: () => api.get<PlateReaderDto[]>('/plate-readers') })
  const [form, setForm] = useState<ReaderForm | null>(null)
  const [created, setCreated] = useState<PlateReaderKeyDto | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['plate-readers'] })
  const doorName = (id: number) => doors.data?.find((d) => d.id === id)?.name ?? `#${id}`

  const save = async () => {
    if (!form?.doorId) return
    try {
      const body = {
        name: form.name,
        doorId: Number(form.doorId),
        snapshotUrl: form.snapshotUrl.trim(),
        debounceSeconds: form.debounceSeconds,
        openDoor: form.openDoor,
        enabled: form.enabled,
      }
      if (form.id) await api.put(`/plate-readers/${form.id}`, body)
      else setCreated(await api.post<PlateReaderKeyDto>('/plate-readers', body))
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const confirm = (title: string, text: string, label: string, run: () => Promise<unknown>, color = 'red') =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{text}</Text>,
      labels: { confirm: label, cancel: t('common.cancel') },
      confirmProps: { color },
      onConfirm: () => void run().then(refresh).catch(notifyError),
    })

  return (
    <>
      <Group justify="flex-end" mb="md">
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() =>
            setForm({ name: '', doorId: null, snapshotUrl: '', debounceSeconds: 30, openDoor: true, enabled: true })
          }
        >
          {t('plates.newReader')}
        </Button>
      </Group>
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('plates.colName')}</Table.Th>
              <Table.Th>{t('plates.colDoor')}</Table.Th>
              <Table.Th>{t('plates.colKey')}</Table.Th>
              <Table.Th>{t('plates.colLastRead')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(readers.data ?? []).map((r) => (
              <Table.Tr key={r.id} opacity={r.enabled ? 1 : 0.5}>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm" fw={500}>
                      {r.name}
                    </Text>
                    {!r.enabled && <Badge color="gray">{t('plates.disabled')}</Badge>}
                    {r.enabled && !r.openDoor && <Badge color="yellow">{t('plates.recordOnly')}</Badge>}
                  </Group>
                </Table.Td>
                <Table.Td>{doorName(r.doorId)}</Table.Td>
                <Table.Td className="mono">{r.keyPrefix}…</Table.Td>
                <Table.Td>{r.lastReadAt ? fmtDateTime(r.lastReadAt) : t('plates.never')}</Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end" wrap="nowrap">
                    <IconButton label={t('common.edit')} onClick={() => setForm({ ...r, doorId: String(r.doorId) })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton
                      label={t('plates.newKey')}
                      onClick={() =>
                        confirm(
                          t('plates.newKey'),
                          t('plates.newKeyConfirm', { name: r.name }),
                          t('plates.newKey'),
                          async () => setCreated(await api.post<PlateReaderKeyDto>(`/plate-readers/${r.id}/key`)),
                          'blue',
                        )
                      }
                    >
                      <IconKey size={16} />
                    </IconButton>
                    <IconButton
                      label={t('common.delete')}
                      color="red"
                      onClick={() =>
                        confirm(
                          t('plates.deleteTitle', { name: r.name }),
                          t('plates.deleteInfo'),
                          t('common.delete'),
                          () => api.del(`/plate-readers/${r.id}`),
                        )
                      }
                    >
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
        title={form?.id ? t('plates.editReaderTitle') : t('plates.newReaderTitle')}
        size="lg"
      >
        {form && (
          <Stack>
            <TextInput
              label={t('plates.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
              data-autofocus
            />
            <Select
              label={t('plates.door')}
              description={t('plates.doorHint')}
              data={(doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
              value={form.doorId}
              onChange={(v) => setForm({ ...form, doorId: v })}
              searchable
            />
            <TextInput
              label={t('plates.snapshotUrl')}
              description={t('plates.snapshotHint')}
              placeholder="http://192.168.1.10:8090/grab.jpg?oid=1&size=1920x1080"
              value={form.snapshotUrl}
              onChange={(e) => setForm({ ...form, snapshotUrl: e.currentTarget.value })}
            />
            <NumberInput
              label={t('plates.debounce')}
              description={t('plates.debounceHint')}
              min={0}
              max={600}
              allowDecimal={false}
              value={form.debounceSeconds}
              onChange={(v) => setForm({ ...form, debounceSeconds: typeof v === 'number' ? v : 0 })}
            />
            <Switch
              label={t('plates.openDoor')}
              description={t('plates.openDoorHint')}
              checked={form.openDoor}
              onChange={(e) => setForm({ ...form, openDoor: e.currentTarget.checked })}
            />
            <Switch
              label={t('plates.enabled')}
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
            />
            <Button onClick={() => void save()} disabled={!form.name.trim() || !form.doorId}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>

      <KeyModal created={created} onClose={() => setCreated(null)} />
    </>
  )
}

/** The addresses to configure in AgentDVR, with the new key: shown only once. */
function KeyModal({ created, onClose }: { created: PlateReaderKeyDto | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [server, setServer] = useState(window.location.origin)
  const base = server.replace(/\/+$/, '')
  const urls = created
    ? [
        { label: t('plates.listUrl'), url: `${base}/api/plates/agentdvr.csv?key=${created.key}` },
        { label: t('plates.actionUrl'), url: `${base}/api/plates/read?key=${created.key}&plate={AI}` },
      ]
    : []
  return (
    <Modal
      opened={!!created}
      onClose={onClose}
      title={created ? t('plates.keyTitle', { name: created.reader.name }) : ''}
      size="xl"
    >
      <Stack>
        <Alert color="orange">{t('plates.keyInfo')}</Alert>
        <TextInput
          label={t('plates.serverAddress')}
          description={t('plates.serverAddressHint')}
          value={server}
          onChange={(e) => setServer(e.currentTarget.value)}
        />
        {urls.map((u) => (
          <Stack key={u.label} gap={4}>
            <Text size="sm" fw={500}>
              {u.label}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Code style={{ flex: 1, wordBreak: 'break-all' }}>{u.url}</Code>
              <CopyButton value={u.url}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant="light"
                    color={copied ? 'green' : 'blue'}
                    leftSection={<IconCopy size={14} />}
                    onClick={copy}
                  >
                    {copied ? t('plates.copied') : t('plates.copy')}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        ))}
      </Stack>
    </Modal>
  )
}
