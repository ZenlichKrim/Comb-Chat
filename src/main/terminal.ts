import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import type { PtyCreateOptions } from '../shared/types'

type DataCb = (data: string) => void
type ExitCb = (code: number) => void

interface Backend {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

class NodePtyBackend implements Backend {
  private term: any
  constructor(opts: PtyCreateOptions, shell: string, onData: DataCb, onExit: ExitCb) {
    // Loaded lazily so a missing native build never breaks app start-up.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty')
    const args: string[] = []
    if (process.platform === 'win32') {
      if (/powershell|pwsh/i.test(shell)) args.push('-NoLogo', '-NoExit')
      else if (/bash/i.test(shell)) args.push('-i')
    } else if (/bash|zsh/.test(shell)) {
      args.push('-l')
    }
    this.term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols || 100,
      rows: opts.rows || 30,
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COMB_TERMINAL: '1' }
    })
    this.term.onData((d: string) => onData(d))
    this.term.onExit(({ exitCode }: { exitCode: number }) => onExit(exitCode))
  }
  write(data: string): void {
    this.term.write(data)
  }
  resize(cols: number, rows: number): void {
    try {
      this.term.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      /* noop */
    }
  }
  kill(): void {
    try {
      this.term.kill()
    } catch {
      /* noop */
    }
  }
}

/**
 * Fallback when node-pty is unavailable (e.g. blocked native build):
 * pipes-only shell. Interactive full-screen apps won't work, but commands,
 * git, npm and REPLs do.
 */
class PipeBackend implements Backend {
  private proc: ChildProcessWithoutNullStreams
  constructor(opts: PtyCreateOptions, onData: DataCb, onExit: ExitCb) {
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash'
    const args = isWin ? [] : ['-i']
    this.proc = spawn(shell, args, {
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', PS1: '\\[\\e[38;5;179m\\]comb\\[\\e[0m\\] \\w $ ' },
      stdio: 'pipe',
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
    this.proc.stdout.on('data', (b: Buffer) => onData(b.toString('utf8')))
    this.proc.stderr.on('data', (b: Buffer) => onData(b.toString('utf8')))
    this.proc.on('exit', (code) => onExit(code ?? 0))
    this.proc.on('error', (e) => onData(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`))
  }
  write(data: string): void {
    this.proc.stdin.write(data)
  }
  resize(): void {
    /* not supported without a tty */
  }
  kill(): void {
    try {
      this.proc.kill()
    } catch {
      /* noop */
    }
  }
}

const sessions = new Map<string, Backend>()
export let terminalBackend: 'pty' | 'pipe' = 'pipe'

function resolveShell(requested?: string): string {
  if (requested && requested.trim()) return requested.trim()
  if (process.platform === 'win32') {
    return process.env.PSModulePath ? 'powershell.exe' : process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export function createTerminal(
  opts: PtyCreateOptions,
  onData: DataCb,
  onExit: ExitCb
): { ok: boolean; error?: string; backend: string } {
  try {
    killTerminal(opts.id)
    const shell = resolveShell(opts.shell)
    try {
      const be = new NodePtyBackend(opts, shell, onData, onExit)
      sessions.set(opts.id, be)
      terminalBackend = 'pty'
      return { ok: true, backend: 'pty' }
    } catch (e: any) {
      const be = new PipeBackend(opts, onData, onExit)
      sessions.set(opts.id, be)
      terminalBackend = 'pipe'
      return { ok: true, backend: 'pipe', error: e?.message }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), backend: 'none' }
  }
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows)
}

export function killTerminal(id: string): void {
  const s = sessions.get(id)
  if (s) {
    s.kill()
    sessions.delete(id)
  }
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
