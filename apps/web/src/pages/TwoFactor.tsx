import {
  Alert,
  Badge,
  Button,
  Center,
  Code,
  Group,
  Image,
  Loader,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { IconCopy, IconDownload } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '../components/CopyButton'
import { api, errorMessage, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'

interface TotpStatus {
  enabled: boolean
  required: boolean
  recoveryCodesLeft: number
}

type Step =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; qr: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'newCodes' }
  | { kind: 'disable' }

/** Code field for an authenticator app (6 digits; recovery codes allowed where `recovery`). */
export function TotpCodeInput({
  value,
  onChange,
  label,
  description,
  recovery = false,
  autoFocus = true,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  description?: string
  recovery?: boolean
  autoFocus?: boolean
}) {
  return (
    <TextInput
      label={label}
      description={description}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      autoFocus={autoFocus}
      required
      autoComplete="one-time-code"
      inputMode={recovery ? 'text' : 'numeric'}
      maxLength={recovery ? 40 : 7}
      className="mono"
    />
  )
}

/** Account page: two-factor authentication of the logged-in operator (forced when the administrators require it for the role). */
export function TwoFactorPage({ forced = false }: { forced?: boolean }) {
  const { t } = useTranslation()
  const { user, refresh, logout } = useAuth()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['totp'], queryFn: () => api.get<TotpStatus>('/auth/totp') })
  const [step, setStep] = useState<Step>(forced ? { kind: 'password' } : { kind: 'idle' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const go = (next: Step) => {
    setStep(next)
    setPassword('')
    setCode('')
    setError(null)
  }

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const startSetup = run(async () => {
    const r = await api.post<{ secret: string; qr: string }>('/auth/totp/setup', { password })
    go({ kind: 'scan', secret: r.secret, qr: r.qr })
  })

  const confirmSetup = run(async () => {
    const r = await api.post<{ recoveryCodes: string[] }>('/auth/totp/enable', { code })
    notifyOk(t('twoFactor.enabled'))
    // the user is refreshed only after the codes have been saved: with a forced setup it would leave this page
    go({ kind: 'codes', codes: r.recoveryCodes })
  })

  const newCodes = run(async () => {
    const r = await api.post<{ recoveryCodes: string[] }>('/auth/totp/recovery-codes', { code })
    go({ kind: 'codes', codes: r.recoveryCodes })
  })

  const disable = run(async () => {
    await api.post('/auth/totp/disable', { password, code })
    notifyOk(t('twoFactor.disabled'))
    go({ kind: 'idle' })
    void qc.invalidateQueries({ queryKey: ['totp'] })
    await refresh()
  })

  const codesDone = async () => {
    go({ kind: 'idle' })
    void qc.invalidateQueries({ queryKey: ['totp'] })
    await refresh()
  }

  const cancel = () => go({ kind: 'idle' })
  const s = status.data

  return (
    <Center h={forced ? '100vh' : undefined} mt={forced ? 0 : 'xl'}>
      <Paper withBorder shadow="sm" p="xl" w={480} maw="calc(100vw - 32px)">
        <Stack>
          <Group justify="space-between" wrap="nowrap">
            <Title order={3}>{t('twoFactor.title')}</Title>
            {s && (
              <Badge color={s.enabled ? 'green' : 'gray'} variant="light">
                {s.enabled ? t('twoFactor.statusOn') : t('twoFactor.statusOff')}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {t('twoFactor.description')}
          </Text>
          {forced && <Alert color="blue">{t('twoFactor.requiredInfo')}</Alert>}
          {error && <Alert color="red">{error}</Alert>}
          {status.isLoading && <Loader size="sm" />}

          {step.kind === 'idle' && s && !s.enabled && (
            <Button onClick={() => go({ kind: 'password' })}>{t('twoFactor.enable')}</Button>
          )}

          {step.kind === 'idle' && s?.enabled && (
            <>
              <Text size="sm">{t('twoFactor.recoveryLeft', { n: s.recoveryCodesLeft })}</Text>
              {s.recoveryCodesLeft <= 3 && <Alert color="yellow">{t('twoFactor.recoveryLow')}</Alert>}
              <Group>
                <Button variant="default" onClick={() => go({ kind: 'newCodes' })}>
                  {t('twoFactor.newCodes')}
                </Button>
                {s.required ? (
                  <Text size="xs" c="dimmed">
                    {t('twoFactor.requiredByPolicy')}
                  </Text>
                ) : (
                  <Button variant="light" color="red" onClick={() => go({ kind: 'disable' })}>
                    {t('twoFactor.disable')}
                  </Button>
                )}
              </Group>
            </>
          )}

          {step.kind === 'password' && (
            <form onSubmit={startSetup}>
              <Stack>
                <PasswordInput
                  label={t('twoFactor.passwordPrompt')}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                  autoFocus
                  autoComplete="current-password"
                />
                <Group>
                  <Button type="submit" loading={busy}>
                    {t('twoFactor.continue')}
                  </Button>
                  {!forced && (
                    <Button variant="subtle" onClick={cancel}>
                      {t('common.cancel')}
                    </Button>
                  )}
                </Group>
              </Stack>
            </form>
          )}

          {step.kind === 'scan' && (
            <form onSubmit={confirmSetup}>
              <Stack>
                <Text size="sm">{t('twoFactor.scan')}</Text>
                <Center>
                  <Image
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(step.qr)}`}
                    w={200}
                    h={200}
                    bg="white"
                    p={6}
                    radius="sm"
                    alt="QR"
                  />
                </Center>
                <Group gap="xs" wrap="nowrap" justify="center">
                  <Code className="mono" style={{ wordBreak: 'break-all' }}>
                    {step.secret.replace(/(.{4})/g, '$1 ').trim()}
                  </Code>
                  <CopyButton value={step.secret}>
                    {({ copied, copy }) => (
                      <Button size="compact-xs" variant="subtle" onClick={copy} leftSection={<IconCopy size={14} />}>
                        {copied ? t('twoFactor.copied') : t('twoFactor.copy')}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
                <TotpCodeInput value={code} onChange={setCode} label={t('twoFactor.code')} />
                <Group>
                  <Button type="submit" loading={busy}>
                    {t('common.confirm')}
                  </Button>
                  {!forced && (
                    <Button variant="subtle" onClick={cancel}>
                      {t('common.cancel')}
                    </Button>
                  )}
                </Group>
              </Stack>
            </form>
          )}

          {step.kind === 'codes' && (
            <RecoveryCodes codes={step.codes} username={user?.username ?? ''} onDone={codesDone} />
          )}

          {step.kind === 'newCodes' && (
            <form onSubmit={newCodes}>
              <Stack>
                <Text size="sm">{t('twoFactor.newCodesInfo')}</Text>
                <TotpCodeInput value={code} onChange={setCode} label={t('twoFactor.code')} />
                <Group>
                  <Button type="submit" loading={busy}>
                    {t('common.confirm')}
                  </Button>
                  <Button variant="subtle" onClick={cancel}>
                    {t('common.cancel')}
                  </Button>
                </Group>
              </Stack>
            </form>
          )}

          {step.kind === 'disable' && (
            <form onSubmit={disable}>
              <Stack>
                <Text size="sm">{t('twoFactor.disableInfo')}</Text>
                <PasswordInput
                  label={t('login.password')}
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                  autoFocus
                  autoComplete="current-password"
                />
                <TotpCodeInput
                  value={code}
                  onChange={setCode}
                  label={t('login.totp')}
                  description={t('login.totpHint')}
                  recovery
                  autoFocus={false}
                />
                <Group>
                  <Button type="submit" color="red" loading={busy}>
                    {t('twoFactor.disable')}
                  </Button>
                  <Button variant="subtle" onClick={cancel}>
                    {t('common.cancel')}
                  </Button>
                </Group>
              </Stack>
            </form>
          )}

          {forced && step.kind !== 'codes' && (
            <Button variant="subtle" onClick={() => void logout()}>
              {t('password.logout')}
            </Button>
          )}
        </Stack>
      </Paper>
    </Center>
  )
}

/** The recovery codes, shown once, with copy and download. */
function RecoveryCodes({ codes, username, onDone }: { codes: string[]; username: string; onDone: () => void }) {
  const { t } = useTranslation()
  const text = codes.join('\n')
  const download = () => {
    const blob = new Blob([`UHPPOTE Desk — ${username}\n\n${text}\n`], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `uhppote-desk-recovery-${username}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <Stack>
      <Title order={5}>{t('twoFactor.recoveryTitle')}</Title>
      <Alert color="yellow">{t('twoFactor.recoveryInfo')}</Alert>
      <SimpleGrid cols={2} spacing="xs">
        {codes.map((c) => (
          <Code key={c} className="mono" ta="center">
            {c}
          </Code>
        ))}
      </SimpleGrid>
      <Group>
        <CopyButton value={text}>
          {({ copied, copy }) => (
            <Button variant="default" onClick={copy} leftSection={<IconCopy size={16} />}>
              {copied ? t('twoFactor.copied') : t('twoFactor.copy')}
            </Button>
          )}
        </CopyButton>
        <Button variant="default" onClick={download} leftSection={<IconDownload size={16} />}>
          {t('twoFactor.download')}
        </Button>
      </Group>
      <Button onClick={onDone}>{t('twoFactor.saved')}</Button>
    </Stack>
  )
}
