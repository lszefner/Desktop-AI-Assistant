import { GoogleService } from "./google.js";
import { SystemService } from "./system.js";
import { AgentService } from "./agent.js";
import { logger } from "../utils/logger.js";
import { config } from "dotenv";
config();

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  hangoutLink?: string;
}

interface Task {
  id: string;
  title: string;
  due?: string;
  status: string;
  updated: string;
}

interface Email {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  threadId: string;
  body?: string;
}

interface EmailImportance {
  isImportant: boolean;
  urgency: "low" | "medium" | "high" | "critical";
  reason: string;
  requiresImmediateAttention: boolean;
  score: number; // 0-1
}

interface NotificationAction {
  label: string;
  query?: string; // Query to send to agent when clicked
  action?: () => Promise<void>; // Custom action function
}

interface Notification {
  title: string;
  message: string;
  priority: "normal" | "high";
  actions?: NotificationAction[]; // Action buttons
  action?: () => Promise<void>; // Legacy support
  icon?: string; // Emoji or icon identifier
}

type NotificationCallback = (notification: Notification) => void;

export class ProactiveService {
  private googleService: GoogleService | null = null;
  private systemService: SystemService | null = null;
  private agentService: AgentService | null = null;
  private notifyCallback: NotificationCallback | null = null;

  // State tracking
  private notifiedEvents: Set<string> = new Set();
  private notifiedTasks: Set<string> = new Set();
  private lastMorningBrief: Date | null = null;
  private lastEmailCheck: Date | null = null;
  private lastResourceCheck: Date | null = null;
  private processedEmailIds: Set<string> = new Set();
  private staleTaskNotificationsToday: Map<string, string> = new Map(); // taskId -> date string
  private sentNotifications: Map<string, Date> = new Map(); // notification key -> timestamp for deduplication
  private notifiedResourceAlerts: Map<string, Date> = new Map(); // processName -> timestamp for deduplication
  private ollamaNotificationSent: boolean = false; // Track if Ollama notification has been sent

  // Configuration
  private readonly PRE_MEETING_MINUTES = 5;
  private readonly STALE_TASK_DAYS = 3;
  private readonly MORNING_BRIEF_HOUR = 9;
  private readonly MORNING_BRIEF_MINUTES = 15;
  private readonly MORNING_BRIEF_WINDOW_MINUTES = 30; // Window for morning brief (9:00-9:30)
  private readonly CPU_THRESHOLD = 90;
  private readonly MEMORY_THRESHOLD = 95;

  // Configuration for new features
  private readonly MEETING_PREP_MINUTES = 15;

  // Memory management
  private readonly MAX_PROCESSED_EMAILS = 1000; // Max emails to track (prevent memory leak)
  private readonly EMAIL_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  // Provider config
  private readonly PROVIDER: "openai" | "ollama" =
    process.env.USE_LOCAL_PROACTIVE === "true" ? "ollama" : "openai";

  /**
   * Creates a new ProactiveService instance.
   *
   * @param googleService - Service for Google Calendar, Tasks, and Email integration
   * @param systemService - Service for system resource monitoring
   * @param agentService - Service for AI-powered analysis and task extraction
   */
  constructor(
    googleService: GoogleService | null,
    systemService: SystemService | null,
    agentService: AgentService | null
  ) {
    this.googleService = googleService;
    this.systemService = systemService;
    this.agentService = agentService;

    // Cleanup processed emails periodically to prevent memory leaks
    setInterval(
      () => this.cleanupProcessedEmails(),
      this.EMAIL_CLEANUP_INTERVAL
    );
  }

  setNotifyCallback(callback: NotificationCallback) {
    this.notifyCallback = callback;
  }

