import { runTone } from '../../lib/tones.ts'
import { Badge } from '../../ui/index.ts'

// `cached`: a cache hit, which ran nothing (its run points to the run it reuses).
export const RunState = ({
  state,
  failureClass,
  cached,
}: {
  state: string
  failureClass?: string | null
  cached?: boolean
}) => (
  <Badge tone={runTone(state)} notes={[failureClass, cached && 'cached']}>
    {state}
  </Badge>
)
