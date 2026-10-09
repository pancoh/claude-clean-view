import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'

// Each mod registers its hooks here, one call per mod.
export const register: Register = on => {
  registerCleanView(on)
}
