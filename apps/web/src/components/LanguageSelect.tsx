import { ActionIcon, Menu, Tooltip } from '@mantine/core'
import { IconCheck, IconLanguage } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { LANGUAGES } from '@uhppote-desk/shared'

/** Language menu; the choice is remembered in the browser. */
export function LanguageSelect() {
  const { t, i18n } = useTranslation()
  const current = (i18n.resolvedLanguage ?? 'en').slice(0, 2)
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={t('common.language')}>
          <ActionIcon variant="subtle" color="gray" aria-label={t('common.language')}>
            <IconLanguage size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        {LANGUAGES.map((l) => (
          <Menu.Item
            key={l.code}
            onClick={() => void i18n.changeLanguage(l.code)}
            rightSection={current === l.code ? <IconCheck size={14} /> : null}
            lang={l.code}
          >
            {l.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}
