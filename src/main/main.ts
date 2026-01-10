import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  Notification,
} from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { config } from "dotenv";
import { AgentService } from "./services/agent.js";
import { GoogleService } from "./services/google.js";
import { SystemService } from "./services/system.js";
import { WebSearchService } from "./services/websearch.js";
import { ScreenshotService } from "./services/screenshot.js";
import { WhisperService } from "./services/whisper.js";
import { BrowserService } from "./services/browser.js";
import { ProactiveService } from "./services/proactive.js";
import Store from "electron-store";
import { createCanvas } from "canvas";
import { logger } from "./utils/logger.js";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
config({ path: path.join(__dirname, "../../.env") });

const store = new Store({
  defaults: {
    autoLaunch: false,
  },
});
const isDev = !app.isPackaged;
const rendererPath = path.join(__dirname, "../renderer/index.html");
const hasBuiltRenderer = fs.existsSync(rendererPath);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentService: AgentService;
let googleService: GoogleService;
let systemService: SystemService;
let webSearchService: WebSearchService;
let screenshotService: ScreenshotService;
let whisperService: WhisperService;
let browserService: BrowserService;
let proactiveService: ProactiveService;
let proactiveInterval: NodeJS.Timeout | null = null;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;
  const winWidth = 560;
  const winHeight = 80;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.floor((screenWidth - winWidth) / 2),
    y: 18, // Top center [[memory:6025037]]
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false, // Helps with transparency on Windows
    thickFrame: false, // Prevents Windows DWM issues with transparent windows
    backgroundColor: "#00000000", // Fully transparent but defined - helps Windows render
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // Prevent throttling when unfocused
    },
  });

  // Hide from screen capture (Windows)
  mainWindow.setContentProtection(true);

  // Use built renderer if available, otherwise try dev server
  if (hasBuiltRenderer) {
    logger.info("Main", `Loading built renderer from: ${rendererPath}`);
    mainWindow.loadFile(rendererPath);
  } else if (isDev) {
    logger.info(
      "Main",
      "No built renderer found, trying dev server at http://localhost:5173"
    );
    mainWindow.loadURL("http://localhost:5173");
  } else {
    logger.error(
      "Main",
      "No renderer found! Build the renderer first with: npm run build:renderer"
    );
    app.quit();
  }

  mainWindow.on("blur", () => {
    // Don't hide on blur - user may want to keep it open
    // Force repaint on blur to prevent transparency rendering issues on Windows
    if (mainWindow) {
      mainWindow.setOpacity(0.99);
      setTimeout(() => mainWindow?.setOpacity(1), 10);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupAutoLaunch() {
  const autoLaunch = store.get("autoLaunch", true) as boolean;
  const appPath = app.getPath("exe");
  const appName = app.getName();

  app.setLoginItemSettings({
    openAtLogin: autoLaunch,
    openAsHidden: true, // Start minimized to tray
    path: appPath,
    name: appName,
  });

  logger.info("Main", `Auto-launch ${autoLaunch ? "enabled" : "disabled"}`);
}

function toggleAutoLaunch(): boolean {
  const current = store.get("autoLaunch", true) as boolean;
  const newValue = !current;
  store.set("autoLaunch", newValue);
  setupAutoLaunch();
  return newValue;
}

function getAutoLaunch(): boolean {
  return store.get("autoLaunch", true) as boolean;
}

function updateTrayMenu() {
  if (!tray) return;

  const autoLaunchEnabled = getAutoLaunch();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open (Ctrl+Y)",
      click: () => toggleWindow(),
    },
    { type: "separator" },
    {
      label: "Auto-launch on startup",
      type: "checkbox",
      checked: autoLaunchEnabled,
      click: () => {
        toggleAutoLaunch();
        updateTrayMenu(); // Refresh menu
      },
    },
    { type: "separator" },
    // Test notifications only in development mode
    ...(isDev
      ? [
          {
            label: "Test Notifications (Dev Only)",
            submenu: [
              {
                label: "Normal (Ctrl+Shift+N)",
                click: () => testNotification("normal"),
              },
              {
                label: "High Priority (Ctrl+Shift+H)",
                click: () => testNotification("high"),
              },
              {
                label: "Critical (Ctrl+Shift+C)",
                click: () => testNotification("critical"),
              },
            ],
          },
        ]
      : []),
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  // Create a simple tray icon
  const iconSize = 32;
  const icon = nativeImage.createEmpty();

  // For production, use a proper icon file
  // Generate a simple tray icon with an "A" using a canvas
  const canvas = createCanvas(iconSize, iconSize);
  const ctx = canvas.getContext("2d");

  // Transparent background
  ctx.clearRect(0, 0, iconSize, iconSize);

  // Optional: subtle background circle
  ctx.beginPath();
  ctx.arc(iconSize / 2, iconSize / 2, iconSize / 2 - 2, 0, 2 * Math.PI, false);
  ctx.fillStyle = "#f7fafc";
  ctx.globalAlpha = 0.95;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Draw centered "A"
  ctx.font = "bold 20px Sans-serif";
  ctx.fillStyle = "#222";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", iconSize / 2, iconSize / 2 + 1);

  tray = new Tray(nativeImage.createFromBuffer(canvas.toBuffer()));

  tray.setToolTip(`Assistant`);

  updateTrayMenu();
  tray.on("click", () => toggleWindow());
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
  }

  if (mainWindow) {
    if (mainWindow.isVisible()) {
      // Window is visible - check if focused
      if (mainWindow.isFocused()) {
        // Focused + visible = user wants to hide
        mainWindow.hide();
      } else {
        // Visible but not focused = just bring focus back (no reset!)
        // mainWindow.show();
        // mainWindow.focus();
        mainWindow.hide();
      }
    } else {
      // Window was hidden - show and reset to idle state
      const [width] = mainWindow.getSize();
      mainWindow.setSize(width, 68);
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("window:reset");
    }
  }
}

function showNotification(title: string, body: string) {
  new Notification({
    title,
    body: body.slice(0, 256),
  }).show();
}

function testNotification(type: "normal" | "high" | "critical" = "normal") {
  const testNotifications = {
    normal: {
      title: "📧 Test Notification (Normal)",
      message:
        "This is a normal priority notification. Click to open the assistant.",
      priority: "normal" as const,
    },
    high: {
      title: "🔴 Test Notification (High Priority)",
      message:
        "This is a high priority notification. This would typically alert you to important emails or urgent tasks.",
      priority: "high" as const,
    },
    critical: {
      title: "🚨 Test Notification (Critical)",
      message:
        "This is a critical priority notification. This would be used for urgent deadlines or critical system alerts.",
      priority: "high" as const,
    },
  };

  const test = testNotifications[type];
  const electronNotification = new Notification({
    title: test.title,
    body: test.message,
    urgency:
      type === "critical" ? "critical" : type === "high" ? "normal" : "normal",
  });

  electronNotification.on("click", () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        toggleWindow();
      } else {
        mainWindow.focus();
      }
    }
  });

  electronNotification.show();
  logger.debug("Main", `Test notification sent: ${type}`);
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Y", () => {
    toggleWindow();
  });

  // Test notification shortcuts only in development mode
  if (isDev) {
    // Ctrl+Shift+N to test normal notification
    globalShortcut.register("CommandOrControl+Shift+N", () => {
      testNotification("normal");
    });

    // Ctrl+Shift+H to test high priority notification
    globalShortcut.register("CommandOrControl+Shift+H", () => {
      testNotification("high");
    });

    // Ctrl+Shift+C to test critical notification
    globalShortcut.register("CommandOrControl+Shift+C", () => {
      testNotification("critical");
    });
  }

  // Ctrl+H to capture screenshot and attach to next message
  globalShortcut.register("CommandOrControl+H", async () => {
    try {
      logger.info("Main", "Ctrl+H pressed - capturing screenshot...");
      const base64 = await screenshotService.captureAsBase64();
      agentService.setPendingScreenshot(base64);

      // Show window if hidden and notify renderer
      if (mainWindow) {
        if (!mainWindow.isVisible()) {
          mainWindow.show();
          mainWindow.focus();
        }
        mainWindow.webContents.send("screenshot:attached", base64);
      }
      logger.debug("Main", "Screenshot attached, ready for next message");
    } catch (error: any) {
      logger.error("Main", "Screenshot capture failed", error);
    }
  });
}

