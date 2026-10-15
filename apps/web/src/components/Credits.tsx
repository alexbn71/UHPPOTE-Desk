import { Anchor, Text } from '@mantine/core'

/** Source of the application, linked from the credits (AGPL-3.0, section 13). */
export const SOURCE_URL = 'https://github.com/alexbn71/UHPPOTE-Desk'

/**
 * Author credits shown at the bottom of every screen. They must stay visible and unaltered in
 * any modified version: see ADDITIONAL-TERMS.md (AGPL-3.0, section 7(b)).
 */
export function Credits() {
  return (
    <Text component="footer" size="xs" c="dimmed" ta="center" py="sm" data-testid="credits">
      UHPPOTE Desk © 2026 Alessandro Blason · AGPL-3.0 ·{' '}
      <Anchor href={SOURCE_URL} target="_blank" rel="noopener noreferrer" inherit>
        Source code
      </Anchor>
    </Text>
  )
}
