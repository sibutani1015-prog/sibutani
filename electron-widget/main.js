const { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const XLSX = require('xlsx');

const STORE_PATH = path.join(app.getPath('userData'), 'griddesk-store.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}
function writeStore(data) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    // ignore write failures (e.g. disk full) rather than crash the widget
  }
}

let storeCache = readStore();
let mainWindow = null;
let tray = null;

function currentDisplay() {
  const displays = screen.getAllDisplays();
  const saved = storeCache.__displayIndex;
  return displays[saved] || screen.getPrimaryDisplay();
}

function createWindow() {
  // A window the user has dragged/resized before (across either monitor)
  // is remembered exactly; otherwise fall back to filling the chosen display.
  const saved = storeCache.__windowBounds;
  const disp = currentDisplay();
  const bounds = saved || {
    x: disp.bounds.x, y: disp.bounds.y,
    width: disp.bounds.width, height: disp.bounds.height
  };

  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAlwaysOnTop(!!storeCache.__alwaysOnTop);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Start in click-through mode: mouse events pass to whatever is under
  // the window (real desktop icons). The renderer re-enables/disables this
  // per mouse position over an actual panel/dock element (see preload.js),
  // including the header bar, which is also the window's drag handle
  // (-webkit-app-region: drag) so the whole widget can be dragged to
  // either monitor on a dual-monitor setup.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  var saveBoundsTimer = null;
  function saveBounds(){
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!mainWindow) return;
      storeCache.__windowBounds = mainWindow.getBounds();
      writeStore(storeCache);
    }, 400);
  }
  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function bringToFront() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  const displays = screen.getAllDisplays();
  const monitorItems = displays.map((d, i) => ({
    label: '모니터 ' + (i + 1) + ' (' + d.bounds.width + 'x' + d.bounds.height + ')',
    type: 'radio',
    checked: (storeCache.__displayIndex || 0) === i,
    click: () => {
      storeCache.__displayIndex = i;
      writeStore(storeCache);
      if (mainWindow) mainWindow.setBounds(displays[i].bounds);
      buildTrayMenu();
    }
  }));

  const menu = Menu.buildFromTemplate([
    { label: '새로고침', click: () => { if (mainWindow) mainWindow.reload(); } },
    { label: '앞으로 보기 (Ctrl+Alt+D)', click: bringToFront },
    { type: 'separator' },
    { label: '모니터 선택', submenu: monitorItems },
    {
      label: '항상 맨 위 고정',
      type: 'checkbox',
      checked: !!storeCache.__alwaysOnTop,
      click: (item) => {
        storeCache.__alwaysOnTop = item.checked;
        writeStore(storeCache);
        if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
      }
    },
    {
      label: '윈도우 시작 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); }
    },
    { type: 'separator' },
    { label: '종료', click: () => { app.quit(); } }
  ]);
  if (tray) tray.setContextMenu(menu);
}

function buildTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon32.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip('그리드 데스크');
  tray.on('click', bringToFront);
  buildTrayMenu();
}

app.whenReady().then(() => {
  createWindow();
  buildTray();

  globalShortcut.register('CommandOrControl+Alt+D', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      bringToFront();
    }
  });

  // 이전에 연결해둔 프로젝트 엑셀 파일이 있으면, 재시작 후에도 계속 감시를 이어감
  const linkedExcel = storeCache['griddesk.todoLinkedFile'];
  if (linkedExcel) watchExcelFile(linkedExcel);
});

// This is a background widget: closing the window (if that ever happens)
// should not quit the app while the tray icon is the real way to exit.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { globalShortcut.unregisterAll(); });

/* ---------- IPC: click-through toggling ---------- */
ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
});

/* ---------- IPC: quick hide (no lock, just tuck the widget away instantly) ---------- */
ipcMain.on('hide-widget', () => {
  if (!mainWindow) return;
  mainWindow.hide();
});

/* ---------- IPC: 퇴근 전 한 번에 - 백업 저장하고 완전히 종료 ---------- */
function saveAndQuit() {
  try {
    const dir = path.join(app.getPath('documents'), 'griddesk-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, 'griddesk-backup-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(storeCache, null, 2), 'utf-8');
  } catch (e) {
    // even if the backup write fails, don't block quitting
  }
  app.quit();
}
ipcMain.on('save-and-quit', saveAndQuit);

/* ---------- IPC: local JSON store (replaces the web version's localStorage) ---------- */
ipcMain.on('store-get', (event, key) => {
  event.returnValue = Object.prototype.hasOwnProperty.call(storeCache, key) ? storeCache[key] : null;
});
ipcMain.on('store-set', (event, key, value) => {
  storeCache[key] = value;
  writeStore(storeCache);
});
ipcMain.on('store-remove', (event, key) => {
  delete storeCache[key];
  writeStore(storeCache);
});

