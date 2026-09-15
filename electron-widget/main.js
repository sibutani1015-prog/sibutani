const { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, nativeImage, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
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

/* ---------- 외장하드로 자동 동기화 ----------
   griddesk-store.json(실제 데이터)과는 별도로, "어느 폴더에 동기화할지"만 이
   컴퓨터에 로컬로 저장해둠 - 이 설정 자체는 컴퓨터마다 다를 수 있어서(드라이브
   문자가 다를 수 있음) 동기화 대상에서 제외함. */
const CONFIG_PATH = path.join(app.getPath('userData'), 'griddesk-config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) { return {}; }
}
function writeConfig(data) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8'); } catch (e) {}
}
let configCache = readConfig();

function syncFilePath() {
  if (!configCache.syncFolder) return null;
  return path.join(configCache.syncFolder, 'griddesk-sync.json');
}

// 퇴근 전 한 번에(저장 후 종료) 때 호출: 지금 데이터를 외장하드에도 남겨둠
function writeSyncCopy() {
  const target = syncFilePath();
  if (!target) return;
  try {
    fs.writeFileSync(target, JSON.stringify({ savedAt: new Date().toISOString(), data: storeCache }, null, 2), 'utf-8');
    configCache.lastSyncedAt = new Date().toISOString();
    writeConfig(configCache);
  } catch (e) {
    // 외장하드가 안 꽂혀 있거나 쓰기 실패해도, 로컬 저장(퇴근 전 백업)은 이미 됐으니 조용히 넘어감
  }
}

// 앱 시작 시 호출: 외장하드 쪽이 이 컴퓨터보다 더 최신이면 그걸로 덮어씀
function importSyncCopyIfNewer() {
  const target = syncFilePath();
  if (!target) return;
  try {
    if (!fs.existsSync(target)) return;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    if (!parsed || !parsed.savedAt || !parsed.data) return;
    const usbTime = new Date(parsed.savedAt).getTime();
    const localTime = configCache.lastSyncedAt ? new Date(configCache.lastSyncedAt).getTime() : 0;
    if (isNaN(usbTime) || usbTime <= localTime) return; // 이 컴퓨터가 이미 그만큼 최신이면 안 건드림
    storeCache = parsed.data;
    writeStore(storeCache);
    configCache.lastSyncedAt = parsed.savedAt;
    writeConfig(configCache);
  } catch (e) {
    // 외장하드 파일이 깨져있거나 읽기 실패하면, 이 컴퓨터에 있던 데이터를 그대로 안전하게 유지
  }
}
importSyncCopyIfNewer();

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
  mainWindow.on('moved', scheduleDockReposition);
  mainWindow.on('resized', scheduleDockReposition);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function bringToFront() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  restoreDockedWindow();
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
    {
      label: configCache.syncFolder ? ('동기화 폴더: ' + configCache.syncFolder) : '동기화 폴더 선택 (외장하드)...',
      click: async () => {
        const res = await dialog.showOpenDialog(mainWindow, {
          title: '외장하드 안의 동기화 폴더 선택',
          properties: ['openDirectory']
        });
        if (res.canceled || !res.filePaths[0]) return;
        configCache.syncFolder = res.filePaths[0];
        writeConfig(configCache);
        buildTrayMenu();
      }
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

/* ---------- 카톡 붙이기: 위젯을 옮기면 지정해둔 다른 프로그램(카카오톡 등)의
   창도 오른쪽에 붙어서 같이 따라오고, Ctrl+Alt+D로 숨기면 그 창도 같이
   최소화됨(옆에서 지나가는 사람이 못 보게). 우리 앱이 아닌 다른 프로그램의
   창이라 Electron API로는 못 다루고, Windows API(user32.dll)를 쓰는
   PowerShell 스크립트(scripts/winhelper.ps1)로 처리함 - robotjs 같은
   네이티브 npm 모듈을 새로 빌드해야 하는 위험을 피하기 위함. ---------- */
const WINHELPER_PATH = path.join(__dirname, 'scripts', 'winhelper.ps1');
function runWinHelper(args) {
  return new Promise((resolve) => {
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINHELPER_PATH].concat(args), { windowsHide: true });
      let out = '';
      ps.stdout.on('data', (d) => { out += d.toString(); });
      ps.on('close', () => {
        try { resolve(JSON.parse(out.trim())); } catch (e) { resolve({ ok: false }); }
      });
      ps.on('error', () => resolve({ ok: false }));
    } catch (e) {
      resolve({ ok: false });
    }
  });
}