  /**
  /**
   * Safely parses a JSON string, handling edge cases including:
   * - Surrounded by Markdown code blocks (``` or ```json)
   * - Extra text before or after JSON
   * - Only partial JSON text present
   * 
   * @param response - The JSON string to parse
   * @param defaultValue - Value to return if parsing fails
   * @returns Parsed JSON object or defaultValue if parsing fails
   */
  private safeParseJSON<T>(response: string | undefined, defaultValue: T): T {
    if (!response || typeof response !== "string") {
      return defaultValue;
    }

    let trimmed = response.trim();

    // Remove Markdown code block wrappers
    // Remove ```json (case-insensitive) or ``` on the start/end
    if (
      trimmed.startsWith("```json") ||
      trimmed.startsWith("```JSON") ||
      trimmed.startsWith("```")
    ) {
      trimmed = trimmed.replace(/^```[jJ][sS][oO][nN]?[\r\n]?/, "");
      // Remove closing ```
      trimmed = trimmed.replace(/```[\s\n]*$/, "");
      trimmed = trimmed.trim();
    }

    // Attempt to extract JSON substring if additional junk is present
    let jsonCandidate = trimmed;

    // Look for first [{ and last }] or }
    const arrayMatch = jsonCandidate.match(/\[[\s\S]*\]/);
    const objectMatch = jsonCandidate.match(/\{[\s\S]*\}/);
    if (arrayMatch) {
      jsonCandidate = arrayMatch[0];
    } else if (objectMatch) {
      jsonCandidate = objectMatch[0];
    }

    // Now, attempt parsing
    try {
      return JSON.parse(jsonCandidate) as T;
    } catch (e) {
      logger.warn(
        "Proactive",
        `Failed to parse JSON response: ${response.substring(0, 300)}`,
        e
      );
      return defaultValue;
    }
  }

  /**
   * Check for upcoming meetings, send pre-meeting briefings, and prepare AI-powered meeting context if applicable.
   * Sends notifications at 5 minutes before meeting (brief) and 15 minutes before (AI-powered prep).
   *
   * @returns Promise that resolves when check is complete
   */
  async checkAndPrepareMeetingBriefings(): Promise<void> {
    if (!this.googleService) {
      logger.debug(
        "Proactive",
        "[MeetingBriefings] GoogleService not available, skipping"
      );
      return;
    }

    try {
      logger.debug(
        "Proactive",
        "[MeetingBriefings] Checking for upcoming meetings..."
      );
      const now = new Date();
      const preMeetingWindow = new Date(
        now.getTime() + this.PRE_MEETING_MINUTES * 60000
      );
      const prepWindow = new Date(
        now.getTime() + this.MEETING_PREP_MINUTES * 60000
      );

      // Check the larger of the two windows so we catch all meetings in one go
      const maxWindow = new Date(
        Math.max(preMeetingWindow.getTime(), prepWindow.getTime())
      );

      const eventsJSON = await this.googleService.getCalendarEventsAsJSON({
        timeMin: now.toISOString(),
        timeMax: maxWindow.toISOString(),
        maxResults: 15,
      });

      if (!eventsJSON || typeof eventsJSON !== "string") {
        logger.debug("Proactive", "[MeetingBriefings] No events data returned");
        return;
      }
      const eventList: CalendarEvent[] = this.safeParseJSON(eventsJSON, []);
      logger.debug(
        "Proactive",
        `[MeetingBriefings] Found ${eventList.length} event(s) in window`
      );
      if (eventList.length === 0) return;

      for (const event of eventList) {
        // === Pre-meeting briefing (simple, high-priority) ===
        const eventId = event.id;
        const startTime = event.start.dateTime
          ? new Date(event.start.dateTime)
          : new Date(event.start.date!);
        const minutesUntil = Math.floor(
          (startTime.getTime() - now.getTime()) / 60000
        );

        if (
          minutesUntil <= this.PRE_MEETING_MINUTES &&
          minutesUntil >= 0 &&
          !this.notifiedEvents.has(eventId)
        ) {
          logger.info(
            "Proactive",
            `[MeetingBriefings] Meeting "${event.summary}" starting in ${minutesUntil} minutes - preparing briefing`
          );
          this.notifiedEvents.add(eventId);

          // Meeting details
          let briefing = `Meeting: ${event.summary}\n`;
          if (event.location) briefing += `Location: ${event.location}\n`;
          if (event.hangoutLink) briefing += `Link: ${event.hangoutLink}\n`;

          // Relevant email with attendees
          if (event.attendees && event.attendees.length > 0) {
            const attendeeEmails = event.attendees
              .map((a) => a.email)
              .filter(Boolean);
            if (attendeeEmails.length > 0) {
              try {
                const emailsJSON = await this.googleService.searchEmailsAsJSON({
                  query: `from:${attendeeEmails[0]} OR to:${attendeeEmails[0]}`,
                  maxResults: 5,
                });

                if (emailsJSON && typeof emailsJSON === "string") {
                  const emailList: Email[] = this.safeParseJSON(emailsJSON, []);
                  if (emailList.length > 0) {
                    const latest = emailList[0];
                    briefing += `\nLatest email: "${latest.subject}"\n${latest.snippet}`;
                  }
                }
              } catch (e) {
                logger.error(
                  "Proactive",
                  "Error fetching email for briefing",
                  e
                );
              }
            }
          }

          this.sendNotification({
            title: `⏰ Meeting in ${minutesUntil} minutes`,
            message: briefing,
            priority: "high",
          });
        }

        // === Prepare meeting context (15 min AI-powered) ===
        if (
          this.agentService &&
          minutesUntil <= this.MEETING_PREP_MINUTES &&
          minutesUntil >= 0
        ) {
          const prepKey = `prep-${event.id}`;
          if (!this.notifiedEvents.has(prepKey)) {
            logger.info(
              "Proactive",
              `[MeetingBriefings] Preparing AI context for meeting "${event.summary}" (${minutesUntil} min until start)`
            );
            this.notifiedEvents.add(prepKey);

            const briefingPrompt = `Prepare a briefing for this meeting:

Title: ${event.summary}
Attendees: ${
              event.attendees
                ?.map((a) => a.email || a.displayName)
                .join(", ") || "None"
            }
Time: ${startTime.toLocaleString()}
${event.location ? `Location: ${event.location}` : ""}

Gather and summarize the following for this meeting (provide clear, actionable details):
1. Recent email threads with attendees (if any):
   - Include relevant threads from the past 2 weeks.
   - Note unresolved questions, key decisions, and requests or follow-ups.
   - Example: "Negotiation thread with Sarah Lee (3 days ago): Awaiting reply on contract edits."
2. Action items from previous related meetings:
   - List outstanding or just-completed action items assigned to any attendee.
   - Include both tasks not yet done and items recently completed for context.
   - Example: "- Alex: Share Q2 report files (pending)\n- Sam: Completed client demo slides."
3. Key discussion points to cover in this meeting:
   - Suggest 2–4 specific discussion topics likely to arise, using agenda if available, or infer based on context.
   - Example: "- Finalize project timeline\n- Discuss budget approval\n- Review pending issues from email chain."
4. Documents or notes that might be relevant:
   - Identify and list links/names of documents (e.g., shared drives, recent attachments), minutes from last meeting, or notes referenced in threads.
   - Example: "Link: Q2_Planning_Doc.pdf (Shared Drive), '2024 Client Agenda' (from last meeting notes)."


Create a concise briefing (3-4 bullet points).`;

            try {
              const briefing = await this.agentService.processQueryWithProvider(
                briefingPrompt,
                this.PROVIDER,
                false,
                false // Natural language, not JSON
              );

              this.sendNotification({
                title: `📋 Meeting Prep: ${event.summary}`,
                message: briefing,
                priority: "normal",
              });
            } catch (error) {
              logger.error(
                "Proactive",
                "Error preparing meeting context",
                error
              );
            }
          }
        }
      }
    } catch (error) {
      logger.error("Proactive", "Error in meeting briefings/context", error);
    }
  }

  /**
   * Extract actionable tasks from an important email and add them as Google Tasks.
   * Uses AI to identify action items and automatically creates Google Tasks.
   *
   * @param email - The email to extract tasks from
   * @returns Promise that resolves when tasks are extracted and added
   */
  async handleImportantEmailTasks(email: Email): Promise<void> {
    if (!this.agentService || !this.googleService) return;
    try {
      let totalTasks = 0;

      // Get today's date for the model context
      const today = new Date().toISOString().split("T")[0];

      const extractPrompt = `You are a precise Task Extraction Engine.
Current Date: ${today} (Use this to calculate relative dates like 'tomorrow' or 'next Friday')

---
EMAIL INPUT
From: "${email.from}"
Subject: "${email.subject}"
Body: "${email.snippet}"
---

INSTRUCTIONS:
1. Extract ONLY explicit action items (requests, questions requiring a reply, scheduling needs).
2. IGNORE general updates, FYIs, pleasantries, or completed items.
3. If there are NO actionable tasks, return exactly: []
4. Do not use Markdown (no \`\`\`json).

RESPONSE FORMAT (Valid JSON Array):
[
  {
    "title": "Action Verb + Noun (max 8 words, e.g., 'Reply to John', 'Review Report')",
    "description": "Specific details or context needed",
    "priority": "high" | "normal",
    "due_date": "YYYY-MM-DD" or null
  }
]`;
      const response = await this.agentService.processQueryWithProvider(
        extractPrompt,
        this.PROVIDER,
        false,
        true // JSON mode
      );

      // Extract JSON array from response
      const match = response.match(/\[([\s\S]*)\]/);
      const taskList: Array<{
        title: string;
        description: string;
        due?: string;
      }> = match ? this.safeParseJSON(match[0], []) : [];

      if (!taskList.length) {
        logger.debug(
          "Proactive",
          `No actionable tasks detected in email "${email.subject}".`
        );
        return;
      }

      totalTasks += taskList.length;

      // 2. Add extracted tasks to Google Tasks
      for (const item of taskList) {
        await this.googleService.manageTasks("add", {
          title: item.title,
          notes: item.description,
          due: item.due && item.due.trim() !== "" ? item.due : undefined,
          source: "email",
        });
      }

      this.sendNotification({
        title: "✅ Tasks Added from Email",
        message: `${totalTasks} task(s) extracted and added from:\n"${email.subject}"`,
        priority: "normal",
        actions: [
          {
            label: "View Tasks",
            query: "Show me my pending tasks",
          },
          {
            label: "View Email",
            query: `Show me the email "${email.subject}"`,
          },
        ],
      });
    } catch (error) {
      logger.error("Proactive", "Error handling important email tasks", error);
    }
  }

  /**
   * Generate morning brief during the configured time window (default 9:00-9:30 AM).
   * Only sends once per day. Includes today's schedule, tasks, and deadlines.
   *
   * @returns Promise that resolves when check is complete
   */
  async checkMorningBrief(): Promise<void> {
    if (!this.googleService || !this.agentService) {
      logger.debug(
        "Proactive",
        "[MorningBrief] GoogleService or AgentService not available, skipping"
      );
      return;
    }

    const now = new Date();
    const currentHour = now.getHours();
    logger.debug(
      "Proactive",
      `[MorningBrief] Current time: ${currentHour}:${now.getMinutes()}, checking if brief time (${
        this.MORNING_BRIEF_HOUR
      }:${this.MORNING_BRIEF_MINUTES})`
    );

    // Check if it's morning brief time window and we haven't sent one today
    // Use window-based approach instead of exact time to be more reliable
    const briefWindowStart =
      this.MORNING_BRIEF_HOUR * 60 + this.MORNING_BRIEF_MINUTES;
    const briefWindowEnd = briefWindowStart + this.MORNING_BRIEF_WINDOW_MINUTES;
    const currentMinutes = currentHour * 60 + now.getMinutes();

    const isInWindow =
      currentMinutes >= briefWindowStart && currentMinutes < briefWindowEnd;
    const notSentToday =
      !this.lastMorningBrief ||
      this.lastMorningBrief.toDateString() !== now.toDateString();

    if (isInWindow && notSentToday) {
      logger.info("Proactive", "[MorningBrief] Generating morning brief...");
      this.lastMorningBrief = now;

      try {
        // Get today's tasks
        logger.debug("Proactive", "[MorningBrief] Fetching tasks...");
        const tasksJSON = await this.googleService.getTasksAsJSON({
          status: "all",
        });
        const tasksList: Task[] = this.safeParseJSON(tasksJSON, []);
        logger.debug(
          "Proactive",
          `[MorningBrief] Found ${tasksList.length} task(s)`
        );

        // Get today's calendar
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        logger.debug("Proactive", "[MorningBrief] Fetching calendar events...");
        const eventsJSON = await this.googleService.getCalendarEventsAsJSON({
          timeMin: today.toISOString(),
          timeMax: tomorrow.toISOString(),
        });

        const eventList: CalendarEvent[] = this.safeParseJSON(eventsJSON, []);
        logger.debug(
          "Proactive",
          `[MorningBrief] Found ${eventList.length} event(s) for today`
        );

        // Analyze tasks for hardest and deadlines
        const pendingTasks = tasksList.filter((t) => t.status !== "completed");
        const tasksWithDue = pendingTasks.filter((t) => t.due);
        const sortedByDue = tasksWithDue.sort((a, b) => {
          const dueA = new Date(a.due!).getTime();
          const dueB = new Date(b.due!).getTime();
          return dueA - dueB;
        });

        // Build brief
        let brief = "Daily Brief\n\n";
        brief += `📅 Today's Schedule: ${eventList.length} events\n`;
        brief += `✅ Tasks: ${pendingTasks.length} pending\n\n`;

        if (sortedByDue.length > 0) {
          brief += "⏰ Upcoming Deadlines:\n";
          sortedByDue.slice(0, 3).forEach((task) => {
            const dueDate = new Date(task.due!);
            const hoursUntil = Math.floor(
              (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60)
            );
            brief += `- ${task.title} (${
              hoursUntil > 0 ? `${hoursUntil}h left` : "OVERDUE"
            })\n`;
          });
        }

        if (eventList.length > 0) {
          brief += "\n📋 Today's Meetings:\n";
          eventList.slice(0, 5).forEach((event) => {
            const start = event.start.dateTime || event.start.date;
            brief += `- ${this.formatTime(start!)}: ${event.summary}\n`;
          });
        }

        this.sendNotification({
          title: "🌅 Daily Brief",
          message: brief,
          priority: "normal",
        });
      } catch (error) {
        logger.error("Proactive", "Error generating morning brief", error);
      }
    }
  }

  // ==================== EXECUTIVE FUNCTION (Task Management) ====================

  /**
   * Check for upcoming task deadlines and send context-aware nudges.
   * Sends notification exactly 2 hours before deadline. Only notifies once per task.
   *
   * @returns Promise that resolves when check is complete
   */
  async checkDeadlineNudges(): Promise<void> {
    if (!this.googleService) return;

    try {
      const now = new Date();
      const tasksJSON = await this.googleService.getTasksAsJSON({
        status: "all",
      });
      const tasksList: Task[] = this.safeParseJSON(tasksJSON, []);
      if (tasksList.length === 0) return;

      const pendingTasks = tasksList.filter(
        (t) => t.status !== "completed" && t.due
      );

      for (const task of pendingTasks) {
        if (this.notifiedTasks.has(task.id)) continue;

        const dueDate = new Date(task.due!);
        const hoursUntil = Math.floor(
          (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60)
        );

        // Notify 2 hours before deadline
        if (hoursUntil === 2 && hoursUntil > 0) {
          this.notifiedTasks.add(task.id);
          this.sendNotification({
            title: "⏳ Deadline Reminder",
            message: `You have 2 hours left for:\n"${task.title}"\n\nWould you like to enter Focus Mode?`,
            priority: "high",
          });
        }
      }
    } catch (error) {
      logger.error("Proactive", "Error checking deadline nudges", error);
    }
  }

  /**
   * Identify stale tasks (overdue for 3+ days) and offer to reschedule or delete.
   * Notifies once per day per stale task. Handles both tasks with due dates and without.
   *
   * @returns Promise that resolves when check is complete
   */
  async checkStaleTasks(): Promise<void> {
    if (!this.googleService) return;

    try {
      const now = new Date();
      const staleThreshold = new Date(
        now.getTime() - this.STALE_TASK_DAYS * 24 * 60 * 60 * 1000
      );

      const tasksJSON = await this.googleService.getTasksAsJSON({
        status: "all",
      });
      if (!tasksJSON || typeof tasksJSON !== "string") return;
      const tasksList: Task[] = this.safeParseJSON(tasksJSON, []);

      // Stale if overdue for 3+ days (with due date)
      const staleTasks = tasksList.filter((task) => {
        if (task.status === "completed") return false;
        if (task.due) {
          const dueDate = new Date(task.due);
          return dueDate < staleThreshold;
        }
        return false;
      });

      // Additionally, handle tasks with no due date
      const dueDateLessStaleTasks = tasksList.filter((task) => {
        if (task.status === "completed") return false;
        if (!task.due) {
          const dateToCheck = (task.updated && new Date(task.updated)) || null;
          if (dateToCheck) {
            return dateToCheck < staleThreshold;
          }
          return true;
        }
        return false;
      });

      // Notify for stale tasks with due date (max once per day)
      const today = now.toDateString();
      for (const task of staleTasks) {
        // Check if we've already notified about this task today
        const lastNotificationDate = this.staleTaskNotificationsToday.get(
          `due-${task.id}`
        );
        if (lastNotificationDate === today) {
          logger.debug(
            "Proactive",
            `[StaleTasks] Already notified about task "${task.title}" today, skipping`
          );
          continue;
        }

        // Mark as notified for today
        this.staleTaskNotificationsToday.set(`due-${task.id}`, today);
        this.sendNotification({
          title: "📦 Stale Task Detected",
          message: `You haven't touched "${task.title}" in ${this.STALE_TASK_DAYS}+ days.\n\nShould we reschedule it for next week or delete it?`,
          priority: "normal",
          actions: [
            {
              label: "Reschedule",
              query: `Reschedule the task "${task.title}" for next week`,
            },
            {
              label: "Delete",
              query: `Delete the stale task "${task.title}"`,
            },
            {
              label: "View Task",
              query: `Show me details about "${task.title}"`,
            },
          ],
        });
      }

      // Notify for stale tasks with no due date (max once per day)
      for (const task of dueDateLessStaleTasks) {
        // Check if we've already notified about this task today
        const lastNotificationDate = this.staleTaskNotificationsToday.get(
          task.id
        );
        if (lastNotificationDate === today) {
          logger.debug(
            "Proactive",
            `[StaleTasks] Already notified about task "${task.title}" today, skipping`
          );
          continue;
        }

        // Mark as notified for today
        this.staleTaskNotificationsToday.set(task.id, today);
        this.sendNotification({
          title: "📦 Stale Task (No Due Date)",
          message: `The task "${task.title}" has no due date and hasn't been updated in ${this.STALE_TASK_DAYS}+ days.\n\nWould you like to add a due date, reschedule, or delete it?`,
          priority: "normal",
        });
      }
    } catch (error) {
      logger.error("Proactive", "Error checking stale tasks", error);
    }
  }

  // ==================== GATEKEEPER (Communication Filter) ====================

  /**
   * AI-powered email importance analysis using configured provider (OpenAI or Ollama).
   * Analyzes email snippet to determine urgency and importance score.
   *
   * @param email - The email to analyze
   * @returns Promise resolving to EmailImportance analysis result
   */
  async analyzeEmailImportance(email: Email): Promise<EmailImportance> {
    try {
      // Use Ollama for lightweight analysis (always local)
      const analysisPrompt = `You are an expert Email Triage Agent. Your job is to categorize the following email based strictly on the snippet provided.

      ---
      INPUT EMAIL
      From: "${email.from}"
      Subject: "${email.subject}"
      Snippet: "${email.snippet}"
      ---
      
      SCORING HEURISTICS:
      - **CRITICAL (0.9-1.0)**: Direct questions from humans, specific deadlines < 24h, security alerts, or "urgent" in subject.
      - **HIGH (0.7-0.8)**: Scheduling requests, active project threads, direct requests from colleagues/clients.
      - **MEDIUM (0.4-0.6)**: FYIs, general updates, newsletters with relevant info, Event Acceptance/Declination.
      - **LOW (0.0-0.3)**: Marketing, automated receipts, social notifications, spam.
      
      INSTRUCTIONS:
      1. Analyze the sender (Personal name > Generic/No-reply).
      2. Analyze the intent (Action required > Informational).
      3. Output strictly valid JSON.
      
      RESPONSE FORMAT (JSON ONLY, NO MARKDOWN, NO COMMENTS):
      {
        "category": "work" | "personal" | "newsletter" | "security" | "marketing",
        "isImportant": boolean,
        "urgency": "low" | "medium" | "high" | "critical",
        "reason": "Max 10 words explanation",
        "requiresImmediateAttention": boolean,
        "score": number
      }`;

      const response = await this.agentService?.processQueryWithProvider(
        analysisPrompt,
        this.PROVIDER,
        false,
        true // jsonMode: true - force JSON output
      );

      // Extract JSON from response
      const jsonMatch = response?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]) as EmailImportance;
        return analysis;
      }
    } catch (e: any) {
      // Check if this is an Ollama connection error
      if (e.isOllamaConnectionError && this.PROVIDER === "ollama") {
        // Only send notification once
        if (!this.ollamaNotificationSent) {
          logger.warn(
            "Proactive",
            "Ollama is not running - sending notification"
          );
          if (this.notifyCallback) {
            this.notifyCallback({
              title: "Ollama Not Running",
              message:
                "Ollama service is not running. Please start Ollama to enable AI-powered email analysis and other proactive features.",
              priority: "normal",
            });
            this.ollamaNotificationSent = true;
          }
        } else {
          logger.debug(
            "Proactive",
            "Ollama notification already sent, skipping"
          );
        }
      } else {
        logger.error("Proactive", "AI analysis failed", e);
      }
    }

    // Fallback
    return {
      isImportant: false,
      urgency: "low",
      reason: "Analysis failed",
      requiresImmediateAttention: false,
      score: 0.3,
    };
  }

