const { app, BrowserWindow, Tray, Menu, screen, ipcMain, globalShortcut, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      bringToFront();
    }
  });
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