let dockRepositionTimer = null;
function scheduleDockReposition() {
  if (!configCache.dockEnabled || !configCache.dockTarget || !mainWindow) return;
  clearTimeout(dockRepositionTimer);
  dockRepositionTimer = setTimeout(() => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    runWinHelper(['-Action', 'Move', '-Process', configCache.dockTarget.process, '-Title', configCache.dockTarget.title, '-X', String(b.x + b.width), '-Y', String(b.y)]);
  }, 150);
}

function dockArgsIfAny() {
  return (configCache.dockEnabled && configCache.dockTarget)
    ? ['-Process', configCache.dockTarget.process, '-Title', configCache.dockTarget.title]
    : null;
}
// 위젯을 숨기는/보이는 경로가 여러 개(Ctrl+Alt+D, 독의 잠깐 숨기기, 트레이 아이콘
// 클릭, 트레이 메뉴)라서, 카톡 창도 항상 같이 최소화/복원되도록 한 곳에 모아둠.
function minimizeDockedWindow() {
  const args = dockArgsIfAny();
  if (args) runWinHelper(['-Action', 'Minimize'].concat(args));
}
function restoreDockedWindow() {
  const args = dockArgsIfAny();
  if (args) runWinHelper(['-Action', 'Restore'].concat(args)).then(() => scheduleDockReposition());
}

// 카톡을 붙이기로 지정해두지 않았어도 쓸 수 있는 비상 단축키: 열려있는
// 카카오톡 창을 전부(친구 목록 + 대화창들) 한번에 최소화/복원함. 지정해둔
// 창이 있으면 그 프로세스 이름을 쓰고, 없으면 "KakaoTalk"으로 가정함.
let kakaoAllHidden = false;
function kakaoProcessName() {
  return (configCache.dockTarget && configCache.dockTarget.process) || 'KakaoTalk';
}

