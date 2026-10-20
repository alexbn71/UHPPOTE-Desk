import {
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconSearch } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CardDto } from '@uhppote-desk/shared'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { cardLabel, fmtDate, fmtDateTime, isValidCard } from '../lib/format'
import { usePeople } from '../lib/queries'

const STATUS_COLOR = { active: 'green', lost: 'red', disabled: 'gray' } as const
type PushResult = { pushErrors: { controllerId: number; error: string }[] }

export function CardsPage() {
  const { t } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const cards = useQuery({
    queryKey: ['cards', filter, search],
    queryFn: () => api.get<CardDto[]>(`/cards?unassigned=${filter === 'free'}&search=${encodeURIComponent(search)}`),
  })
  const unknown = useQuery({
    queryKey: ['cards-unknown', 'page'],
    queryFn: () =>
      api.get<{ card: number; timestamp: string; controllerId: number; door: number }[]>('/cards/unknown?minutes=60'),
    refetchInterval: 5000,
    enabled: can('operator'),
  })
  const [batchFrom, setBatchFrom] = useState<number | string>('')
  const [batchTo, setBatchTo] = useState<number | string>('')

  const personOptions = (people.data ?? []).map((p) => ({
    value: String(p.id),
    label: `${p.lastName} ${p.firstName} (${p.code})`,
  }))
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cards'] })
    void qc.invalidateQueries({ queryKey: ['cards-unknown'] })
    void qc.invalidateQueries({ queryKey: ['people'] })
  }

  const register = (number: number) => {
    let personId: string | null = null
    modals.openConfirmModal({
      title: t('cards.registerTitle', { n: number }),
      children: (
        <Select
          label={t('cards.registerAssign')}
          description={t('cards.registerAssignHint')}
          searchable
          clearable
          data={personOptions}
          onChange={(v) => (personId = v)}
        />
      ),
      labels: { confirm: t('cards.registerConfirm'), cancel: t('common.cancel') },
      onConfirm: () =>
        api
          .post<PushResult>('/cards', { number, personId: personId ? Number(personId) : null })
          .then((r) => {
            notifyOk(t('cards.registered', { n: number }))
            notifyPush(r)
            refresh()
          })
          .catch(notifyError),
    })
  }

  const assign = (c: CardDto, personId: string | null) =>
    api
      .put<PushResult>(`/cards/${c.id}`, {
        number: c.number,
        personId: personId ? Number(personId) : null,
        status: c.status,
      })
      .then((r) => {
        notifyPush(r)
        refresh()
      })
      .catch(notifyError)

  const batch = async () => {
    const from = Number(batchFrom)
    const to = Number(batchTo)
    if (!from || !to || to < from || to - from > 999) return notifyError(new Error(t('cards.batchInvalid')))
    let ok = 0
    for (let n = from; n <= to; n++) {
      try {
        await api.post('/cards', { number: n, personId: null })
        ok++
      } catch {
        // duplicate or invalid: continue with the next one
      }
    }
    notifyOk(t('cards.batchDone', { n: ok }))
    refresh()
  }

  return (
    <>
      <PageHeader title={t('cards.title')} description={t('cards.description')} />
      {can('operator') && (
        <Group align="stretch" grow mb="md">
          <Card withBorder>
            <Title order={5} mb="xs">
              {t('cards.unknownTitle')}
            </Title>
            <Text size="sm" c="dimmed" mb="sm">
              {t('cards.unknownHint')}
            </Text>
            <Group gap="xs">
              {(unknown.data ?? []).map((u) =>
                isValidCard(u.card) ? (
                  <Button key={u.card} variant="outline" size="xs" onClick={() => register(u.card)}>
                    {cardLabel(u.card)} · {fmtDateTime(u.timestamp)}
                  </Button>
                ) : (
                  <Tooltip key={u.card} label={t('errors.invalidWiegand')} multiline w={260}>
                    <Button variant="outline" color="gray" size="xs" data-disabled onClick={(e) => e.preventDefault()}>
                      {cardLabel(u.card)} · {fmtDateTime(u.timestamp)}
                    </Button>
                  </Tooltip>
                ),
              )}
              {unknown.data?.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('common.none')}
                </Text>
              )}
            </Group>
          </Card>
          <Card withBorder>
            <Title order={5} mb="xs">
              {t('cards.batchTitle')}
            </Title>
            <Group align="flex-end">
              <NumberInput
                label={t('cards.batchFrom')}
                value={batchFrom}
                onChange={setBatchFrom}
                hideControls
                allowDecimal={false}
              />
              <NumberInput
                label={t('cards.batchTo')}
                value={batchTo}
                onChange={setBatchTo}
                hideControls
                allowDecimal={false}
              />
              <Button onClick={() => void batch()}>{t('cards.batchSubmit')}</Button>
            </Group>
          </Card>
        </Group>
      )}
      <Card withBorder>
        <Group mb="md">
          <SegmentedControl
            value={filter}
            onChange={setFilter}
            data={[
              { value: 'all', label: t('cards.filterAll') },
              { value: 'free', label: t('cards.filterFree') },
            ]}
          />
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={t('cards.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </Group>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('cards.colNumber')}</Table.Th>
                <Table.Th>{t('cards.colAssigned')}</Table.Th>
                <Table.Th>{t('cards.colStatus')}</Table.Th>
                <Table.Th>{t('cards.colRegistered')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(cards.data ?? []).map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td className="mono">{cardLabel(c.number)}</Table.Td>
                  <Table.Td w={320}>
                    {can('operator') ? (
                      <Select
                        size="xs"
                        searchable
                        clearable
                        data={personOptions}
                        value={c.personId ? String(c.personId) : null}
                        onChange={(v) => void assign(c, v)}
                        placeholder={t('cards.free')}
                      />
                    ) : (
                      (c.personName ?? '—')
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[c.status]} variant="light">
                      {codes.cardStatus(c.status)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{fmtDate(c.createdAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Stack>
          {cards.data?.length === 0 && (
            <Text c="dimmed" ta="center" py="md">
              {t('cards.none')}
            </Text>
          )}
        </Stack>
      </Card>
    </>
  )
}
