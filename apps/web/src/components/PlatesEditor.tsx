import { Button, Group, Stack, Table, Text, TextInput } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MIN_PLATE_LENGTH, normalizePlate, type PlateDto } from '@uhppote-desk/shared'
import { api, notifyError } from '../lib/api'
import { fmtDate } from '../lib/format'
import { IconButton } from './common'

/** The vehicle plates of a person (Licence plates readers open the person's doors for them). */
export function PlatesEditor({ personId, readOnly }: { personId: number; readOnly: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const plates = useQuery({
    queryKey: ['plates', personId],
    queryFn: () => api.get<PlateDto[]>(`/plates?personId=${personId}`),
  })
  const [plate, setPlate] = useState('')
  const [note, setNote] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['plates'] })

  const add = async () => {
    try {
      await api.post('/plates', { plate, personId, note })
      setPlate('')
      setNote('')
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('plates.personHint')}
      </Text>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('plates.colPlate')}</Table.Th>
            <Table.Th>{t('plates.colNote')}</Table.Th>
            <Table.Th>{t('people.cardSinceCol')}</Table.Th>
            <Table.Th />
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
              <Table.Td>{p.note}</Table.Td>
              <Table.Td>{fmtDate(p.createdAt)}</Table.Td>
              <Table.Td>
                {!readOnly && (
                  <Group justify="flex-end">
                    <IconButton
                      label={t('common.delete')}
                      color="red"
                      onClick={() => void api.del(`/plates/${p.id}`).then(refresh).catch(notifyError)}
                    >
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
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            label={t('plates.colPlate')}
            placeholder={t('plates.platePlaceholder')}
            value={plate}
            onChange={(e) => setPlate(normalizePlate(e.currentTarget.value))}
            onKeyDown={(e) => e.key === 'Enter' && plate.length >= MIN_PLATE_LENGTH && void add()}
            className="mono"
            w={160}
          />
          <TextInput
            style={{ flex: 1 }}
            label={t('plates.colNote')}
            placeholder={t('plates.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Button disabled={plate.length < MIN_PLATE_LENGTH} onClick={() => void add()}>
            {t('plates.add')}
          </Button>
        </Group>
      )}
    </Stack>
  )
}
