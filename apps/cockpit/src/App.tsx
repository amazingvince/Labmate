import { useRoute } from './lib/router'
import { StudyListView } from '@/components/views/StudyListView'
import { StudyView } from '@/components/views/StudyView'
import { NewStudyView } from '@/components/views/NewStudyView'

export function App() {
  const route = useRoute()
  if (route.name === 'study') {
    return <StudyView studyId={route.id} tab={route.tab} key={route.id} />
  }
  if (route.name === 'new') {
    return <NewStudyView />
  }
  return <StudyListView />
}
