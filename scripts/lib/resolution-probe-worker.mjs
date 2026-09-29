// Worker half of scripts/diagnose-dsh-resolution.mjs.
//
// Installs the DSH runtime resolution inherited through `setEnvironmentData`
// (the app-boot worker bootstrap does that on import) and then imports every
// requested target, reporting success or the exact resolution error.
import { workerData, parentPort } from 'node:worker_threads'

await import(workerData.bootstrapUrl)

for (const target of workerData.targets) {
  try {
    const mod = await import(target)
    parentPort.postMessage({ target, ok: true, exports: Object.keys(mod).sort().join(',') })
  } catch (error) {
    parentPort.postMessage({
      target,
      ok: false,
      code: (error && error.code) || null,
      message: String((error && error.message) || error).split('\n')[0],
    })
  }
}
