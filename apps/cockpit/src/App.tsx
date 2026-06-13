import { useRoute } from './lib/router'
import { StudyList } from './components/StudyList'
import { StudyDetail } from './components/StudyDetail'

export function App() {
  const route = useRoute()
  return (
    <>
      <div className="crt" aria-hidden="true" />
      {route.name === 'study' ? (
        <StudyDetail studyId={route.id} key={route.id} />
      ) : (
        <StudyList />
      )}
    </>
  )
}
