const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),

  // Connection status
  getStatus: () => ipcRenderer.invoke('get-status'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // Projects
  getProjects: () => ipcRenderer.invoke('get-projects'),
  scanProjects: () => ipcRenderer.invoke('scan-projects'),
  addProjectsDir: () => ipcRenderer.invoke('add-projects-dir'),
  removeProjectsDir: (dir: string) => ipcRenderer.invoke('remove-projects-dir', dir),

  // Events
  onStatusChanged: (callback: (status: { connected: boolean }) => void) => {
    ipcRenderer.on('status-changed', (_event: any, status: any) => callback(status));
  },
});
