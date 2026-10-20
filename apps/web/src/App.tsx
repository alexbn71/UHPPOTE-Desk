import {
  AppShell,
  Badge,
  Burger,
  Center,
  Collapse,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconActivity,
  IconBolt,
  IconAlertTriangle,
  IconBell,
  IconApi,
  IconCalendarTime,
  IconChevronDown,
  IconDeviceMobile,
  IconChecklist,
  IconClockHour4,
  IconCpu,
  IconDashboard,
  IconDoor,
  IconHistory,
  IconId,
  IconKey,
  IconLogout,
  IconRefresh,
  IconReportAnalytics,
  IconUserCheck,
  IconSettings,
  IconSitemap,
  IconTicket,
  IconUsers,
  IconUserShield,
  IconWebhook,
} from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import type { Role } from '@uhppote-desk/shared'
import { Credits } from './components/Credits'
import { LanguageSelect } from './components/LanguageSelect'
import { ThemeSelect } from './components/ThemeSelect'
import { useAuth } from './lib/auth'
import { useCodes } from './lib/codes'
import { LiveProvider, useLive } from './lib/live'
import { AnomaliesPage } from './pages/Anomalies'
import { ApiTokensPage } from './pages/ApiTokens'
import { AttendancePage } from './pages/Attendance'
import { AuditPage } from './pages/Audit'
import { CardsPage } from './pages/Cards'
import { ChangePasswordPage } from './pages/ChangePassword'
import { ControllerDetailPage } from './pages/ControllerDetail'
import { ControllersPage } from './pages/Controllers'
import { DashboardPage } from './pages/Dashboard'
import { DoorsPage } from './pages/Doors'
import { EventsPage } from './pages/Events'
import { GuestsPage } from './pages/Guests'
import { LoginPage } from './pages/Login'
import { MobileAdminPage } from './pages/MobileAdmin'
import { MobileApp } from './pages/MobileApp'
import { MonitorPage } from './pages/Monitor'
import { NotificationsPage } from './pages/Notifications'
import { OperatorsPage } from './pages/Operators'
import { PeoplePage } from './pages/People'
import { PermissionsPage } from './pages/Permissions'
import { PresencePage } from './pages/Presence'
import { RulesPage } from './pages/Rules'
import { StructurePage } from './pages/Structure'
import { SyncPage } from './pages/Sync'
import { SystemPage } from './pages/System'
import { TasksPage } from './pages/Tasks'
import { TimeProfilesPage } from './pages/TimeProfiles'
import { WebhooksPage } from './pages/Webhooks'

type NavKey =
  | 'dashboard'
  | 'monitor'
  | 'events'
  | 'presence'
  | 'attendance'
  | 'anomalies'
  | 'people'
  | 'cards'
  | 'guests'
  | 'permissions'
  | 'structure'
  | 'controllers'
  | 'doors'
  | 'timeProfiles'
  | 'tasks'
  | 'sync'
  | 'operators'
  | 'audit'
  | 'webhooks'
  | 'apiTokens'
  | 'mobile'
  | 'notifications'
  | 'rules'
  | 'systemInfo'

interface NavItem {
  to: string
  label: NavKey
  icon: ReactNode
  role: Role
}

