import { contextBridge, ipcRenderer } from "electron";

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld("electron", {
  // Agent
  query: (text: string) => ipcRenderer.invoke("agent:query", text),
  getDatetime: () => ipcRenderer.invoke("agent:datetime"),
  setProvider: (provider: "openai" | "ollama") =>
    ipcRenderer.invoke("agent:setProvider", provider),
  getProvider: () => ipcRenderer.invoke("agent:getProvider"),

  // Google
  manageTasks: (action: string, params?: any) =>
    ipcRenderer.invoke("google:tasks", action, params),
  manageCalendar: (action: string, params?: any) =>
    ipcRenderer.invoke("google:calendar", action, params),
  manageEmail: (action: string, params?: any) =>
    ipcRenderer.invoke("google:email", action, params),

  // Web
  webSearch: (query: string, maxResults?: number) =>
    ipcRenderer.invoke("web:search", query, maxResults),

  // System
  systemStatus: () => ipcRenderer.invoke("system:status"),
  systemProcesses: () => ipcRenderer.invoke("system:processes"),

  // Screenshot
  attachScreenshot: () => ipcRenderer.invoke("screenshot:attach"),
  clearScreenshot: () => ipcRenderer.invoke("screenshot:clear"),
  getPendingScreenshot: () => ipcRenderer.invoke("screenshot:getPending"),

  // Whisper (local voice recognition)
  transcribeAudio: (audioBase64: string) =>
    ipcRenderer.invoke("whisper:transcribe", audioBase64),
  whisperStatus: () => ipcRenderer.invoke("whisper:status"),

  // Window
  hideWindow: () => ipcRenderer.send("window:hide"),
  resizeWindow: (height: number) => ipcRenderer.send("window:resize", height),

  // App settings
  getAutoLaunch: () => ipcRenderer.invoke("app:getAutoLaunch"),
  toggleAutoLaunch: () => ipcRenderer.invoke("app:toggleAutoLaunch"),
  testNotification: (type?: "normal" | "high" | "critical") =>
    ipcRenderer.invoke("app:testNotification", type),

  // Events from main
  onStatus: (callback: (status: string) => void) => {
    ipcRenderer.on("agent:status", (_, status) => callback(status));
    return () => ipcRenderer.removeAllListeners("agent:status");
  },
  onReset: (callback: () => void) => {
    ipcRenderer.on("window:reset", () => callback());
    return () => ipcRenderer.removeAllListeners("window:reset");
  },
  onScreenshotAttached: (callback: (base64: string) => void) => {
    ipcRenderer.on("screenshot:attached", (_, base64) => callback(base64));
    return () => ipcRenderer.removeAllListeners("screenshot:attached");
  },
  onNotificationAction: (callback: (query: string) => void) => {
    ipcRenderer.on("notification:action", (_, query) => callback(query));
    return () => ipcRenderer.removeAllListeners("notification:action");
  },
});

// Type declarations for the exposed API
declare global {
  interface Window {
    electron: {
      query: (text: string) => Promise<string>;
      getDatetime: () => Promise<string>;
      setProvider: (provider: "openai" | "ollama") => Promise<void>;
      getProvider: () => Promise<"openai" | "ollama">;
      manageTasks: (action: string, params?: any) => Promise<string>;
      manageCalendar: (action: string, params?: any) => Promise<string>;
      manageEmail: (action: string, params?: any) => Promise<string>;
      webSearch: (query: string, maxResults?: number) => Promise<any>;
      systemStatus: () => Promise<any>;
      systemProcesses: () => Promise<any>;
      attachScreenshot: () => Promise<{
        success: boolean;
        base64?: string;
        error?: string;
      }>;
      clearScreenshot: () => Promise<{ success: boolean }>;
      getPendingScreenshot: () => Promise<{
        attached: boolean;
        base64?: string;
      }>;
      transcribeAudio: (audioBase64: string) => Promise<{
        success: boolean;
        transcript?: string;
        error?: string;
      }>;
      whisperStatus: () => Promise<{
        loaded: boolean;
        loading: boolean;
      }>;
      hideWindow: () => void;
      resizeWindow: (height: number) => void;
      getAutoLaunch: () => Promise<boolean>;
      toggleAutoLaunch: () => Promise<boolean>;
      testNotification: (
        type?: "normal" | "high" | "critical"
      ) => Promise<{ success: boolean }>;
      onStatus: (callback: (status: string) => void) => () => void;
      onReset: (callback: () => void) => () => void;
      onScreenshotAttached: (callback: (base64: string) => void) => () => void;
      onNotificationAction: (callback: (query: string) => void) => () => void;
    };
  }
}