  /**
   * Check for important emails using AI analysis.
   * Analyzes unread emails and sends notifications for important ones.
   * Marks emails as read after processing to prevent reprocessing.
   * Checks every 10 minutes by default.
   *
   * @returns Promise that resolves when check is complete
   */
  async checkVIPEmails(): Promise<void> {
    if (!this.googleService || !this.agentService) {
      logger.debug(
        "Proactive",
        "[VIPEmails] GoogleService or AgentService not available, skipping"
      );
      return;
    }

    try {
      const now = new Date();
      // Check every 10 minutes (less frequent to reduce API calls and processing)
      const EMAIL_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
      if (
        this.lastEmailCheck &&
        now.getTime() - this.lastEmailCheck.getTime() < EMAIL_CHECK_INTERVAL
      ) {
        const timeSinceLastCheck = Math.floor(
          (now.getTime() - this.lastEmailCheck.getTime()) / 1000
        );
        logger.debug(
          "Proactive",
          `[VIPEmails] Skipping check (last check was ${timeSinceLastCheck}s ago, minimum interval: ${
            EMAIL_CHECK_INTERVAL / 1000
          }s)`
        );
        return;
      }
      const checkStartTime = Date.now();
      this.lastEmailCheck = now;

      // Get unread emails as JSON
      logger.debug("Proactive", "[VIPEmails] Fetching unread emails...");
      const emailsJSON = await this.googleService.getUnreadEmailsAsJSON({
        maxResults: 5,
        avoidSpam: true,
        important: false,
      });

      if (!emailsJSON || typeof emailsJSON !== "string") {
        logger.debug("Proactive", "[VIPEmails] No email data returned");
        return;
      }
      const emailList: Email[] = this.safeParseJSON(emailsJSON, []);
      logger.debug(
        "Proactive",
        `[VIPEmails] Found ${emailList.length} unread email(s)`
      );

      let analyzedCount = 0;
      let importantCount = 0;
      for (const email of emailList) {
        if (this.processedEmailIds.has(email.id)) {
          logger.debug(
            "Proactive",
            `[VIPEmails] Email "${email.subject}" already processed, skipping`
          );
          continue;
        }

        // AI-powered importance analysis using local model
        logger.debug(
          "Proactive",
          `[VIPEmails] Analyzing importance of email: "${email.subject}" from ${email.from}`
        );
        analyzedCount++;
        const importance = await this.analyzeEmailImportance(email);
        logger.debug(
          "Proactive",
          `[VIPEmails] Email analysis result - Important: ${
            importance.isImportant
          }, Score: ${importance.score.toFixed(2)}, Urgency: ${
            importance.urgency
          }, Reason: ${importance.reason}`
        );

        // Mark email as processed and read (regardless of importance)
        // This ensures it won't be analyzed again
        this.processedEmailIds.add(email.id);

        // Prevent memory leak: limit set size
        if (this.processedEmailIds.size > this.MAX_PROCESSED_EMAILS) {
          // Remove oldest entries (Set maintains insertion order in modern JS)
          const entriesToRemove =
            this.processedEmailIds.size - this.MAX_PROCESSED_EMAILS + 100;
          const idsArray = Array.from(this.processedEmailIds);
          for (let i = 0; i < entriesToRemove; i++) {
            this.processedEmailIds.delete(idsArray[i]);
          }
        }

        try {
          await this.googleService.manageEmail("markRead", {
            messageId: email.id,
          });
          logger.debug(
            "Proactive",
            `[VIPEmails] Email "${email.subject}" marked as read`
          );
        } catch (error) {
          logger.error(
            "Proactive",
            `Failed to mark email "${email.subject}" as read`,
            error
          );
        }

        if (importance.isImportant && importance.score > 0.6) {
          importantCount++;
          logger.info(
            "Proactive",
            `[VIPEmails] Email "${
              email.subject
            }" marked as important (score: ${importance.score.toFixed(
              2
            )}), sending notification`
          );
          this.sendNotification({
            title:
              importance.urgency === "critical" || importance.urgency === "high"
                ? "🔴 Important Email"
                : "📧 Email Alert",
            message: `From: ${email.from}\nSubject: ${
              email.subject
            }\n\n${email.snippet.substring(0, 150)}${
              email.snippet.length > 150 ? "..." : ""
            }\n\nWhy important: ${importance.reason}`,
            priority:
              importance.requiresImmediateAttention ||
              importance.urgency === "critical"
                ? "high"
                : "normal",
          });
          logger.debug(
            "Proactive",
            `[VIPEmails] Turning email into actionable tasks...`
          );
          await this.handleImportantEmailTasks(email);
        } else {
          logger.debug(
            "Proactive",
            `[VIPEmails] Email "${
              email.subject
            }" not important enough (score: ${importance.score.toFixed(
              2
            )}), skipping notification`
          );
        }
      }
      const checkDuration = Date.now() - checkStartTime;
      logger.info(
        "Proactive",
        `[VIPEmails] Check completed: analyzed ${analyzedCount} email(s), ${importantCount} marked as important, duration: ${checkDuration}ms`
      );
    } catch (error) {
      logger.error("Proactive", "[VIPEmails] Error checking VIP emails", error);
    }
  }

