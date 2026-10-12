import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconEdit, IconList, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Language,
  NotificationChannelDto,
  RuleDto,
  RuleInput,
  RuleRunDto,
  RuleSeverity,
  WebhookDto,
} from '@uhppote-desk/shared'
import { DOOR_OPEN_FOR, LANGUAGES, RULE_SEVERITIES, WEBHOOK_EVENTS } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput } from '../components/common'
import { api, notifyError } from '../lib/api'
import { useCodes } from '../lib/codes'
import { fmtDateTime } from '../lib/format'
import { useDoors, usePeople } from '../lib/queries'

type Form = RuleInput & { id?: number }

const SEVERITY_COLOR: Record<RuleSeverity, string> = { info: 'blue', warning: 'orange', alarm: 'red' }
const ALL_DAYS = [true, true, true, true, true, true, true]
const duration = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`)

export function RulesPage() {
  const { t, i18n } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const doors = useDoors()
  const people = usePeople()
  const channels = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationChannelDto[]>('/notifications'),
  })
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<WebhookDto[]>('/webhooks') })
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<RuleDto[]>('/rules') })
  const [form, setForm] = useState<Form | null>(null)
  const [history, setHistory] = useState<RuleDto | null>(null)
  const [cardsText, setCardsText] = useState('')

  const eventLabel = (e: string) =>
    e === DOOR_OPEN_FOR
      ? t('rules.openFor')
      : t(`codes.webhookEvent.${e.replace('.', '_')}` as 'codes.webhookEvent.alarm', { defaultValue: e })
  const names = <T extends { id: number }>(list: T[] | undefined, ids: number[], name: (x: T) => string) =>
    ids.map((id) => (list?.find((x) => x.id === id) ? name(list.find((x) => x.id === id)!) : `#${id}`)).join(', ')
  const doorNames = (ids: number[]) => names(doors.data, ids, (d) => d.name)
  const personName = (p: { firstName: string; lastName: string }) => `${p.lastName} ${p.firstName}`.trim()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['rules'] })

  const open = (f: Form) => {
    setCardsText(f.conditions.cards.join(', '))
    setForm(f)
  }

  const newForm = (): Form => ({
    name: '',
    enabled: true,
    severity: 'warning',
    language: (LANGUAGES.find((l) => i18n.language.startsWith(l.code))?.code ?? 'en') as Language,
    trigger: { type: 'access.granted', seconds: 120 },
    conditions: { doorIds: [], personIds: [], cards: [], timeFrom: null, timeTo: null, weekdays: ALL_DAYS },
    actions: { channelIds: [], webhookIds: [], openDoorIds: [] },
    message: '',
    cooldownSeconds: 0,
  })

  const save = async () => {
    if (!form) return
    try {
      const { id, ...body } = form
      const cards = cardsText
        .split(/[,;\s]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
      const payload = { ...body, conditions: { ...body.conditions, cards } }
      if (id) await api.put(`/rules/${id}`, payload)
      else await api.post('/rules', payload)
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (r: RuleDto) =>
    modals.openConfirmModal({
      title: t('rules.deleteTitle', { name: r.name }),
      children: <Text size="sm">{t('rules.deleteInfo')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => api.del(`/rules/${r.id}`).then(refresh).catch(notifyError),
    })

  const whenText = (r: RuleDto) =>
    r.trigger.type === DOOR_OPEN_FOR
      ? t('rules.openForSummary', { duration: duration(r.trigger.seconds) })
      : eventLabel(r.trigger.type)
  const ifText = (r: RuleDto) => {
    const c = r.conditions
    const parts: string[] = []
    if (c.doorIds.length) parts.push(t('rules.sumDoors', { list: doorNames(c.doorIds) }))
    const who = [...c.personIds.map((id) => names(people.data, [id], personName)), ...c.cards.map(String)]
    if (who.length) parts.push(t('rules.sumWho', { list: who.join(', ') }))
    if (c.timeFrom && c.timeTo) parts.push(t('rules.sumTime', { from: c.timeFrom, to: c.timeTo }))
    if (c.weekdays.some((d) => !d)) parts.push(t('rules.sumDays', { list: codes.weekdaysText(c.weekdays) }))
    return parts.length ? parts.join(' · ') : t('rules.any')
  }
  const thenText = (r: RuleDto) => {
    const a = r.actions
    const parts: string[] = []
    if (a.channelIds.length)
      parts.push(t('rules.sumNotify', { list: names(channels.data, a.channelIds, (c) => c.name) }))
    if (a.webhookIds.length)
      parts.push(t('rules.sumWebhooks', { list: names(webhooks.data, a.webhookIds, (w) => w.name) }))
    if (a.openDoorIds.length) parts.push(t('rules.sumOpen', { list: doorNames(a.openDoorIds) }))
    return parts.length ? parts.join(' · ') : t('rules.sumAppOnly')
  }

  const doorOptions = (doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))
  const setConditions = (patch: Partial<Form['conditions']>) =>
    form && setForm({ ...form, conditions: { ...form.conditions, ...patch } })
  const setActions = (patch: Partial<Form['actions']>) =>
    form && setForm({ ...form, actions: { ...form.actions, ...patch } })
  const ids = (v: string[]) => v.map(Number)
  const strs = (v: number[]) => v.map(String)

  return (
    <>
      <PageHeader
        title={t('rules.title')}
        description={t('rules.description')}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => open(newForm())}>
            {t('rules.new')}
          </Button>
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('rules.colName')}</Table.Th>
              <Table.Th>{t('rules.colTrigger')}</Table.Th>
              <Table.Th>{t('rules.colConditions')}</Table.Th>
              <Table.Th>{t('rules.colActions')}</Table.Th>
              <Table.Th>{t('rules.colLast')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(rules.data ?? []).map((r) => (
              <Table.Tr key={r.id} opacity={r.enabled ? 1 : 0.5}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Badge
                      size="xs"
                      circle
                      color={SEVERITY_COLOR[r.severity]}
                      title={t(`codes.ruleSeverity.${r.severity}`)}
                    >
                      {' '}
                    </Badge>
                    {r.name}
                  </Group>
                </Table.Td>
                <Table.Td>{whenText(r)}</Table.Td>
                <Table.Td>{ifText(r)}</Table.Td>
                <Table.Td>{thenText(r)}</Table.Td>
                <Table.Td>
                  {r.lastFiredAt ? (
                    <Stack gap={0}>
                      <Text size="sm">{fmtDateTime(r.lastFiredAt)}</Text>
                      <Text size="xs" c="dimmed">
                        {t('rules.fired', { n: r.fireCount })}
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t('rules.never')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end" wrap="nowrap">
                    <IconButton label={t('rules.runs')} onClick={() => setHistory(r)}>
                      <IconList size={16} />
                    </IconButton>
                    <IconButton label={t('common.edit')} onClick={() => open(r)}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label={t('common.delete')} color="red" onClick={() => remove(r)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Text size="xs" c="dimmed" mt="xs">
        {t('rules.docs')}
      </Text>

      <Modal
        opened={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t('rules.editTitle') : t('rules.newTitle')}
        size="xl"
      >
        {form && (
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput
                label={t('rules.name')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
              />
              <Select
                label={t('rules.severity')}
                data={RULE_SEVERITIES.map((s) => ({ value: s, label: t(`codes.ruleSeverity.${s}`) }))}
                value={form.severity}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, severity: (v ?? 'warning') as RuleSeverity })}
              />
              <Select
                label={t('rules.language')}
                data={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                value={form.language}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, language: (v ?? 'en') as Language })}
              />
            </SimpleGrid>
            <Text size="xs" c="dimmed" mt={-8}>
              {t('rules.severityHint')}
            </Text>

            <Divider label={<Title order={6}>{t('rules.sectionWhen')}</Title>} labelPosition="left" />
            <Group align="flex-start" grow>
              <Select
                label={t('rules.trigger')}
                data={[...WEBHOOK_EVENTS, DOOR_OPEN_FOR].map((e) => ({ value: e, label: eventLabel(e) }))}
                value={form.trigger.type}
                allowDeselect={false}
                onChange={(v) =>
                  v && setForm({ ...form, trigger: { ...form.trigger, type: v as Form['trigger']['type'] } })
                }
              />
              {form.trigger.type === DOOR_OPEN_FOR && (
                <NumberInput
                  label={t('rules.seconds')}
                  description={t('rules.secondsHint')}
                  min={10}
                  max={86400}
                  value={form.trigger.seconds}
                  onChange={(v) => setForm({ ...form, trigger: { ...form.trigger, seconds: Number(v) || 120 } })}
                />
              )}
            </Group>

            <Divider label={<Title order={6}>{t('rules.sectionIf')}</Title>} labelPosition="left" />
            <MultiSelect
              label={t('rules.doors')}
              description={t('rules.doorsHint')}
              data={doorOptions}
              value={strs(form.conditions.doorIds)}
              onChange={(v) => setConditions({ doorIds: ids(v) })}
              searchable
            />
            {form.trigger.type !== DOOR_OPEN_FOR && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <MultiSelect
                  label={t('rules.people')}
                  data={(people.data ?? []).map((p) => ({ value: String(p.id), label: personName(p) }))}
                  value={strs(form.conditions.personIds)}
                  onChange={(v) => setConditions({ personIds: ids(v) })}
                  searchable
                />
                <TextInput
                  label={t('rules.cards')}
                  description={t('rules.cardsHint')}
                  value={cardsText}
                  onChange={(e) => setCardsText(e.currentTarget.value)}
                />
              </SimpleGrid>
            )}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Group grow align="flex-start">
                <TextInput
                  label={t('rules.timeFrom')}
                  placeholder="22:00"
                  value={form.conditions.timeFrom ?? ''}
                  onChange={(e) => setConditions({ timeFrom: e.currentTarget.value || null })}
                />
                <TextInput
                  label={t('rules.timeTo')}
                  placeholder="06:00"
                  value={form.conditions.timeTo ?? ''}
                  onChange={(e) => setConditions({ timeTo: e.currentTarget.value || null })}
                />
              </Group>
              <WeekdaysInput
                label={t('rules.weekdays')}
                value={form.conditions.weekdays}
                onChange={(w) => setConditions({ weekdays: w })}
              />
            </SimpleGrid>
            <Text size="xs" c="dimmed" mt={-8}>
              {t('rules.timeHint')}
            </Text>

            <Divider label={<Title order={6}>{t('rules.sectionThen')}</Title>} labelPosition="left" />
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <MultiSelect
                label={t('rules.channels')}
                data={(channels.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                value={strs(form.actions.channelIds)}
                onChange={(v) => setActions({ channelIds: ids(v) })}
              />
              <MultiSelect
                label={t('rules.webhooks')}
                data={(webhooks.data ?? []).map((w) => ({ value: String(w.id), label: w.name }))}
                value={strs(form.actions.webhookIds)}
                onChange={(v) => setActions({ webhookIds: ids(v) })}
              />
              <MultiSelect
                label={t('rules.openDoors')}
                data={doorOptions}
                value={strs(form.actions.openDoorIds)}
                onChange={(v) => setActions({ openDoorIds: ids(v) })}
                searchable
              />
            </SimpleGrid>
            <Textarea
              label={t('rules.message')}
              description={t('rules.messageHint')}
              autosize
              minRows={2}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.currentTarget.value })}
            />
            <Group align="flex-end" justify="space-between">
              <NumberInput
                w={260}
                label={t('rules.cooldown')}
                description={t('rules.cooldownHint')}
                min={0}
                max={86400}
                value={form.cooldownSeconds}
                onChange={(v) => setForm({ ...form, cooldownSeconds: Number(v) || 0 })}
              />
              <Switch
                label={t('rules.enabledSwitch')}
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
              />
            </Group>
            <Button onClick={() => void save()} disabled={!form.name.trim()}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>

      <RunsModal rule={history} onClose={() => setHistory(null)} />
    </>
  )
}

function RunsModal({ rule, onClose }: { rule: RuleDto | null; onClose: () => void }) {
  const { t } = useTranslation()
  const runs = useQuery({
    queryKey: ['rule-runs', rule?.id],
    queryFn: () => api.get<RuleRunDto[]>(`/rules/${rule!.id}/runs`),
    enabled: !!rule,
    refetchInterval: 5000,
  })
  return (
    <Modal opened={!!rule} onClose={onClose} title={rule ? t('rules.runsTitle', { name: rule.name }) : ''} size="xl">
      {runs.data?.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('rules.noRuns')}
        </Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('rules.colTime')}</Table.Th>
              <Table.Th>{t('rules.colText')}</Table.Th>
              <Table.Th>{t('rules.colErrors')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(runs.data ?? []).map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</Table.Td>
                <Table.Td style={{ whiteSpace: 'pre-line' }}>{r.text}</Table.Td>
                <Table.Td>
                  {r.errors.map((e) => (
                    <Text key={e} size="xs" c="red">
                      {e}
                    </Text>
                  ))}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  )
}
