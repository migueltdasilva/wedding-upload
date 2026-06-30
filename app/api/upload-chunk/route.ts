import { NextRequest, NextResponse } from 'next/server'

export async function PUT(req: NextRequest) {
  const sessionUri = req.headers.get('x-session-uri')
  const contentRange = req.headers.get('content-range')
  const contentType = req.headers.get('x-content-type') || 'application/octet-stream'

  if (!sessionUri) {
    return NextResponse.json({ error: 'Missing X-Session-Uri' }, { status: 400 })
  }

  const body = await req.arrayBuffer()

  const headers: Record<string, string> = { 'Content-Type': contentType }
  if (contentRange) headers['Content-Range'] = contentRange

  const gRes = await fetch(sessionUri, { method: 'PUT', headers, body: body.byteLength > 0 ? body : undefined })

  if (gRes.status === 308) {
    const range = gRes.headers.get('Range')
    return new NextResponse(null, {
      status: 308,
      headers: range ? { Range: range } : {},
    })
  }

  if (gRes.status === 200 || gRes.status === 201) {
    return new NextResponse(null, { status: gRes.status })
  }

  const text = await gRes.text().catch(() => '')
  return NextResponse.json({ error: `Google ${gRes.status}: ${text}` }, { status: 500 })
}
