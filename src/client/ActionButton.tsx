/**
 * An icon-only write on a plugin card.
 *
 * The verb lives in a delayed Tooltip, not beside the glyph: four of these on
 * a row would crowd the title they sit next to. Delay and placement match the
 * header utility switches (`omdsh-sidepanel`, `omdsh-sidechat`): 500 ms, below.
 *
 * The Tooltip wraps a span rather than {@link Button} itself: the primitive
 * does not forward a ref, and a disabled native button never fires mouseenter
 * — the "up to date" Update still has to explain itself.
 * @module @omdsh-plugins/omdsh-plughub/client/ActionButton
 */

import type { ReactNode } from 'react'
import { Button, Tooltip, type ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Panel.module.css'

/** Hover delay shared with the header utility switches. */
export const ACTION_TOOLTIP_DELAY_MS = 500

/** Props of one icon-only card action. */
export interface ActionButtonProps {
  readonly label: string
  readonly variant?: ButtonVariant
  readonly disabled: boolean
  readonly icon: ReactNode
  readonly onClick: () => void
}

/**
 * Render one icon-only action.
 * @param props - the label, look, and click.
 * @returns the tooltip-wrapped button.
 */
export function ActionButton({
  label, variant = 'ghost', disabled, icon, onClick,
}: ActionButtonProps): ReactNode {
  return (
    <Tooltip label={label} side="bottom" delayMs={ACTION_TOOLTIP_DELAY_MS}>
      <span className={css.action}>
        <Button
          variant={variant}
          size="sm"
          disabled={disabled}
          icon={icon}
          aria-label={label}
          onClick={onClick}
        />
      </span>
    </Tooltip>
  )
}
