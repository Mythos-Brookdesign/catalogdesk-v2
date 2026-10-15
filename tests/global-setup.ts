import { execFileSync } from 'node:child_process'

// E2E tests run the built renderer, so a dev server (and its hot reloads) cannot interfere.
export default function globalSetup() {
  execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit' })
}
