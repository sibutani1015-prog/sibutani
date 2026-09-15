const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isElectron: true,

  // Click-through: the renderer calls this on every mousemove, passing
  // true when the cursor is over empty (transparent) space so clicks fall
  // through to the real desktop, false when it is over a panel/dock so the
  // widget itself receives the click.
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),

  // Quick hide: tucks the widget out of sight instantly (no password/lock),
  // brought back with the tray icon or Ctrl+Alt+D.
  hideWidget: () => ipcRenderer.send('hide-widget'),

  // 퇴근 전 한 번에: 문서 폴더에 백업 파일을 남기고 앱을 완전히 종료.
  saveAndQuit: () => ipcRenderer.send('save-and-quit'),

  store: {
    get: (key) => ipcRenderer.sendSync('store-get', key),
    set: (key, value) => ipcRenderer.send('store-set', key, value),
    remove: (key) => ipcRenderer.send('store-remove', key)
  },

  exportBackup: (dataStr) => ipcRenderer.invoke('export-backup', dataStr),

  selectPhotoFolder: () => ipcRenderer.invoke('select-photo-folder'),
  listPhotos: () => ipcRenderer.invoke('list-photos')
});