app.whenReady().then(() => {
  createWindow();
  buildTray();

  globalShortcut.register('CommandOrControl+Alt+D', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      minimizeDockedWindow();
    } else {
      bringToFront();
    }
  });

  // 비상 단축키: 위젯과는 무관하게, 열려있는 카카오톡 창만 전부 숨기거나 복원함
  globalShortcut.register('CommandOrControl+Alt+K', () => {
    const proc = kakaoProcessName();
    if (!kakaoAllHidden) {
      runWinHelper(['-Action', 'MinimizeAllByProcess', '-Process', proc]);
      kakaoAllHidden = true;
    } else {
      runWinHelper(['-Action', 'RestoreAllByProcess', '-Process', proc]).then(() => scheduleDockReposition());
      kakaoAllHidden = false;
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
  minimizeDockedWindow();
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
  writeSyncCopy();
  // 퇴근 전 한 번에: 저장까지 끝났으니 컴퓨터 자체도 종료. 15초 유예를 둬서
  // 실수로 눌렀을 때 명령 프롬프트에서 shutdown /a 로 취소할 시간을 줌.
  notifyDday('저장 완료', '15초 후 컴퓨터가 종료됩니다.');
  try {
    spawn('shutdown.exe', ['/s', '/t', '15'], { windowsHide: true });
  } catch (e) {
    // 종료 명령이 실패해도(권한 등) 앱 종료 자체는 계속 진행
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

/* ---------- IPC: 카톡 붙이기 ---------- */
ipcMain.handle('pick-dock-window', async () => {
  const res = await runWinHelper(['-Action', 'Pick']);
  if (res && res.ok && res.title) {
    configCache.dockTarget = { process: res.process, title: res.title };
    configCache.dockEnabled = true;
    writeConfig(configCache);
    scheduleDockReposition();
  }
  return res;
});

ipcMain.on('unset-dock-window', () => {
  configCache.dockTarget = null;
  configCache.dockEnabled = false;
  writeConfig(configCache);
});

ipcMain.handle('get-dock-status', () => {
  return { enabled: !!(configCache.dockEnabled && configCache.dockTarget), title: configCache.dockTarget ? configCache.dockTarget.title : null };
});

/* ---------- D-Day 예매 자동화: 정해둔 시각에 사이트 열기 + 새로고침 ----------
   내 컴퓨터 시계가 몇 초 어긋나 있을 수 있어서, 표준시(HTTPS 서버 응답의 Date
   헤더)로 한 번 보정값을 구해두고, 그 보정값을 더한 "진짜 시각" 기준으로 판단함. */
let clockOffsetMs = 0;
function syncClockOffset() {
  try {
    const req = https.request({ host: 'www.naver.com', method: 'HEAD', timeout: 5000 }, (res) => {
      const serverDate = res.headers && res.headers.date ? new Date(res.headers.date) : null;
      if (serverDate && !isNaN(serverDate.getTime())) {
        clockOffsetMs = serverDate.getTime() - Date.now();
      }
      res.resume();
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end();
  } catch (e) {
    // 오프라인이면 그냥 이 컴퓨터 시계를 그대로 씀
  }
}
syncClockOffset();
setInterval(syncClockOffset, 60 * 60 * 1000); // 한 시간마다 다시 보정

function correctedNow() { return new Date(Date.now() + clockOffsetMs); }

function refreshFrontWindow() {
  // 그 순간 활성 창(포커스된 창)에 F5를 보냄 - 예매 사이트 탭이 맨 앞에 있어야 함
  const ps = spawn('powershell.exe', [
    '-NoProfile', '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F5}')"
  ], { windowsHide: true });
  ps.on('error', () => {});
}

function notifyDday(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

const firedDdayActions = new Set();
function targetDate(dateStr, timeStr) {
  // timeStr: "HH:MM" 또는 "HH:MM:SS"
  const d = new Date(dateStr + 'T' + (timeStr.length === 5 ? timeStr + ':00' : timeStr));
  return isNaN(d.getTime()) ? null : d;
}
function checkDdayAutomations() {
  const ddays = storeCache['griddesk.ddays'];
  if (!Array.isArray(ddays)) return;
  const now = correctedNow();
  ddays.forEach((item) => {
    if (!item || !item.url || !item.d) return;
    [
      ['notifyAt', 'notify'],
      ['openAt', 'open'],
      ['refreshAt', 'refresh']
    ].forEach(([field, kind]) => {
      const timeStr = item[field];
      if (!timeStr) return;
      const key = item.n + '|' + item.d + '|' + kind;
      if (firedDdayActions.has(key)) return;
      const target = targetDate(item.d, timeStr);
      if (!target) return;
      const diffMs = now.getTime() - target.getTime();
      if (diffMs < 0 || diffMs > 60000) return; // 아직 안 됐거나, 1분 넘게 지난 건 건너뜀(놓친 것)
      firedDdayActions.add(key);
      if (kind === 'notify') {
        notifyDday('D-Day 알림: ' + item.n, '예매 준비 시간이에요.');
      } else if (kind === 'open') {
        shell.openExternal(item.url);
        notifyDday('사이트를 열었어요: ' + item.n, item.url);
      } else if (kind === 'refresh') {
        refreshFrontWindow();
      }
    });
  });
}
setInterval(checkDdayAutomations, 1000);
