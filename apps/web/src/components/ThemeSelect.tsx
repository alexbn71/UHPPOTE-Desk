import {
  ActionIcon,
  Menu,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
  type MantineColorScheme,
} from '@mantine/core'
import { IconCheck, IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

const OPTIONS: { value: MantineColorScheme; icon: typeof IconSun; label: 'themeAuto' | 'themeLight' | 'themeDark' }[] =
  [
    { value: 'auto', icon: IconDeviceDesktop, label: 'themeAuto' },
    { value: 'light', icon: IconSun, label: 'themeLight' },
    { value: 'dark', icon: IconMoon, label: 'themeDark' },
  ]

/** Light/dark theme menu; the choice is remembered in the browser ("automatic" follows the system). */
export function ThemeSelect() {
  const { t } = useTranslation()
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const computed = useComputedColorScheme('light')
  const Icon = computed === 'dark' ? IconMoon : IconSun
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={t('common.theme')}>
          <ActionIcon variant="subtle" color="gray" aria-label={t('common.theme')}>
            <Icon size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        {OPTIONS.map((o) => (
          <Menu.Item
            key={o.value}
            leftSection={<o.icon size={14} />}
            rightSection={colorScheme === o.value ? <IconCheck size={14} /> : null}
            onClick={() => setColorScheme(o.value)}
          >
            {t(`common.${o.label}`)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
