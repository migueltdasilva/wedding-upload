/**
 * Разовая настройка: получаем refresh-токен и создаём папку на Google Drive.
 *
 * Запуск:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node setup.mjs
 *
 * Требует Node.js 18+.
 */

import http from 'http'
import { exec } from 'child_process'
import { URL } from 'url'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n⚠️  Не хватает переменных окружения.')
  console.error('Запусти так:\n')
  console.error('  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node setup.mjs\n')
  process.exit(1)
}

const REDIRECT_URI = 'http://localhost:5555/callback'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_NAME = 'Свадьба Ани и Никиты 28.06.2026'

// ── 1. Открываем браузер для авторизации ──
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPE)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')  // гарантирует выдачу refresh_token

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('  Настройка Google OAuth для свадебного загрузчика')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
console.log('🌐 Открываем браузер...')
console.log('\nЕсли браузер не открылся, перейди по ссылке:\n')
console.log(authUrl.toString())
console.log()

const openCmd =
  process.platform === 'darwin' ? 'open' :
  process.platform === 'win32'  ? 'start' :
                                   'xdg-open'
exec(`${openCmd} "${authUrl.toString()}"`, () => {})

// ── 2. Принимаем callback ──
const code = await waitForCode()
console.log('\n✅ Код получен. Меняем на токены...\n')

// ── 3. Меняем code на токены ──
const tokens = await exchangeCode(code)
console.log('✅ Токены получены!\n')

// ── 4. Создаём папку на Google Drive ──
console.log(`📁 Создаём папку «${FOLDER_NAME}»...`)
const folderId = await createFolder(tokens.access_token)
console.log('✅ Папка создана!\n')

// ── 5. Выводим результат ──
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('  Скопируй в переменные окружения Vercel:')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`)
console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`)
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
console.log(`DRIVE_FOLDER_ID=${folderId}`)
console.log(`UPLOAD_PASSCODE=  ← придумай кодовое слово для гостей`)
console.log()
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

process.exit(0)

// ── Helpers ──

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:5555')
      if (url.pathname !== '/callback') { res.end(); return }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h2>Ошибка: ${error}</h2>`)
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h2>Нет кода в ответе</h2>')
        server.close()
        reject(new Error('No code'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`
        <!DOCTYPE html>
        <html lang="ru">
        <head><meta charset="utf-8"><title>Готово!</title>
        <style>
          body { font-family: sans-serif; display: flex; align-items: center; justify-content: center;
                 min-height: 100vh; margin: 0; background: linear-gradient(-45deg,#ff006e,#8338ec,#3a86ff,#ffbe0b);
                 background-size: 400% 400%; animation: s 8s ease infinite; }
          @keyframes s { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
          .card { background: white; border-radius: 24px; padding: 3rem 2rem; text-align: center; max-width: 400px; }
          h2 { font-size: 2rem; margin-bottom: 1rem; }
          p { color: #6b7280; }
        </style>
        </head>
        <body><div class="card">
          <div style="font-size:3rem">✅</div>
          <h2>Готово!</h2>
          <p>Вернись в терминал — там уже всё готово.</p>
        </div></body>
        </html>
      `)
      server.close()
      resolve(code)
    })

    server.listen(5555, () => {
      console.log('🔌 Слушаем http://localhost:5555/callback...')
    })

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error('\n❌ Порт 5555 занят. Закрой другое приложение, занявшее этот порт, и попробуй снова.\n')
      }
      reject(err)
    })
  })
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${text}`)
  }

  const data = await res.json()

  if (!data.refresh_token) {
    throw new Error(
      'Google не вернул refresh_token.\n' +
      'Скорее всего, приложение уже было авторизовано ранее.\n' +
      'Зайди на https://myaccount.google.com/permissions, отзови доступ у своего приложения и запусти setup.mjs снова.',
    )
  }

  return data
}

async function createFolder(accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Create folder failed: ${text}`)
  }

  const data = await res.json()
  return data.id
}
