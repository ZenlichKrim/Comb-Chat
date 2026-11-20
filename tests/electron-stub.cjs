/* Electron is not available outside the desktop app; the agent loop only needs
   the data directory, so the harness runs it against this stand-in. */
const dir = process.env.COMB_TEST_DIR || '/tmp/comb-test-data'
module.exports = {
  app: { getPath: () => dir, getName: () => 'comb-chat', getVersion: () => '2.0.0', on: () => {}, whenReady: async () => {} },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  BrowserWindow: class {},
  nativeTheme: { themeSource: 'dark', on: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  Notification: class { static isSupported() { return false } },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
}
