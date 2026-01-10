// Type declarations for the Electron API exposed via preload
declare global {
  interface Window {
    electron: {
      query: (text: string) => Promise<string>;
      getDatetime: () => Promise<string>;
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
      onStatus: (callback: (status: string) => void) => () => void;
      onReset: (callback: () => void) => () => void;
      onScreenshotAttached: (callback: (base64: string) => void) => () => void;
    };
  }
}

export {};
