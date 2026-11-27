'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcomGui', {
  getConfig: () => ipcRenderer.invoke('hcomGui:getConfig'),
  pickFolder: () => ipcRenderer.invoke('hcomGui:pickFolder'),
  pickInstallerAndUpdate: () => ipcRenderer.invoke('hcomGui:pickInstallerAndUpdate'),
});
