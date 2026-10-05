/** The waitlist form's choices, shared by the form and the route that checks it. */
export const INTERESTS = [
  { id: 'fleet', label: 'I run agents that pay per call' },
  { id: 'finance', label: 'I own the bill for our agents' },
  { id: 'vendor', label: 'I sell an API to agents' },
  { id: 'curious', label: 'Just following along' },
] as const

export const FLEETS = [
  { id: '1-3', label: '1–3 agents' },
  { id: '4-20', label: '4–20' },
  { id: '21-100', label: '21–100' },
  { id: '100+', label: '100+' },
] as const