function setupIPC() {
  // Process user query
  ipcMain.handle("agent:query", async (_, query: string) => {
    logger.info("IPC", `Received query: ${query.substring(0, 50)}...`);
    try {
      const result = await agentService.processQuery(query);
      logger.debug("IPC", `Query processed, result length: ${result.length}`);
      return result;
    } catch (error) {
      logger.error("IPC", "Error processing query", error);
      throw error;
    }
  });

  // Get current datetime
  ipcMain.handle("agent:datetime", async () => {
    return new Date().toLocaleString();
  });

  // Set agent provider (OpenAI or Ollama)
  ipcMain.handle(
    "agent:setProvider",
    async (_, provider: "openai" | "ollama") => {
      logger.info("IPC", `Setting agent provider to: ${provider}`);
      agentService.setProvider(provider);
    }
  );

  // Get current agent provider
  ipcMain.handle("agent:getProvider", async () => {
    return agentService.getProvider();
  });

  // Google services
  ipcMain.handle("google:tasks", async (_, action: string, params?: any) => {
    return await googleService.manageTasks(action, params);
  });

  ipcMain.handle("google:calendar", async (_, action: string, params?: any) => {
    return await googleService.manageCalendar(action, params);
  });

  ipcMain.handle("google:email", async (_, action: string, params?: any) => {
    return await googleService.manageEmail(action, params);
  });

  // Web search
  ipcMain.handle(
    "web:search",
    async (_, query: string, maxResults?: number) => {
      return await webSearchService.search(query, maxResults);
    }
  );

  // System
  ipcMain.handle("system:status", async () => {
    return await systemService.getStatus();
  });

  ipcMain.handle("system:processes", async () => {
    return await systemService.getTopProcesses();
  });

  // Screenshot
  ipcMain.handle("screenshot:capture", async () => {
    const result = await screenshotService.captureScreen();
    return { path: result.path };
  });

  // Attach screenshot to next message
  ipcMain.handle("screenshot:attach", async () => {
    try {
      const base64 = await screenshotService.captureAsBase64();
      agentService.setPendingScreenshot(base64);
      return { success: true, base64 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Clear pending screenshot
  ipcMain.handle("screenshot:clear", async () => {
    agentService.setPendingScreenshot("");
    return { success: true };
  });

  // Get pending screenshot status
  ipcMain.handle("screenshot:getPending", async () => {
    const pending = agentService.getPendingScreenshot();
    return pending ? { attached: true, base64: pending } : { attached: false };
  });

  // Google OAuth
  ipcMain.handle("google:getAuthUrl", async () => {
    try {
      return await googleService.getAuthUrl();
    } catch (error: any) {
      throw new Error(`Failed to get auth URL: ${error.message}`);
    }
  });

  ipcMain.handle("google:handleCallback", async (_, code: string) => {
    try {
      const success = await googleService.handleOAuthCallback(code);
      if (success) {
        // Reinitialize services after getting token
        await googleService.initialize();
      }
      return success;
    } catch (error: any) {
      throw new Error(`Failed to handle callback: ${error.message}`);
    }
  });

  // Auto-launch controls
  ipcMain.handle("app:getAutoLaunch", async () => {
    return getAutoLaunch();
  });

  ipcMain.handle("app:toggleAutoLaunch", async () => {
    const newValue = toggleAutoLaunch();
    updateTrayMenu(); // Update tray menu to reflect change
    return newValue;
  });

  // Test notifications
  ipcMain.handle(
    "app:testNotification",
    async (_, type: "normal" | "high" | "critical" = "normal") => {
      testNotification(type);
      return { success: true };
    }
  );

  // Window controls
  ipcMain.on("window:hide", () => {
    mainWindow?.hide();
  });

  ipcMain.on("window:resize", (_, height: number) => {
    if (mainWindow && typeof height === "number" && !isNaN(height)) {
      const [width] = mainWindow.getSize();
      const heightInt = Math.round(height);
      logger.debug("Main", `Resizing window to ${width}x${heightInt}`);

      // Use setBounds for more reliable resizing on Windows with transparent windows
      const bounds = mainWindow.getBounds();
      mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: width,
        height: heightInt,
      });
    }
  });

  // Reset state (sent from main process when window is shown)
  // This is handled via webContents.send, no handler needed here

  // Whisper transcription
  ipcMain.handle("whisper:transcribe", async (_, audioBase64: string) => {
    try {
      logger.info("IPC", "Transcribing audio...");
      const transcript = await whisperService.transcribeFromBase64(audioBase64);
      logger.debug(
        "IPC",
        `Transcription result: ${transcript.slice(0, 50)}...`
      );
      return { success: true, transcript };
    } catch (error: any) {
      logger.error("IPC", "Transcription error", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("whisper:status", async () => {
    return {
      loaded: whisperService.isModelLoaded(),
      loading: whisperService.isLoading(),
    };
  });
}

app.whenReady().then(async () => {
  // Request notification permission (required on some systems)
  if (process.platform === "win32") {
    // Windows 10+ requires app user model ID for notifications
    // Use a proper AUMID format instead of execPath to show "Assistant" in notification header
    app.setAppUserModelId("Assistant");
    // Set app name for notifications (Windows uses this)
    if (process.platform === "win32") {
      app.setName("Assistant");
    }
  }

  // Check if notifications are supported
  if (!Notification.isSupported()) {
    logger.warn(
      "Main",
      "Desktop notifications are not supported on this system"
    );
  } else {
    logger.debug("Main", "Desktop notifications are supported");
  }

  logger.info("Main", "Initializing services...");

  // Initialize services
  agentService = new AgentService();
  googleService = new GoogleService();
  systemService = new SystemService();
  webSearchService = new WebSearchService();
  screenshotService = new ScreenshotService();
  whisperService = new WhisperService();
  browserService = new BrowserService(true); // headless by default
  proactiveService = new ProactiveService(
    googleService,
    systemService,
    agentService
  );

  // Initialize Whisper in background (preload model)
  whisperService.initialize().then((success) => {
    if (success) {
      logger.info("Main", "Whisper service initialized");
    } else {
      logger.warn("Main", "Whisper service initialization failed");
    }
  });

  // Connect services to agent
  agentService.setServices(
    googleService,
    webSearchService,
    systemService,
    screenshotService
  );
  agentService.setBrowserService(browserService);

  // Set up progress callback to send status updates to renderer
  agentService.setProgressCallback((status: string) => {
    mainWindow?.webContents.send("agent:status", status);
  });
  logger.info("Main", "Services connected to agent");

  const googleInitialized = await googleService.initialize();
  if (!googleInitialized) {
    logger.warn("Main", "Google services not initialized. To set up OAuth:");
    logger.info("Main", "1. Place credentials.json in the project root");
    logger.info("Main", "2. Run: npm run oauth");
    logger.info("Main", "Or call startGoogleOAuth() from the console");
  }

  logger.info("Main", "Creating window and UI...");
  setupAutoLaunch(); // Set up auto-launch on startup
  createWindow();
  createTray();
  registerShortcuts();
  setupIPC();
  logger.info("Main", "IPC handlers registered");

  // Set up proactive service notification callback
  proactiveService.setNotifyCallback(async (notification) => {
    try {
      // Show system notification
      if (!Notification.isSupported()) {
        logger.warn(
          "Proactive",
          "Notifications not supported, logging instead"
        );
        logger.info(
          "Proactive",
          `Notification: ${notification.title}: ${notification.message}`
        );
        return;
      }

      // Format message for better readability (limit to 256 chars but preserve structure)
      const formatMessage = (msg: string): string => {
        // Clean up multiple newlines
        let formatted = msg.replace(/\n{3,}/g, "\n\n").trim();
        // If too long, truncate intelligently
        if (formatted.length > 256) {
          const lines = formatted.split("\n");
          let result = "";
          for (const line of lines) {
            if (result.length + line.length + 1 > 240) break;
            result += (result ? "\n" : "") + line;
          }
          if (result.length < formatted.length) {
            result += "\n...";
          }
          return result;
        }
        return formatted;
      };

      const notificationOptions: Electron.NotificationConstructorOptions = {
        title: notification.title, // Windows will automatically prefix with app name
        body: formatMessage(notification.message),
        urgency: notification.priority === "high" ? "critical" : "normal",
        silent: true, // All notifications are silent
        // Windows 10+ action buttons support
        timeoutType: notification.priority === "high" ? "never" : "default",
      };

      // Action buttons removed for now (not visible/working properly)

      const electronNotification = new Notification(notificationOptions);

      // Handle notification click (main body click)
      electronNotification.on("click", () => {
        logger.debug("Proactive", "Notification clicked");
        // Show and focus the agent window
        if (mainWindow) {
          if (!mainWindow.isVisible()) {
            toggleWindow();
          } else {
            mainWindow.focus();
          }
        }
        // Legacy action support
        if (notification.action) {
          notification.action();
        }
      });

      // Action button click handling removed for now

      electronNotification.on("show", () => {
        logger.debug("Proactive", `Notification shown: ${notification.title}`);
      });

      electronNotification.show();
      logger.info("Proactive", `Notification sent: ${notification.title}`);
    } catch (error) {
      logger.error("Proactive", "Error showing notification", error);
    }
  });

  // Start proactive checks (run every 2 minutes - less frequent for better performance)
  const PROACTIVE_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
  logger.info(
    "Main",
    `Starting proactive monitoring (checks every ${
      PROACTIVE_CHECK_INTERVAL / 1000
    } seconds)...`
  );
  proactiveInterval = setInterval(async () => {
    try {
      logger.debug("Main", "Triggering proactive checks...");
      await proactiveService.runProactiveChecks();
    } catch (error) {
      logger.error("Main", "Proactive check error", error);
    }
  }, PROACTIVE_CHECK_INTERVAL);

  // Run initial check after 5 seconds (give services time to initialize)
  setTimeout(async () => {
    try {
      logger.debug("Main", "Running initial proactive check...");
      await proactiveService.runProactiveChecks();
    } catch (error) {
      logger.error("Main", "Initial proactive check error", error);
    }
  }, 5000);

  logger.info("Main", "Application ready - Proactive features enabled");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (proactiveInterval) {
    clearInterval(proactiveInterval);
    proactiveInterval = null;
  }
  browserService?.close();
});

app.on("window-all-closed", () => {
  // Don't quit on window close - keep tray running
});
