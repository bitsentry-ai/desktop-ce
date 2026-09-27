const { spawn } = require('child_process')
const path = require('path')

module.exports = async function afterPack(context) {
  const scriptPath = path.join(__dirname, 'dist', 'after-pack.js')
  const payload = JSON.stringify({
    appOutDir: context.appOutDir,
    electronPlatformName: context.electronPlatformName,
    arch: context.arch,
    packager: {
      appInfo: {
        productFilename: context.packager?.appInfo?.productFilename,
        productName: context.packager?.appInfo?.productName,
      },
    },
  })

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, payload], {
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`after-pack CLI wrapper generation failed with exit code ${code ?? 'null'}`))
    })
  })
}
