import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // A fixed, fake key so tests never create a key file; real servers use their own (src/security/crypto.ts).
    env: { SYLKEN_DATA_KEY: Buffer.alloc(32, 7).toString('base64') },
  },
})
