import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControllerOptionsReadDto, ControllerOptionsSettings } from '@uhppote-desk/shared'
import { api, notifyError } from '../lib/api'
import { useTimeProfiles } from '../lib/queries'

const DOORS = [0, 1, 2, 3] as const

/** Vendor "extended functions" of the readers and doors (parameter table, verified by read-back). */
export function ControllerOptionsCard({
  id,
  value,
  onChange,
  readOnly,
}: {
  id: number
  value: ControllerOptionsSettings
  onChange: (v: ControllerOptionsSettings) => void
  readOnly: boolean
}) {
  const { t } = useTranslation()
  const profiles = useTimeProfiles()
  const [read, setRead] = useState<ControllerOptionsReadDto | null>(null)
  const [reading, setReading] = useState(false)
  const o = value
  const setQuad = <K extends 'doorAsSwitch' | 'multiCard'>(k: K, i: number, v: ControllerOptionsSettings[K][number]) =>
    onChange({ ...o, [k]: o[k].map((x, j) => (j === i ? v : x)) })
  const setReader = (i: number, on: boolean) =>
    onChange({
      ...o,
      fourTimesNormalOpen: {
        ...o.fourTimesNormalOpen,
        readers: o.fourTimesNormalOpen.readers.map((x, j) => (j === i ? on : x)),
      },
    })

  const readFromController = async () => {
    setReading(true)
    try {
      setRead(await api.get<ControllerOptionsReadDto>(`/controllers/${id}/controller-options`))
    } catch (err) {
      notifyError(err)
    } finally {
      setReading(false)
    }
  }

  const profileOptions = [
    { value: '0', label: t('controllerOptions.allUsers') },
    ...(profiles.data ?? [])
      .filter((p) => p.id >= 2 && p.id <= 15)
      .map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` })),
  ]
  const doorList = (q: readonly boolean[]) =>
    q.flatMap((on, i) => (on ? [t('common.doorN', { n: i + 1 })] : [])).join(', ') || '—'

  return (
    <Card withBorder data-testid="controller-options">
      <Group justify="space-between" mb="xs">
        <Title order={5}>{t('controllerOptions.title')}</Title>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconDownload size={14} />}
          loading={reading}
          onClick={() => void readFromController()}
        >
          {t('expansion.read')}
        </Button>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('controllerOptions.intro')}
      </Text>
      <Switch
        label={t('controllerOptions.managed')}
        description={t('controllerOptions.managedHint')}
        checked={o.managed}
        disabled={readOnly}
        onChange={(e) => onChange({ ...o, managed: e.currentTarget.checked })}
        mb="md"
      />
      {read && (
        <Card withBorder padding="sm" mb="md" data-testid="controller-options-read">
          <Group justify="space-between" mb={4}>
            <Text size="sm" fw={500}>
              {t('expansion.readTitle')}
            </Text>
            {read.mismatches === null ? (
              <Badge color="gray">{t('controllerOptions.readNotCompared')}</Badge>
            ) : read.mismatches.length === 0 ? (
              <Badge color="green">{t('expansion.readAligned')}</Badge>
            ) : (
              <Badge color="orange">{t('expansion.readDifferent', { n: read.mismatches.length })}</Badge>
            )}
          </Group>
          <Text size="xs">
            {t('controllerOptions.fourTimes')}: {doorList(read.fourTimesNormalOpen.readers)} ·{' '}
            {t('controllerOptions.silent')}: {read.silentInvalidCard ? t('common.yes') : t('common.no')} ·{' '}
            {t('controllerOptions.swipeGap')}: {read.swipeGapSeconds} · {t('controllerOptions.doorAsSwitch')}:{' '}
            {doorList(read.doorAsSwitch)} · {t('controllerOptions.multiCard')}:{' '}
            {read.multiCard.map((n, i) => `${i + 1}=${n || '—'}`).join(' ')}
          </Text>
          {!readOnly && (
            <Button
              mt="xs"
              size="xs"
              variant="light"
              onClick={() => {
                const { mismatches: _mismatches, ...values } = read
                onChange({ ...values, managed: o.managed })
              }}
            >
              {t('expansion.readUse')}
            </Button>
          )}
        </Card>
      )}
      <Stack gap="md" opacity={o.managed ? 1 : 0.6}>
        <div>
          <Text size="sm" fw={500}>
            {t('controllerOptions.fourTimes')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('controllerOptions.fourTimesHint')}
          </Text>
          <Group>
            {DOORS.map((i) => (
              <Checkbox
                key={i}
                label={t('controllerOptions.readerN', { n: i + 1 })}
                checked={o.fourTimesNormalOpen.readers[i]}
                disabled={readOnly}
                onChange={(e) => setReader(i, e.currentTarget.checked)}
              />
            ))}
            <Select
              size="xs"
              w={220}
              aria-label={t('controllerOptions.fourTimesProfile')}
              data={profileOptions}
              value={String(o.fourTimesNormalOpen.timeProfile)}
              onChange={(v) =>
                onChange({ ...o, fourTimesNormalOpen: { ...o.fourTimesNormalOpen, timeProfile: Number(v ?? 0) } })
              }
              readOnly={readOnly}
              allowDeselect={false}
            />
          </Group>
        </div>
        <Switch
          label={t('controllerOptions.silent')}
          description={t('controllerOptions.silentHint')}
          checked={o.silentInvalidCard}
          disabled={readOnly}
          onChange={(e) => onChange({ ...o, silentInvalidCard: e.currentTarget.checked })}
        />
        <NumberInput
          label={t('controllerOptions.swipeGap')}
          description={t('controllerOptions.swipeGapHint')}
          min={0}
          max={600}
          step={2}
          w={320}
          value={o.swipeGapSeconds}
          onChange={(v) => {
            const n = Math.max(0, Math.min(600, Number(v) || 0))
            onChange({ ...o, swipeGapSeconds: n - (n % 2) })
          }}
          readOnly={readOnly}
        />
        <div>
          <Text size="sm" fw={500}>
            {t('controllerOptions.doorAsSwitch')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('controllerOptions.doorAsSwitchHint')}
          </Text>
          <Group>
            {DOORS.map((i) => (
              <Checkbox
                key={i}
                label={t('common.doorN', { n: i + 1 })}
                checked={o.doorAsSwitch[i]}
                disabled={readOnly}
                onChange={(e) => setQuad('doorAsSwitch', i, e.currentTarget.checked)}
              />
            ))}
          </Group>
        </div>
        <div>
          <Text size="sm" fw={500}>
            {t('controllerOptions.multiCard')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('controllerOptions.multiCardHint')}
          </Text>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            {DOORS.map((i) => (
              <NumberInput
                key={i}
                size="xs"
                label={t('common.doorN', { n: i + 1 })}
                min={0}
                max={10}
                value={o.multiCard[i]}
                onChange={(v) => {
                  const n = Math.max(0, Math.min(10, Number(v) || 0))
                  setQuad('multiCard', i, n === 1 ? 2 : n)
                }}
                readOnly={readOnly}
              />
            ))}
          </SimpleGrid>
        </div>
      </Stack>
    </Card>
  )
}
