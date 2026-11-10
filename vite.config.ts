import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The ONNX runtime behind the Kokoro voice, served from this origin.
 *
 * transformers.js points the runtime at cdn.jsdelivr.net for its loader and
 * WASM binary by default. The loader is a JavaScript module, and the page's
 * CSP only runs scripts from 'self' — so the import is refused, no backend
 * initialises, and the voice fails with "no available backend found".
 * Serving the same two files from here, byte for byte, keeps the CSP as tight
 * as it is and drops the CDN dependency. kokoro.ts sets wasmPaths to /ort/.
 *
 * Served raw rather than through Vite's module pipeline: the loader carries a
 * Node-only `import("module")` branch that import analysis has no business
 * rewriting.
 */
export const ORT_DIR = fileURLToPath(new URL('./node_modules/@huggingface/transformers/dist/', import.meta.url))
export const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

function ortAssets(): Plugin {
  return {
    name: 'jarvis-ort-assets',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
        if (!ORT_FILES.includes(name)) return next()
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(ORT_DIR + name).pipe(res)
      })
    },
    generateBundle() {
      for (const name of ORT_FILES) {
        this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: readFileSync(ORT_DIR + name) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ortAssets()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
