import { Link } from 'react-router-dom'
import UploadButton from './UploadButton'

// Shared top bar: the Vidscribe title (links home), a link to the dashboard,
// and the "+" upload button in the top right.

function AppHeader() {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-gray-800 px-6 py-4">
      <Link to="/" className="block">
        <h1 className="text-2xl font-bold tracking-tight">Vidscribe</h1>
        <p className="text-sm text-gray-400">video notes that remember the moment</p>
      </Link>
      <div className="flex items-center gap-2">
        <UploadButton />
      </div>
    </header>
  )
}

export default AppHeader
