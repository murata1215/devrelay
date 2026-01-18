const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Connection status
  getStatus: () => ipcRenderer.invoke('get-status'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // Projects
  getProjects: () => ipcRenderer.invoke('get-projects'),
  scanProjects: () => ipcRenderer.invoke('scan-projects'),
  addProjectsDir: () => ipcRenderer.invoke('add-projects-dir'),
  removeProjectsDir: (dir) => ipcRenderer.invoke('remove-projects-dir', dir),

  // Auto launch
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  // Events
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (_event, status) => callback(status));
  },
});
