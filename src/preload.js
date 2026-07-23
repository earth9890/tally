'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  summary: (range) => ipcRenderer.invoke('summary', range),
  timeline: (day) => ipcRenderer.invoke('timeline', day),
  week: () => ipcRenderer.invoke('week'),
  seenApps: () => ipcRenderer.invoke('seenApps'),
  getCategories: () => ipcRenderer.invoke('getCategories'),
  setCategory: (app, prod) => ipcRenderer.invoke('setCategory', { app, prod }),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSetting: (key, value) => ipcRenderer.invoke('setSetting', { key, value }),
  getTracking: () => ipcRenderer.invoke('getTracking'),
  setTracking: (on) => ipcRenderer.invoke('setTracking', on),
  popoverData: () => ipcRenderer.invoke('popoverData'),
  openDashboard: () => ipcRenderer.invoke('openDashboard'),
  quit: () => ipcRenderer.invoke('quit'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  about: () => ipcRenderer.invoke('about'),
  chooseSound: () => ipcRenderer.invoke('chooseSound'),
  openRepo: () => ipcRenderer.invoke('openRepo'),
  onPopoverRefresh: (cb) => ipcRenderer.on('popover:refresh', () => cb()),
  getReminders: () => ipcRenderer.invoke('getReminders'),
  saveReminder: (r) => ipcRenderer.invoke('saveReminder', r),
  deleteReminder: (id) => ipcRenderer.invoke('deleteReminder', id),
  testReminder: (id) => ipcRenderer.invoke('testReminder', id),
  onCurrent: (cb) => ipcRenderer.on('current', (_e, data) => cb(data)),
});
