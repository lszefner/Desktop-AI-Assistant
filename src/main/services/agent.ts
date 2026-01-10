import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";
import {
  ChatCompletionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { GoogleService } from "./google.js";
import { WebSearchService } from "./websearch.js";
import { SystemService } from "./system.js";
import { ScreenshotService } from "./screenshot.js";
import { BrowserService } from "./browser.js";
import { logger } from "../utils/logger.js";

const USE_OLLAMA = process.env.USE_OLLAMA === "true";
const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;

type NotificationCallback = (title: string, message: string) => void;
type ProgressCallback = (status: string) => void;
type ToolHandler = (
  args: any
) => Promise<string | { result: string; screenshot?: string }>;

interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string | MessageContent[];
  tool_call_id?: string;
}

interface MessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

interface OllamaResponse {
  message?: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, any>;
      };
    }>;
  };
  response?: string;
  done: boolean;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  };
}

// --- TOOL DEFINITIONS ---
// Kept outside the class to keep the code clean.
const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  // CALENDAR
  {
    type: "function",
    function: {
      name: "calendar_list",
      description:
        "Get calendar events for today or tomorrow. Use when user asks: 'what's on my calendar', 'my schedule today', 'what do I have tomorrow', 'today's meetings'. REQUIRES date parameter: 'today' or 'tomorrow'.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            enum: ["today", "tomorrow"],
            description: "Must be 'today' or 'tomorrow'",
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_week",
      description:
        "Get calendar events for the next 7 days (this week). Use when user asks: 'this week', 'week ahead', 'upcoming week', 'what's my week look like', 'schedule this week'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_month",
      description:
        "Get calendar events for the rest of the current month. Use when user asks: 'this month', 'rest of month', 'month schedule'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_search",
      description:
        "Search calendar events by keyword. Use when user asks: 'find meeting about X', 'search calendar for Y', 'do I have anything about Z'. REQUIRES keyword parameter.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description:
              "Search term to find in event titles/descriptions (e.g., 'interview', 'Meta', 'Kara')",
          },
          max_results: {
            type: "number",
            description: "Max results (default 10)",
          },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_add",
      description:
        "Create a new calendar event. Use when user asks: 'add event', 'create meeting', 'schedule X', 'book a meeting'. REQUIRES title and dateTime. dateTime format: 'YYYY-MM-DD HH:MM' or 'tomorrow 14:00' or 'today 15:30'.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Event title (e.g., 'Meeting with John')",
          },
          dateTime: {
            type: "string",
            description:
              "Event date and time. Format: 'YYYY-MM-DD HH:MM' or 'tomorrow 14:00' or 'today 15:30'",
          },
          description: {
            type: "string",
            description: "Optional event description",
          },
          location: { type: "string", description: "Optional event location" },
        },
        required: ["title", "dateTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_freebusy",
      description:
        "Check if user is available (free/busy) during a time period. Use when user asks: 'am I free', 'check availability', 'am I busy on X'. REQUIRES start_time and end_time in ISO format or 'YYYY-MM-DD HH:MM'.",
      parameters: {
        type: "object",
        properties: {
          start_time: {
            type: "string",
            description: "Start time (e.g., '2024-12-23 10:00' or ISO format)",
          },
          end_time: {
            type: "string",
            description: "End time (e.g., '2024-12-23 12:00' or ISO format)",
          },
        },
        required: ["start_time", "end_time"],
      },
    },
  },

  // TASKS
  {
    type: "function",
    function: {
      name: "tasks_list",
      description:
        "List all tasks (both pending and completed). Use when user asks: 'my tasks', 'what tasks do I have', 'show my todos', 'all my tasks'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_pending",
      description:
        "List only incomplete/pending tasks. Use when user asks: 'pending tasks', 'incomplete tasks', 'what's not done', 'what do I need to do', 'unfinished tasks'.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Maximum number of results (default: all)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_completed",
      description:
        "List completed/finished tasks. Use when user asks: 'completed tasks', 'what I finished', 'done tasks', 'finished todos'.",
      parameters: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description:
              "Only show tasks completed since this date (ISO format)",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results (default: all)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_search",
      description:
        "Search tasks by keyword. Use when user asks: 'find task about X', 'search tasks for Y', 'do I have a task about Z'. REQUIRES keyword parameter.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description:
              "Search term to find in task titles/notes (e.g., 'Meta', 'interview', 'milk')",
          },
          include_completed: {
            type: "boolean",
            description: "Include completed tasks in search (default: false)",
          },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_add",
      description:
        "Create a new task. Use when user asks: 'add task', 'create todo', 'remind me to X', 'add X to my tasks'. REQUIRES title parameter.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Task title (e.g., 'buy milk', 'prepare for interview')",
          },
          notes: {
            type: "string",
            description: "Optional task notes/description",
          },
          due_date: {
            type: "string",
            description: "Optional due date (ISO format or 'YYYY-MM-DD')",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_complete",
      description:
        "Mark a task as completed/done. Use when user asks: 'complete task X', 'mark X as done', 'finish task X', 'done with X'. REQUIRES title parameter to identify the task.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Title of the task to complete (must match existing task)",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_update",
      description:
        "Update/modify an existing task. Use when user asks: 'update task X', 'change task X', 'modify task X', 'edit task X'. REQUIRES title to find the task, then provide new_title, notes, or due_date to update.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Title of the task to update (must match existing task)",
          },
          new_title: {
            type: "string",
            description: "New title for the task",
          },
          notes: {
            type: "string",
            description: "New or updated notes/description",
          },
          due_date: {
            type: "string",
            description: "New due date (ISO format or 'YYYY-MM-DD')",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasks_delete",
      description:
        "Delete/remove a task. Use when user asks: 'delete task X', 'remove task X', 'cancel task X'. REQUIRES title parameter to identify the task.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Title of the task to delete (must match existing task)",
          },
        },
        required: ["title"],
      },
    },
  },

  // EMAIL
  {
    type: "function",
    function: {
      name: "email_list",
      description:
        "Get list of recent emails from inbox. Use this when user asks: 'check my emails', 'latest emails', 'what emails do I have', 'show my inbox'. Returns email subjects, senders, dates. Do NOT use email_read for this - use email_list first.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to return (default 10)",
          },
          important_only: {
            type: "boolean",
            description: "Only show important emails",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_unread",
      description:
        "Get list of unread emails only. Use when user asks: 'unread emails', 'new emails', 'emails I haven't read'.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to return (default 10)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_search",
      description:
        "Search emails using Gmail query syntax. Use when user asks: 'emails about X', 'find emails with Y', 'emails from Z'. Examples: 'from:meta', 'subject:interview', 'Kara Daly'. REQUIRES query parameter.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Gmail search query (e.g., 'from:meta', 'Kara Daly', 'subject:interview')",
          },
          max_results: {
            type: "number",
            description: "Number of results (default 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_from",
      description:
        "Get emails from a specific sender. Use when user asks: 'emails from John', 'what did Meta send me'. REQUIRES sender parameter.",
      parameters: {
        type: "object",
        properties: {
          sender: {
            type: "string",
            description:
              "Email address or name of sender (e.g., 'meta.com', 'John Doe')",
          },
          max_results: {
            type: "number",
            description: "Number of results (default 5)",
          },
        },
        required: ["sender"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_read",
      description:
        "Read the full body content of a specific email. Use ONLY after you have found the email using email_list, email_search, or email_from. You MUST provide a query parameter to identify which email to read (e.g., 'subject:Interview' or 'from:Kara'). Do NOT call this with empty parameters. If user asks 'check my emails', use email_list NOT email_read.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Gmail query to find the specific email to read (e.g., 'subject:Interview', 'from:Kara Daly'). REQUIRED - never call without this.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_draft",
      description: "Draft email",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          cc: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_mark_read",
      description: "Mark read",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_archive",
      description: "Archive email",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "email_star",
      description: "Star email",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, star: { type: "boolean" } },
        required: ["query"],
      },
    },
  },

  // WEB & SYSTEM
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search google/internet",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_status",
      description: "CPU/RAM stats",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Analyze screen visually",
      parameters: { type: "object", properties: {} },
    },
  },

  // BROWSER AUTOMATION
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Navigate to a URL. Use when user asks: 'go to X', 'open X website', 'navigate to X', 'visit X'. REQUIRES url parameter. Always call this FIRST before any other browser action. URL should include https:// or http://.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Full URL to navigate to (e.g., 'https://amazon.com', 'https://google.com')",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description:
        "Get the current page content (HTML, text, links, buttons). Use when user asks: 'what's on this page', 'read the page', 'get page content', 'what do I see', or AFTER navigating/clicking to see what changed. Call this AFTER browser_navigate and AFTER any clicks/interactions to see updated content.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click on an element (button, link, etc.). Use when user asks: 'click X', 'press X button', 'open X link'. REQUIRES selector parameter. Selector can be: button text (e.g., 'Login'), link text (e.g., 'iPhone 16'), or CSS selector. Call browser_snapshot FIRST to see available elements, then click the appropriate selector.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "Element to click: button/link text (e.g., 'Login', 'iPhone 16') or CSS selector (e.g., '#submit', '.button')",
          },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description:
        "Fill an input field with a value (replaces existing text). Use when user asks: 'fill X with Y', 'enter Y into X', 'type Y in X field'. REQUIRES selector and value. Use for simple inputs like search boxes, login forms. Call browser_snapshot FIRST to see available input fields.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "Input field selector: placeholder text (e.g., 'Search'), label text (e.g., 'Email'), or CSS selector (e.g., '#email', 'input[name=username]')",
          },
          value: {
            type: "string",
            description: "Value to fill into the input field",
          },
        },
        required: ["selector", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text character-by-character into an input (simulates typing). Use for complex inputs that need typing simulation (e.g., rich text editors, textareas). For simple inputs, prefer browser_fill. REQUIRES selector and text.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "Input field selector: placeholder text, label text, or CSS selector",
          },
          text: {
            type: "string",
            description: "Text to type character-by-character",
          },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press_key",
      description:
        "Press a keyboard key. Use when user asks: 'press Enter', 'press Tab', 'press Escape'. REQUIRES key parameter. Common keys: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace'.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace')",
          },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description:
        "Scroll the page. Use when user asks: 'scroll down', 'scroll up', 'scroll to top', 'scroll to bottom'. REQUIRES direction parameter: 'up', 'down', 'top', or 'bottom'.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "top", "bottom"],
            description:
              "Scroll direction: 'up' (scroll up), 'down' (scroll down), 'top' (scroll to top), 'bottom' (scroll to bottom)",
          },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_back",
      description:
        "Go back to the previous page (browser back button). Use when user asks: 'go back', 'previous page', 'back'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current page. Use when user asks: 'take screenshot', 'capture page', 'screenshot'. Returns base64 image data.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description:
        "Execute JavaScript code on the page. Use for advanced operations like extracting data, manipulating DOM, or running custom scripts. REQUIRES script parameter with JavaScript code.",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description:
              "JavaScript code to execute (e.g., 'document.title', 'window.scrollY')",
          },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_search_google",
      description:
        "Quick search using DuckDuckGo (not Google, as Google blocks bots). Use when user asks: 'search for X', 'google X', 'look up X'. This navigates to DuckDuckGo and performs the search. REQUIRES query parameter. After calling, use browser_snapshot to see results.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query (e.g., 'best laptops', 'iPhone 16 price')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description:
        "Close the browser. ALWAYS call this when done with browser tasks. Use when user's browser task is complete or when you're finished interacting with a website. This is the LAST step in any browser workflow.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/**
 * AgentService handles AI-powered query processing and tool execution.
 * Supports both OpenAI and Ollama providers. Manages conversation history,
 * tool calling, and response formatting.
 */
