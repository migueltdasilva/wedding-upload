import UploadClient from './upload-client'

export default function Page() {
  const passcodeEnabled = Boolean(process.env.UPLOAD_PASSCODE)
  return <UploadClient passcodeEnabled={passcodeEnabled} />
}
