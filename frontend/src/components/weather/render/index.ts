/** One renderer per kind of storm. */
import type { StormKind } from '../../../lib/weather/types'
import { blackout } from './blackout'
import { blizzard } from './blizzard'
import { closure } from './closure'
import { flood } from './flood'
import { ice } from './ice'
import { lightning } from './lightning'
import { thunderstorm } from './thunderstorm'
import { tornado } from './tornado'
import type { KindRenderer } from './types'

export const RENDERERS: Record<StormKind, KindRenderer> = {
  tornado,
  thunderstorm,
  ice,
  flood,
  blizzard,
  lightning,
  blackout,
  closure,
}
