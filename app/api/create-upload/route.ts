import { NextRequest, NextResponse } from 'next/server'

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token error: ${text}`)
  }
  const { access_token } = await res.json()
  return access_token
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { filename, mimeType, fileSize, fileCreatedAt, guestName, passcode, validateOnly } = body

    // Passcode check
    const required = process.env.UPLOAD_PASSCODE
    if (required && passcode !== required) {
      return NextResponse.json({ error: 'Неверный пароль' }, { status: 403 })
    }

    // Used by the passcode gate to verify without creating an upload
    if (validateOnly) {
      return NextResponse.json({ ok: true })
    }

    if (!filename || !fileSize) {
      return NextResponse.json({ error: 'Отсутствуют обязательные поля' }, { status: 400 })
    }

    // File type validation (image or video only)
    const effectiveMime = (mimeType as string) || 'application/octet-stream'
    const isImage =
      effectiveMime.startsWith('image/') || /\.(heic|heif)$/i.test(filename)
    const isVideo =
      effectiveMime.startsWith('video/') ||
      /\.(mov|mp4|avi|mkv|m4v|3gp|webm|mts)$/i.test(filename)
    if (!isImage && !isVideo) {
      return NextResponse.json(
        { error: 'Принимаем только фото и видео' },
        { status: 400 },
      )
    }

    // Size limit
    const maxBytes =
      parseFloat(process.env.MAX_FILE_SIZE_GB || '4') * 1024 ** 3
    if (fileSize > maxBytes) {
      return NextResponse.json({ error: 'Файл слишком большой' }, { status: 400 })
    }

    // Prefer file's own creation time (shooting date) for chronological sorting in Drive
    const shootDate = fileCreatedAt
      ? new Date(fileCreatedAt as number)
      : new Date()
    const shootTs = shootDate
      .toISOString()
      .replace('T', ' ')
      .replace(/:/g, '-')
      .slice(0, 19)  // "2026-06-28 14-30-00"

    // Build filename: "2026-06-28 14-30-00 — Гость — оригинальное имя"
    const guest = (guestName as string | undefined)?.trim()
    const safeName = guest
      ? `${shootTs} — ${guest} — ${filename}`
      : `${shootTs} — ${filename}`

    const accessToken = await getAccessToken()

    // Initiate resumable upload session on Google Drive
    const initRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': effectiveMime,
          'X-Upload-Content-Length': String(fileSize),
        },
        body: JSON.stringify({
          name: safeName,
          parents: [process.env.DRIVE_FOLDER_ID!],
        }),
      },
    )

    if (!initRes.ok) {
      const text = await initRes.text()
      throw new Error(`Drive API ${initRes.status}: ${text}`)
    }

    const sessionUri = initRes.headers.get('Location')
    if (!sessionUri) throw new Error('Google Drive не вернул Location header')

    // Only the session URI goes to the client — tokens stay on the server
    return NextResponse.json({ sessionUri })
  } catch (err) {
    console.error('[create-upload]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Внутренняя ошибка' },
      { status: 500 },
    )
  }
}
