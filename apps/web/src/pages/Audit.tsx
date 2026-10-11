import { Badge, Card, Code, Group, Pagination, Table, Text, TextInput, Tooltip } from '@mantine/core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/common'
import { api, qs } from '../lib/api'
import { fmtDateTime } from '../lib/format'

interface AuditEntry {
  id: number
  at: string
  operatorName: string | null
  action: string
  target: string | null
  details: unknown
  outcome: 'ok' | 'error'
  error: string | null
}

const PAGE = 100

export function AuditPage() {
  const { t } = useTranslation()
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const audit = useQuery({
    queryKey: ['audit', action, page],
    queryFn: () => api.get<{ rows: AuditEntry[]; total: number }>(`/audit${qs({ action, limit: PAGE, offset: (page - 1) * PAGE })}`),
    placeholderData: keepPreviousData,
  })
  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <Card withBorder>
        <TextInput
          placeholder={t('audit.filterPlaceholder')}
          value={action}
          onChange={(e) => {
            setAction(e.currentTarget.value)
            setPage(1)
          }}
          mb="md"
          w={360}
        />
        <Table.ScrollContainer minWidth={800}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('audit.colTime')}</Table.Th>
                <Table.Th>{t('audit.colOperator')}</Table.Th>
                <Table.Th>{t('audit.colAction')}</Table.Th>
                <Table.Th>{t('audit.colTarget')}</Table.Th>
                <Table.Th>{t('audit.colOutcome')}</Table.Th>
                <Table.Th>{t('audit.colDetails')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(audit.data?.rows ?? []).map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td className="mono">{fmtDateTime(a.at)}</Table.Td>
                  <Table.Td>{a.operatorName ?? t('common.system')}</Table.Td>
                  <Table.Td className="mono">{a.action}</Table.Td>
                  <Table.Td className="mono">{a.target ?? ''}</Table.Td>
                  <Table.Td>
                    {a.outcome === 'ok' ? (
                      <Badge color="green" variant="light">
                        {t('common.ok')}
                      </Badge>
                    ) : (
                      <Tooltip label={a.error} multiline w={300}>
                        <Badge color="red" variant="light">
                          {t('common.error')}
                        </Badge>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td maw={400}>
                    {a.details !== null && (
                      <Code block style={{ maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                        {JSON.stringify(a.details)}
                      </Code>
                    )}
                    {a.error && (
                      <Text size="xs" c="red">
                        {a.error}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group justify="space-between" mt="md">
          <Text size="sm" c="dimmed">
            {t('audit.count', { n: audit.data?.total ?? 0 })}
          </Text>
          <Pagination total={Math.max(1, Math.ceil((audit.data?.total ?? 0) / PAGE))} value={page} onChange={setPage} />
        </Group>
      </Card>
    </>
  )
}
