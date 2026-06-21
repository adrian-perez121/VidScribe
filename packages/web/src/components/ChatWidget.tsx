import { useEffect, useRef, useState } from 'react'
import { Link, useMatch } from 'react-router-dom'
import type { ChatSource } from '@vid-mark/shared'
import { sendChat, getVideo } from '../lib/api'

// Floating study-chatbot widget, available on every page. Asks POST /api/chat,
// which searches across the student's notes/research/lens explanations and
// answers with Claude, returning the video(s) the answer came from as `sources`.
// The conversation is threaded with a session id persisted in localStorage so
// follow-up questions ("explain that more simply") keep context.

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[]
}

const SESSION_KEY = 'vidscribe:chat:session'

function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}

function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const sessionId = useRef<string>(getSessionId())
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // When we're on a video's page, offer to scope the chat to just that video.
  const videoMatch = useMatch('/videos/:id')
  const videoId = videoMatch?.params.id ?? ''
  const [videoTitle, setVideoTitle] = useState('')
  const [scopeToVideo, setScopeToVideo] = useState(true)

  // Reset the scope and pull the title whenever the current video changes.
  useEffect(() => {
    if (!videoId) {
      setVideoTitle('')
      return
    }
    setScopeToVideo(true)
    let cancelled = false
    getVideo(videoId)
      .then((v) => {
        if (!cancelled) setVideoTitle(v.title)
      })
      .catch(() => {
        /* title is cosmetic — ignore */
      })
    return () => {
      cancelled = true
    }
  }, [videoId])

  // Keep the latest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setSending(true)
    try {
      const scopedVideoId = videoId && scopeToVideo ? videoId : undefined
      const { answer, sources } = await sendChat(text, sessionId.current, scopedVideoId)
      setMessages((prev) => [...prev, { role: 'assistant', content: answer, sources }])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: err instanceof Error ? err.message : 'Something went wrong.' },
      ])
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        aria-label={open ? 'Close study chat' : 'Open study chat'}
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-2xl text-white shadow-lg transition hover:bg-indigo-500"
      >
        {open ? '✕' : '💬'}
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[32rem] w-[22rem] flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-2xl sm:w-96">
          <div className="shrink-0 border-b border-gray-800 px-4 py-3">
            <p className="text-sm font-semibold text-gray-100">Study chat</p>
            <p className="text-xs text-gray-400">Ask about anything in your videos</p>
          </div>

          {/* On a video page: scope toggle (this video vs. everything). */}
          {videoId && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-800 bg-gray-950/60 px-4 py-2 text-xs">
              <span className="truncate text-gray-400">
                {scopeToVideo ? (
                  <>
                    Asking about <span className="text-gray-200">{videoTitle || 'this video'}</span>
                  </>
                ) : (
                  'Asking across all videos'
                )}
              </span>
              <button
                type="button"
                onClick={() => setScopeToVideo((s) => !s)}
                className="shrink-0 rounded border border-gray-700 px-2 py-0.5 text-gray-300 hover:bg-gray-800"
              >
                {scopeToVideo ? 'All videos' : 'This video'}
              </button>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="mt-8 text-center text-sm text-gray-500">
                Ask a question about your notes and lectures to get started.
              </p>
            )}

            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    'max-w-[85%] rounded-lg px-3 py-2 text-sm ' +
                    (m.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-100')
                  }
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>

                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-gray-700 pt-2">
                      {m.sources.map((s) => (
                        <Link
                          key={s.video_id}
                          to={`/videos/${s.video_id}`}
                          onClick={() => setOpen(false)}
                          className="rounded bg-gray-900 px-1.5 py-0.5 text-xs text-indigo-300 hover:text-indigo-200"
                          title={s.video_title}
                        >
                          ▶ {s.video_title}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-400">Thinking…</div>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-gray-800 p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder="Ask a question…"
                className="max-h-28 flex-1 resize-none rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || !input.trim()}
                className="shrink-0 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default ChatWidget