  // ==================== SYSTEM WATCHDOG (OS Health) ====================

  /**
   * Monitor system resources and warn about resource-heavy processes.
   * Checks CPU and memory usage, alerts if thresholds are exceeded.
   * Per-process deduplication prevents spam (30 minute cooldown per process).
   * Checks every 5 minutes by default.
   *
   * @returns Promise that resolves when check is complete
   */
  async checkResourceGuardian(): Promise<void> {
    if (!this.systemService) {
      logger.debug(
        "Proactive",
        "[ResourceGuardian] SystemService not available, skipping"
      );
      return;
    }

    try {
      const now = new Date();
      // Check every 5 minutes (less frequent to reduce overhead)
      const RESOURCE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
      if (
        this.lastResourceCheck &&
        now.getTime() - this.lastResourceCheck.getTime() <
          RESOURCE_CHECK_INTERVAL
      ) {
        const timeSinceLastCheck = Math.floor(
          (now.getTime() - this.lastResourceCheck.getTime()) / 1000
        );
        logger.debug(
          "Proactive",
          `[ResourceGuardian] Skipping check (last check was ${timeSinceLastCheck}s ago, minimum interval: ${
            RESOURCE_CHECK_INTERVAL / 1000
          }s)`
        );
        return;
      }
      this.lastResourceCheck = now;

      logger.debug(
        "Proactive",
        "[ResourceGuardian] Checking system resources..."
      );
      const status = await this.systemService.getStatus();
      const processes = await this.systemService.getTopProcesses(5);
      logger.debug(
        "Proactive",
        `[ResourceGuardian] CPU: ${status.cpu}%, Memory: ${status.memory.percent}%, Found ${processes.length} top process(es)`
      );

      // Check overall CPU/Memory
      if (
        status.cpu > this.CPU_THRESHOLD ||
        status.memory.percent > this.MEMORY_THRESHOLD
      ) {
        logger.warn(
          "Proactive",
          `[ResourceGuardian] High resource usage detected (CPU: ${status.cpu}% > ${this.CPU_THRESHOLD}% or Memory: ${status.memory.percent}% > ${this.MEMORY_THRESHOLD}%)`
        );
        // Find the culprit process
        const heavyProcess = processes.find((p) => p.cpu > 50 || p.memory > 50);

        if (heavyProcess) {
          // Deduplicate resource alerts per process (don't spam for same process)
          const alertKey = `resource-${heavyProcess.name}`;
          const lastAlert = this.notifiedResourceAlerts.get(alertKey);
          const alertCooldown = 30 * 60 * 1000; // 30 minutes cooldown per process

          if (
            !lastAlert ||
            now.getTime() - lastAlert.getTime() >= alertCooldown
          ) {
            this.notifiedResourceAlerts.set(alertKey, now);
            logger.warn(
              "Proactive",
              `[ResourceGuardian] Found heavy process: ${heavyProcess.name} (CPU: ${heavyProcess.cpu}%, Memory: ${heavyProcess.memory}%)`
            );
            this.sendNotification({
              title: "⚡ High Resource Usage",
              message: `${heavyProcess.name} is using ${heavyProcess.cpu}% CPU and ${heavyProcess.memory}% memory.\n\nThis may be slowing down your system.`,
              priority: "normal",
            });
          } else {
            const minutesSinceLastAlert = Math.floor(
              (now.getTime() - lastAlert.getTime()) / 1000 / 60
            );
            logger.debug(
              "Proactive",
              `[ResourceGuardian] Skipping alert for ${heavyProcess.name} (last alert ${minutesSinceLastAlert} minutes ago, cooldown: 30 minutes)`
            );
          }

          // Cleanup old resource alert entries (keep only last 50)
          if (this.notifiedResourceAlerts.size > 50) {
            const entriesToRemove = this.notifiedResourceAlerts.size - 50 + 10;
            const entries = Array.from(this.notifiedResourceAlerts.entries());
            for (let i = 0; i < entriesToRemove; i++) {
              this.notifiedResourceAlerts.delete(entries[i][0]);
            }
          }
        }
      }
    } catch (error) {
      logger.error("Proactive", "Error checking resources", error);
    }
  }

