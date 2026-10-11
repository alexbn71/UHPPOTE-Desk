import { ActionIcon, Badge, Chip, Group, Stack, Table, Text, Title, Tooltip } from '@mantine/core'
import { IconArrowDownRight, IconArrowUpRight, IconCheck, IconX } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { EventDto } from '@uhppote-desk/shared'
import { ALARM_REASONS, EVENT_TYPE_LABELS, WEEKDAY_LABELS, reasonLabel } from '@uhppote-desk/shared'
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

export function WeekdaysInput({ value, onChange, label }: { value: boolean[]; onChange: (v: boolean[]) => void; label?: string }) {
  return (
    <Stack gap={4}>
      {label && (
        <Text size="sm" fw={500}>
          {label}
        </Text>
      )}
      <Chip.Group
        multiple
        value={WEEKDAY_LABELS.map((_, i) => String(i)).filter((i) => value[Number(i)])}
        onChange={(v) => onChange(WEEKDAY_LABELS.map((_, i) => v.includes(String(i))))}
      >
        <Group gap={4}>
          {WEEKDAY_LABELS.map((d, i) => (
            <Chip key={d} value={String(i)} size="xs">
              {d}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </Stack>
  )
}

export function weekdaysText(w: boolean[]): string {
  if (w.every(Boolean)) return 'Tutti i giorni'
  if (w.slice(0, 5).every(Boolean) && !w[5] && !w[6]) return 'Lun-Ven'
  return WEEKDAY_LABELS.filter((_, i) => w[i]).join(', ') || 'Nessun giorno'
}

export function GrantedBadge({ granted }: { granted: boolean }) {
  return granted ? (
    <Badge color="green" leftSection={<IconCheck size={12} />} variant="light">
      Consentito
    </Badge>
  ) : (
    <Badge color="red" leftSection={<IconX size={12} />} variant="light">
      Negato
    </Badge>
  )
}

export function DirectionIcon({ direction }: { direction: number }) {
  if (direction === 1)
    return (
      <Tooltip label="Ingresso">
        <IconArrowDownRight size={16} color="var(--mantine-color-teal-6)" />
      </Tooltip>
    )
  if (direction === 2)
    return (
      <Tooltip label="Uscita">
        <IconArrowUpRight size={16} color="var(--mantine-color-grape-6)" />
      </Tooltip>
    )
  return null
}

export function EventsTable({ events, showController = true }: { events: EventDto[]; showController?: boolean }) {
  if (!events.length) {
    return (
      <Text c="dimmed" ta="center" py="lg">
        Nessun evento
      </Text>
    )
  }
  return (
    <Table.ScrollContainer minWidth={800}>
      <Table striped highlightOnHover verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Data/ora</Table.Th>
            {showController && <Table.Th>Controller</Table.Th>}
            <Table.Th>Porta</Table.Th>
            <Table.Th>Tipo</Table.Th>
            <Table.Th>Persona / tessera</Table.Th>
            <Table.Th>Esito</Table.Th>
            <Table.Th>Motivo</Table.Th>
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
                  {e.door === 0 ? '—' : (e.doorName ?? `Porta ${e.door}`)}
                </Group>
              </Table.Td>
              <Table.Td>{EVENT_TYPE_LABELS[e.type] ?? e.type}</Table.Td>
              <Table.Td>
                {e.personName ?? (e.card ? <Text span c="dimmed">Tessera {e.card}</Text> : '—')}
              </Table.Td>
              <Table.Td>{e.type === 1 || e.reason === 44 ? <GrantedBadge granted={e.granted} /> : null}</Table.Td>
              <Table.Td>{reasonLabel(e.reason)}</Table.Td>
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
