import { ActionIcon, Badge, Chip, Group, Stack, Table, Text, Title, Tooltip } from '@mantine/core'
import { IconArrowDownRight, IconArrowUpRight, IconCheck, IconX } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { EventDto } from '@uhppote-desk/shared'
import { ALARM_REASONS } from '@uhppote-desk/shared'
import { useCodes } from '../lib/codes'
import { fmtDateTime } from '../lib/format'

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" wrap="wrap">
      <Stack gap={2}>
        <Title order={2}>{title}</Title>
        {description && (
          <Text c="dimmed" size="sm">
            {description}
          </Text>
        )}
      </Stack>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  )
}

const WEEK = [0, 1, 2, 3, 4, 5, 6]

export function WeekdaysInput({ value, onChange, label }: { value: boolean[]; onChange: (v: boolean[]) => void; label?: string }) {
  const codes = useCodes()
  return (
    <Stack gap={4}>
      {label && (
        <Text size="sm" fw={500}>
          {label}
        </Text>
      )}
      <Chip.Group
        multiple
        value={WEEK.map(String).filter((i) => value[Number(i)])}
        onChange={(v) => onChange(WEEK.map((i) => v.includes(String(i))))}
      >
        <Group gap={4}>
          {WEEK.map((i) => (
            <Chip key={i} value={String(i)} size="xs">
              {codes.weekday(i)}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </Stack>
  )
}

export function GrantedBadge({ granted }: { granted: boolean }) {
  const { t } = useTranslation()
  return granted ? (
    <Badge color="green" leftSection={<IconCheck size={12} />} variant="light">
      {t('csv.events.granted')}
    </Badge>
  ) : (
    <Badge color="red" leftSection={<IconX size={12} />} variant="light">
      {t('csv.events.denied')}
    </Badge>
  )
}

export function DirectionIcon({ direction }: { direction: number }) {
  const codes = useCodes()
  if (direction === 1)
    return (
      <Tooltip label={codes.direction(1)}>
        <IconArrowDownRight size={16} color="var(--mantine-color-teal-6)" />
      </Tooltip>
    )
  if (direction === 2)
    return (
      <Tooltip label={codes.direction(2)}>
        <IconArrowUpRight size={16} color="var(--mantine-color-grape-6)" />
      </Tooltip>
    )
  return null
}

export function EventsTable({ events, showController = true }: { events: EventDto[]; showController?: boolean }) {
  const { t } = useTranslation()
  const codes = useCodes()
  if (!events.length) {
    return (
      <Text c="dimmed" ta="center" py="lg">
        {t('events.none')}
      </Text>
    )
  }
  return (
    <Table.ScrollContainer minWidth={800}>
      <Table striped highlightOnHover verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('events.colTime')}</Table.Th>
            {showController && <Table.Th>{t('events.colController')}</Table.Th>}
            <Table.Th>{t('events.colDoor')}</Table.Th>
            <Table.Th>{t('events.colType')}</Table.Th>
            <Table.Th>{t('events.colPerson')}</Table.Th>
            <Table.Th>{t('events.colOutcome')}</Table.Th>
            <Table.Th>{t('events.colReason')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((e) => (
            <Table.Tr key={`${e.controllerId}-${e.id}`} className={ALARM_REASONS.has(e.reason) ? 'event-row-alarm' : !e.granted && e.type === 1 ? 'event-row-denied' : undefined}>
              <Table.Td className="mono">{fmtDateTime(e.timestamp)}</Table.Td>
              {showController && <Table.Td>{e.controllerName}</Table.Td>}
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {e.door !== 0 && <DirectionIcon direction={e.direction} />}
                  {e.door === 0 ? '—' : (e.doorName ?? t('common.doorN', { n: e.door }))}
                </Group>
              </Table.Td>
              <Table.Td>{codes.eventType(e.type)}</Table.Td>
              <Table.Td>
                {e.personName ?? (e.card ? <Text span c="dimmed">{t('events.cardOnly', { n: e.card })}</Text> : '—')}
              </Table.Td>
              <Table.Td>{e.type === 1 || e.reason === 44 ? <GrantedBadge granted={e.granted} /> : null}</Table.Td>
              <Table.Td>{codes.reason(e.reason)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

export function IconButton({ label, onClick, children, color, disabled, loading }: { label: string; onClick: () => void; children: ReactNode; color?: string; disabled?: boolean; loading?: boolean }) {
  return (
    <Tooltip label={label}>
      <ActionIcon variant="subtle" color={color} onClick={onClick} disabled={disabled} loading={loading} aria-label={label}>
        {children}
      </ActionIcon>
    </Tooltip>
  )
}
