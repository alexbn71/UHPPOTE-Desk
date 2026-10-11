import { Alert, Button, Center, Paper, PasswordInput, Stack, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, errorMessage, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { user, refresh, logout } = useAuth()
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== confirm) return setError(t('password.mismatch'))
    if (next.length < 8) return setError(t('password.tooShort'))
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next })
      notifyOk(t('password.updated'))
      setCurrent('')
      setNext('')
      setConfirm('')
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (user?.passwordManaged) {
    return (
      <Center mt="xl">
        <Paper withBorder shadow="sm" p="xl" w={400}>
          <Stack>
            <Title order={3}>{t('password.title')}</Title>
            <Alert color="blue">{t('password.managedInfo')}</Alert>
          </Stack>
        </Paper>
      </Center>
    )
  }

  return (
    <Center h={forced ? '100vh' : undefined} mt={forced ? 0 : 'xl'}>
      <Paper withBorder shadow="sm" p="xl" w={400}>
        <form onSubmit={submit}>
          <Stack>
            <Title order={3}>{t('password.title')}</Title>
            {forced && <Alert color="blue">{t('password.forcedInfo')}</Alert>}
            {error && <Alert color="red">{error}</Alert>}
            <PasswordInput label={t('password.current')} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} required autoComplete="current-password" />
            <PasswordInput label={t('password.new')} description={t('password.newHint')} value={next} onChange={(e) => setNext(e.currentTarget.value)} required autoComplete="new-password" />
            <PasswordInput label={t('password.repeat')} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} required autoComplete="new-password" />
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
            {forced && (
              <Button variant="subtle" onClick={() => void logout()}>
                {t('password.logout')}
              </Button>
            )}
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
