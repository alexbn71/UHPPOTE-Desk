import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  MultiSelect,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useDoors, usePeople, usePermissions, useTimeProfiles } from '../lib/queries'

/** People × doors matrix and bulk assignment (equivalent to "Access Privilege" in the original software). */
export function PermissionsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const doors = useDoors()
  const perms = usePermissions()
  const profiles = useTimeProfiles()
  const [search, setSearch] = useState('')
  const [selPeople, setSelPeople] = useState<string[]>([])
  const [selDoors, setSelDoors] = useState<string[]>([])
  const [profile, setProfile] = useState<string | null>('always')
  const [busy, setBusy] = useState(false)

  const map = useMemo(() => new Map((perms.data ?? []).map((p) => [`${p.personId}:${p.doorId}`, p])), [perms.data])
  const activeDoors = (doors.data ?? []).filter((d) => d.active)
  const filtered = (people.data ?? []).filter((p) =>
    `${p.lastName} ${p.firstName} ${p.code}`.toLowerCase().includes(search.toLowerCase()),
  )
  const profileName = (id: number | null) =>
    id === null
      ? t('people.permAlways')
      : (profiles.data?.find((p) => p.id === id)?.name ?? t('permissions.profileN', { n: id }))

  const apply = async (action: 'grant' | 'revoke') => {
    setBusy(true)
    try {
      const r = await api.post<{ pushErrors: { controllerId: number; error: string }[] }>('/permissions/bulk', {
        personIds: selPeople.map(Number),
        doorIds: selDoors.map(Number),
        action,
        profileId: profile && profile !== 'always' ? Number(profile) : null,
      })
      notifyOk(action === 'grant' ? t('permissions.granted') : t('permissions.revoked'))
      notifyPush(r)
      void qc.invalidateQueries({ queryKey: ['permissions'] })
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title={t('permissions.title')} description={t('permissions.description')} />
      {can('operator') && (
        <Card withBorder mb="md">
          <Title order={5} mb="sm">
            {t('permissions.bulkTitle')}
          </Title>
          <Stack>
            <MultiSelect
              label={t('permissions.people')}
              searchable
              data={(people.data ?? []).map((p) => ({
                value: String(p.id),
                label: `${p.lastName} ${p.firstName} (${p.code})`,
              }))}
              value={selPeople}
              onChange={setSelPeople}
            />
            <MultiSelect
              label={t('permissions.doors')}
              data={activeDoors.map((d) => ({ value: String(d.id), label: d.name }))}
              value={selDoors}
              onChange={setSelDoors}
            />
            <Group align="flex-end">
              <Select
                label={t('permissions.profile')}
                data={[
                  { value: 'always', label: t('people.permAlways') },
                  ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` })),
                ]}
                value={profile}
                onChange={setProfile}
                w={260}
              />
              <Button
                disabled={!selPeople.length || !selDoors.length}
                loading={busy}
                onClick={() => void apply('grant')}
              >
                {t('permissions.grant')}
              </Button>
              <Button
                color="red"
                variant="light"
                disabled={!selPeople.length || !selDoors.length}
                loading={busy}
                onClick={() => void apply('revoke')}
              >
                {t('permissions.revoke')}
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
      <Card withBorder>
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t('permissions.filterPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          mb="md"
        />
        <Table.ScrollContainer minWidth={400}>
          <Table className="matrix-table" withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('permissions.colPerson')}</Table.Th>
                {activeDoors.map((d) => (
                  <Table.Th key={d.id}>
                    <Text size="xs" fw={600}>
                      {d.name}
                    </Text>
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Checkbox
                      size="xs"
                      label={`${p.lastName} ${p.firstName}`}
                      checked={selPeople.includes(String(p.id))}
                      onChange={(e) =>
                        setSelPeople(
                          e.currentTarget.checked
                            ? [...selPeople, String(p.id)]
                            : selPeople.filter((x) => x !== String(p.id)),
                        )
                      }
                      disabled={!can('operator')}
                    />
                  </Table.Td>
                  {activeDoors.map((d) => {
                    const perm = map.get(`${p.id}:${d.id}`)
                    return (
                      <Table.Td key={d.id}>
                        {perm ? (
                          <Tooltip label={profileName(perm.profileId)}>
                            <Badge size="sm" color={perm.profileId === null ? 'green' : 'blue'} variant="light">
                              {perm.profileId === null ? '✓' : perm.profileId}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Text c="dimmed" size="xs">
                            —
                          </Text>
                        )}
                      </Table.Td>
                    )
                  })}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Text size="xs" c="dimmed" mt="sm">
          {t('permissions.legend')}
        </Text>
      </Card>
    </>
  )
}
