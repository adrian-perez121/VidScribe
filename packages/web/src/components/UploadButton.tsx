import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ACCEPTED_VIDEO_TYPES,
  ACCEPTED_VIDEO_ACCEPT,
  captureThumbnail,
} from '../lib/thumbnail'
import { uploadVideo } from '../lib/api'

type Status =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'uploading'; percent: number }

function UploadButton() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const navigate = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const busy = status.kind !== 'idle'

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setError(null)
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type as (typeof ACCEPTED_VIDEO_TYPES)[number])) {
      setError('Please choose an MP4 or WebM video.')
      return
    }

    setStatus({ kind: 'preparing' })
    try {
      const { dataUrl, durationSec } = await captureThumbnail(file)
      const title = file.name.replace(/\.[^.]+$/, '')
      setStatus({ kind: 'uploading', percent: 0 })
      const video = await uploadVideo({
        file,
        title,
        thumbnailDataUrl: dataUrl,
        durationSec,
        onProgress: (percent) => setStatus({ kind: 'uploading', percent }),
      })
      navigate(`/videos/${video.id}`, { state: { autoGenerateTranscript: true } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setStatus({ kind: 'idle' })
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_VIDEO_ACCEPT}
        className="hidden"
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Upload a video"
        aria-label="Upload a video"
        className="flex h-9 w-9 items-center justify-center rounded-md bg-indigo-600 text-xl font-bold leading-none text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <span className="text-xs font-normal">…</span> : '+'}
      </button>

      {busy && (
        <div className="absolute right-0 top-11 z-10 w-56 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {status.kind === 'preparing' ? (
            <p className="text-xs text-gray-600 dark:text-gray-300">Preparing video…</p>
          ) : (
            <>
              <div className="mb-1 flex justify-between text-xs text-gray-600 dark:text-gray-300">
                <span>Uploading…</span>
                <span>{status.percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-[width] duration-150"
                  style={{ width: `${status.percent}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="absolute right-0 top-11 z-10 w-56 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-500 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}

export default UploadButton