  // ==================== MAIN LOOP ====================

  /**
   * Run all proactive checks (called periodically).
   * Coordinates execution of all proactive monitoring checks:
   * - Timekeeper: Meeting briefings and morning briefs
   * - Executive: Deadline nudges and stale task detection
   * - Gatekeeper: Email importance analysis
   * - System Watchdog: Resource monitoring
   *
   * @returns Promise that resolves when all checks complete
   */
  async runProactiveChecks(): Promise<void> {
    const checkStartTime = Date.now();
    const timestamp = new Date().toISOString();
    logger.info(
      "Proactive",
      `[${timestamp}] Starting proactive checks cycle...`
    );

    logger.debug("Proactive", `Using provider: ${this.PROVIDER}`);

    const results = {
      timekeeper: { completed: 0, errors: 0, duration: 0 },
      executive: { completed: 0, errors: 0, duration: 0 },
      gatekeeper: { completed: 0, errors: 0, duration: 0 },
      System: { completed: 0, errors: 0, duration: 0 },
    };

    try {
      // Timekeeper checks
      const timekeeperStart = Date.now();
      logger.debug("Proactive", "[Timekeeper] Starting Timekeeper checks...");

      try {
        logger.debug(
          "Proactive",
          "[Timekeeper] Running checkAndPrepareMeetingBriefings..."
        );
        await this.checkAndPrepareMeetingBriefings();
        results.timekeeper.completed++;
        logger.debug(
          "Proactive",
          "[Timekeeper] checkAndPrepareMeetingBriefings completed"
        );
      } catch (error) {
        results.timekeeper.errors++;
        logger.error(
          "Proactive",
          "[Timekeeper] checkAndPrepareMeetingBriefings failed",
          error
        );
      }

      try {
        logger.debug("Proactive", "[Timekeeper] Running checkMorningBrief...");
        await this.checkMorningBrief();
        results.timekeeper.completed++;
        logger.debug("Proactive", "[Timekeeper] checkMorningBrief completed");
      } catch (error) {
        results.timekeeper.errors++;
        logger.error(
          "Proactive",
          "[Timekeeper] checkMorningBrief failed",
          error
        );
      }

      results.timekeeper.duration = Date.now() - timekeeperStart;
      logger.debug(
        "Proactive",
        `[Timekeeper] Completed ${results.timekeeper.completed}/4 checks in ${results.timekeeper.duration}ms (${results.timekeeper.errors} errors)`
      );

      // Executive Function checks
      const executiveStart = Date.now();
      logger.debug(
        "Proactive",
        "[Executive] Starting Executive Function checks..."
      );

      try {
        logger.debug("Proactive", "[Executive] Running checkDeadlineNudges...");
        await this.checkDeadlineNudges();
        results.executive.completed++;
        logger.debug("Proactive", "[Executive] checkDeadlineNudges completed");
      } catch (error) {
        results.executive.errors++;
        logger.error(
          "Proactive",
          "[Executive] checkDeadlineNudges failed",
          error
        );
      }

      try {
        logger.debug("Proactive", "[Executive] Running checkStaleTasks...");
        await this.checkStaleTasks();
        results.executive.completed++;
        logger.debug("Proactive", "[Executive] checkStaleTasks completed");
      } catch (error) {
        results.executive.errors++;
        logger.error("Proactive", "[Executive] checkStaleTasks failed", error);
      }

      results.executive.duration = Date.now() - executiveStart;
      logger.debug(
        "Proactive",
        `[Executive] Completed ${results.executive.completed}/4 checks in ${results.executive.duration}ms (${results.executive.errors} errors)`
      );

      // Gatekeeper checks
      const gatekeeperStart = Date.now();
      logger.debug("Proactive", "[Gatekeeper] Starting Gatekeeper checks...");

      try {
        logger.debug("Proactive", "[Gatekeeper] Running checkVIPEmails...");
        await this.checkVIPEmails();
        results.gatekeeper.completed++;
        logger.debug("Proactive", "[Gatekeeper] checkVIPEmails completed");
      } catch (error) {
        results.gatekeeper.errors++;
        logger.error("Proactive", "[Gatekeeper] checkVIPEmails failed", error);
      }

      results.gatekeeper.duration = Date.now() - gatekeeperStart;
      logger.debug(
        "Proactive",
        `[Gatekeeper] Completed ${results.gatekeeper.completed}/1 checks in ${results.gatekeeper.duration}ms (${results.gatekeeper.errors} errors)`
      );

      // System Watchdog checks
      const systemStart = Date.now();
      logger.debug("Proactive", "[System] Starting System Watchdog checks...");

      try {
        logger.debug("Proactive", "[System] Running checkResourceGuardian...");
        await this.checkResourceGuardian();
        results.System.completed++;
        logger.debug("Proactive", "[System] checkResourceGuardian completed");
      } catch (error) {
        results.System.errors++;
        logger.error(
          "Proactive",
          "[System] checkResourceGuardian failed",
          error
        );
      }

      results.System.duration = Date.now() - systemStart;
      logger.debug(
        "Proactive",
        `[System] Completed ${results.System.completed}/1 checks in ${results.System.duration}ms (${results.System.errors} errors)`
      );

      const totalDuration = Date.now() - checkStartTime;
      const totalCompleted =
        results.timekeeper.completed +
        results.executive.completed +
        results.gatekeeper.completed +
        results.System.completed;
      const totalErrors =
        results.timekeeper.errors +
        results.executive.errors +
        results.gatekeeper.errors +
        results.System.errors;

      logger.info(
        "Proactive",
        `[${new Date().toISOString()}] Completed all checks: ${totalCompleted} succeeded, ${totalErrors} failed in ${totalDuration}ms`
      );
      logger.debug(
        "Proactive",
        `Breakdown - Timekeeper: ${results.timekeeper.duration}ms, Executive: ${results.executive.duration}ms, Gatekeeper: ${results.gatekeeper.duration}ms, System: ${results.System.duration}ms`
      );
    } catch (error) {
      const duration = Date.now() - checkStartTime;
      logger.error(
        "Proactive",
        `[${new Date().toISOString()}] Fatal error in runProactiveChecks after ${duration}ms`,
        error
      );
    }
  }

