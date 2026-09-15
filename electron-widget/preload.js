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
  listPhotos: () => ipcRenderer.invoke('list-photos'),

  // 자료함: 엑셀 파일 등 특정 파일을 골라서 연결해두고, 클릭하면 그 파일을 바로 엶.
  selectMaterialFile: () => ipcRenderer.invoke('select-material-file'),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),

  // 할일: 프로젝트 엑셀 파일을 연결해두면, 파일을 열지 않고 "프로젝트" 시트 데이터를
  // 그대로 읽어와 할일 대시보드에 보여줌. 저장할 때마다 자동으로 갱신됨.
  linkExcelFile: () => ipcRenderer.invoke('link-excel-file'),
  unlinkExcelFile: () => ipcRenderer.send('unlink-excel-file'),
  readExcelProjects: (filePath) => ipcRenderer.invoke('read-excel-projects', filePath),
  onExcelFileChanged: (callback) => ipcRenderer.on('excel-file-changed', callback),

  // 카톡 붙이기: 위젯을 옮기면 지정해둔 카카오톡(또는 다른 프로그램) 창도
  // 오른쪽에 붙어서 같이 따라오고, Ctrl+Alt+D로 숨기면 같이 최소화됨.
  pickDockWindow: () => ipcRenderer.invoke('pick-dock-window'),
  unsetDockWindow: () => ipcRenderer.send('unset-dock-window'),
  getDockStatus: () => ipcRenderer.invoke('get-dock-status')
});
