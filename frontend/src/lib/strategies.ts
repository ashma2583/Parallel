/** Response policies. Mirrors STRATEGIES in backend/agents/logic.py. */
export interface Strategy {
  id: string
  label: string
  description: string
}

export const STRATEGIES: Strategy[] = [
  { id: 'tiered', label: 'Priority tiers', description: 'Shed the lowest priority tier first. Critical care is never shed.' },
  { id: 'residential', label: 'Protect residential', description: 'Keep dorms powered. Academic and commons buildings go dark first.' },
  { id: 'academic', label: 'Protect classes', description: 'Keep classrooms and libraries powered. Residence halls go dark first.' },
  { id: 'people', label: 'Most people per kW', description: 'Shed the buildings that serve the fewest people per kilowatt first.' },
  { id: 'even', label: 'Ration evenly', description: 'No load shedding. Every building on the feed gets the same share.' },
]

export const DEFAULT_STRATEGY = 'tiered'

export function strategyFor(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]
}
