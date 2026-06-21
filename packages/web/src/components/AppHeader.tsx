import { Link } from 'react-router-dom'
import UploadButton from './UploadButton'
import { useTheme } from '../lib/theme'

function AppHeader() {
  const { theme, toggleTheme } = useTheme()

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-800 dark:bg-gray-950">
      <Link to="/" className="block">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Vidscribe
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          video notes that remember the moment
        </p>
      </Link>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <UploadButton />
      </div>
    </header>
  )
}

export default AppHeader