/* ---------- IPC: export backup via native save dialog ---------- */
ipcMain.handle('export-backup', async (event, dataStr) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '전체 내보내기',
    defaultPath: 'griddesk-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, dataStr, 'utf-8');
  return { ok: true, path: res.filePath };
});

/* ---------- IPC: 자료함 - 특정 파일(엑셀 등)을 연결해두고 바로 열기 ---------- */
ipcMain.handle('select-material-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '자료함에 연결할 파일 선택',
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('open-path', async (event, filePath) => {
  const err = await shell.openPath(filePath);
  return { ok: !err, error: err || null };
});

/* ---------- IPC: 휴식 카드용 사진 폴더 (인터넷 없이, 이 컴퓨터 안의 파일만) ---------- */
const PHOTO_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

ipcMain.handle('select-photo-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '휴식 카드에 보여줄 사진 폴더 선택',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  storeCache.__photoFolder = res.filePaths[0];
  writeStore(storeCache);
  return res.filePaths[0];
});

ipcMain.handle('list-photos', async () => {
  const dir = storeCache.__photoFolder;
  if (!dir) return { folder: null, files: [] };
  try {
    const names = fs.readdirSync(dir).filter((name) => PHOTO_EXTS.includes(path.extname(name).toLowerCase()));
    const urls = names.map((name) => pathToFileURL(path.join(dir, name)).href);
    return { folder: dir, files: urls };
  } catch (e) {
    return { folder: dir, files: [] };
  }
});

/* ---------- IPC: 할일 - 프로젝트 엑셀 파일을 연결해두면, 그 안의 "프로젝트" 시트를
   읽어서 할일 대시보드에 그대로 보여줌. 파일을 여는 게 아니라 데이터만 읽어옴,
   저장할 때마다(fs.watch) 자동으로 다시 읽어서 항상 최신 상태를 유지함. ---------- */
const PROJECT_SHEET_NAME = '프로젝트';
const PROJECT_HEADER_ROW = 10; // 프로젝트 시트에서 표 헤더가 있는 행 번호(1-based)
const PRIORITY_LABEL = { 1: '높음', 2: '중간', 3: '낮음' };

function todayIsoMain() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseExcelProjects(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets[PROJECT_SHEET_NAME];
  if (!ws) return { ok: false, error: '"프로젝트" 시트를 찾을 수 없어요.' };

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const items = [];
  let nextId = 1;
  let cur = null; // 지금 누적 중인 프로젝트 { name, priority, end, childProgresses }

  function cellVal(col, row) {
    const cell = ws[col + row];
    return cell ? cell.v : undefined;
  }
  function toIso(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function flushProject() {
    if (!cur) return;
    const vals = cur.childProgresses;
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    items.push({
      id: 'xlsx-' + (nextId++),
      title: cur.name,
      date: cur.end || todayIsoMain(),
      project: '프로젝트',
      priority: PRIORITY_LABEL[cur.priority] || '중간',
      progress: avg,
      repeat: 'none',
      _fromExcel: true
    });
    cur = null;
  }

  // 프로젝트(사업) 단위로 하나씩만 보여줌 - 하위 업무 하나하나는 목록에 안 넣고
  // 그 프로젝트의 평균 진행률로 묶어서 한 줄만 표시 (사업이 몇 개 안 되니 이게 더 알아보기 쉬움)
  for (let r = PROJECT_HEADER_ROW + 1; r <= range.e.r + 1; r++) {
    const star = cellVal('B', r);
    const name = cellVal('C', r);
    if (name === undefined || String(name).trim() === '') continue;

    if (String(star || '').trim() === '*') {
      flushProject();
      cur = { name: String(name).trim(), priority: cellVal('D', r), end: toIso(cellVal('F', r)), childProgresses: [] };
      continue;
    }

    if (cur) {
      const rawProgress = cellVal('I', r);
      cur.childProgresses.push((typeof rawProgress === 'number') ? Math.round(rawProgress * 100) : 0);
    }
  }
  flushProject();
  return { ok: true, items: items };
}

ipcMain.handle('read-excel-projects', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '파일을 찾을 수 없어요.' };
    return parseExcelProjects(filePath);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

let excelWatcher = null;
function watchExcelFile(filePath) {
  if (excelWatcher) { try { excelWatcher.close(); } catch (e) {} excelWatcher = null; }
  if (!filePath) return;
  try {
    let debounceTimer = null;
    excelWatcher = fs.watch(filePath, { persistent: false }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (mainWindow) mainWindow.webContents.send('excel-file-changed');
      }, 500);
    });
  } catch (e) {
    // 저장 중 파일이 잠깐 사라졌다 생기는 경우 등은 조용히 무시 (다음 연결/재시작 시 다시 감시)
  }
}

ipcMain.handle('link-excel-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '프로젝트 엑셀 파일 연결',
    properties: ['openFile'],
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  watchExcelFile(res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.on('unlink-excel-file', () => { watchExcelFile(null); });