export class AgentService {
  private openaiClient: OpenAI;
  private provider: "openai" | "ollama" = USE_OLLAMA ? "ollama" : "openai";
  private history: Message[] = [];
  private maxHistory = 10;
  private progressCallback: ProgressCallback | null = null;

  // Services
  private googleService: GoogleService | null = null;
  private webSearchService: WebSearchService | null = null;
  private systemService: SystemService | null = null;
  private screenshotService: ScreenshotService | null = null;
  private browserService: BrowserService | null = null;

  private pendingScreenshot: string | null = null;
  private toolRegistry: Record<string, ToolHandler> = {};

  /**
   * Creates a new AgentService instance.
   * Initializes OpenAI client and optionally connects to Ollama.
   */
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    logger.info(
      "Agent",
      `Initializing... Mode: ${USE_OLLAMA ? "OLLAMA" : "OPENAI"}`
    );

    // OpenAI client is always needed for Vision capability even if using Ollama for text
    if (apiKey) {
      this.openaiClient = new OpenAI({ apiKey });
    } else {
      this.openaiClient = null as any;
    }

    if (USE_OLLAMA) {
      this.initializeOllama();
    }

    // Initialize the Optimized Tool Registry
    this.registerTools();
  }

  // --- REGISTRY BASED TOOL EXECUTION (Optimized) ---
  private registerTools() {
    // 1. Calendar Tools
    this.toolRegistry["calendar_list"] = async (args) =>
      this.googleService!.manageCalendar("list", {
        date: args.date || "today",
      });
    this.toolRegistry["calendar_week"] = async () =>
      this.googleService!.manageCalendar("week");
    this.toolRegistry["calendar_month"] = async () =>
      this.googleService!.manageCalendar("month");
    this.toolRegistry["calendar_search"] = async (args) =>
      this.googleService!.manageCalendar("search", {
        keyword: args.keyword,
        maxResults: args.max_results,
      });
    this.toolRegistry["calendar_add"] = async (args) =>
      this.googleService!.manageCalendar("add", args);
    this.toolRegistry["calendar_freebusy"] = async (args) =>
      this.googleService!.manageCalendar("freeBusy", {
        startTime: args.start_time,
        endTime: args.end_time,
      });

    // 2. Task Tools
    this.toolRegistry["tasks_list"] = async () =>
      this.googleService!.manageTasks("list");
    this.toolRegistry["tasks_pending"] = async (args) =>
      this.googleService!.manageTasks("pending", {
        maxResults: args.max_results,
      });
    this.toolRegistry["tasks_completed"] = async (args) =>
      this.googleService!.manageTasks("completed", {
        since: args.since,
        maxResults: args.max_results,
      });
    this.toolRegistry["tasks_search"] = async (args) =>
      this.googleService!.manageTasks("search", {
        keyword: args.keyword,
        includeCompleted: args.include_completed,
      });
    this.toolRegistry["tasks_add"] = async (args) =>
      this.googleService!.manageTasks("add", {
        title: args.title,
        notes: args.notes,
        dueDate: args.due_date,
      });
    this.toolRegistry["tasks_complete"] = async (args) =>
      this.googleService!.manageTasks("complete", { title: args.title });
    this.toolRegistry["tasks_update"] = async (args) =>
      this.googleService!.manageTasks("update", {
        title: args.title,
        newTitle: args.new_title,
        notes: args.notes,
        dueDate: args.due_date,
      });
    this.toolRegistry["tasks_delete"] = async (args) =>
      this.googleService!.manageTasks("delete", { title: args.title });

    // 3. Email Tools
    this.toolRegistry["email_list"] = async (args) =>
      this.googleService!.manageEmail("list", {
        maxResults: args.max_results,
        important: args.important_only,
      });
    this.toolRegistry["email_unread"] = async (args) =>
      this.googleService!.manageEmail("unread", {
        maxResults: args.max_results,
      });
    this.toolRegistry["email_search"] = async (args) =>
      this.googleService!.manageEmail("search", {
        query: args.query || args.keyword || "", // Handle both query and keyword
        maxResults: args.max_results,
      });
    this.toolRegistry["email_from"] = async (args) =>
      this.googleService!.manageEmail("from", {
        sender: args.sender,
        maxResults: args.max_results,
      });
    this.toolRegistry["email_read"] = async (args) =>
      this.googleService!.manageEmail("getBody", { query: args.query });
    this.toolRegistry["email_draft"] = async (args) =>
      this.googleService!.manageEmail("draft", args);
    this.toolRegistry["email_mark_read"] = async (args) =>
      this.googleService!.manageEmail("markRead", { query: args.query });
    this.toolRegistry["email_archive"] = async (args) =>
      this.googleService!.manageEmail("archive", { query: args.query });
    this.toolRegistry["email_star"] = async (args) =>
      this.googleService!.manageEmail("star", {
        query: args.query,
        star: args.star,
      });

    // 4. Web & System
    this.toolRegistry["system_status"] = async () =>
      JSON.stringify(await this.systemService!.getStatus(), null, 2);
    this.toolRegistry["take_screenshot"] = async () => {
      const base64 = await this.screenshotService!.captureAsBase64();
      return { result: "Screenshot captured.", screenshot: base64 };
    };
    this.toolRegistry["web_search"] = async (args) => {
      const results = await this.webSearchService!.search(
        args.query,
        args.max_results || 5,
        true
      );
      return results
        .map(
          (r: any, i: number) =>
            `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
        )
        .join("\n\n");
    };

    // 5. Browser Automation
    this.toolRegistry["browser_navigate"] = async (args) =>
      this.browserService!.navigate(args.url);
    this.toolRegistry["browser_snapshot"] = async () =>
      this.browserService!.getSnapshot();
    this.toolRegistry["browser_click"] = async (args) =>
      this.browserService!.click(args.selector);
    this.toolRegistry["browser_fill"] = async (args) =>
      this.browserService!.fill(args.selector, args.value);
    this.toolRegistry["browser_type"] = async (args) =>
      this.browserService!.type(args.selector, args.text);
    this.toolRegistry["browser_press_key"] = async (args) =>
      this.browserService!.pressKey(args.key);
    this.toolRegistry["browser_scroll"] = async (args) =>
      this.browserService!.scroll(args.direction);
    this.toolRegistry["browser_back"] = async () =>
      this.browserService!.goBack();
    this.toolRegistry["browser_screenshot"] = async () => {
      const base64 = await this.browserService!.screenshot();
      return { result: "Browser screenshot captured", screenshot: base64 };
    };
    this.toolRegistry["browser_evaluate"] = async (args) =>
      this.browserService!.evaluate(args.script);
    this.toolRegistry["browser_search_google"] = async (args) =>
      this.browserService!.searchGoogle(args.query);
    this.toolRegistry["browser_close"] = async () => {
      await this.browserService!.close();
      return "Browser closed";
    };
  }

  // --- INITIALIZATION ---
  /**
   * Initialize connection to Ollama service.
   * Verifies Ollama is running and accessible.
   *
   * @private
   */
  private async initializeOllama(): Promise<void> {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`);
      if (resp.ok) {
        logger.info("Agent", "Ollama connection established.");
      } else {
        logger.error("Agent", "Ollama connection failed");
      }
    } catch (e: any) {
      logger.error("Agent", "Failed to connect to Ollama", e);
    }
  }

  // --- SERVICE SETTERS ---
  /**
   * Set the services used for tool execution.
   *
   * @param g - Google service for Calendar, Tasks, Email
   * @param w - Web search service
   * @param s - System service for resource monitoring
   * @param sc - Screenshot service for visual analysis
   */
  setServices(
    g: GoogleService,
    w: WebSearchService,
    s: SystemService,
    sc: ScreenshotService
  ) {
    this.googleService = g;
    this.webSearchService = w;
    this.systemService = s;
    this.screenshotService = sc;
  }

  /**
   * Set the browser automation service.
   *
   * @param b - Browser service for web automation
   */
  setBrowserService(b: BrowserService) {
    this.browserService = b;
  }

  /**
   * Set a pending screenshot to attach to the next query.
   *
   * @param base64 - Base64-encoded screenshot image
   */
  setPendingScreenshot(base64: string) {
    this.pendingScreenshot = base64;
  }

  /**
   * Get the pending screenshot if one exists.
   *
   * @returns Base64-encoded screenshot or null
   */
  getPendingScreenshot() {
    return this.pendingScreenshot;
  }

  /**
   * Set callback for progress updates during query processing.
   *
   * @param cb - Callback function to receive status updates
   */
  setProgressCallback(cb: ProgressCallback) {
    this.progressCallback = cb;
  }

  /**
   * Switch between OpenAI and Ollama providers.
   *
   * @param provider - Provider to use: "openai" or "ollama"
   */
  setProvider(provider: "openai" | "ollama") {
    this.provider = provider;
    logger.info("Agent", `Provider switched to: ${provider.toUpperCase()}`);
  }

  /**
   * Get the current AI provider.
   *
   * @returns Current provider: "openai" or "ollama"
   */
  getProvider(): "openai" | "ollama" {
    return this.provider;
  }

  // --- CORE EXECUTION ---
  /**
   * Execute a tool by name with given arguments.
   *
   * @param name - Tool name from registry
   * @param args - Tool arguments
   * @returns Tool execution result with optional screenshot
   * @private
   */
  private async executeTool(
    name: string,
    args: Record<string, any>
  ): Promise<{ result: string; screenshot?: string }> {
    logger.debug("Agent", `Executing tool: ${name}`, args);
    const handler = this.toolRegistry[name];

    if (!handler) return { result: `Unknown tool: ${name}` };

    // Check if service is available for this tool
    if (name.startsWith("calendar_") && !this.googleService)
      return { result: "Google Calendar service not configured." };
    if (name.startsWith("browser_") && !this.browserService)
      return { result: "Browser service not configured." };

    // Validate required parameters for specific tools
    if (name === "email_read" && (!args.query || args.query.trim() === "")) {
      return {
        result:
          "Error: email_read requires a 'query' parameter to identify which email to read. Use email_list first to see emails, then email_read with a query like 'subject:X' or 'from:Y'.",
      };
    }
    if (
      name === "email_search" &&
      (!args.query || args.query.trim() === "") &&
      (!args.keyword || args.keyword.trim() === "")
    ) {
      return {
        result:
          "Error: email_search requires a 'query' parameter. Example: email_search with query 'from:meta' or 'Kara Daly'.",
      };
    }

    try {
      const output = await handler(args);
      // Handle complex returns (objects with screenshots) vs simple strings
      if (typeof output === "object" && output !== null && "result" in output) {
        return output as { result: string; screenshot?: string };
      }
      return { result: String(output) };
    } catch (error: any) {
      logger.error("Agent", `Tool ${name} error`, error);
      return { result: `Error executing ${name}: ${error.message}` };
    }
  }

  // --- PROMPTING ---
  private getSystemPrompt(): string {
    const now = new Date();
    const fullDate = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const time = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // ReAct Agent Prompt - focused on tool calling and reasoning
    return `You are an autonomous ReAct agent. Your task is to fulfill the user's request using available tools.

CONTEXT: ${fullDate} at ${time} (${
      Intl.DateTimeFormat().resolvedOptions().timeZone
    })

AVAILABLE TOOLS:
- Calendar: list, week, month, search, add, freebusy
- Tasks: list, pending, completed, search, add, complete, update, delete  
- Email: list, unread, search, from, read, draft, mark_read, archive, star
- Web: search
- Browser: navigate, snapshot, click, fill, type, press_key, scroll, back, screenshot, evaluate, search_google, close
- System: status, take_screenshot

CRITICAL: TOOL CALLING FORMAT
When calling tools, you MUST use the EXACT tool name from the available tools list. 
DO NOT use placeholders like "<function-name>" or generic names.
The tool name must match EXACTLY one of: calendar_list, calendar_week, calendar_month, calendar_search, calendar_add, calendar_freebusy, tasks_list, tasks_pending, tasks_completed, tasks_search, tasks_add, tasks_complete, tasks_update, tasks_delete, email_list, email_unread, email_search, email_from, email_read, email_draft, email_mark_read, email_archive, email_star, web_search, system_status, take_screenshot, browser_navigate, browser_snapshot, browser_click, browser_fill, browser_type, browser_press_key, browser_scroll, browser_back, browser_screenshot, browser_evaluate, browser_search_google, browser_close.

RULES:
1. Act autonomously - don't ask permission for read-only operations
2. Use tools to get real data - NEVER make up information
3. Browser workflow: Navigate → Snapshot → Interact → Snapshot → Close
4. If a tool fails, acknowledge it
5. Call tools until you have ALL information needed to answer
6. ALWAYS use the EXACT tool name - never use placeholders or generic names

TOOL SELECTION GUIDE (CRITICAL FOR SMALL MODELS):

EMAIL TOOLS:
- "check my emails" / "latest emails" / "what emails do I have" → email_list
- "unread emails" / "new emails" → email_unread
- "emails from Meta" / "emails about X" → email_search with query "from:meta" or "X"
- "read email about X" → FIRST email_search to find it, THEN email_read with query
- NEVER call email_read with empty {} - it ALWAYS needs a query parameter

EMAIL EXAMPLES:
- "check my latest emails" → email_list
- "do I have anything from meta?" → email_search with query "from:meta"
- "read the email from Kara" → email_search with query "from:Kara", then email_read with that query

CALENDAR TOOLS:
- "what's on my calendar" / "my schedule" / "what do I have today" → calendar_list with date "today"
- "what's tomorrow" / "tomorrow's schedule" → calendar_list with date "tomorrow"
- "this week" / "week ahead" / "upcoming week" → calendar_week
- "this month" / "rest of month" → calendar_month
- "find meeting about X" / "search calendar for Y" → calendar_search with keyword "X" or "Y"
- "add event" / "create meeting" / "schedule X" → calendar_add with title and dateTime
- "am I free" / "check availability" → calendar_freebusy with startTime and endTime

CALENDAR EXAMPLES:
- "what's on my calendar today?" → calendar_list with date "today"
- "do I have anything tomorrow?" → calendar_list with date "tomorrow"
- "what's my week look like?" → calendar_week
- "find meetings about interview" → calendar_search with keyword "interview"
- "add meeting with John tomorrow at 2pm" → calendar_add with title "Meeting with John" and dateTime "tomorrow 14:00"
- "am I free next Tuesday 10am-12pm?" → calendar_freebusy with startTime and endTime

TASKS TOOLS:
- "my tasks" / "what tasks do I have" / "show my todos" → tasks_list
- "pending tasks" / "incomplete tasks" / "what's not done" → tasks_pending
- "completed tasks" / "what I finished" → tasks_completed
- "find task about X" / "search tasks for Y" → tasks_search with keyword "X" or "Y"
- "add task" / "create todo" / "remind me to X" → tasks_add with title
- "complete task X" / "mark X as done" → tasks_complete with title "X"
- "update task X" / "change task X" → tasks_update with title "X" and new fields
- "delete task X" / "remove task X" → tasks_delete with title "X"

TASKS EXAMPLES:
- "what tasks do I have?" → tasks_list
- "what's not done?" → tasks_pending
- "add task: buy milk" → tasks_add with title "buy milk"
- "complete the interview prep task" → tasks_complete with title "interview prep"
- "find tasks about Meta" → tasks_search with keyword "Meta"
- "update 'buy milk' to 'buy organic milk'" → tasks_update with title "buy milk" and newTitle "buy organic milk"

BROWSER TOOLS (MUST FOLLOW WORKFLOW):
Workflow: browser_navigate → browser_snapshot → (interact) → browser_snapshot → browser_close

- "go to X" / "open X website" / "navigate to X" → browser_navigate with url "https://X.com"
- "what's on this page" / "read the page" / "get page content" → browser_snapshot (AFTER navigating)
- "click X" / "press X button" → browser_click with selector "X" (text or CSS selector)
- "fill X with Y" / "type Y into X" → browser_fill with selector "X" and value "Y"
- "type Y" (for complex inputs) → browser_type with selector and text
- "press Enter" / "press Tab" → browser_press_key with key "Enter" or "Tab"
- "scroll down" / "scroll up" → browser_scroll with direction "down" or "up"
- "go back" → browser_back
- "take screenshot" → browser_screenshot
- "search Google for X" → browser_search_google with query "X"
- "close browser" → browser_close (ALWAYS close when done)

BROWSER EXAMPLES:
- "go to amazon.com and find iPhone price" → browser_navigate("https://amazon.com") → browser_snapshot → browser_click("iPhone") → browser_snapshot → browser_close
- "search Google for best laptops" → browser_search_google("best laptops") → browser_snapshot → browser_close
- "fill the login form with username 'john' and password 'pass'" → browser_navigate → browser_snapshot → browser_fill("username", "john") → browser_fill("password", "pass") → browser_click("Login") → browser_close
- "scroll down the page" → browser_scroll("down")
- NEVER forget browser_close when done with browser tasks

OUTPUT: When you have gathered enough information, provide your final answer. The answer will be reformatted by a speaker agent.`;
  }

  /**
   * Generate speaker prompt for formatting final responses.
   * Defines JARVIS-like personality and formatting rules.
   *
   * @returns Speaker prompt string
   * @private
   */
  private getSpeakerPrompt(): string {
    return `You are a sophisticated AI assistant. Address the user as "Sir".

PERSONA:
- Efficient, intelligent, subtly witty
- Loyal and discreet
- British butler meets advanced AI

FORMATTING RULES:
- Direct answers first, details after
- Use bullet points for lists (3+ items)
- Keep responses concise unless complexity demands more
- No fluff, no filler phrases
- Never mention tools, APIs, or technical processes
- Never say "I searched for..." or "According to my tools..."
- Present information as if you naturally know it

PROHIBITIONS:
- Never say "I'd be happy to...", "Certainly!", "Of course!"
- Never repeat the question back
- Never apologize unless you made an actual error
- Never add unnecessary caveats

Your task: Take the information gathered and present it naturally to Sir.`;
  }

  // --- MAIN QUERY PROCESSOR ---
  /**
   * Process a query with a specific provider (for lightweight analysis tasks)
   * Useful for proactive features that should use local models
   * @param jsonMode - If true, forces JSON output and bypasses speaker formatting
   */
  async processQueryWithProvider(
    query: string,
    provider: "openai" | "ollama",
    useTools: boolean = false,
    jsonMode: boolean = false
  ): Promise<string> {
    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.getSystemPrompt() },
        { role: "user", content: query },
      ];

      const tools = useTools ? this.getAvailableTools() : [];

      if (provider === "ollama") {
        if (jsonMode) {
          // Direct JSON query without speaker formatting
          return await this.runOllamaJSONQuery(messages);
        }
        return await this.runOllamaLoop(
          messages,
          useTools ? this.getOllamaTools() : []
        );
      } else {
        return await this.runOpenAILoop(messages, tools);
      }
    } catch (error: any) {
      // Preserve Ollama connection error flag for proactive service
      if (error.isOllamaConnectionError) {
        logger.error(
          "Agent",
          "Error in processQueryWithProvider - Ollama not running",
          error
        );
        throw error; // Re-throw so proactive service can detect and notify
      }
      logger.error("Agent", "Error in processQueryWithProvider", error);
      return `Analysis error: ${error.message}`;
    }
  }

  /**
   * Run a simple Ollama query that returns JSON (no tools, no speaker formatting).
   * Used for proactive analysis tasks.
   *
   * @param messages - Conversation messages
   * @returns Promise resolving to JSON string
   * @private
   */
  private async runOllamaJSONQuery(messages: any[]): Promise<string> {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: messages,
          stream: false,
          options: { temperature: 0.2, num_predict: 2000 },
          format: "json", // Force JSON output
        }),
      });

      const data: OllamaResponse = await response.json();
      return data.message?.content || "";
    } catch (error: any) {
      // Detect if this is a connection error (Ollama not running)
      const isConnectionError =
        error instanceof TypeError &&
        (error.message?.includes("fetch failed") ||
          error.message?.includes("ECONNREFUSED") ||
          (error.cause &&
            typeof error.cause === "object" &&
            "code" in error.cause &&
            error.cause.code === "ECONNREFUSED"));

      if (isConnectionError) {
        const connectionError: any = new Error("Ollama connection failed");
        connectionError.isOllamaConnectionError = true;
        connectionError.originalError = error;
        logger.error(
          "Agent",
          "Ollama connection failed - service may not be running",
          error
        );
        throw connectionError;
      }

      logger.error("Agent", "Error in runOllamaJSONQuery", error);
      throw error;
    }
  }

  /**
   * Main query processing method.
   * Handles user queries, manages conversation history, and coordinates tool execution.
   * Supports both OpenAI and Ollama providers. Handles screenshot attachments.
   *
   * @param query - User query string
   * @returns Promise resolving to formatted response string
   */
  async processQuery(query: string): Promise<string> {
    logger.info("Agent", `Input: ${query.substring(0, 50)}...`);

    // 1. Handle Screenshots (Ctrl+H)
    let screenshotBase64 = this.pendingScreenshot;
    this.pendingScreenshot = null;

    // 2. Manage History (Sliding window + Screenshot pruning)
    this.history.push({ role: "user", content: query });
    if (this.history.length > this.maxHistory)
      this.history = this.history.slice(-this.maxHistory);

    try {
      // 3. Prepare Messages
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: this.getSystemPrompt() },
        ...this.history.map((m) => {
          // History only contains user/assistant messages (tool results aren't saved)
          return { role: m.role, content: m.content } as any;
        }),
      ];

      // Inject screenshot if present into the LAST user message
      if (screenshotBase64) {
        const lastUserMsg = messages[messages.length - 1];
        if (lastUserMsg.role === "user") {
          lastUserMsg.content = [
            { type: "text", text: query },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${screenshotBase64}` },
            },
          ];
        }
      }

      // 4. Determine Execution Path
      // If we have an image, we MUST use OpenAI/LLaVA (Ollama Vision is separate logic usually)
      const hasVision = !!screenshotBase64;

      // Select Tools
      const tools = this.getAvailableTools();

      // 5. Execution Loop (ReAct)
      let finalResponse = "";

      if (this.provider === "ollama" && !hasVision) {
        finalResponse = await this.runOllamaLoop(
          messages,
          this.getOllamaTools()
        );
      } else {
        // OpenAI (or vision requires OpenAI)
        finalResponse = await this.runOpenAILoop(messages, tools);
      }

      this.history.push({ role: "assistant", content: finalResponse });
      return finalResponse;
    } catch (error: any) {
      logger.error("Agent", "Critical Error", error);
      return `I apologize, Sir. A system error occurred: ${error.message}`;
    }
  }

  // --- OLLAMA SPECIFIC LOOP (Optimized for Qwen/Llama 3.2) ---
  private async runOllamaLoop(
    messages: any[],
    tools: OllamaTool[]
  ): Promise<string> {
    // Add specific instruction for tool use on local models
    const toolInstruction = `\n\n[CRITICAL TOOL CALLING INSTRUCTIONS]:
When you need to use a tool, you MUST:
1. Use the EXACT tool name from the available tools list (e.g., "email_list", "calendar_list", "tasks_list")
2. NEVER use placeholders like "<function-name>" or generic names
3. Provide the tool call in the proper format with the exact tool name and required parameters
4. Available tool names: ${Object.keys(this.toolRegistry).join(", ")}

Example correct format:
{
  "function": {
    "name": "email_list",
    "arguments": {}
  }
}

WRONG (never do this):
{
  "function": {
    "name": "<function-name>",
    "arguments": {}
  }
}`;
    if (messages[0].role === "system") messages[0].content += toolInstruction;

    let iterations = 0;
    const maxIterations = 10;
    let currentMessages = [...messages];
    let usedTools = false;
    const failedTools = new Set<string>(); // Track tools that have failed

    while (iterations < maxIterations) {
      if (iterations === 0) {
        this.emitProgress("Thinking...");
        logger.debug(
          "Agent",
          `[Ollama] Starting iteration ${iterations + 1}/${maxIterations}`
        );
        logger.debug(
          "Agent",
          `[Ollama] User query: "${
            currentMessages[currentMessages.length - 1]?.content || "N/A"
          }"`
        );
        logger.debug(
          "Agent",
          `[Ollama] Available tools: ${tools.length} tools (${tools
            .slice(0, 5)
            .map((t) => t.function.name)
            .join(", ")}${tools.length > 5 ? "..." : ""})`
        );
      } else {
        logger.debug(
          "Agent",
          `[Ollama] Iteration ${
            iterations + 1
          }/${maxIterations} - Processing tool results...`
        );
      }

      // Call Ollama (Agent)
      const requestBody = {
        model: OLLAMA_MODEL,
        messages: currentMessages,
        stream: false,
        tools: tools,
        options: { temperature: 0.2, num_predict: 10000 },
        format: "json",
      };

      logger.debug(
        "Agent",
        `[Ollama] Sending request to ${OLLAMA_URL}/api/chat`
      );
      logger.debug(
        "Agent",
        `[Ollama] Message count: ${currentMessages.length}, Tools available: ${tools.length}`
      );

      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data: OllamaResponse = await response.json();
      const aiMsg = data.message;

      if (!aiMsg) throw new Error("Empty response from Ollama");

      // Log agent's raw response (debug level)
      logger.debug("Agent", `[Ollama] Raw response received:`);
      logger.debug(
        "Agent",
        `[Ollama] - Content: ${
          aiMsg.content
            ? aiMsg.content.substring(0, 200) +
              (aiMsg.content.length > 200 ? "..." : "")
            : "None"
        }`
      );
      logger.debug(
        "Agent",
        `[Ollama] - Tool calls: ${
          aiMsg.tool_calls ? aiMsg.tool_calls.length : 0
        }`
      );
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        aiMsg.tool_calls.forEach((call, idx) => {
          const toolName = call.function?.name || "unknown";
          const args = call.function?.arguments || {};
          logger.debug(
            "Agent",
            `[Ollama] - Tool call ${
              idx + 1
            }: ${toolName} with args: ${JSON.stringify(args).substring(0, 150)}`
          );
        });
      }

      // Check for Tool Calls in the new format: { "function": "tool_name", "arguments": {...} }
      // This format is returned when Ollama is configured with format: "json"
      let parsedToolCall: { name: string; args: Record<string, any> } | null =
        null;
      if (aiMsg.content) {
        try {
          const contentStr =
            typeof aiMsg.content === "string"
              ? aiMsg.content
              : JSON.stringify(aiMsg.content);
          // Try to parse as JSON first
          const jsonMatch = contentStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.function && typeof parsed.function === "string") {
              // New format: { "function": "tool_name", "arguments": {...} }
              parsedToolCall = {
                name: parsed.function,
                args: parsed.arguments || {},
              };
              logger.debug(
                "Agent",
                `[Ollama] ✓ Detected new format tool call: ${parsedToolCall.name}`
              );
            } else if (parsed.name && typeof parsed.name === "string") {
              // Alternative format: { "name": "tool_name", "arguments": {...} }
              parsedToolCall = {
                name: parsed.name,
                args: parsed.arguments || {},
              };
              logger.debug(
                "Agent",
                `[Ollama] ✓ Detected alternative format tool call: ${parsedToolCall.name}`
              );
            }
          }
        } catch (e) {
          // Not valid JSON, will fall through to other parsing
          logger.debug(
            "Agent",
            `[Ollama] Content is not JSON format, trying other parsers...`
          );
        }
      }

      // Check for Tool Calls (standard format)
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        usedTools = true;
        logger.info(
          "Agent",
          `[Ollama] Agent decided to use ${aiMsg.tool_calls.length} tool(s)`
        );
        currentMessages.push({
          role: "assistant",
          content: "",
          tool_calls: aiMsg.tool_calls,
        } as any);

        for (const call of aiMsg.tool_calls) {
          let toolName = call.function?.name || "";
          const toolArgs =
            typeof call.function?.arguments === "string"
              ? JSON.parse(call.function.arguments)
              : call.function?.arguments || {};

          logger.debug("Agent", `[Ollama] Processing tool call: ${toolName}`);
          logger.debug(
            "Agent",
            `[Ollama] Tool arguments: ${JSON.stringify(toolArgs)}`
          );

          // Validate tool name - check if it's a placeholder or invalid
          if (
            !toolName ||
            toolName.includes("<") ||
            toolName.includes(">") ||
            !this.toolRegistry[toolName]
          ) {
            logger.warn(
              "Agent",
              `[Ollama] Invalid tool name detected: "${toolName}", attempting to parse from text...`
            );
            // Try to parse tool name from text content or arguments
            const parsedTool = this.parseToolFromText(
              aiMsg.content || "",
              toolArgs
            );
            if (parsedTool && this.toolRegistry[parsedTool]) {
              toolName = parsedTool;
              logger.debug(
                "Agent",
                `[Ollama] Successfully parsed tool name: ${toolName} (was: ${call.function?.name})`
              );
            } else {
              // Invalid tool name - skip this call and inform the model
              logger.error(
                "Agent",
                `[Ollama] Invalid tool name: ${toolName}. Available tools: ${Object.keys(
                  this.toolRegistry
                ).join(", ")}`
              );
              currentMessages.push({
                role: "assistant",
                content: `[ERROR] Invalid tool name "${toolName}". Please use one of the exact tool names from the available tools list. Available tools: ${Object.keys(
                  this.toolRegistry
                )
                  .slice(0, 10)
                  .join(", ")}...`,
              });
              continue;
            }
          }

          // Check if this tool already failed
          if (failedTools.has(toolName)) {
            logger.debug(
              "Agent",
              `[Ollama] ⚠️ Tool ${toolName} already failed, skipping retry`
            );
            currentMessages.push({
              role: "assistant",
              content: `[SKIP] Tool ${toolName} is not available. Moving on to provide a response.`,
            });
            continue;
          }

          this.emitProgress(this.formatToolProgress(toolName, toolArgs));
          logger.info("Agent", `[Ollama] Executing tool: ${toolName}...`);
          const result = await this.executeTool(toolName, toolArgs);
          logger.debug(
            "Agent",
            `[Ollama] Tool ${toolName} completed. Result length: ${
              result.result?.length || 0
            } chars`
          );

          // Check if result indicates an error
          if (this.isToolResultError(result.result)) {
            logger.warn(
              "Agent",
              `[Ollama] ✗ Tool ${toolName} returned error: ${result.result}`
            );
            failedTools.add(toolName);
            currentMessages.push({
              role: "assistant",
              content: `[TOOL_RESULT:${toolName}]\n${result.result}\n\n[NOTE] This tool is not available. Do not call it again. Provide a helpful response to the user explaining this limitation.`,
            });
            continue; // Skip to next iteration
          }

          // Format tool result as assistant message for small model compatibility
          // Small models may not understand role: "tool", so we embed it clearly
          currentMessages.push({
            role: "assistant",
            content: `[TOOL_RESULT:${toolName}]\n${result.result}`,
          });
        }
        iterations++;
      } else if (parsedToolCall) {
        // Handle the new format: { "function": "tool_name", "arguments": {...} }
        usedTools = true;
        logger.debug(
          "Agent",
          `[Ollama] Executing tool from new format: ${parsedToolCall.name}`
        );

        if (this.toolRegistry[parsedToolCall.name]) {
          // Check if this tool already failed
          if (failedTools.has(parsedToolCall.name)) {
            logger.debug(
              "Agent",
              `[Ollama] ⚠️ Tool ${parsedToolCall.name} already failed, skipping retry`
            );
            currentMessages.push({
              role: "assistant",
              content: `[SKIP] Tool ${parsedToolCall.name} is not available. Moving on to provide a response.`,
            });
            iterations++;
            continue;
          }

          logger.info(
            "Agent",
            `[Ollama] Executing parsed tool: ${parsedToolCall.name}`
          );
          this.emitProgress(
            this.formatToolProgress(parsedToolCall.name, parsedToolCall.args)
          );
          const result = await this.executeTool(
            parsedToolCall.name,
            parsedToolCall.args
          );
          logger.debug(
            "Agent",
            `[Ollama] Tool ${parsedToolCall.name} completed. Result length: ${
              result.result?.length || 0
            } chars`
          );

          // Check if result indicates an error
          if (this.isToolResultError(result.result)) {
            logger.warn(
              "Agent",
              `[Ollama] ✗ Tool ${parsedToolCall.name} returned error: ${result.result}`
            );
            failedTools.add(parsedToolCall.name);
            currentMessages.push({
              role: "assistant",
              content: `[TOOL_RESULT:${parsedToolCall.name}]\n${result.result}\n\n[NOTE] This tool is not available. Do not call it again. Provide a helpful response to the user explaining this limitation.`,
            });
            iterations++;
            continue;
          }

          currentMessages.push({
            role: "assistant",
            content: `[TOOL_RESULT:${parsedToolCall.name}]\n${result.result}`,
          });
          iterations++;
          continue;
        } else {
          logger.error(
            "Agent",
            `[Ollama] ✗ Invalid tool name from new format: ${
              parsedToolCall.name
            }. Available tools: ${Object.keys(this.toolRegistry).join(", ")}`
          );
          currentMessages.push({
            role: "assistant",
            content: `[ERROR] Invalid tool name "${parsedToolCall.name}". Please use one of the exact tool names from the available tools list.`,
          });
          iterations++;
          continue;
        }
      } else if (aiMsg.content) {
        // Text parsing fallback: check if content contains tool call patterns
        logger.debug(
          "Agent",
          `[Ollama] No tool calls detected, checking for tool patterns in text content...`
        );
        const parsedCalls = this.parseToolCallsFromText(aiMsg.content);
        if (parsedCalls.length > 0) {
          logger.debug(
            "Agent",
            `[Ollama] Found ${parsedCalls.length} tool call(s) in text content`
          );
          usedTools = true;
          for (const { name, args } of parsedCalls) {
            if (this.toolRegistry[name]) {
              // Check if this tool already failed
              if (failedTools.has(name)) {
                logger.debug(
                  "Agent",
                  `[Ollama] ⚠️ Tool ${name} already failed, skipping retry`
                );
                currentMessages.push({
                  role: "assistant",
                  content: `[SKIP] Tool ${name} is not available. Moving on to provide a response.`,
                });
                continue;
              }

              logger.info("Agent", `[Ollama] Executing parsed tool: ${name}`);
              this.emitProgress(this.formatToolProgress(name, args));
              const result = await this.executeTool(name, args);
              logger.debug(
                "Agent",
                `[Ollama] Tool ${name} completed. Result length: ${
                  result.result?.length || 0
                } chars`
              );

              // Check if result indicates an error
              if (this.isToolResultError(result.result)) {
                logger.warn(
                  "Agent",
                  `[Ollama] ✗ Tool ${name} returned error: ${result.result}`
                );
                failedTools.add(name);
                currentMessages.push({
                  role: "assistant",
                  content: `[TOOL_RESULT:${name}]\n${result.result}\n\n[NOTE] This tool is not available. Do not call it again. Provide a helpful response to the user explaining this limitation.`,
                });
                continue;
              }

              currentMessages.push({
                role: "assistant",
                content: `[TOOL_RESULT:${name}]\n${result.result}`,
              });
            }
          }
          iterations++;
          continue;
        } else {
          logger.debug(
            "Agent",
            `[Ollama] No tool calls found in text. Agent is providing final response.`
          );
          logger.debug(
            "Agent",
            `[Ollama] Response preview: ${aiMsg.content.substring(0, 200)}${
              aiMsg.content.length > 200 ? "..." : ""
            }`
          );
        }
      } else {
        logger.warn(
          "Agent",
          `[Ollama] Empty response from agent, finishing...`
        );
      }

      // Agent finished - now format with Speaker if tools were used
      if (aiMsg.content && !aiMsg.tool_calls) {
        logger.debug(
          "Agent",
          `[Ollama] Finalizing response (usedTools: ${usedTools})...`
        );
        if (usedTools) {
          logger.debug(
            "Agent",
            `[Ollama] Formatting with Speaker (tools were used)...`
          );
          return await this.formatWithSpeaker(currentMessages, aiMsg.content);
        }
        logger.debug(
          "Agent",
          `[Ollama] Returning direct response (no tools used)...`
        );
        return aiMsg.content;
      }
    }
    // Max iterations - format whatever we have
    logger.warn(
      "Agent",
      `[Ollama] ⚠️ Reached max iterations (${maxIterations}), finalizing...`
    );
    return await this.formatWithSpeaker(
      currentMessages,
      "Maximum iterations reached."
    );
  }

  /**
   * Run OpenAI query loop with tool calling support.
   * Handles standard OpenAI function calling format.
   *
   * @param messages - Conversation messages
   * @param tools - Available tools for execution
   * @returns Promise resolving to final response string
   * @private
   */
  private async runOpenAILoop(
    messages: any[],
    tools: ChatCompletionTool[]
  ): Promise<string> {
    let iterations = 0;
    const maxIterations = 20;
    let currentMessages = [...messages];
    let usedTools = false;

    while (iterations < maxIterations) {
      if (iterations === 0) {
        this.emitProgress("Thinking...");
      }

      const response = await this.openaiClient.chat.completions.create({
        model: "gpt-5-mini",
        messages: currentMessages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
      });

      const msg = response.choices[0].message;
      currentMessages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        usedTools = true;
        for (const call of msg.tool_calls) {
          const toolName = call.function.name;
          const args = JSON.parse(call.function.arguments);

          this.emitProgress(this.formatToolProgress(toolName, args));
          const { result, screenshot } = await this.executeTool(toolName, args);

          if (screenshot) {
            currentMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `[Screenshot Taken] ${result}`,
            });
          } else {
            currentMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
          }
        }
        iterations++;
      } else {
        // Agent finished - format with Speaker if tools were used
        if (usedTools) {
          return await this.formatWithSpeaker(
            currentMessages,
            msg.content || ""
          );
        }
        return msg.content || "";
      }
    }
    // Max iterations - format whatever we have
    return await this.formatWithSpeaker(
      currentMessages,
      "Maximum iterations reached."
    );
  }

  /**
   * Format final response using speaker prompt for natural language.
   * Takes raw agent output and tool results, formats into JARVIS-style response.
   *
   * @param conversationHistory - Full conversation with tool results
   * @param agentSummary - Raw agent summary
   * @returns Promise resolving to formatted response string
   * @private
   */
  private async formatWithSpeaker(
    conversationHistory: any[],
    agentSummary: string
  ): Promise<string> {
    this.emitProgress("Formatting response...");

    // Extract the original user query
    const userQuery = conversationHistory.find(
      (m) => m.role === "user"
    )?.content;
    const userText =
      typeof userQuery === "string"
        ? userQuery
        : userQuery?.[0]?.text || "the request";

    // Collect tool results for context
    // For Ollama, tool results are embedded as assistant messages with [TOOL_RESULT:...] prefix
    const toolResults = conversationHistory
      .filter((m) => {
        if (m.role === "tool") return true; // OpenAI format
        if (
          m.role === "assistant" &&
          typeof m.content === "string" &&
          m.content.startsWith("[TOOL_RESULT:")
        )
          return true; // Ollama format
        return false;
      })
      .map((m) => {
        if (m.role === "tool") return m.content;
        // Extract content after [TOOL_RESULT:toolname] prefix
        const match = (m.content as string).match(
          /\[TOOL_RESULT:[^\]]+\]\n(.*)/s
        );
        return match ? match[1] : m.content;
      })
      .join("\n\n");

    logger.debug(
      "Agent",
      `Speaker - Tool results length: ${toolResults.length}`
    );
    logger.debug(
      "Agent",
      `Speaker - Tool results preview: ${toolResults.substring(0, 200)}...`
    );

    const speakerMessages = [
      { role: "system", content: this.getSpeakerPrompt() },
      {
        role: "user",
        content: `User asked: "${userText}"

Here is ALL the data gathered from tools:
${toolResults || "No data gathered"}

${agentSummary ? `Agent notes: ${agentSummary}` : ""}

IMPORTANT: You MUST use the data above to answer the user's question. Include all relevant information found. Do not give generic responses - use the actual data gathered.`,
      },
    ];

    try {
      if (this.provider === "ollama") {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: speakerMessages,
            stream: false,
            options: { temperature: 0.7, num_predict: 800 },
          }),
        });
        const data = await response.json();
        return data.message?.content || agentSummary;
      } else {
        // OpenAI
        const response = await this.openaiClient.chat.completions.create({
          model: "gpt-5-mini",
          messages: speakerMessages as any,
          max_completion_tokens: 800,
        });
        return response.choices[0]?.message?.content || agentSummary;
      }
    } catch (error) {
      logger.error("Agent", "Speaker formatting failed", error);
      return agentSummary; // Fallback to agent's raw summary
    }
  }

  // --- UTILITIES ---
  /**
   * Get available tools filtered by service availability.
   *
   * @returns Array of available tool definitions
   * @private
   */
  private getAvailableTools(): ChatCompletionTool[] {
    // Filter definitions based on which services are actually active
    return TOOL_DEFINITIONS.filter((t) => {
      const name = t.function.name;
      if (
        name.startsWith("calendar_") ||
        name.startsWith("tasks_") ||
        name.startsWith("email_")
      )
        return !!this.googleService;
      if (name.startsWith("web_")) return !!this.webSearchService;
      if (name.startsWith("browser_")) return !!this.browserService;
      if (name === "take_screenshot") return !!this.screenshotService;
      return true;
    });
  }

  /**
   * Convert OpenAI tool definitions to Ollama format.
   *
   * @returns Array of Ollama-compatible tool definitions
   * @private
   */
  private getOllamaTools(): OllamaTool[] {
    return this.getAvailableTools().map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters as any,
      },
    }));
  }

  /**
   * Emit progress status to registered callback.
   *
   * @param status - Progress status message
   * @private
   */
  private emitProgress(status: string) {
    if (this.progressCallback) this.progressCallback(status);
    logger.debug("Agent", `Progress: ${status}`);
  }

  /**
   * Check if a tool result indicates an error or unavailability.
   *
   * @param result - Tool execution result string
   * @returns True if result indicates an error
   * @private
   */
  private isToolResultError(result: string): boolean {
    if (!result) return false;
    const lowerResult = result.toLowerCase();
    const errorPatterns = [
      "not available",
      "error",
      "failed",
      "unavailable",
      "not found",
      "unauthorized",
      "permission denied",
      "access denied",
    ];
    return errorPatterns.some((pattern) => lowerResult.includes(pattern));
  }

  /**
   * Parse tool name from text content or arguments (fallback for malformed tool calls).
   *
   * @param content - Text content to parse
   * @param args - Tool arguments that might hint at tool name
   * @returns Parsed tool name or null if not found
   * @private
   */
  private parseToolFromText(
    content: string,
    args: Record<string, any>
  ): string | null {
    // Check if args contain hints about which tool to use
    if (args.query && !args.keyword) {
      if (args.url) return "browser_navigate";
      if (args.sender) return "email_from";
      return "email_search";
    }
    if (args.keyword) {
      if (args.include_completed !== undefined) return "tasks_search";
      return "calendar_search";
    }
    if (args.date) return "calendar_list";
    if (args.title && args.dateTime) return "calendar_add";
    if (args.title && !args.dateTime) {
      if (args.new_title || args.notes || args.due_date) return "tasks_update";
      if (args.notes !== undefined && !args.new_title) return "tasks_add";
      return "tasks_complete";
    }
    if (args.selector) {
      if (args.value) return "browser_fill";
      if (args.text) return "browser_type";
      return "browser_click";
    }
    if (args.direction) return "browser_scroll";
    if (args.key) return "browser_press_key";
    if (args.url) return "browser_navigate";

    // Try to extract from content text
    const toolPatterns = [
      /email_list|check.*email|latest.*email/i,
      /email_unread|unread.*email/i,
      /email_search|search.*email/i,
      /email_read|read.*email/i,
      /calendar_list|calendar.*today|calendar.*tomorrow/i,
      /calendar_week|week.*schedule/i,
      /calendar_month|month.*schedule/i,
      /calendar_search|search.*calendar/i,
      /calendar_add|add.*event|create.*meeting/i,
      /tasks_list|my.*tasks/i,
      /tasks_pending|pending.*tasks/i,
      /tasks_search|search.*tasks/i,
      /tasks_add|add.*task|create.*task/i,
      /browser_navigate|go.*to|navigate.*to|open.*website/i,
      /browser_snapshot|read.*page|get.*page|what.*page/i,
      /browser_click|click.*button|press.*button/i,
      /web_search|search.*web|search.*internet/i,
    ];

    for (const pattern of toolPatterns) {
      if (pattern.test(content)) {
        const match = pattern.source.match(/(\w+_\w+)/);
        if (match) return match[1];
      }
    }

    return null;
  }

  /**
   * Parse tool calls from text content (fallback when tool_calls are not present).
   *
   * @param content - Text content containing tool call patterns
   * @returns Array of parsed tool calls with name and arguments
   * @private
   */
  private parseToolCallsFromText(
    content: string
  ): Array<{ name: string; args: Record<string, any> }> {
    const calls: Array<{ name: string; args: Record<string, any> }> = [];

    // Pattern 1: New format { "function": "tool_name", "arguments": {...} }
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.function && typeof parsed.function === "string") {
          const toolName = parsed.function;
          const args = parsed.arguments || {};
          if (this.toolRegistry[toolName]) {
            calls.push({ name: toolName, args });
            return calls; // Return early if we found this format
          }
        } else if (parsed.name && typeof parsed.name === "string") {
          const toolName = parsed.name;
          const args = parsed.arguments || {};
          if (this.toolRegistry[toolName]) {
            calls.push({ name: toolName, args });
            return calls; // Return early if we found this format
          }
        }
      }
    } catch (e) {
      // Not valid JSON, continue to other patterns
    }

    // Pattern 2: JSON tool call format with "name" field
    const jsonPattern =
      /\{[\s\S]*?"function"[\s\S]*?"name"[\s\S]*?"(\w+)"[\s\S]*?"arguments"[\s\S]*?\{([\s\S]*?)\}[\s\S]*?\}/g;
    let match;
    while ((match = jsonPattern.exec(content)) !== null) {
      try {
        const toolName = match[1];
        const argsStr = match[2];
        const args = JSON.parse(`{${argsStr}}`);
        if (this.toolRegistry[toolName]) {
          calls.push({ name: toolName, args });
        }
      } catch (e) {
        // Invalid JSON, skip
      }
    }

    // Pattern 2: Function call format: tool_name(arg="value")
    const funcPattern = /(\w+_\w+)\s*\(([^)]*)\)/g;
    while ((match = funcPattern.exec(content)) !== null) {
      const toolName = match[1];
      const argsStr = match[2];
      if (this.toolRegistry[toolName]) {
        const args: Record<string, any> = {};
        // Simple parsing: key="value" or key=value
        const argPattern = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*(\w+)/g;
        let argMatch;
        while ((argMatch = argPattern.exec(argsStr)) !== null) {
          const key = argMatch[1] || argMatch[3];
          const value = argMatch[2] || argMatch[4];
          args[key] = value;
        }
        calls.push({ name: toolName, args });
      }
    }

    return calls;
  }

  /**
   * Format tool name and arguments into human-readable progress text.
   *
   * @param tool - Tool name
   * @param args - Tool arguments
   * @returns Human-readable progress message
   * @private
   */
  private formatToolProgress(tool: string, args: Record<string, any>): string {
    const formatMap: Record<string, (a: any) => string> = {
      // Browser
      browser_navigate: (a) => `Opening ${new URL(a.url).hostname}...`,
      browser_snapshot: () => `Reading page content...`,
      browser_click: (a) => `Clicking "${a.selector}"...`,
      browser_fill: (a) => `Filling "${a.selector}"...`,
      browser_type: (a) => `Typing into "${a.selector}"...`,
      browser_press_key: (a) => `Pressing ${a.key}...`,
      browser_scroll: (a) => `Scrolling ${a.direction}...`,
      browser_back: () => `Going back...`,
      browser_screenshot: () => `Taking screenshot...`,
      browser_evaluate: () => `Running script...`,
      browser_search_google: (a) => `Searching "${a.query}"...`,
      browser_close: () => `Closing browser...`,
      // Web
      web_search: (a) => `Searching web for "${a.query}"...`,
      // Calendar
      calendar_list: () => `Checking calendar...`,
      calendar_week: () => `Getting week schedule...`,
      calendar_month: () => `Getting month schedule...`,
      calendar_search: (a) => `Searching calendar for "${a.keyword}"...`,
      calendar_add: (a) => `Creating event "${a.title}"...`,
      calendar_freebusy: () => `Checking availability...`,
      // Tasks
      tasks_list: () => `Getting tasks...`,
      tasks_pending: () => `Getting pending tasks...`,
      tasks_completed: () => `Getting completed tasks...`,
      tasks_search: (a) => `Searching tasks for "${a.keyword}"...`,
      tasks_add: (a) => `Creating task "${a.title}"...`,
      tasks_complete: (a) => `Completing "${a.title}"...`,
      tasks_update: (a) => `Updating "${a.title}"...`,
      tasks_delete: (a) => `Deleting "${a.title}"...`,
      // Email
      email_list: () => `Checking inbox...`,
      email_unread: () => `Getting unread emails...`,
      email_search: (a) =>
        `Searching emails for "${a.query || a.keyword || ""}"...`,
      email_from: (a) => `Getting emails from ${a.sender}...`,
      email_read: () => `Reading email...`,
      email_draft: (a) => `Drafting email to ${a.to}...`,
      email_mark_read: () => `Marking as read...`,
      email_archive: () => `Archiving email...`,
      email_star: () => `Starring email...`,
      // System
      system_status: () => `Checking system...`,
      take_screenshot: () => `Capturing screen...`,
    };

    const formatter = formatMap[tool];
    if (formatter) {
      try {
        return formatter(args);
      } catch {
        return `${tool.replace(/_/g, " ")}...`;
      }
    }
    return `${tool.replace(/_/g, " ")}...`;
  }
}
