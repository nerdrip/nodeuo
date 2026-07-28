import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Mime/text-ish assets where compression is worth it. Pre-compressed binary
// (PNG, mp3, br/gz already), source maps, and giant UO binary blobs are
// excluded. Brotli Q11 over 80-160 MB map/sound .bin files made production
// builds look hung after Rollup had already emitted the bundle.
const COMPRESS_EXT = /\.(?:html|css|js|mjs|json|svg|wasm|txt)$/i;
const MIN_BYTES = 1024;
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Custom plugin: walk dist/ after build and emit `.br` + `.gz` next to
 * each compressible asset so a Caddy/Nginx in front can serve `Encoding:
 * br` directly without runtime work. We use Node's built-in zlib so no
 * new npm dep is needed.
 */
function precompressPlugin() {
  let compressed = false;
  return {
    name: 'uo-precompress',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      // Vite 8's environment build can finalize the same client output more
      // than once. Compression is deterministic, so avoid repeating the most
      // CPU-expensive post-build pass within one invocation.
      if (compressed) return;
      compressed = true;
      const root = path.resolve('dist');
      if (!fs.existsSync(root)) return;
      const queue = [root];
      let count = 0, brotliBytes = 0, gzipBytes = 0, originalBytes = 0;
      while (queue.length) {
        const dir = queue.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { queue.push(full); continue; }
          if (!e.isFile()) continue;
          if (!COMPRESS_EXT.test(e.name)) continue;
          if (e.name.endsWith('.br') || e.name.endsWith('.gz')) continue;
          const buf = fs.readFileSync(full);
          if (buf.length < MIN_BYTES) continue;
          if (buf.length > MAX_BYTES) continue;
          const [br, gz] = await Promise.all([
            brotli(buf, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: buf.length > 1024 * 1024 ? 6 : 9,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
              },
            }),
            gzip(buf, { level: 9 }),
          ]);
          fs.writeFileSync(`${full}.br`, br);
          fs.writeFileSync(`${full}.gz`, gz);
          count++;
          originalBytes += buf.length;
          brotliBytes   += br.length;
          gzipBytes     += gz.length;
        }
      }
      if (count > 0) {
        const pct = (n) => ((1 - n / originalBytes) * 100).toFixed(1);
        console.log(
          `[precompress] ${count} files: brotli ${(brotliBytes/1024).toFixed(1)}kB (-${pct(brotliBytes)}%), `
          + `gzip ${(gzipBytes/1024).toFixed(1)}kB (-${pct(gzipBytes)}%)`,
        );
      }
    },
  };
}

function ensureKtxTranscoderPlugin() {
  const files = ['libktx.js', 'libktx.wasm'];
  let warned = false;
  const copy = () => {
    const srcDir = path.join(HERE, 'node_modules/pixi.js/transcoders/ktx');
    const dstDir = path.join(HERE, 'public/assets/ktx');
    if (!fs.existsSync(srcDir)) {
      if (!warned) {
        console.warn(`[ktx2] Pixi KTX transcoders not found: ${srcDir}`);
        warned = true;
      }
      return;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    for (const name of files) {
      const src = path.join(srcDir, name);
      const dst = path.join(dstDir, name);
      if (!fs.existsSync(src)) continue;
      const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
      if (!same) fs.copyFileSync(src, dst);
    }
  };
  return {
    name: 'uo-ktx2-transcoders',
    configResolved: copy,
    buildStart: copy,
    configureServer() { copy(); },
  };
}

export default defineConfig(({ mode }) => ({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // 'hidden' keeps maps for crash diagnostics but doesn't expose them
    // via the //# sourceMappingURL comment — saves a public fetch and
    // hides source from casual viewers. In dev we still get inline maps.
    sourcemap: mode === 'production' ? 'hidden' : true,
    // Vite 8 uses Oxc for transforms/minification and Rolldown for bundling.
    // Keep the native fast path instead of pulling the legacy esbuild fallback.
    minify: 'oxc',
    cssMinify: true,
    // Pixi is intentionally isolated as a long-cache vendor chunk and
    // currently lands around 850 kB minified. Keep the warning above that
    // known vendor floor so future game-code growth still stands out.
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // Split the heavy Pixi runtime into its own long-cache chunk using
        // Rolldown's native grouping API. Vite 8 removed object-form
        // manualChunks together with the Rollup backend.
        codeSplitting: {
          groups: [
            {
              name: 'pixi',
              test: /[\\/]node_modules[\\/](?:\.pnpm[\\/][^/\\]+[\\/]node_modules[\\/])?pixi\.js[\\/]/,
            },
          ],
        },
        minify: {
          compress: {
            dropDebugger: true,
            treeshake: {
              manualPureFunctions: ['console.debug', 'console.trace'],
            },
          },
        },
      },
    },
    reportCompressedSize: false,
    assetsInlineLimit: 4096,
  },
  resolve: {
    alias: {
      '@': path.resolve('./src'),
    },
  },
  optimizeDeps: {
    include: ['pixi.js'],
    // @uo/protocol is a workspace package that changes together with the
    // client. Pre-bundling it leaves Vite's .vite/deps copy stale whenever a
    // new packet/capability export is added, which can make a valid named
    // import fail until the cache is deleted by hand. Serve its ESM source
    // directly so protocol and client exports always stay in lock-step.
    exclude: ['@uo/protocol'],
  },
  plugins: [
    ensureKtxTranscoderPlugin(),
    precompressPlugin(),
  ],
}));