const NAV: { section: 'operations' | 'registry' | 'configuration' | 'administration'; items: NavItem[] }[] = [
  {
    section: 'operations',
    items: [
      { to: '/', label: 'dashboard', icon: <IconDashboard size={18} />, role: 'viewer' },
      { to: '/monitor', label: 'monitor', icon: <IconActivity size={18} />, role: 'viewer' },
      { to: '/events', label: 'events', icon: <IconHistory size={18} />, role: 'viewer' },
      { to: '/presence', label: 'presence', icon: <IconUserCheck size={18} />, role: 'viewer' },
      { to: '/attendance', label: 'attendance', icon: <IconReportAnalytics size={18} />, role: 'viewer' },
      { to: '/anomalies', label: 'anomalies', icon: <IconAlertTriangle size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'registry',
    items: [
      { to: '/people', label: 'people', icon: <IconUsers size={18} />, role: 'viewer' },
      { to: '/cards', label: 'cards', icon: <IconId size={18} />, role: 'viewer' },
      { to: '/guests', label: 'guests', icon: <IconTicket size={18} />, role: 'operator' },
      { to: '/permissions', label: 'permissions', icon: <IconKey size={18} />, role: 'viewer' },
      { to: '/structure', label: 'structure', icon: <IconSitemap size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'configuration',
    items: [
      { to: '/controllers', label: 'controllers', icon: <IconCpu size={18} />, role: 'viewer' },
      { to: '/doors', label: 'doors', icon: <IconDoor size={18} />, role: 'viewer' },
      { to: '/time-profiles', label: 'timeProfiles', icon: <IconClockHour4 size={18} />, role: 'viewer' },
      { to: '/tasks', label: 'tasks', icon: <IconCalendarTime size={18} />, role: 'viewer' },
      { to: '/sync', label: 'sync', icon: <IconRefresh size={18} />, role: 'operator' },
    ],
  },
  {
    section: 'administration',
    items: [
      { to: '/operators', label: 'operators', icon: <IconUserShield size={18} />, role: 'admin' },
      { to: '/audit', label: 'audit', icon: <IconChecklist size={18} />, role: 'admin' },
      { to: '/rules', label: 'rules', icon: <IconBolt size={18} />, role: 'admin' },
      { to: '/notifications', label: 'notifications', icon: <IconBell size={18} />, role: 'admin' },
      { to: '/webhooks', label: 'webhooks', icon: <IconWebhook size={18} />, role: 'admin' },
      { to: '/mobile-app', label: 'mobile', icon: <IconDeviceMobile size={18} />, role: 'admin' },
      { to: '/api-tokens', label: 'apiTokens', icon: <IconApi size={18} />, role: 'admin' },
      { to: '/system', label: 'systemInfo', icon: <IconSettings size={18} />, role: 'viewer' },
    ],
  },
]

type Section = (typeof NAV)[number]['section']

/** Menu sections collapsed by the user, remembered in the browser; configuration and administration start collapsed. */
const COLLAPSED_KEY = 'uhd.nav.collapsed'
const DEFAULT_COLLAPSED: Section[] = ['configuration', 'administration']

function loadCollapsed(): Section[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? (JSON.parse(raw) as Section[]) : DEFAULT_COLLAPSED
  } catch {
    return DEFAULT_COLLAPSED
  }
}

function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<Section[]>(loadCollapsed)
  const update = (next: Section[]) => {
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      // storage unavailable (private mode): the choice lasts until the page is reloaded
    }
  }
  const toggle = (s: Section) => update(collapsed.includes(s) ? collapsed.filter((x) => x !== s) : [...collapsed, s])
  const expand = (s: Section) => collapsed.includes(s) && update(collapsed.filter((x) => x !== s))
  return { collapsed, toggle, expand }
}

const isActive = (to: string, path: string) => (to === '/' ? path === '/' : path.startsWith(to))

function Shell({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure()
  const { user, logout, can } = useAuth()
  const { t } = useTranslation()
  const codes = useCodes()
  const live = useLive()
  const location = useLocation()
  const navigate = useNavigate()
  const sections = useCollapsedSections()

  // opening a page of a collapsed section (link, reload) expands that section
  const activeSection = NAV.find((s) => s.items.some((i) => isActive(i.to, location.pathname)))?.section
  useEffect(() => {
    if (activeSection) sections.expand(activeSection)
    // only when the page changes: a section collapsed by hand on the current page stays collapsed
  }, [activeSection])

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <img src="/icon.svg" width={28} height={28} alt="" />
            <Title order={4} visibleFrom="xs">
              {t('app.name')}
            </Title>
            <Tooltip label={live.connected ? t('nav.liveOn') : t('nav.liveOff')}>
              <Badge color={live.connected ? 'green' : 'red'} variant="dot">
                {live.connected ? t('common.live') : t('common.offline')}
              </Badge>
            </Tooltip>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" visibleFrom="xs">
              {user?.displayName} · {user ? codes.role(user.role) : ''}
            </Text>
            <Tooltip label={t('nav.mobile')}>
              <UnstyledButton onClick={() => navigate('/m')} aria-label={t('nav.mobile')}>
                <IconDeviceMobile size={20} />
              </UnstyledButton>
            </Tooltip>
            <ThemeSelect />
            <LanguageSelect />
            {!user?.passwordManaged && (
              <Tooltip label={t('nav.changePassword')}>
                <UnstyledButton onClick={() => navigate('/password')}>
                  <IconKey size={20} />
                </UnstyledButton>
              </Tooltip>
            )}
            <Tooltip label={t('nav.logout')}>
              <UnstyledButton onClick={() => void logout()}>
                <IconLogout size={20} />
              </UnstyledButton>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((section) => {
            const items = section.items.filter((i) => can(i.role))
            if (!items.length) return null
            const open = !sections.collapsed.includes(section.section)
            return (
              <div key={section.section}>
                <UnstyledButton
                  w="100%"
                  px="sm"
                  pt="sm"
                  pb={4}
                  onClick={() => sections.toggle(section.section)}
                  aria-expanded={open}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                      {t(`nav.${section.section}`)}
                    </Text>
                    <IconChevronDown
                      size={14}
                      color="var(--mantine-color-dimmed)"
                      style={{ transform: open ? undefined : 'rotate(-90deg)', transition: 'transform 150ms ease' }}
                    />
                  </Group>
                </UnstyledButton>
                <Collapse expanded={open}>
                  {items.map((item) => (
                    <NavLink
                      key={item.to}
                      label={t(`nav.${item.label}`)}
                      leftSection={item.icon}
                      active={isActive(item.to, location.pathname)}
                      onClick={() => {
                        navigate(item.to)
                        close()
                      }}
                    />
                  ))}
                </Collapse>
              </div>
            )
          })}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        {children}
        <Credits />
      </AppShell.Main>
    </AppShell>
  )
}

