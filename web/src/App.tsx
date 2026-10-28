import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { GraphProvider } from './api/hooks'
import { Shell } from './components/Shell'
import { BlastRadius } from './screens/BlastRadius'
import { EnterChange } from './screens/EnterChange'
import { Feed } from './screens/Feed'
import { GraphView } from './screens/GraphView'
import { IncidentScreen } from './screens/Incident'
import { NotFound } from './screens/NotFound'
import { Policy } from './screens/Policy'
import { Record } from './screens/Record'
import { TaskMessage } from './screens/TaskMessage'

export function App() {
  return (
    <BrowserRouter>
      <GraphProvider>
        <Routes>
          <Route path="/task/:taskId" element={<TaskMessage />} />
          <Route element={<Shell />}>
            <Route index element={<Feed />} />
            <Route path="/enter" element={<EnterChange />} />
            <Route path="/runs/:runId" element={<BlastRadius />} />
            <Route path="/runs/:runId/incident" element={<IncidentScreen />} />
            <Route path="/graph" element={<GraphView />} />
            <Route path="/policy" element={<Policy />} />
            <Route path="/record" element={<Record />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </GraphProvider>
    </BrowserRouter>
  )
}