  // ==================== UTILITIES ====================

  /**
   * Format notification message for better readability.
   * Cleans up excessive newlines and ensures proper spacing.
   *
   * @param message - Raw notification message
   * @returns Formatted message string
   */
  private formatNotificationMessage(message: string): string {
    // Clean up multiple newlines
    let formatted = message.replace(/\n{3,}/g, "\n\n").trim();

    // Ensure proper spacing
    formatted = formatted.replace(/\n\s*\n/g, "\n\n");

    return formatted;
  }

  /**
   * Send a notification with deduplication logic.
   * Prevents sending the same notification within 1 hour.
   *
   * @param notification - The notification to send
   */
  private sendNotification(notification: Notification) {
    // Create a unique key for this notification to prevent duplicates
    const notificationKey = `${
      notification.title
    }:${notification.message.substring(0, 50)}`;
    const now = new Date();

    // Check if we've sent this notification recently (within last hour)
    const lastSent = this.sentNotifications.get(notificationKey);
    if (lastSent && now.getTime() - lastSent.getTime() < 60 * 60 * 1000) {
      logger.debug(
        "Proactive",
        `Skipping duplicate notification: "${
          notification.title
        }" (sent ${Math.floor(
          (now.getTime() - lastSent.getTime()) / 1000 / 60
        )} minutes ago)`
      );
      return;
    }

    // Track this notification
    this.sentNotifications.set(notificationKey, now);

    // Cleanup old notification entries (keep only last 100)
    if (this.sentNotifications.size > 100) {
      const entriesToRemove = this.sentNotifications.size - 100 + 20;
      const entries = Array.from(this.sentNotifications.entries());
      // Remove oldest entries
      for (let i = 0; i < entriesToRemove; i++) {
        this.sentNotifications.delete(entries[i][0]);
      }
    }

    if (this.notifyCallback) {
      // Format message before sending
      const formattedNotification = {
        ...notification,
        message: this.formatNotificationMessage(notification.message),
      };
      this.notifyCallback(formattedNotification);
    } else {
      logger.debug(
        "Proactive",
        `Notification: ${notification.title} - ${notification.message.substring(
          0,
          50
        )}`
      );
    }
  }

