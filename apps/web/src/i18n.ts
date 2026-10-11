import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import dayjs from 'dayjs'
import localizedFormat from 'dayjs/plugin/localizedFormat'
import 'dayjs/locale/de'
import 'dayjs/locale/es'
import 'dayjs/locale/fr'
import 'dayjs/locale/it'
import { DEFAULT_LANGUAGE, LANGUAGES, resources, type Messages } from '@uhppote-desk/shared'

dayjs.extend(localizedFormat)

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: Messages }
  }
}

export const LANGUAGE_STORAGE_KEY = 'uhd.lang'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: Object.fromEntries(Object.entries(resources).map(([lng, messages]) => [lng, { translation: messages }])),
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnNull: false,
  })

const syncDocumentLanguage = (lng: string) => {
  const code = lng.slice(0, 2)
  document.documentElement.lang = code
  dayjs.locale(code)
}
syncDocumentLanguage(i18n.resolvedLanguage ?? DEFAULT_LANGUAGE)
i18n.on('languageChanged', syncDocumentLanguage)

export default i18n
