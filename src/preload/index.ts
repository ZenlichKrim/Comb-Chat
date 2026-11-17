import { contextBridge, ipcRenderer } from 'electron'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  app: {
    platform: process.platform,
    version: process.env.npm_package_version || '',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    homedir: '',
    getInfo: () => ipcRenderer.invoke('app:info'),
    minimize: () => ipcRenderer.send('app:minimize'),
    maximize: () => ipcRenderer.send('app:maximize'),
    close: () => ipcRenderer.send('app:close'),
    isMaximized: () => ipcRenderer.invoke('app:isMaximized'),
    onMaximized: (cb: (v: boolean) => void) => on<boolean>('window:maximized', cb),
    openExternal: (url: string) => ipcRenderer.send('app:openExternal', url),
    showItemInFolder: (p: string) => ipcRenderer.send('app:showItemInFolder', p),
    openPath: (p: string) => ipcRenderer.invoke('app:openPath', p),
    /** taskbar progress + flash while a long run is in flight */
    attention: (on: boolean, label?: string) => ipcRenderer.send('app:attention', on, label)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (cb: (s: unknown) => void) => on('settings:changed', cb)
  },
  threads: {
    list: () => ipcRenderer.invoke('threads:list'),
    save: (t: unknown) => ipcRenderer.invoke('threads:save', t),
    delete: (id: string) => ipcRenderer.invoke('threads:delete', id),
    clearAll: () => ipcRenderer.invoke('threads:clearAll')
  },
  fs: {
    pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('fs:pickFiles'),
    list: (dir: string) => ipcRenderer.invoke('fs:list', dir),
    tree: (root: string, depth?: number) => ipcRenderer.invoke('fs:tree', root, depth),
    read: (p: string) => ipcRenderer.invoke('fs:read', p),
    readImage: (p: string) => ipcRenderer.invoke('fs:readImage', p),
    write: (p: string, c: string) => ipcRenderer.invoke('fs:write', p, c),
    create: (p: string, isDir: boolean) => ipcRenderer.invoke('fs:create', p, isDir),
    rename: (a: string, b: string) => ipcRenderer.invoke('fs:rename', a, b),
    remove: (p: string) => ipcRenderer.invoke('fs:remove', p),
    exists: (p: string) => ipcRenderer.invoke('fs:exists', p),
    search: (root: string, q: string, o?: unknown) => ipcRenderer.invoke('fs:search', root, q, o),
    findFiles: (root: string, q: string, o?: unknown) => ipcRenderer.invoke('fs:findFiles', root, q, o),
    watch: (root: string, id: string) => ipcRenderer.invoke('fs:watch', root, id),
    unwatch: (id: string) => ipcRenderer.invoke('fs:unwatch', id),
    onChanged: (cb: (e: unknown) => void) => on('fs:changed', cb)
  },
  git: {
    status: (root: string) => ipcRenderer.invoke('git:status', root),
    diff: (root: string, p: string) => ipcRenderer.invoke('git:diff', root, p),
    commit: (root: string, message: string, paths?: string[]) => ipcRenderer.invoke('git:commit', root, message, paths),
    init: (root: string) => ipcRenderer.invoke('git:init', root),
    stage: (root: string, paths: string[]) => ipcRenderer.invoke('git:stage', root, paths),
    unstage: (root: string, paths: string[]) => ipcRenderer.invoke('git:unstage', root, paths),
    checkout: (root: string, p: string) => ipcRenderer.invoke('git:checkout', root, p)
  },
  agent: {
    run: (req: unknown) => ipcRenderer.invoke('agent:run', req),
    stop: (runId: string) => ipcRenderer.invoke('agent:stop', runId),
    approve: (runId: string, callId: string, decision: string, editedArgs?: unknown) =>
      ipcRenderer.invoke('agent:approve', runId, callId, decision, editedArgs),
    onEvent: (cb: (e: unknown) => void) => on('agent:event', cb),
    testKey: (key: string, baseUrl: string) => ipcRenderer.invoke('agent:testKey', key, baseUrl)
  },
  files: {
    describe: (abs: string, ctx?: { task?: string }) => ipcRenderer.invoke('files:describe', abs, ctx),
    summaries: (paths: string[]) => ipcRenderer.invoke('files:summaries', paths)
  },
  terminal: {
    create: (opts: unknown) => ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('terminal:kill', id),
    onData: (cb: (e: unknown) => void) => on('terminal:data', cb),
    onExit: (cb: (e: unknown) => void) => on('terminal:exit', cb)
  },
  checkpoints: {
    list: (threadId: string) => ipcRenderer.invoke('checkpoints:list', threadId),
    restore: (id: string) => ipcRenderer.invoke('checkpoints:restore', id),
    create: (threadId: string, label: string, rels: string[], workspace: string) =>
      ipcRenderer.invoke('checkpoints:create', threadId, label, rels, workspace)
  },
  clipboard: {
    write: (text: string) => ipcRenderer.send('clipboard:write', text),
    read: () => ipcRenderer.invoke('clipboard:read')
  },
  window: {
    setTheme: (theme: string, accent: string) => ipcRenderer.send('window:setTheme', theme, accent)
  },
  ui: {
    onCommand: (cb: (cmd: string) => void) => on<string>('ui:command', cb)
  }
}

contextBridge.exposeInMainWorld('comb', api)