  /**
   * Format a date string to a readable time format.
   *
   * @param dateString - ISO date string
   * @returns Formatted time string (HH:MM)
   */
  private formatTime(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /**
   * Cleanup processed email IDs to prevent memory leaks
   */
  private cleanupProcessedEmails() {
    const currentSize = this.processedEmailIds.size;
    if (currentSize > this.MAX_PROCESSED_EMAILS) {
      const entriesToRemove = currentSize - this.MAX_PROCESSED_EMAILS + 200;
      const idsArray = Array.from(this.processedEmailIds);
      for (let i = 0; i < entriesToRemove; i++) {
        this.processedEmailIds.delete(idsArray[i]);
      }
      logger.debug(
        "Proactive",
        `Cleaned up ${entriesToRemove} processed email IDs (was ${currentSize}, now ${this.processedEmailIds.size})`
      );
    }
  }

  /**
   * Reset daily state (called at midnight or app restart)
   */
  resetDailyState() {
    this.notifiedEvents.clear();
    this.notifiedTasks.clear();
    this.lastMorningBrief = null;
    this.staleTaskNotificationsToday.clear(); // Clear stale task notifications daily
    this.sentNotifications.clear(); // Clear notification history daily
    this.notifiedResourceAlerts.clear(); // Clear resource alerts daily
    // Note: We keep processedEmailIds across days to avoid reprocessing emails
  }
}
