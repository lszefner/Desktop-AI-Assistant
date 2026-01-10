import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import { logger } from "../utils/logger.js";

const SCOPES = [
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

/**
 * GoogleService handles integration with Google APIs (Calendar, Tasks, Gmail).
 * Manages OAuth2 authentication, token refresh, and provides unified interface
 * for calendar events, tasks, and email operations.
 */
export class GoogleService {
  private oauth2Client: OAuth2Client | null = null;
  private tasksService: any = null;
  private calendarService: any = null;
  private gmailService: any = null;

  /**
   * Get path to Google OAuth credentials file.
   *
   * @private
   */
  private get credentialsPath() {
    return "./credentials.json";
  }

  /**
   * Get path to stored OAuth token file.
   *
   * @private
   */
  private get tokenPath() {
    return "./token.json";
  }

  /**
   * Initialize Google services with OAuth2 authentication.
   * Loads credentials, refreshes token if expired, and initializes API clients.
   *
   * @returns Promise resolving to true if initialization successful, false otherwise
   */
  async initialize(): Promise<boolean> {
    try {
      // Check for credentials file
      if (!fs.existsSync(this.credentialsPath)) {
        logger.info(
          "Google",
          "No Google credentials file found. Google services disabled."
        );
        return false;
      }

      const credentials = JSON.parse(
        fs.readFileSync(this.credentialsPath, "utf-8")
      );
      const { client_id, client_secret, redirect_uris } =
        credentials.installed || credentials.web;

      this.oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );

      // Try to load existing token
      if (fs.existsSync(this.tokenPath)) {
        const token = JSON.parse(fs.readFileSync(this.tokenPath, "utf-8"));
        this.oauth2Client.setCredentials(token);

        // Refresh if expired
        if (token.expiry_date && Date.now() >= token.expiry_date) {
          const { credentials: newCreds } =
            await this.oauth2Client.refreshAccessToken();
          fs.writeFileSync(this.tokenPath, JSON.stringify(newCreds));
          this.oauth2Client.setCredentials(newCreds);
        }
      } else {
        logger.info(
          "Google",
          "No token found. Run OAuth flow to authenticate."
        );
        return false;
      }

      // Initialize services
      this.tasksService = google.tasks({
        version: "v1",
        auth: this.oauth2Client,
      });
      this.calendarService = google.calendar({
        version: "v3",
        auth: this.oauth2Client,
      });
      this.gmailService = google.gmail({
        version: "v1",
        auth: this.oauth2Client,
      });

      return true;
    } catch (error) {
      logger.error("Google", "Google service init error:", error);
      return false;
    }
  }

  /**
   * Generate OAuth2 authorization URL for user authentication.
   * User should open this URL in browser to grant permissions.
   *
   * @returns Promise resolving to authorization URL string
   * @throws Error if credentials file not found
   */
  async getAuthUrl(): Promise<string> {
    if (!this.oauth2Client) {
      // Initialize OAuth client if not already done
      if (!fs.existsSync(this.credentialsPath)) {
        throw new Error("No credentials.json file found");
      }
      const credentials = JSON.parse(
        fs.readFileSync(this.credentialsPath, "utf-8")
      );
      const { client_id, client_secret, redirect_uris } =
        credentials.installed || credentials.web;
      this.oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );
    }

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent", // Force consent to get refresh token
    });

    return authUrl;
  }

  /**
   * Handle OAuth2 callback with authorization code.
   * Exchanges code for access/refresh tokens and saves them.
   *
   * @param code - OAuth authorization code from callback URL
   * @returns Promise resolving to true if authentication successful
   * @throws Error if OAuth flow fails
   */
  async handleOAuthCallback(code: string): Promise<boolean> {
    if (!this.oauth2Client) {
      throw new Error("OAuth client not initialized");
    }

    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);

      // Save token to file
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens));
      logger.info("Google", "Token saved successfully");

      // Initialize services
      this.tasksService = google.tasks({
        version: "v1",
        auth: this.oauth2Client,
      });
      this.calendarService = google.calendar({
        version: "v3",
        auth: this.oauth2Client,
      });
      this.gmailService = google.gmail({
        version: "v1",
        auth: this.oauth2Client,
      });

      return true;
    } catch (error) {
      logger.error("Google", "OAuth callback error:", error);
      throw error;
    }
  }

  /**
   * Manage Google Tasks operations.
   * Supports: list, add, complete, search, pending, completed, update, delete, getDetails.
   *
   * @param action - Task operation to perform
   * @param params - Operation-specific parameters (title, taskId, keyword, etc.)
   * @returns Promise resolving to operation result string
   */
  async manageTasks(action: string, params?: any): Promise<string> {
    if (!this.tasksService) return "Google Tasks not available.";

    try {
      const taskLists = await this.tasksService.tasklists.list();
      const defaultList = taskLists.data.items?.[0]?.id;

      if (!defaultList) return "No task lists found.";

      switch (action) {
        case "list": {
          const response = await this.tasksService.tasks.list({
            tasklist: defaultList,
          });
          const tasks = response.data.items || [];
          if (tasks.length === 0) return "No tasks found.";

          return (
            tasks
              .slice(0, 10)
              .map((t: any) => {
                const status = t.status === "completed" ? "✅" : "📌";
                return `${status} ${t.title}`;
              })
              .join("\n") + "\n"
          );
        }

        case "add": {
          if (!params?.title) return "Please provide a task title.";
          await this.tasksService.tasks.insert({
            tasklist: defaultList,
            requestBody: { title: params.title, notes: params.notes || "" },
          });
          return `Task added: "${params.title}"`;
        }

        case "complete": {
          if (!params?.title) return "Please specify which task to complete.";
          const response = await this.tasksService.tasks.list({
            tasklist: defaultList,
          });
          const task = response.data.items?.find((t: any) =>
            t.title?.toLowerCase().includes(params.title.toLowerCase())
          );
          if (!task) return `Task "${params.title}" not found.`;
          await this.tasksService.tasks.update({
            tasklist: defaultList,
            task: task.id,
            requestBody: { ...task, status: "completed" },
          });
          return `Task completed: "${task.title}"`;
        }

        case "search": {
          const keyword = params?.keyword?.toLowerCase() || "";
          const response = await this.tasksService.tasks.list({
            tasklist: defaultList,
            showCompleted: params?.includeCompleted !== false,
          });
          const tasks = response.data.items || [];
          const filtered = keyword
            ? tasks.filter(
                (t: any) =>
                  t.title?.toLowerCase().includes(keyword) ||
                  t.notes?.toLowerCase().includes(keyword)
              )
            : tasks;

          if (filtered.length === 0) return "No matching tasks found.";

          return filtered
            .slice(0, params?.maxResults || 10)
            .map((t: any) => {
              const status = t.status === "completed" ? "✅" : "📌";
              const due = t.due
                ? ` (Due: ${new Date(t.due).toLocaleDateString()})`
                : "";
              const notes = t.notes ? ` - ${t.notes.slice(0, 50)}` : "";
              return `${status} ${t.title}${due}${notes}`;
            })
            .join("\n");
        }

        case "pending": {
          const response = await this.tasksService.tasks.list({
            tasklist: defaultList,
            showCompleted: false,
          });
          const tasks = response.data.items || [];
          if (tasks.length === 0) return "No pending tasks.";

          return tasks
            .slice(0, params?.maxResults || 20)
            .map((t: any) => {
              const due = t.due
                ? ` (Due: ${new Date(t.due).toLocaleDateString()})`
                : "";
              return `📌 ${t.title}${due}`;
            })
            .join("\n");
        }

        case "completed": {
          const response = await this.tasksService.tasks.list({
            tasklist: defaultList,
            showCompleted: true,
            completedMin: params?.since
              ? new Date(params.since).toISOString()
              : undefined,
          });
          const tasks = (response.data.items || []).filter(
            (t: any) => t.status === "completed"
          );
          if (tasks.length === 0) return "No completed tasks found.";

          return tasks
            .slice(0, params?.maxResults || 10)
            .map((t: any) => {
              const completed = t.completed
                ? ` (Completed: ${new Date(t.completed).toLocaleDateString()})`
                : "";
              return `✅ ${t.title}${completed}`;
            })
            .join("\n");
        }

        case "update": {
          if (!params?.taskId && !params?.title) {
            return "Please provide task ID or title to find task.";
          }

          let task: any;
          if (params.taskId) {
            const taskResponse = await this.tasksService.tasks.get({
              tasklist: defaultList,
              task: params.taskId,
            });
            task = taskResponse.data;
          } else {
            const listResponse = await this.tasksService.tasks.list({
              tasklist: defaultList,
            });
            task = listResponse.data.items?.find((t: any) =>
              t.title?.toLowerCase().includes(params.title.toLowerCase())
            );
            if (!task) return `Task "${params.title}" not found.`;
          }

          const updates: any = {};
          if (params.newTitle) updates.title = params.newTitle;
          if (params.notes !== undefined) updates.notes = params.notes;
          if (params.dueDate)
            updates.due = new Date(params.dueDate).toISOString();
          if (params.status) updates.status = params.status;

          await this.tasksService.tasks.update({
            tasklist: defaultList,
            task: task.id,
            requestBody: { ...task, ...updates },
          });

          return `Task updated: "${updates.title || task.title}"`;
        }

        case "delete": {
          if (!params?.taskId && !params?.title) {
            return "Please provide task ID or title.";
          }

          let taskId: string;
          if (params.taskId) {
            taskId = params.taskId;
          } else {
            const listResponse = await this.tasksService.tasks.list({
              tasklist: defaultList,
            });
            const task = listResponse.data.items?.find((t: any) =>
              t.title?.toLowerCase().includes(params.title.toLowerCase())
            );
            if (!task) return `Task "${params.title}" not found.`;
            taskId = task.id;
          }

          await this.tasksService.tasks.delete({
            tasklist: defaultList,
            task: taskId,
          });

          return "Task deleted.";
        }

        case "getDetails": {
          if (!params?.taskId && !params?.title) {
            return "Please provide task ID or title.";
          }

          let task: any;
          if (params.taskId) {
            const taskResponse = await this.tasksService.tasks.get({
              tasklist: defaultList,
              task: params.taskId,
            });
            task = taskResponse.data;
          } else {
            const listResponse = await this.tasksService.tasks.list({
              tasklist: defaultList,
            });
            task = listResponse.data.items?.find((t: any) =>
              t.title?.toLowerCase().includes(params.title.toLowerCase())
            );
            if (!task) return `Task "${params.title}" not found.`;
          }

          const details = [
            `Title: ${task.title}`,
            task.notes ? `Notes: ${task.notes}` : "",
            task.due
              ? `Due: ${new Date(task.due).toLocaleString()}`
              : "No due date",
            `Status: ${task.status === "completed" ? "Completed" : "Pending"}`,
            task.completed
              ? `Completed: ${new Date(task.completed).toLocaleString()}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          return details;
        }

        default:
          return "Invalid action. Use: list, add, complete, search, pending, completed, update, delete, getDetails";
      }
    } catch (error) {
      logger.error("Google", "Tasks error:", error);
      return `Task operation failed: ${error}`;
    }
  }

  /**
   * Manage Google Calendar operations.
   * Supports: list (today/tomorrow/week/month), search, getDetails.
   *
   * @param action - Calendar operation to perform
   * @param params - Operation-specific parameters (date, query, eventId, etc.)
   * @returns Promise resolving to operation result string
   */
  async manageCalendar(action: string, params?: any): Promise<string> {
    if (!this.calendarService) return "Google Calendar not available.";

    try {
      switch (action) {
        case "list": {
          const now = new Date();
          let targetDate = now;

          if (params?.date === "tomorrow") {
            targetDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          }

          // Use provided timeMin/timeMax, or default to today
          let timeMin: string;
          let timeMax: string;
          if (params?.timeMin && params?.timeMax) {
            timeMin = params.timeMin;
            timeMax = params.timeMax;
          } else {
            const dayStart = new Date(targetDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(targetDate);
            dayEnd.setHours(23, 59, 59, 999);
            timeMin = dayStart.toISOString();
            timeMax = dayEnd.toISOString();
          }

          const response = await this.calendarService.events.list({
            calendarId: "primary",
            timeMin,
            timeMax,
            maxResults: params?.maxResults || 10,
            singleEvents: true,
            orderBy: "startTime",
          });

          const events = response.data.items || [];
          if (events.length === 0) {
            const dateStr = params?.date === "tomorrow" ? "tomorrow" : "today";
            return `No events scheduled for ${dateStr}.`;
          }

          return events
            .map((e: any) => {
              const start = e.start?.dateTime || e.start?.date;
              let timeStr = "All day";
              if (e.start?.dateTime) {
                const d = new Date(e.start.dateTime);
                timeStr = d.toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              }
              return `🕐 ${timeStr} - ${e.summary || "Untitled"}`;
            })
            .join("\n");
        }

        case "add": {
          if (!params?.title || !params?.dateTime) {
            return "Provide event title and date/time.";
          }
          const startTime = new Date(params.dateTime);
          const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour default

          await this.calendarService.events.insert({
            calendarId: "primary",
            requestBody: {
              summary: params.title,
              start: { dateTime: startTime.toISOString() },
              end: { dateTime: endTime.toISOString() },
            },
          });
          return `Event created: "${params.title}"`;
        }

        case "create": {
          // Similar to "add" but supports custom start/end times
          if (!params?.title && !params?.summary) {
            return "Provide event title (or summary).";
          }
          const title = params.title || params.summary;

          // Support both dateTime (single time) and start/end format
          let startTime: Date;
          let endTime: Date;

          if (params.dateTime) {
            startTime = new Date(params.dateTime);
            endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour default
          } else if (params.start?.dateTime && params.end?.dateTime) {
            startTime = new Date(params.start.dateTime);
            endTime = new Date(params.end.dateTime);
          } else if (params.start?.dateTime) {
            startTime = new Date(params.start.dateTime);
            endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // 1 hour default
          } else {
            return "Provide start time (dateTime or start.dateTime).";
          }

          await this.calendarService.events.insert({
            calendarId: "primary",
            requestBody: {
              summary: title,
              start: { dateTime: startTime.toISOString() },
              end: { dateTime: endTime.toISOString() },
            },
          });
          return `Event created: "${title}"`;
        }

        case "search": {
          const keyword = params?.keyword || "";
          const now = new Date();
          const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year ahead

          const response = await this.calendarService.events.list({
            calendarId: "primary",
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            maxResults: params?.maxResults || 20,
            singleEvents: true,
            orderBy: "startTime",
            q: keyword,
          });

          const events = response.data.items || [];
          if (events.length === 0) return "No matching events found.";

          return events
            .map((e: any) => {
              const start = e.start?.dateTime || e.start?.date;
              let timeStr = "All day";
              if (e.start?.dateTime) {
                const d = new Date(e.start.dateTime);
                timeStr = d.toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
              }
              return `🕐 ${timeStr} - ${e.summary || "Untitled"}`;
            })
            .join("\n");
        }

        case "week": {
          const now = new Date();
          const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

          const response = await this.calendarService.events.list({
            calendarId: "primary",
            timeMin: now.toISOString(),
            timeMax: weekEnd.toISOString(),
            maxResults: 50,
            singleEvents: true,
            orderBy: "startTime",
          });

          const events = response.data.items || [];
          if (events.length === 0) return "No events this week.";

          // Group by day
          const byDay: { [key: string]: any[] } = {};
          events.forEach((e: any) => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            const dayKey = start.toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            });
            if (!byDay[dayKey]) byDay[dayKey] = [];
            byDay[dayKey].push(e);
          });

          return Object.entries(byDay)
            .map(([day, dayEvents]) => {
              const eventsList = dayEvents
                .map((e: any) => {
                  const start = new Date(e.start?.dateTime || e.start?.date);
                  const timeStr = e.start?.dateTime
                    ? start.toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "All day";
                  return `  🕐 ${timeStr} - ${e.summary || "Untitled"}`;
                })
                .join("\n");
              return `${day}:\n${eventsList}`;
            })
            .join("\n\n");
        }

        case "month": {
          const now = new Date();
          const monthEnd = new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            0,
            23,
            59,
            59
          );

          const response = await this.calendarService.events.list({
            calendarId: "primary",
            timeMin: now.toISOString(),
            timeMax: monthEnd.toISOString(),
            maxResults: 100,
            singleEvents: true,
            orderBy: "startTime",
          });

          const events = response.data.items || [];
          if (events.length === 0) return "No events this month.";

          return events
            .slice(0, 30)
            .map((e: any) => {
              const start = new Date(e.start?.dateTime || e.start?.date);
              const dateStr = start.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
              const timeStr = e.start?.dateTime
                ? start.toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "All day";
              return `📅 ${dateStr} ${timeStr} - ${e.summary || "Untitled"}`;
            })
            .join("\n");
        }

        case "getDetails": {
          if (!params?.eventId) return "Please provide event ID.";

          const event = await this.calendarService.events.get({
            calendarId: "primary",
            eventId: params.eventId,
          });

          const details = [
            `Title: ${event.data.summary || "Untitled"}`,
            event.data.description
              ? `Description: ${event.data.description}`
              : "",
            event.data.location ? `Location: ${event.data.location}` : "",
            event.data.start?.dateTime
              ? `Start: ${new Date(event.data.start.dateTime).toLocaleString()}`
              : event.data.start?.date
              ? `Start: ${event.data.start.date} (All day)`
              : "",
            event.data.end?.dateTime
              ? `End: ${new Date(event.data.end.dateTime).toLocaleString()}`
              : event.data.end?.date
              ? `End: ${event.data.end.date}`
              : "",
            event.data.attendees?.length
              ? `Attendees: ${event.data.attendees
                  .map((a: any) => a.email)
                  .join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          return details;
        }

        case "update": {
          if (!params?.eventId) return "Please provide event ID.";

          const event = await this.calendarService.events.get({
            calendarId: "primary",
            eventId: params.eventId,
          });

          const updates: any = {};
          if (params.title) updates.summary = params.title;
          if (params.description !== undefined)
            updates.description = params.description;
          if (params.location) updates.location = params.location;
          if (params.startTime)
            updates.start = {
              dateTime: new Date(params.startTime).toISOString(),
            };
          if (params.endTime)
            updates.end = {
              dateTime: new Date(params.endTime).toISOString(),
            };

          await this.calendarService.events.update({
            calendarId: "primary",
            eventId: params.eventId,
            requestBody: { ...event.data, ...updates },
          });

          return `Event updated: "${updates.summary || event.data.summary}"`;
        }

        case "delete": {
          if (!params?.eventId) return "Please provide event ID.";

          await this.calendarService.events.delete({
            calendarId: "primary",
            eventId: params.eventId,
          });

          return "Event deleted.";
        }

        case "freeBusy": {
          const start = params?.startTime
            ? new Date(params.startTime)
            : new Date();
          const end = params?.endTime
            ? new Date(params.endTime)
            : new Date(start.getTime() + 24 * 60 * 60 * 1000);

          const response = await this.calendarService.freebusy.query({
            requestBody: {
              timeMin: start.toISOString(),
              timeMax: end.toISOString(),
              items: [{ id: "primary" }],
            },
          });

          const busy = response.data.calendars?.primary?.busy || [];
          if (busy.length === 0) return "You're free during this time.";

          return `Busy periods:\n${busy
            .map(
              (b: any) =>
                `${new Date(b.start).toLocaleString()} - ${new Date(
                  b.end
                ).toLocaleString()}`
            )
            .join("\n")}`;
        }

        default:
          return "Invalid action. Use: list, add, search, week, month, getDetails, update, delete, freeBusy";
      }
    } catch (error) {
      logger.error("Google", "Calendar error", error);
      return `Calendar operation failed: ${error}`;
    }
  }

  /**
   * Manage Gmail operations.
   * Supports: list, search, read, send, reply, getDetails.
   *
   * @param action - Email operation to perform
   * @param params - Operation-specific parameters (query, emailId, to, subject, body, etc.)
   * @returns Promise resolving to operation result string
   */
  async manageEmail(action: string, params?: any): Promise<string> {
    if (!this.gmailService) return "Gmail not available.";

    try {
      switch (action) {
        case "list": {
          // Build query with spam avoidance
          let query = params?.inbox || "in:inbox";
          if (params?.avoidSpam !== false) {
            query += " -in:spam -in:promotions -in:social -in:notifications"; // Exclude spam by default
          }
          if (params?.important) {
            query += " is:important";
          }
          if (params?.unread) {
            query += " is:unread";
          }

          const response = await this.gmailService.users.messages.list({
            userId: "me",
            maxResults: params?.maxResults || 10,
            q: query,
          });

          const messages = response.data.messages || [];
          if (messages.length === 0) return "No emails found.";

          const emails = await Promise.all(
            messages.map(async (m: any) => {
              const detail = await this.gmailService.users.messages.get({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
              });
              const headers = detail.data.payload?.headers || [];
              const subject =
                headers.find((h: any) => h.name === "Subject")?.value ||
                "No Subject";
              let from =
                headers.find((h: any) => h.name === "From")?.value || "Unknown";
              if (from.includes("<")) from = from.split("<")[0].trim();
              const date = headers.find((h: any) => h.name === "Date")?.value;
              const dateStr = date
                ? new Date(date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "";
              const labels = detail.data.labelIds || [];
              const isUnread = labels.includes("UNREAD");
              const isStarred = labels.includes("STARRED");
              const status = isUnread ? "🔵" : isStarred ? "⭐" : "📧";
              return `${status} From: ${from}${
                dateStr ? ` (${dateStr})` : ""
              }\n   Subject: ${subject}`;
            })
          );

          return emails.join("\n\n");
        }

        case "read": {
          let query = params?.query || "in:inbox";
          if (params?.avoidSpam !== false) query += " -in:spam";

          const response = await this.gmailService.users.messages.list({
            userId: "me",
            maxResults: 1,
            q: query,
          });

          const messages = response.data.messages || [];
          if (messages.length === 0) return "No email found.";

          const detail = await this.gmailService.users.messages.get({
            userId: "me",
            id: messages[0].id,
            format: "full",
          });

          const headers = detail.data.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "No Subject";
          const from =
            headers.find((h: any) => h.name === "From")?.value || "Unknown";
          const date = headers.find((h: any) => h.name === "Date")?.value;

          // Extract body (simplified - real implementation would handle multipart)
          let body = detail.data.snippet || "";

          return `From: ${from}\nDate: ${
            date ? new Date(date).toLocaleString() : "Unknown"
          }\nSubject: ${subject}\n\n${body}`;
        }

        case "search": {
          // Advanced search with Gmail query syntax
          let query = params?.query || "in:inbox";
          if (params?.avoidSpam !== false) query += " -in:spam";
          if (params?.inbox) {
            // Support specific inbox: primary, social, promotions, updates, forums
            query = `in:${params.inbox}`;
            if (params.avoidSpam !== false) query += " -in:spam";
          }

          const maxResults = params?.maxResults || 10;
          const response = await this.gmailService.users.messages.list({
            userId: "me",
            maxResults,
            q: query,
          });

          const messages = response.data.messages || [];
          if (messages.length === 0) return "No emails found.";

          const emails = await Promise.all(
            messages.map(async (m: any) => {
              const detail = await this.gmailService.users.messages.get({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
              });
              const headers = detail.data.payload?.headers || [];
              const subject =
                headers.find((h: any) => h.name === "Subject")?.value ||
                "No Subject";
              let from =
                headers.find((h: any) => h.name === "From")?.value || "Unknown";
              if (from.includes("<")) from = from.split("<")[0].trim();
              const date = headers.find((h: any) => h.name === "Date")?.value;
              const dateStr = date
                ? new Date(date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "";
              return `📧 ${from}${dateStr ? ` (${dateStr})` : ""} - ${subject}`;
            })
          );

          return `Found ${messages.length} email(s):\n${emails.join("\n")}`;
        }

        case "unread": {
          let query = "is:unread in:inbox";
          if (params?.avoidSpam !== false) query += " -in:spam";
          if (params?.inbox) query = `is:unread in:${params.inbox} -in:spam`;

          const maxResults = params?.maxResults || 10;
          const response = await this.gmailService.users.messages.list({
            userId: "me",
            maxResults,
            q: query,
          });

          const messages = response.data.messages || [];
          if (messages.length === 0) return "No unread emails.";

          const emails = await Promise.all(
            messages.map(async (m: any) => {
              const detail = await this.gmailService.users.messages.get({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
              });
              const headers = detail.data.payload?.headers || [];
              const subject =
                headers.find((h: any) => h.name === "Subject")?.value ||
                "No Subject";
              let from =
                headers.find((h: any) => h.name === "From")?.value || "Unknown";
              if (from.includes("<")) from = from.split("<")[0].trim();
              return `🔵 ${from}: ${subject}`;
            })
          );

          return `🔔 ${messages.length} Unread Email(s):\n${emails.join("\n")}`;
        }

        case "from": {
          if (!params?.sender) return "Please provide sender email or name.";
          let query = `from:${params.sender} in:inbox`;
          if (params?.avoidSpam !== false) query += " -in:spam";

          const response = await this.gmailService.users.messages.list({
            userId: "me",
            maxResults: params?.maxResults || 10,
            q: query,
          });

          const messages = response.data.messages || [];
          if (messages.length === 0)
            return `No emails from "${params.sender}".`;

          const emails = await Promise.all(
            messages.map(async (m: any) => {
              const detail = await this.gmailService.users.messages.get({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "Date"],
              });
              const headers = detail.data.payload?.headers || [];
              const subject =
                headers.find((h: any) => h.name === "Subject")?.value ||
                "No Subject";
              const date = headers.find((h: any) => h.name === "Date")?.value;
              const dateStr = date ? new Date(date).toLocaleDateString() : "";
              return `📧 ${dateStr} - ${subject}`;
            })
          );

          return `Emails from ${params.sender}:\n${emails.join("\n")}`;
        }

        case "markRead": {
          if (!params?.messageId) {
            // Try to find by subject/query
            let query = params?.query || "in:inbox";
            if (params?.avoidSpam !== false) query += " -in:spam";
            const searchResponse = await this.gmailService.users.messages.list({
              userId: "me",
              maxResults: 1,
              q: query,
            });
            if (!searchResponse.data.messages?.[0]) return "Email not found.";
            params.messageId = searchResponse.data.messages[0].id;
          }

          await this.gmailService.users.messages.modify({
            userId: "me",
            id: params.messageId,
            requestBody: { removeLabelIds: ["UNREAD"] },
          });
          return "Email marked as read.";
        }

        case "markUnread": {
          if (!params?.messageId) {
            let query = params?.query || "in:inbox";
            if (params?.avoidSpam !== false) query += " -in:spam";
            const searchResponse = await this.gmailService.users.messages.list({
              userId: "me",
              maxResults: 1,
              q: query,
            });
            if (!searchResponse.data.messages?.[0]) return "Email not found.";
            params.messageId = searchResponse.data.messages[0].id;
          }

          await this.gmailService.users.messages.modify({
            userId: "me",
            id: params.messageId,
            requestBody: { addLabelIds: ["UNREAD"] },
          });
          return "Email marked as unread.";
        }

        case "archive": {
          if (!params?.messageId) {
            let query = params?.query || "in:inbox";
            const searchResponse = await this.gmailService.users.messages.list({
              userId: "me",
              maxResults: 1,
              q: query,
            });
            if (!searchResponse.data.messages?.[0]) return "Email not found.";
            params.messageId = searchResponse.data.messages[0].id;
          }

          await this.gmailService.users.messages.modify({
            userId: "me",
            id: params.messageId,
            requestBody: { removeLabelIds: ["INBOX"] },
          });
          return "Email archived.";
        }

        case "star": {
          if (!params?.messageId) {
            let query = params?.query || "in:inbox";
            if (params?.avoidSpam !== false) query += " -in:spam";
            const searchResponse = await this.gmailService.users.messages.list({
              userId: "me",
              maxResults: 1,
              q: query,
            });
            if (!searchResponse.data.messages?.[0]) return "Email not found.";
            params.messageId = searchResponse.data.messages[0].id;
          }

          const addLabelIds = params?.star !== false ? ["STARRED"] : [];
          const removeLabelIds = params?.star === false ? ["STARRED"] : [];

          await this.gmailService.users.messages.modify({
            userId: "me",
            id: params.messageId,
            requestBody: { addLabelIds, removeLabelIds },
          });
          return params?.star !== false ? "Email starred." : "Email unstarred.";
        }

        case "getBody": {
          if (!params?.messageId) {
            let query = params?.query || "in:inbox";
            if (params?.avoidSpam !== false) query += " -in:spam";
            const searchResponse = await this.gmailService.users.messages.list({
              userId: "me",
              maxResults: 1,
              q: query,
            });
            if (!searchResponse.data.messages?.[0]) return "Email not found.";
            params.messageId = searchResponse.data.messages[0].id;
          }

          const detail = await this.gmailService.users.messages.get({
            userId: "me",
            id: params.messageId,
            format: "full",
          });

          const headers = detail.data.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "No Subject";
          const from =
            headers.find((h: any) => h.name === "From")?.value || "Unknown";
          const date = headers.find((h: any) => h.name === "Date")?.value;

          // Extract body from multipart message
          const extractBody = (payload: any): string => {
            if (payload.body?.data) {
              return Buffer.from(payload.body.data, "base64")
                .toString("utf-8")
                .slice(0, 2000);
            }
            if (payload.parts) {
              for (const part of payload.parts) {
                if (part.mimeType === "text/plain" && part.body?.data) {
                  return Buffer.from(part.body.data, "base64")
                    .toString("utf-8")
                    .slice(0, 2000);
                }
                if (part.parts) {
                  const result = extractBody(part);
                  if (result) return result;
                }
              }
            }
            return detail.data.snippet || "";
          };

          const body = extractBody(detail.data.payload);

          return `From: ${from}\nDate: ${
            date ? new Date(date).toLocaleString() : "Unknown"
          }\nSubject: ${subject}\n\n${body}`;
        }

        case "draft": {
          if (!params?.to || !params?.subject) {
            return "Please provide recipient (to) and subject.";
          }

          const message = [
            `To: ${params.to}`,
            `Subject: ${params.subject}`,
            params.cc ? `Cc: ${params.cc}` : "",
            params.bcc ? `Bcc: ${params.bcc}` : "",
            "",
            params.body || "",
          ]
            .filter(Boolean)
            .join("\r\n");

          const encoded = Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          await this.gmailService.users.drafts.create({
            userId: "me",
            requestBody: {
              message: { raw: encoded },
            },
          });

          return `Draft created: "${params.subject}"`;
        }

        default:
          return "Invalid action. Use: list, read, search, unread, from, markRead, markUnread, archive, star, getBody, draft";
      }
    } catch (error) {
      logger.error("Google", "Email error", error);
      return `Email operation failed: ${error}`;
    }
  }

  /**
   * Check for important unread emails.
   * Uses AI to analyze email importance and returns summary.
   * Used by proactive monitoring features.
   *
   * @returns Promise resolving to summary of important emails
   */
  async checkImportantEmails(): Promise<string> {
    if (!this.gmailService) return "Gmail not available.";

    try {
      // Avoid spam and focus on important emails
      const response = await this.gmailService.users.messages.list({
        userId: "me",
        maxResults: 5,
        q: "is:unread newer_than:1d -in:spam -in:promotions -in:social -in:notifications in:inbox",
      });

      const messages = response.data.messages || [];
      if (messages.length === 0) return "📧 No new important emails.";

      const emails = await Promise.all(
        messages.map(async (m: any) => {
          const detail = await this.gmailService.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From"],
          });
          const headers = detail.data.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "No Subject";
          let from =
            headers.find((h: any) => h.name === "From")?.value || "Unknown";
          if (from.includes("<")) from = from.split("<")[0].trim();
          return `📧 ${from}: ${subject.slice(0, 50)}`;
        })
      );

      return `🔔 ${messages.length} Unread Email(s):\n${emails.join("\n")}`;
    } catch (error) {
      return `Email check failed: ${error}`;
    }
  }

  /**
   * Search emails and return as JSON array for proactive service
   * Returns Email[] objects with id, subject, from, snippet, threadId
   */
  /**
   * Search emails and return results as JSON.
   * Used by proactive features for structured email analysis.
   *
   * @param params - Search parameters (query, maxResults, includeUnread, etc.)
   * @returns Promise resolving to JSON string with email data
   */
  async searchEmailsAsJSON(params: {
    query: string;
    maxResults?: number;
    avoidSpam?: boolean;
  }): Promise<string> {
    if (!this.gmailService) return "[]";

    try {
      let query = params.query || "in:inbox";
      if (params.avoidSpam !== false) {
        query += " -in:spam";
      }

      const response = await this.gmailService.users.messages.list({
        userId: "me",
        maxResults: params.maxResults || 10,
        q: query,
      });

      const messages = response.data.messages || [];
      if (messages.length === 0) return "[]";

      const emails = await Promise.all(
        messages.map(async (m: any) => {
          const detail = await this.gmailService.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From"],
          });
          const headers = detail.data.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "No Subject";
          let from =
            headers.find((h: any) => h.name === "From")?.value || "Unknown";
          const fromEmail = from.includes("<")
            ? from.match(/<([^>]+)>/)?.[1] || from
            : from;

          return {
            id: m.id,
            subject,
            from: fromEmail.trim(),
            snippet: detail.data.snippet || "",
            threadId: m.threadId,
            body: undefined,
          };
        })
      );

      return JSON.stringify(emails);
    } catch (error) {
      logger.error("Google", "Error searching emails as JSON", error);
      return "[]";
    }
  }

  /**
   * Get tasks as JSON array for proactive service
   * Returns Task[] objects with id, title, due, status, updated
   */
  /**
   * Get tasks and return results as JSON.
   * Used by proactive features for structured task analysis.
   *
   * @param params - Optional filter parameters (includeCompleted, maxResults, etc.)
   * @returns Promise resolving to JSON string with task data
   */
  async getTasksAsJSON(params?: {
    status?: "all" | "pending" | "completed";
    maxResults?: number;
  }): Promise<string> {
    if (!this.tasksService) return "[]";

    try {
      const taskLists = await this.tasksService.tasklists.list();
      const defaultList = taskLists.data.items?.[0]?.id;
      if (!defaultList) return "[]";

      const showCompleted =
        params?.status === "all" || params?.status === "completed";
      const response = await this.tasksService.tasks.list({
        tasklist: defaultList,
        showCompleted,
      });

      let tasks = response.data.items || [];

      // Filter by status if needed
      if (params?.status === "pending") {
        tasks = tasks.filter((t: any) => t.status !== "completed");
      } else if (params?.status === "completed") {
        tasks = tasks.filter((t: any) => t.status === "completed");
      }

      const maxResults = params?.maxResults || 100;
      tasks = tasks.slice(0, maxResults);

      const taskArray = tasks.map((t: any) => ({
        id: t.id,
        title: t.title || "Untitled",
        due: t.due || undefined,
        status: t.status || "needsAction",
        updated: t.updated || new Date().toISOString(),
      }));

      return JSON.stringify(taskArray);
    } catch (error) {
      logger.error("Google", "Error fetching tasks as JSON", error);
      return "[]";
    }
  }

  /**
   * Get calendar events as JSON array for proactive service
   * Returns CalendarEvent[] objects with id, summary, start, end, location, attendees, hangoutLink
   */
  /**
   * Get calendar events and return results as JSON.
   * Used by proactive features for structured calendar analysis.
   *
   * @param params - Optional filter parameters (timeMin, timeMax, maxResults, etc.)
   * @returns Promise resolving to JSON string with event data
   */
  async getCalendarEventsAsJSON(params?: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  }): Promise<string> {
    if (!this.calendarService) return "[]";

    try {
      const response = await this.calendarService.events.list({
        calendarId: "primary",
        timeMin: params?.timeMin || new Date().toISOString(),
        timeMax: params?.timeMax,
        maxResults: params?.maxResults || 50,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];
      if (events.length === 0) return "[]";

      const eventArray = events.map((e: any) => ({
        id: e.id,
        summary: e.summary || "Untitled",
        start: e.start || {},
        end: e.end || {},
        location: e.location || undefined,
        attendees: e.attendees || undefined,
        hangoutLink:
          e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri || undefined,
      }));

      return JSON.stringify(eventArray);
    } catch (error) {
      logger.error("Google", "Error fetching calendar events as JSON", error);
      return "[]";
    }
  }

  /**
   * Get unread emails as JSON array for proactive service
   * Returns Email[] objects with id, subject, from, snippet, threadId
   */
  /**
   * Get unread emails and return results as JSON.
   * Used by proactive features for structured email analysis.
   *
   * @param params - Optional filter parameters (maxResults, query, etc.)
   * @returns Promise resolving to JSON string with unread email data
   */
  async getUnreadEmailsAsJSON(params?: {
    maxResults?: number;
    avoidSpam?: boolean;
    important?: boolean;
  }): Promise<string> {
    if (!this.gmailService) return "[]";

    try {
      let query = "is:unread in:inbox";
      if (params?.avoidSpam !== false) {
        query += " -in:spam -in:promotions -in:social -in:notifications";
      }
      if (params?.important) {
        query += " is:important";
      }
      // Add recency to fetch only emails from the last 10 days (customize if needed)
      const sinceDays = 2;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - sinceDays);
      // Use YYYY/MM/DD format (Gmail accepts this for "after")
      const y = sinceDate.getFullYear();
      const m = String(sinceDate.getMonth() + 1).padStart(2, "0");
      const d = String(sinceDate.getDate()).padStart(2, "0");
      query += ` after:${y}/${m}/${d}`;

      const maxResults = params?.maxResults || 10;
      const response = await this.gmailService.users.messages.list({
        userId: "me",
        maxResults,
        q: query,
      });

      const messages = response.data.messages || [];
      if (messages.length === 0) return "[]";

      const emails = await Promise.all(
        messages.map(async (m: any) => {
          const detail = await this.gmailService.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          const subject =
            headers.find((h: any) => h.name === "Subject")?.value ||
            "No Subject";
          let from =
            headers.find((h: any) => h.name === "From")?.value || "Unknown";
          // Extract email address from "From" header (handles "Name <email@domain.com>" or just "email@domain.com")
          const fromEmail = from.includes("<")
            ? from.match(/<([^>]+)>/)?.[1] || from
            : from;

          return {
            id: m.id,
            subject,
            from: fromEmail.trim(),
            snippet: detail.data.snippet || "",
            threadId: m.threadId,
            body: undefined, // Not fetching full body for performance
          };
        })
      );

      return JSON.stringify(emails);
    } catch (error) {
      logger.error("Google", "Error fetching unread emails as JSON", error);
      return "[]";
    }
  }

  /**
   * Check for upcoming calendar events.
   * Returns formatted summary of events in the next 24 hours.
   * Used by proactive monitoring features.
   *
   * @returns Promise resolving to summary of upcoming events
   */
  async checkUpcomingEvents(): Promise<string> {
    if (!this.calendarService) return "Calendar not available.";

    try {
      const now = new Date();
      const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const response = await this.calendarService.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: twoHoursLater.toISOString(),
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];
      if (events.length === 0) return "📅 No events in the next 2 hours.";

      const formatted = events.map((e: any) => {
        const start = new Date(e.start?.dateTime || e.start?.date);
        const minutesUntil = Math.floor(
          (start.getTime() - now.getTime()) / 60000
        );
        const timeStr = start.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });

        let urgency = "🟢";
        if (minutesUntil <= 15) urgency = "🔴 SOON:";
        else if (minutesUntil <= 60) urgency = "🟡";

        return `${urgency} ${timeStr} (${minutesUntil}m) - ${
          e.summary || "Untitled"
        }`;
      });

      return `🔔 Upcoming Events:\n${formatted.join("\n")}`;
    } catch (error) {
      return `Event check failed: ${error}`;
    }
  }
}
