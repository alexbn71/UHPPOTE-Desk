import { Alert, Box, Card, Container, Group, Loader, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { IconAlertTriangle, IconDeviceMobileOff, IconLinkOff } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GuestViewDto } from '@uhppote-desk/shared'
import { Credits } from '../components/Credits'
import { HoldButton } from '../components/HoldButton'
import { LanguageSelect } from '../components/LanguageSelect'
import { api, ApiError, errorMessage, notifyError, notifyOk } from '../lib/api'
import { useCodes } from '../lib/codes'
import { fmtDateTimeShort } from '../lib/format'

/** The page a guest link opens (/g/<token>): no login, only the doors of the pass. */
export function GuestApp({ token }: { token: string }) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  const view = useQuery({
    queryKey: ['guest', token],
    queryFn: () => api.get<GuestViewDto>(`/guest/${token}`),
    retry: false,
    refetchInterval: 60_000,
  })
  const g = view.data

  const open = (door: { id: number; name: string }) =>
    api
      .post(`/guest/${token}/doors/${door.id}/open`, g?.pinRequired ? { pin } : {})
      .then(() => notifyOk(t('mobile.opened', { door: door.name })))
      .catch(notifyError)
      .finally(() => void view.refetch())

  return (
    <Box mih="100dvh" bg="var(--mantine-color-body)">
      <Group
        justify="space-between"
        px="md"
        py="sm"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Group gap="xs">
          <img src="/icon.svg" width={28} height={28} alt="" />
          <Title order={4}>{t('app.name')}</Title>
        </Group>
        <LanguageSelect />
      </Group>
      <Container size="xs" p="md">
        {view.isLoading ? (
          <Group justify="center" mt="xl">
            <Loader />
          </Group>
        ) : view.error ? (
          <LinkError error={view.error} />
        ) : g ? (
          <Stack>
            <Title order={2}>{t('guestApp.hello', { name: g.name })}</Title>
            <Validity g={g} />
            {g.otherDevice ? (
              <Alert color="red" icon={<IconDeviceMobileOff />} title={t('guestApp.otherDeviceTitle')}>
                {t('guestApp.otherDeviceText')}
              </Alert>
            ) : g.status !== 'active' ? (
              <Alert color="orange" icon={<IconAlertTriangle />} title={t('guestApp.inactiveTitle')}>
                {t(`errors.guestStatus.${g.status}` as 'errors.guestStatus.expired')}
              </Alert>
            ) : g.doors.length === 0 ? (
              <Text c="dimmed">{t('guestApp.noDoors')}</Text>
            ) : (
              <>
                {g.pinRequired && (
                  <PasswordInput
                    label={t('guestApp.pin')}
                    description={t('guestApp.pinHint')}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    size="lg"
                    value={pin}
                    onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))}
                  />
                )}
                <Text>{t('guestApp.intro')}</Text>
                {g.doors.map((d) => (
                  <Card key={d.id} withBorder padding="md">
                    <Text fw={600} mb="sm">
                      {d.name}
                    </Text>
                    <HoldButton name={d.name} onConfirm={() => open(d)} />
                  </Card>
                ))}
                <Text size="sm" c="dimmed">
                  {t('guestApp.tip')}
                </Text>
              </>
            )}
          </Stack>
        ) : null}
        <Credits />
      </Container>
    </Box>
  )
}

function Validity({ g }: { g: GuestViewDto }) {
  const { t } = useTranslation()
  const codes = useCodes()
  const restricted = g.weekdays.some((d) => !d) || g.timeFrom !== null
  return (
    <Stack gap={2}>
      <Text size="sm" c="dimmed">
        {t('guestApp.validity', { from: fmtDateTimeShort(g.validFrom), to: fmtDateTimeShort(g.validTo) })}
      </Text>
      {restricted && (
        <Text size="sm" c="dimmed">
          {g.timeFrom && g.timeTo
            ? t('guests.validityRepeat', { days: codes.weekdaysText(g.weekdays), from: g.timeFrom, to: g.timeTo })
            : codes.weekdaysText(g.weekdays)}
        </Text>
      )}
      {g.opensLeft !== null && (
        <Text size="sm" c="dimmed">
          {t('guestApp.opensLeft', { n: g.opensLeft })}
        </Text>
      )}
    </Stack>
  )
}

function LinkError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  if (error instanceof ApiError && error.status === 404)
    return (
      <Alert color="red" icon={<IconLinkOff />} title={t('guestApp.notFoundTitle')} mt="md">
        {t('guestApp.notFoundText')}
      </Alert>
    )
  return (
    <Alert color="red" icon={<IconAlertTriangle />} mt="md">
      {errorMessage(error)}
    </Alert>
  )
}
