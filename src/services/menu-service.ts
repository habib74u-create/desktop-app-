// src/services/menu-service.ts
import { Menu, Tray, nativeImage, app, shell } from 'electron';
import path from 'path';
import { log } from '../core/logger';
import { getWindowManager } from './window-manager';
import { getUpdateService } from './update-service';
import { getJarvisCore } from '../core/jarvis-core';

export class MenuService {
  private tray: Tray | null = null;
  private appMenuBuilt = false;

  init(): void {
    this.buildAppMenu();
    this.buildTray();
    log.services.info('menu-service ready');
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /* ---- App menu --------------------------------------------------------- */

  private buildAppMenu(): void {
    if (this.appMenuBuilt) return;
    const isMac = process.platform === 'darwin';
    const send = (channel: string) => () => {
      getWindowManager().broadcast(channel);
    };

    const template: Electron.MenuItemConstructorOptions[] = [
      ...(isMac
        ? ([
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: () => getWindowManager().focusOrCreate('settings') },
                { label: 'Check for Updates…', click: () => void getUpdateService().check() },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: send('menu:new-session') },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Jarvis',
        submenu: [
          { label: 'Start Listening', accelerator: 'CmdOrCtrl+Shift+L', click: send('menu:start-listening') },
          { label: 'Stop Listening',  accelerator: 'CmdOrCtrl+Shift+S', click: send('menu:stop-listening') },
          { type: 'separator' },
          { label: 'Toggle Overlay',  click: send('menu:toggle-overlay') },
          { label: 'Toggle Tray Icon', click: send('menu:toggle-tray') },
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Documentation', click: () => void shell.openExternal('https://example.com/docs') },
          { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/YOUR_ORG/jarvis-desktop/issues') },
          { type: 'separator' },
          { label: 'About Jarvis', click: send('menu:about') },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.appMenuBuilt = true;
  }

  /* ---- Tray ------------------------------------------------------------- */

  private buildTray(): void {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'jarvis-menubar-template.png');
    let image = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') image.setTemplateImage(true);

    try {
      this.tray = new Tray(image);
    } catch (err) {
      log.services.error('failed to create tray', err);
      return;
    }

    const core = getJarvisCore();
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Jarvis',
        click: () => getWindowManager().focusOrCreate('main'),
      },
      {
        label: 'Open Settings…',
        click: () => getWindowManager().focusOrCreate('settings'),
      },
      { type: 'separator' },
      {
        label: 'Toggle Listening',
        click: () => {
          const state = core.getState();
          core.setState(state === 'listening' ? 'idle' : 'listening', 'tray-toggle');
        },
      },
      { type: 'separator' },
      {
        label: `Version ${app.getVersion()}`,
        enabled: false,
      },
      {
        label: 'Check for Updates…',
        click: () => void getUpdateService().check(),
      },
      { type: 'separator' },
      { label: 'Quit Jarvis', role: 'quit' },
    ]);

    this.tray.setToolTip('Jarvis');
    this.tray.setContextMenu(contextMenu);
    this.tray.on('click', () => {
      if (process.platform === 'darwin') this.tray?.popUpContextMenu();
      else getWindowManager().focusOrCreate('main');
    });
  }

  setTrayVisible(visible: boolean): void {
    if (!this.tray) return;
    if (visible) this.tray.setImage(this.tray.getIgnoreDoubleClickEvents ? this.tray.getImage() : nativeImage.createEmpty());
    else this.tray.destroy();
  }
}

let instance: MenuService | null = null;
export function initMenuService(): MenuService {
  if (instance) return instance;
  instance = new MenuService();
  return instance;
}
export function getMenuService(): MenuService {
  if (!instance) throw new Error('MenuService not initialized');
  return instance;
}
