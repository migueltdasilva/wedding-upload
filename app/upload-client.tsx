'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

// ── Types ──
type UploadStatus = 'pending' | 'uploading' | 'done' | 'error'

interface FileEntry {
  id: string
  file: File
  status: UploadStatus
  progress: number
  error?: string
  objectUrl?: string
}

// ── Constants ──
const CHUNK_SIZE = 4 * 1024 * 1024       // 4 MB — Vercel body limit
const MAX_CONCURRENT = 2
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB
const ACCEPTED = 'image/*,video/*,.heic,.heif,.mov,.mp4,.avi,.mkv,.m4v,.3gp,.mts,.webm'

// ── Helpers ──
let _uid = 0
function uid() { return String(++_uid) }

function isAccepted(file: File): boolean {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true
  return /\.(heic|heif|mov|mp4|avi|mkv|m4v|3gp|webm|mts)$/i.test(file.name)
}

function isImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(jpg|jpeg|png|gif|webp|avif|bmp|tiff|svg)$/i.test(file.name)
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} Б`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} КБ`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} МБ`
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  if (m100 >= 11 && m100 <= 19) return many
  if (m10 === 1) return one
  if (m10 >= 2 && m10 <= 4) return few
  return many
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Chunks go through our /api/upload-chunk proxy to avoid CORS issues
async function proxyChunk(
  sessionUri: string,
  contentRange: string,
  contentType: string,
  body?: ArrayBuffer,
): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Session-Uri': sessionUri,
    'X-Content-Type': contentType,
    'Content-Range': contentRange,
  }
  return fetch('/api/upload-chunk', { method: 'PUT', headers, body })
}

async function queryResumable(sessionUri: string, total: number): Promise<number> {
  try {
    const res = await proxyChunk(sessionUri, `bytes */${total}`, 'application/octet-stream')
    if (res.status === 308) {
      const range = res.headers.get('Range')
      if (range) {
        const m = range.match(/bytes=0-(\d+)/)
        if (m) return parseInt(m[1]) + 1
      }
      return 0
    }
    if (res.status === 200 || res.status === 201) return total
  } catch { /* network error */ }
  return 0
}

async function uploadChunked(
  file: File,
  sessionUri: string,
  onProgress: (bytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  const total = file.size
  let retries = 0
  const MAX_RETRIES = 5
  const ct = file.type || 'application/octet-stream'

  while (offset < total) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const end = Math.min(offset + CHUNK_SIZE, total) - 1
    const chunkBuf = await file.slice(offset, end + 1).arrayBuffer()

    let res: Response
    try {
      res = await proxyChunk(sessionUri, `bytes ${offset}-${end}/${total}`, ct, chunkBuf)
    } catch (err) {
      if (signal.aborted) throw err
      retries++
      if (retries > MAX_RETRIES) throw new Error('Слишком много ошибок сети')
      await sleep(2000 * retries)
      offset = await queryResumable(sessionUri, total)
      onProgress(offset)
      continue
    }

    retries = 0

    if (res.status === 200 || res.status === 201) {
      onProgress(total)
      return
    }

    if (res.status === 308) {
      const range = res.headers.get('Range')
      if (range) {
        const m = range.match(/bytes=0-(\d+)/)
        offset = m ? parseInt(m[1]) + 1 : end + 1
      } else {
        offset = end + 1
      }
      onProgress(offset)
      continue
    }

    if (res.status >= 500) {
      retries++
      if (retries > MAX_RETRIES) throw new Error(`Ошибка сервера: ${res.status}`)
      await sleep(2000 * retries)
      offset = await queryResumable(sessionUri, total)
      onProgress(offset)
      continue
    }

    const body = await res.text().catch(() => '')
    throw new Error(`Ошибка: ${res.status} ${body}`.slice(0, 120))
  }
}

// ── Component ──
interface Props {
  passcodeEnabled: boolean
}

export default function UploadClient({ passcodeEnabled }: Props) {
  const [step, setStep] = useState<'passcode' | 'upload' | 'done'>(
    passcodeEnabled ? 'passcode' : 'upload'
  )
  const [passcodeInput, setPasscodeInput] = useState('')
  const [passcodeError, setPasscodeError] = useState('')
  const [passcodeLoading, setPasscodeLoading] = useState(false)
  const [savedPasscode, setSavedPasscode] = useState('')
  const [guestName, setGuestName] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Transition to done when all files complete
  useEffect(() => {
    if (files.length > 0 && files.every(f => f.status === 'done') && !isUploading) {
      const t = setTimeout(() => setStep('done'), 700)
      return () => clearTimeout(t)
    }
  }, [files, isUploading])

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach(f => { if (f.objectUrl) URL.revokeObjectURL(f.objectUrl) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = useCallback((rawFiles: FileList | File[]) => {
    const entries: FileEntry[] = []
    for (const file of Array.from(rawFiles)) {
      if (!isAccepted(file)) {
        alert(`«${file.name}» — не поддерживается. Принимаем только фото и видео.`)
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        alert(`«${file.name}» слишком большой (максимум 4 ГБ).`)
        continue
      }
      entries.push({
        id: uid(),
        file,
        status: 'pending',
        progress: 0,
        objectUrl: isImage(file) ? URL.createObjectURL(file) : undefined,
      })
    }
    setFiles(prev => [...prev, ...entries])
  }, [])

  function removeFile(id: string) {
    setFiles(prev => {
      const entry = prev.find(f => f.id === id)
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl)
      return prev.filter(f => f.id !== id)
    })
  }

  function onDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragging(true) }
  function onDragLeave() { setIsDragging(false) }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }

  async function handlePasscode(e: React.FormEvent) {
    e.preventDefault()
    setPasscodeError('')
    setPasscodeLoading(true)
    try {
      const res = await fetch('/api/create-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validateOnly: true, passcode: passcodeInput }),
      })
      if (res.ok) {
        setSavedPasscode(passcodeInput)
        setStep('upload')
      } else {
        const data = await res.json().catch(() => ({}))
        setPasscodeError(data.error || 'Неверный пароль')
      }
    } catch {
      setPasscodeError('Ошибка соединения, попробуй ещё раз')
    } finally {
      setPasscodeLoading(false)
    }
  }

  async function handleUpload() {
    const toUpload = files.filter(f => f.status === 'pending' || f.status === 'error')
    if (!toUpload.length || isUploading) return

    setIsUploading(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    // concurrent workers sharing a queue index
    let idx = 0
    const worker = async () => {
      while (idx < toUpload.length) {
        const entry = toUpload[idx++]
        await doUploadFile(entry, ctrl.signal, savedPasscode, guestName)
      }
    }
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker))
    setIsUploading(false)
  }

  async function doUploadFile(
    entry: FileEntry,
    signal: AbortSignal,
    passcode: string,
    name: string,
  ) {
    setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, status: 'uploading', error: undefined } : f))

    try {
      const res = await fetch('/api/create-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: entry.file.name,
          mimeType: entry.file.type || '',
          fileSize: entry.file.size,
          guestName: name.trim() || undefined,
          passcode: passcode || undefined,
        }),
        signal,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const { sessionUri } = await res.json()

      await uploadChunked(
        entry.file,
        sessionUri,
        (bytes) => {
          const progress = Math.round((bytes / entry.file.size) * 100)
          setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, progress } : f))
        },
        signal,
      )

      setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, status: 'done', progress: 100 } : f))
    } catch (err) {
      if (signal.aborted) return
      const msg = err instanceof Error ? err.message : 'Ошибка загрузки'
      setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, status: 'error', error: msg } : f))
    }
  }

  // Computed
  const totalFiles = files.length
  const doneFiles = files.filter(f => f.status === 'done').length
  const errorFiles = files.filter(f => f.status === 'error').length
  const pendingCount = files.filter(f => f.status === 'pending' || f.status === 'error').length
  const totalBytes = files.reduce((s, f) => s + f.file.size, 0)
  const uploadedBytes = files.reduce((s, f) => s + (f.progress / 100) * f.file.size, 0)
  const overallPct = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0

  // ── Passcode screen ──
  if (step === 'passcode') {
    return (
      <div className="page-center">
        <div className="card passcode-card">
          <span className="hearts">💕</span>
          <h1 className="title">Аня & Никита</h1>
          <p className="subtitle">28 июня 2026</p>
          <form onSubmit={handlePasscode} className="passcode-form">
            <p className="passcode-hint">Введи кодовое слово, чтобы войти</p>
            <input
              type="text"
              value={passcodeInput}
              onChange={e => { setPasscodeInput(e.target.value); setPasscodeError('') }}
              placeholder="Кодовое слово"
              className="input"
              autoComplete="off"
              autoFocus
            />
            {passcodeError && <p className="error-text">{passcodeError}</p>}
            <button
              type="submit"
              className="btn-primary"
              disabled={!passcodeInput.trim() || passcodeLoading}
            >
              {passcodeLoading ? 'Проверяем...' : 'Войти →'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Done screen ──
  if (step === 'done') {
    return (
      <div className="page-center">
        <div className="card done-card">
          <span className="done-emoji">🎉</span>
          <h2 className="done-title">Спасибо!</h2>
          <p className="done-subtitle">
            Файлы сохранены — мы их сбережём на память 💕
          </p>
          <p className="done-count">
            {doneFiles} {plural(doneFiles, 'файл', 'файла', 'файлов')} загружено
          </p>
          <button
            className="btn-secondary"
            onClick={() => { setFiles([]); setStep('upload') }}
          >
            Загрузить ещё
          </button>
        </div>
      </div>
    )
  }

  // ── Upload screen ──
  return (
    <div className="page">
      <header className="header">
        <span className="hearts">💕</span>
        <h1 className="title">Аня & Никита</h1>
        <p className="subtitle">28 июня 2026 · Поделись фото и видео со свадьбы!</p>
      </header>

      <div className="card upload-card">
        {/* Guest name */}
        <div className="field">
          <label className="label" htmlFor="guestName">Как тебя зовут?</label>
          <input
            id="guestName"
            type="text"
            value={guestName}
            onChange={e => setGuestName(e.target.value)}
            placeholder="Необязательно"
            className="input"
            disabled={isUploading}
            autoComplete="name"
          />
        </div>

        {/* Drop zone */}
        <div
          className={`dropzone${isDragging ? ' dropzone-active' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !isUploading && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED}
            style={{ display: 'none' }}
            onChange={e => e.target.files && addFiles(e.target.files)}
            disabled={isUploading}
          />
          <span className="dropzone-icon">{isDragging ? '👐' : '📸'}</span>
          <p className="dropzone-text">
            {isDragging ? 'Отпускай!' : 'Нажми или перетащи фото и видео'}
          </p>
          <p className="dropzone-hint">Любое количество файлов · фото, видео, HEIC, MOV</p>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="file-list">
            {files.map(entry => (
              <FileRow
                key={entry.id}
                entry={entry}
                onRemove={() => removeFile(entry.id)}
                disabled={isUploading}
              />
            ))}
          </div>
        )}

        {/* Overall progress */}
        {isUploading && totalBytes > 0 && (
          <div className="overall-progress">
            <div className="overall-progress-header">
              <span>Загружено {doneFiles} из {totalFiles}</span>
              <span>{overallPct}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${overallPct}%` }} />
            </div>
          </div>
        )}

        {/* Error hint */}
        {!isUploading && errorFiles > 0 && (
          <p className="error-summary">
            {errorFiles} {plural(errorFiles, 'файл', 'файла', 'файлов')} не загрузилось — нажми «Загрузить» ещё раз
          </p>
        )}

        {/* Upload button */}
        {files.length > 0 && (
          <button
            className="btn-primary"
            onClick={handleUpload}
            disabled={isUploading || files.every(f => f.status === 'done')}
          >
            {isUploading
              ? `Загружаем... ${overallPct}%`
              : files.every(f => f.status === 'done')
                ? '✓ Всё загружено!'
                : `Загрузить ${pendingCount} ${plural(pendingCount, 'файл', 'файла', 'файлов')}`}
          </button>
        )}
      </div>
    </div>
  )
}

// ── FileRow ──
function FileRow({
  entry,
  onRemove,
  disabled,
}: {
  entry: FileEntry
  onRemove: () => void
  disabled: boolean
}) {
  return (
    <div className={`file-row file-row-${entry.status}`}>
      {entry.objectUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.objectUrl} alt="" className="file-thumb" />
      ) : (
        <div className="file-thumb-video">🎬</div>
      )}

      <div className="file-info">
        <p className="file-name">{entry.file.name}</p>
        <p className="file-size">{fmtBytes(entry.file.size)}</p>
        {(entry.status === 'uploading' || entry.status === 'done') && (
          <div className="progress-bar" style={{ marginTop: '4px' }}>
            <div className="progress-fill" style={{ width: `${entry.progress}%` }} />
          </div>
        )}
        {entry.status === 'error' && entry.error && (
          <p className="file-error">{entry.error}</p>
        )}
      </div>

      <div className="file-status">
        {entry.status === 'done' && <span className="status-done">✓</span>}
        {entry.status === 'uploading' && (
          <span className="status-uploading">{entry.progress}%</span>
        )}
        {entry.status === 'error' && <span className="status-error">✗</span>}
        {entry.status === 'pending' && !disabled && (
          <button className="btn-remove" onClick={onRemove} title="Убрать">×</button>
        )}
      </div>
    </div>
  )
}
