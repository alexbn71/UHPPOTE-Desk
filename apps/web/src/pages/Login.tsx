import { Alert, Button, Center, Checkbox, Group, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Credits } from '../components/Credits'
import { LanguageSelect } from '../components/LanguageSelect'
import { ThemeSelect } from '../components/ThemeSelect'
import { api, ApiError, errorMessage } from '../lib/api'
import type { CurrentUser } from '../lib/auth'
import { deviceName, prefersRemember } from '../lib/device'
import { TotpCodeInput } from './TwoFactor'

export function LoginPage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(prefersRemember)
  /** Second step: the password was right and the operator has two-factor authentication. */
  const [askCode, setAskCode] = useState(false)
  const [code, setCode] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ user: CurrentUser }>('/auth/login', {
        username,
        password,
        remember,
        deviceName: deviceName(),
        totp: askCode ? code : undefined,
      })
      qc.setQueryData(['me'], r.user)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totpRequired') {
        setAskCode(true)
        return
      }
      if (askCode) setCode('')
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Stack gap={0} align="center">
        <Paper withBorder shadow="md" p="xl" w={360} maw="calc(100vw - 32px)">
          <form onSubmit={submit}>
            <Stack>
              <Group justify="flex-end" gap="xs" mb={-16}>
                <ThemeSelect />
                <LanguageSelect />
              </Group>
              <Center>
                <img src="/icon.svg" width={64} height={64} alt="" />
              </Center>
              <Title order={3} ta="center">
                {t('app.name')}
              </Title>
              {error && <Alert color="red">{error}</Alert>}
              {askCode ? (
                <>
                  <TotpCodeInput
                    value={code}
                    onChange={setCode}
                    label={t('login.totp')}
                    description={t('login.totpHint')}
                    recovery
                  />
                  <Button type="submit" loading={busy} fullWidth>
                    {t('login.submit')}
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => {
                      setAskCode(false)
                      setCode('')
                      setPassword('')
                      setError(null)
                    }}
                  >
                    {t('login.back')}
                  </Button>
                </>
              ) : (
                <>
                  <TextInput
                    label={t('login.username')}
                    value={username}
                    onChange={(e) => setUsername(e.currentTarget.value)}
                    autoFocus
                    required
                    autoComplete="username"
                  />
                  <PasswordInput
                    label={t('login.password')}
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    required
                    autoComplete="current-password"
                  />
                  <Checkbox
                    label={t('login.remember')}
                    description={t('login.rememberHint')}
                    checked={remember}
                    onChange={(e) => setRemember(e.currentTarget.checked)}
                  />
                  <Button type="submit" loading={busy} fullWidth>
                    {t('login.submit')}
                  </Button>
                </>
              )}
            </Stack>
          </form>
        </Paper>
        <Credits />
      </Stack>
    </Center>
  )
}