function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useAuth()
  return can(role) ? <>{children}</> : <Navigate to="/" replace />
}

export function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  return (
    <BrowserRouter>
      {!user ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : user.mustChangePassword ? (
        <ChangePasswordPage forced />
      ) : (
        <LiveProvider enabled>
          <Routes>
            {/* mobile app: full screen, without the menu */}
            <Route path="/m" element={<MobileApp />} />
            <Route
              path="*"
              element={
                <Shell>
                  <Routes>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/monitor" element={<MonitorPage />} />
                    <Route path="/events" element={<EventsPage />} />
                    <Route path="/presence" element={<PresencePage />} />
                    <Route path="/attendance" element={<AttendancePage />} />
                    <Route path="/anomalies" element={<AnomaliesPage />} />
                    <Route path="/people" element={<PeoplePage />} />
                    <Route path="/cards" element={<CardsPage />} />
                    <Route
                      path="/guests"
                      element={
                        <Guard role="operator">
                          <GuestsPage />
                        </Guard>
                      }
                    />
                    <Route path="/permissions" element={<PermissionsPage />} />
                    <Route path="/structure" element={<StructurePage />} />
                    <Route path="/controllers" element={<ControllersPage />} />
                    <Route path="/controllers/:id" element={<ControllerDetailPage />} />
                    <Route path="/doors" element={<DoorsPage />} />
                    <Route path="/time-profiles" element={<TimeProfilesPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route
                      path="/sync"
                      element={
                        <Guard role="operator">
                          <SyncPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/operators"
                      element={
                        <Guard role="admin">
                          <OperatorsPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/audit"
                      element={
                        <Guard role="admin">
                          <AuditPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/rules"
                      element={
                        <Guard role="admin">
                          <RulesPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/notifications"
                      element={
                        <Guard role="admin">
                          <NotificationsPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/mobile-app"
                      element={
                        <Guard role="admin">
                          <MobileAdminPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/webhooks"
                      element={
                        <Guard role="admin">
                          <WebhooksPage />
                        </Guard>
                      }
                    />
                    <Route
                      path="/api-tokens"
                      element={
                        <Guard role="admin">
                          <ApiTokensPage />
                        </Guard>
                      }
                    />
                    <Route path="/system" element={<SystemPage />} />
                    <Route path="/password" element={<ChangePasswordPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Shell>
              }
            />
          </Routes>
        </LiveProvider>
      )}
    </BrowserRouter>
  )
}
