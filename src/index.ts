/**
 * Alexi Plugin — Personal Project Coach
 *
 * Actions: PLAN_PROJECT, SCHEDULE_TASKS, TODAYS_TASKS, MARK_DONE, DAILY_REPORT, WEEKLY_SUMMARY
 * Providers: schedule-provider (injects current tasks/progress into every response)
 */

import {
  type Plugin,
  type Action,
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type ActionExample,
} from "@elizaos/core";

// ─── Notion Integration ─────────────────────────────────────────────────────

async function notionCreatePage(
  apiKey: string,
  databaseId: string,
  properties: Record<string, unknown>
): Promise<{ id: string } | null> {
  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
    });
    if (!res.ok) {
      console.error("[NOTION] Create page failed:", await res.text());
      return null;
    }
    return (await res.json()) as { id: string };
  } catch (e) {
    console.error("[NOTION] Create page error:", e);
    return null;
  }
}

async function notionUpdatePage(
  apiKey: string,
  pageId: string,
  properties: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
    return res.ok;
  } catch (e) {
    console.error("[NOTION] Update page error:", e);
    return false;
  }
}

async function notionQueryDatabase(
  apiKey: string,
  databaseId: string,
  filter?: Record<string, unknown>
): Promise<Array<{ id: string; properties: Record<string, any> }>> {
  try {
    const body: Record<string, unknown> = {};
    if (filter) body.filter = filter;
    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { results: Array<{ id: string; properties: Record<string, any> }> };
    return data.results;
  } catch (e) {
    console.error("[NOTION] Query error:", e);
    return [];
  }
}

function buildNotionTaskProperties(
  task: { title: string; projectName: string; scheduledDate: string; startTime: string; endTime: string; status: string; resources?: string }
) {
  const props: Record<string, unknown> = {
    "Tasks ": { title: [{ text: { content: task.title } }] },
    Project: { rich_text: [{ text: { content: task.projectName } }] },
    "Start Time": { rich_text: [{ text: { content: task.startTime } }] },
    "End Time": { rich_text: [{ text: { content: task.endTime } }] },
    Status: { select: { name: task.status === "done" ? "Done" : task.status === "skipped" ? "Skipped" : task.status === "carried_over" ? "Carried Over" : "Pending" } },
  };
  if (task.scheduledDate) {
    props.Date = { date: { start: task.scheduledDate } };
  }
  if (task.resources) {
    props["Resources "] = { url: task.resources };
  }
  return props;
}

function getNotionConfig(): { apiKey: string; databaseId: string } | null {
  const apiKey = process.env.NOTION_API_KEY || "";
  const databaseId = process.env.NOTION_DATABASE_ID || "";
  if (!apiKey || !databaseId) return null;
  return { apiKey, databaseId };
}

// ─── Database helpers (using ElizaOS built-in SQLite) ───────────────────────

interface Project {
  id: string;
  name: string;
  description: string;
  weekStart: string; // ISO date string (Monday)
  status: "active" | "completed" | "carried_over";
  createdAt: string;
}

interface Task {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  scheduledDate: string; // ISO date
  startTime: string; // "14:00"
  endTime: string; // "15:30"
  status: "pending" | "done" | "skipped" | "carried_over";
  resources: string; // JSON array of links
  notionPageId: string | null;
  createdAt: string;
  completedAt: string | null;
}

// In-memory store for now — we'll persist to SQLite via the sql plugin later
let projects: Project[] = [];
let tasks: Task[] = [];
let lastPlanText = "";
let lastPlanProject: Project | null = null;
let lastPlanResources: { title: string; url: string }[] = [];

function generateId(): string {
  return crypto.randomUUID();
}

function getCurrentDateWAT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}

function getCurrentTimeWAT(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getDayOfWeekWAT(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "Africa/Lagos",
    weekday: "long",
  });
}

function getWeekStartDate(): string {
  const now = new Date();
  const watDate = new Date(
    now.toLocaleString("en-US", { timeZone: "Africa/Lagos" })
  );
  const day = watDate.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday
  watDate.setDate(watDate.getDate() + diff);
  return watDate.toISOString().split("T")[0];
}

function getTodaysTasks(): Task[] {
  const today = getCurrentDateWAT();
  return tasks
    .filter((t) => t.scheduledDate === today)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function getWeekTasks(): Task[] {
  const weekStart = getWeekStartDate();
  return tasks.filter((t) => t.scheduledDate >= weekStart);
}

function getRemainingHoursToday(): number {
  const currentTime = getCurrentTimeWAT();
  const [h, m] = currentTime.split(":").map(Number);
  const currentMinutes = h * 60 + m;
  const endOfDay = 19 * 60; // 7PM WAT
  const startOfDay = 12 * 60; // 12PM WAT

  if (currentMinutes < startOfDay) return 7; // full day
  if (currentMinutes >= endOfDay) return 0;
  return Math.round(((endOfDay - currentMinutes) / 60) * 10) / 10;
}

// ─── PROVIDER: Schedule Context ─────────────────────────────────────────────

const scheduleProvider: Provider = {
  name: "schedule-provider",
  description:
    "Provides current schedule, tasks, and progress context for Alexi",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ) => {
    const today = getCurrentDateWAT();
    const dayOfWeek = getDayOfWeekWAT();
    const currentTime = getCurrentTimeWAT();
    const todaysTasks = getTodaysTasks();
    const weekTasks = getWeekTasks();

    const completedToday = todaysTasks.filter(
      (t) => t.status === "done"
    ).length;
    const totalToday = todaysTasks.length;
    const completedWeek = weekTasks.filter((t) => t.status === "done").length;
    const totalWeek = weekTasks.length;
    const remainingHours = getRemainingHoursToday();

    const activeProjects = projects.filter((p) => p.status === "active");

    let text = `📅 Current Context:\n`;
    text += `- Day: ${dayOfWeek}, ${today}\n`;
    text += `- Time: ${currentTime} WAT\n`;
    text += `- Work window remaining: ${remainingHours} hours (until 7:00 PM)\n\n`;

    if (activeProjects.length > 0) {
      text += `Active Projects: ${activeProjects.map((p) => p.name).join(", ")}\n`;
    } else {
      text += `No active projects this week.\n`;
    }

    if (todaysTasks.length > 0) {
      text += `\nToday's Tasks (${completedToday}/${totalToday} done):\n`;
      for (const task of todaysTasks) {
        const status =
          task.status === "done"
            ? "✅"
            : task.status === "skipped"
              ? "⏭️"
              : "⬜";
        text += `${status} ${task.startTime}-${task.endTime} | ${task.title} [${task.projectName}]\n`;
      }
    } else {
      text += `\nNo tasks scheduled for today.\n`;
    }

    if (totalWeek > 0) {
      const weekProgress = Math.round((completedWeek / totalWeek) * 100);
      text += `\nWeekly Progress: ${completedWeek}/${totalWeek} tasks (${weekProgress}%)\n`;
    }

    return {
      text,
      values: {
        currentDate: today,
        currentTime,
        dayOfWeek,
        remainingHours,
        todayTaskCount: totalToday,
        todayCompletedCount: completedToday,
        weekTaskCount: totalWeek,
        weekCompletedCount: completedWeek,
        activeProjectCount: activeProjects.length,
      },
      data: {
        todaysTasks,
        activeProjects,
      },
    };
  },
};

// ─── ACTION: Plan Project ───────────────────────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string
): Promise<{ title: string; url: string }[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_answer: false,
      }),
    });
    const data = (await response.json()) as {
      results?: { title: string; url: string }[];
    };
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
    }));
  } catch {
    return [];
  }
}

function formatResourcesPlainText(
  results: { title: string; url: string }[]
): string {
  if (results.length === 0) return "No resources found.";
  return results
    .map((r, i) => {
      const url = r.url || "";
      const isYouTube =
        url.includes("youtube.com") || url.includes("youtu.be");
      const displayUrl = isYouTube
        ? url.replace("https://", "").replace("http://", "")
        : url;
      return `${i + 1}. ${r.title} — ${displayUrl}`;
    })
    .join("\n");
}

const planProjectAction: Action = {
  name: "PLAN_PROJECT",
  description:
    "Break down a project idea into structured subtasks with time estimates, learning resources, and a daily schedule. Use this when the user describes a new project or goal they want to tackle this week. This action searches for real resources and creates a complete plan.",
  similes: [
    "PLAN",
    "BREAK_DOWN",
    "CREATE_PLAN",
    "PROJECT_PLAN",
    "PLAN_WEEK",
    "NEW_PROJECT",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("plan") ||
      text.includes("project") ||
      text.includes("build") ||
      text.includes("want to") ||
      text.includes("this week") ||
      text.includes("break down") ||
      text.includes("new project")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    const lastMessageText = message.content.text || "";
    const weekStart = getWeekStartDate();
    const remainingHours = getRemainingHoursToday();
    const dayOfWeek = getDayOfWeekWAT();

    const dayIndex = [
      "Sunday", "Monday", "Tuesday", "Wednesday",
      "Thursday", "Friday", "Saturday",
    ].indexOf(dayOfWeek);
    const workDaysLeft = dayIndex <= 5 ? Math.max(0, 5 - dayIndex + 1) : 0;
    const totalHoursAvailable = workDaysLeft * 7;

    // Get conversation history to find the original project idea
    let conversationContext = lastMessageText;
    try {
      const recentMemories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: "messages",
        count: 10,
      });
      if (recentMemories && recentMemories.length > 0) {
        // Collect all user messages to build full context
        const userMessages = recentMemories
          .filter((m: any) => m.entityId !== runtime.agentId && m.content?.text)
          .map((m: any) => m.content.text)
          .reverse();
        if (userMessages.length > 0) {
          conversationContext = userMessages.join("\n\n");
        }
      }
    } catch (e) {
      console.log("[PLAN_PROJECT] Could not fetch conversation history:", e);
    }

    // Extract project title from full conversation (not just last message)
    const baseUrl = process.env.OPENAI_BASE_URL || "";
    const model = process.env.OPENAI_LARGE_MODEL || "Qwen3.5-9B-FP8";
    let projectName = lastMessageText.slice(0, 80);
    try {
      const titleRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY || "nosana"}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Below is a conversation where a user describes a project they want to build. Extract a short project title (5-10 words max). Return ONLY the title, nothing else. The title should describe WHAT the user wants to build, not their answers to follow-up questions." },
            { role: "user", content: conversationContext },
          ],
          max_tokens: 30,
          temperature: 0.3,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      const titleData = await titleRes.json() as any;
      const extracted = titleData?.choices?.[0]?.message?.content?.trim();
      if (extracted && extracted.length > 3 && extracted.length < 100) {
        projectName = extracted.replace(/^["']|["']$/g, "");
      }
      console.log(`[PLAN_PROJECT] Extracted title: "${projectName}"`);
    } catch {
      console.log("[PLAN_PROJECT] Title extraction failed, using fallback");
    }

    // Create the project
    const project: Project = {
      id: generateId(),
      name: projectName,
      description: conversationContext,
      weekStart,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    projects.push(project);

    // Step 1: Search for real resources
    const tavilyKey =
      runtime.getSetting("TAVILY_API_KEY") ||
      process.env.TAVILY_API_KEY ||
      "";
    let resources: { title: string; url: string }[] = [];
    let resourcesText = "";

    if (tavilyKey) {
      resources = await searchTavily(
        `${projectName} ${lastMessageText} tutorial guide documentation`,
        tavilyKey as string
      );
      resourcesText = formatResourcesPlainText(resources);
    } else {
      resourcesText = "Web search unavailable (no TAVILY_API_KEY configured).";
    }

    // Step 2: Use the LLM to compose a plan with the resources
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const availableDays = dayNames.slice(
      Math.max(0, dayIndex - 1),
      5
    );

    const planPrompt = `You are Alexi, a project coach. Create a weekly project plan.

PROJECT: ${projectName}
DETAILS: ${conversationContext}

RESOURCES FOUND:
${resourcesText}

CONSTRAINTS:
- Work days: ${availableDays.join(", ")}
- Hours: 12:00 PM - 7:00 PM WAT daily (7h/day, ~${totalHoursAvailable}h total)
- Today: ${dayOfWeek}, ${remainingHours}h remaining

Write the plan in this exact format:

DAILY SCHEDULE

[For each available day, list time-blocked tasks. Include the resource title and link inline when a task involves studying that resource. Example format:]

Monday 12PM-7PM WAT:
- 12:00-2:00 — Study: "Resource Title" (resource-url-here). Focus on [specific topic].
- 2:00-4:00 — Set up project structure and environment
- 4:00-7:00 — Build [specific component]

[Continue for each day...]

Rules:
- First 1-2 days should focus on learning from the resources above
- Include the actual resource title and URL inline with each learning task
- Later days shift to building and testing
- Be specific about what to build in each block
- Keep it concise, no filler`;

    let planText = "";
    try {
      const baseUrl = process.env.OPENAI_BASE_URL || "https://6vq2bcqphcansrs9b88ztxfs88oqy7etah2ugudytv2x.node.k8s.prd.nos.ci/v1";
      const model = process.env.OPENAI_LARGE_MODEL || "Qwen3.5-9B-FP8";
      const llmRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY || "nosana"}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a project planning assistant. Output only the plan, no preamble." },
            { role: "user", content: planPrompt },
          ],
          max_tokens: 2000,
          temperature: 0.7,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      const llmData = await llmRes.json() as any;
      planText = llmData?.choices?.[0]?.message?.content || "";
      if (!planText) console.warn("[PLAN_PROJECT] LLM returned empty response:", JSON.stringify(llmData).slice(0, 200));
    } catch (e) {
      console.error("[PLAN_PROJECT] LLM call failed:", e);
      // Fallback if LLM call fails
      planText = `DAILY SCHEDULE

${availableDays.map((day, i) => {
  const taskNum = i + 1;
  if (i === 0) return `${day} 12PM-7PM WAT:\n- 12:00-3:00 — Study resources listed above\n- 3:00-5:00 — Set up project environment\n- 5:00-7:00 — Begin core implementation`;
  if (i === availableDays.length - 1) return `${day} 12PM-7PM WAT:\n- 12:00-3:00 — Test end-to-end\n- 3:00-5:00 — Fix bugs and polish\n- 5:00-7:00 — Document and deploy`;
  return `${day} 12PM-7PM WAT:\n- 12:00-2:00 — Continue implementation (task ${taskNum})\n- 2:00-5:00 — Build next component\n- 5:00-7:00 — Test and iterate`;
}).join("\n\n")}`;
    }

    // Step 3: Combine resources + plan into one response
    const fullResponse = `**LEARNING RESOURCES**
${resourcesText}

${planText}

---
Review the plan above. If it looks good, say **"approve"** or **"schedule it"** and I'll save the tasks to your Notion Calendar.`;

    // Store the plan text for SCHEDULE_TASKS to parse later
    lastPlanText = planText;
    lastPlanProject = project;
    lastPlanResources = resources;
    console.log(`[PLAN_PROJECT] Stored ${resources.length} resources for SCHEDULE_TASKS matching:`)
    resources.forEach((r, i) => console.log(`  ${i + 1}. "${r.title}" -> ${r.url}`));

    if (callback) {
      await callback({
        text: fullResponse,
        actions: ["PLAN_PROJECT"],
      });
    }

    return {
      success: true,
      data: {
        projectId: project.id,
        projectName: project.name,
        workDaysLeft,
        totalHoursAvailable,
        resourceCount: resources.length,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "I want to build a web scraper that finds AI builder campaigns this week",
        },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: "LEARNING RESOURCES\n1. Web Scraping Tutorial — example.com\n\nTASK BREAKDOWN\n1. Study resource #1 — 2h\n2. Set up project — 1h\n\nDAILY SCHEDULE\nMonday 12:00-2:00 — Study resources",
          actions: ["PLAN_PROJECT"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── ACTION: Schedule Tasks ─────────────────────────────────────────────────

const scheduleTasksAction: Action = {
  name: "SCHEDULE_TASKS",
  description:
    "Save approved tasks to the schedule. Use this after the user reviews and approves a plan, or when they want to add specific tasks to their calendar.",
  similes: ["SCHEDULE", "APPROVE_PLAN", "ADD_TASKS", "CONFIRM_SCHEDULE"],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("approve") ||
      text.includes("schedule") ||
      text.includes("looks good") ||
      text.includes("confirm") ||
      text.includes("add task") ||
      text.includes("let's go") ||
      text.includes("lock it in")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    if (!lastPlanText || !lastPlanProject) {
      if (callback) {
        await callback({
          text: "No plan to schedule. Describe a project first and I'll create a plan for you to approve.",
        });
      }
      return { success: false, error: "No plan pending" };
    }

    const project = lastPlanProject;

    // Parse tasks from the plan text using flexible regex
    const parsedTasks: Task[] = [];

    // Build day-to-date mapping
    const today = new Date(getCurrentDateWAT());
    const dayNameToDate: Record<string, string> = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const name = d.toLocaleDateString("en-US", { weekday: "long" });
      if (!dayNameToDate[name]) {
        dayNameToDate[name] = d.toISOString().split("T")[0];
      }
    }

    // Split by day headers — flexible pattern matching
    const lines = lastPlanText.split("\n");
    let currentDay = "";
    for (const line of lines) {
      // Match day headers like "Monday 12PM-7PM WAT:", "**Monday**:", "Monday:", etc.
      const dayMatch = line.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday)\b/i);
      if (dayMatch && (line.includes(":") || line.includes("WAT"))) {
        currentDay = dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();
        continue;
      }
      if (!currentDay) continue;

      // Match task lines like "- 12:00-2:00 — Task description" or "12:00-14:00 - Task"
      const taskMatch = line.match(/[-•*]?\s*(\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}:\d{2})\s*[-–—:]\s*(.*)/);
      if (taskMatch) {
        // Convert to 24h format (work window is 12PM-7PM, so hours 1-7 = 13-19, 12 stays 12)
        const to24h = (t: string): string => {
          const [h, m] = t.split(":").map(Number);
          if (h >= 1 && h <= 7) return `${h + 12}:${m.toString().padStart(2, "0")}`;
          return `${h}:${m.toString().padStart(2, "0")}`;
        };
        const startTime = to24h(taskMatch[1]);
        const endTime = to24h(taskMatch[2]);
        const rawTitle = taskMatch[3].trim().replace(/\*\*/g, "");

        // Extract URL from task text if present, or match resource by title
        const urlMatch = rawTitle.match(/(https?:\/\/[^\s)]+|www\.[^\s)]+)/);
        let resourceUrl = urlMatch ? urlMatch[1] : "";

        // If no URL in text, try to match a resource by title keywords
        if (!resourceUrl && lastPlanResources.length > 0) {
          const titleLower = rawTitle.toLowerCase();
          // Extract quoted text from task title (e.g., Study: "Resource Title")
          const quotedMatch = rawTitle.match(/"([^"]+)"/);
          const searchText = quotedMatch ? quotedMatch[1].toLowerCase() : titleLower;

          const matchedResource = lastPlanResources.find((r) => {
            const resourceTitleLower = r.title.toLowerCase();
            // Strategy 1: Check if quoted title from task matches resource title
            if (quotedMatch) {
              const quotedWords = searchText.split(/\s+/).filter((w: string) => w.length > 3);
              const matchCount = quotedWords.filter((w: string) => resourceTitleLower.includes(w)).length;
              return matchCount >= 2 || matchCount >= quotedWords.length * 0.5;
            }
            // Strategy 2: Check if any significant resource title words appear in task
            const words = resourceTitleLower.split(/\s+/).filter((w: string) => w.length > 4);
            const matchCount = words.filter((w: string) => titleLower.includes(w)).length;
            return matchCount >= 2;
          });
          if (matchedResource) {
            resourceUrl = matchedResource.url;
            console.log(`[SCHEDULE_TASKS] Matched resource: "${matchedResource.title}" -> ${resourceUrl}`);
          }
        }
        console.log(`[SCHEDULE_TASKS] Task: "${rawTitle.slice(0, 60)}..." | Resource: ${resourceUrl || "none"}`);

        const title = rawTitle.replace(/(https?:\/\/[^\s)]+|www\.[^\s)]+)/g, "").replace(/[()]/g, "").trim().slice(0, 200);

        const dateStr = dayNameToDate[currentDay] || "";

        if (title && dateStr) {
          parsedTasks.push({
            id: generateId(),
            projectId: project.id,
            projectName: project.name,
            title,
            description: "",
            scheduledDate: dateStr,
            startTime,
            endTime,
            status: "pending",
            resources: resourceUrl,
            notionPageId: null,
            createdAt: new Date().toISOString(),
            completedAt: null,
          });
        }
      }
    }

    console.log(`[SCHEDULE_TASKS] Parsed ${parsedTasks.length} tasks from plan`);

    // Save to local store
    tasks.push(...parsedTasks);

    // Sync to Notion
    const notion = getNotionConfig();
    let notionSynced = 0;
    if (notion && parsedTasks.length > 0) {
      for (const task of parsedTasks) {
        console.log(`[SCHEDULE_TASKS] Syncing to Notion: "${task.title}" on ${task.scheduledDate}`);
        const page = await notionCreatePage(
          notion.apiKey,
          notion.databaseId,
          buildNotionTaskProperties({
            title: task.title,
            projectName: task.projectName,
            scheduledDate: task.scheduledDate,
            startTime: task.startTime,
            endTime: task.endTime,
            status: "pending",
            resources: task.resources,
          })
        );
        if (page) {
          task.notionPageId = page.id;
          notionSynced++;
          console.log(`[SCHEDULE_TASKS] Notion page created: ${page.id}`);
        }
      }
    }

    // Clear the pending plan
    lastPlanText = "";
    lastPlanProject = null;
    lastPlanResources = [];

    const notionMsg = notionSynced > 0
      ? `\n📅 ${notionSynced} tasks synced to Notion Calendar.`
      : parsedTasks.length > 0
        ? "\n(Notion not configured — tasks saved locally only)"
        : "";

    if (callback) {
      await callback({
        text: `**Plan approved!** ${parsedTasks.length} tasks scheduled for project: **${project.name}**${notionMsg}\n\nUse "what's on today?" to see your tasks. I'll track your progress as you go.`,
        actions: ["SCHEDULE_TASKS"],
      });
    }

    return {
      success: true,
      data: { projectId: project.id, tasksScheduled: parsedTasks.length, notionSynced },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Looks good, approve the plan" },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: "Tasks scheduled! You'll get your first briefing at 12:00 PM WAT.",
          actions: ["SCHEDULE_TASKS"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── ACTION: Today's Tasks ──────────────────────────────────────────────────

const todaysTasksAction: Action = {
  name: "TODAYS_TASKS",
  description:
    "Show today's scheduled tasks with time blocks and completion status. Use when the user asks what they should work on today.",
  similes: [
    "TODAY",
    "WHATS_TODAY",
    "MY_TASKS",
    "DAILY_BRIEFING",
    "WHAT_SHOULD_I_DO",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("today") ||
      text.includes("what's on") ||
      text.includes("whats on") ||
      text.includes("my tasks") ||
      text.includes("briefing") ||
      text.includes("what should i") ||
      text.includes("what do i have")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    let todaysTasks = getTodaysTasks();
    const remainingHours = getRemainingHoursToday();
    const currentTime = getCurrentTimeWAT();
    const dayOfWeek = getDayOfWeekWAT();
    const today = getCurrentDateWAT();

    // If no local tasks, try pulling from Notion
    if (todaysTasks.length === 0) {
      const notion = getNotionConfig();
      if (notion) {
        const pages = await notionQueryDatabase(notion.apiKey, notion.databaseId, {
          property: "Date",
          date: { equals: today },
        });
        for (const page of pages) {
          const titleProp = page.properties?.["Tasks "]?.title;
          const title = titleProp?.[0]?.text?.content || "Untitled";
          const startTime = page.properties?.["Start Time"]?.rich_text?.[0]?.text?.content || "12:00";
          const endTime = page.properties?.["End Time"]?.rich_text?.[0]?.text?.content || "13:00";
          const statusName = page.properties?.Status?.select?.name || "Pending";
          const projectName = page.properties?.Project?.rich_text?.[0]?.text?.content || "";

          tasks.push({
            id: generateId(),
            projectId: "",
            projectName,
            title,
            description: "",
            scheduledDate: today,
            startTime,
            endTime,
            status: statusName === "Done" ? "done" : statusName === "Skipped" ? "skipped" : "pending",
            resources: "",
            notionPageId: page.id,
            createdAt: new Date().toISOString(),
            completedAt: null,
          });
        }
        todaysTasks = getTodaysTasks();
      }
    }

    if (todaysTasks.length === 0) {
      if (callback) {
        await callback({
          text: `**${dayOfWeek} — No tasks scheduled**\n\nYour calendar is clear today. Want to plan a project or add some tasks?`,
          actions: ["TODAYS_TASKS"],
        });
      }
      return { success: true, data: { taskCount: 0 } };
    }

    const completed = todaysTasks.filter((t) => t.status === "done").length;
    let response = `**${dayOfWeek} — ${completed}/${todaysTasks.length} tasks done** (${remainingHours}h left in work window)\n\n`;

    for (const task of todaysTasks) {
      const statusIcon =
        task.status === "done"
          ? "✅"
          : task.status === "skipped"
            ? "⏭️"
            : currentTime > task.endTime
              ? "⚠️"
              : currentTime >= task.startTime
                ? "🔵"
                : "⬜";
      response += `${statusIcon} **${task.startTime}-${task.endTime}** — ${task.title}\n`;
      if (task.description) {
        response += `   _${task.description}_\n`;
      }
    }

    // Find current or next task
    const currentTask = todaysTasks.find(
      (t) =>
        t.status === "pending" &&
        currentTime >= t.startTime &&
        currentTime < t.endTime
    );
    const nextTask = todaysTasks.find(
      (t) => t.status === "pending" && currentTime < t.startTime
    );

    if (currentTask) {
      response += `\n**Right now:** Focus on "${currentTask.title}" (until ${currentTask.endTime})`;
    } else if (nextTask) {
      response += `\n**Next up:** "${nextTask.title}" at ${nextTask.startTime}`;
    }

    if (callback) {
      await callback({
        text: response,
        actions: ["TODAYS_TASKS"],
      });
    }

    return {
      success: true,
      data: { taskCount: todaysTasks.length, completed },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's on today?" },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: "Tuesday — 2/5 tasks done (4.5h left)\n\n✅ 12:00-1:30 — Read ElizaOS docs\n🔵 1:30-3:00 — Build task action\n⬜ 3:15-5:00 — Wire up SQLite\n⬜ 5:00-7:00 — Test full flow",
          actions: ["TODAYS_TASKS"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── ACTION: Mark Done ──────────────────────────────────────────────────────

const markDoneAction: Action = {
  name: "MARK_DONE",
  description:
    "Mark a task as completed. Use when the user says they finished a task.",
  similes: ["DONE", "FINISHED", "COMPLETED", "CHECK_OFF", "MARK_COMPLETE"],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("done") ||
      text.includes("finished") ||
      text.includes("completed") ||
      text.includes("check off") ||
      text.includes("mark complete")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    const text = message.content.text?.toLowerCase() || "";
    const todaysTasks = getTodaysTasks();
    const pendingTasks = todaysTasks.filter((t) => t.status === "pending");

    if (pendingTasks.length === 0) {
      if (callback) {
        await callback({
          text: "No pending tasks to mark done. You're all clear! 🎉",
          actions: ["MARK_DONE"],
        });
      }
      return { success: true, data: { marked: false } };
    }

    // Try to match by task title or just mark the current/first pending one
    let matchedTask = pendingTasks.find((t) =>
      text.includes(t.title.toLowerCase())
    );

    if (!matchedTask) {
      // Mark the current time-block task, or the first pending one
      const currentTime = getCurrentTimeWAT();
      matchedTask =
        pendingTasks.find(
          (t) => currentTime >= t.startTime && currentTime < t.endTime
        ) || pendingTasks[0];
    }

    // Mark it done
    const taskIndex = tasks.findIndex((t) => t.id === matchedTask!.id);
    if (taskIndex !== -1) {
      tasks[taskIndex].status = "done";
      tasks[taskIndex].completedAt = new Date().toISOString();

      // Sync to Notion
      const notion = getNotionConfig();
      if (notion && tasks[taskIndex].notionPageId) {
        await notionUpdatePage(notion.apiKey, tasks[taskIndex].notionPageId!, {
          Status: { select: { name: "Done" } },
        });
      }
    }

    const remaining = todaysTasks.filter(
      (t) => t.status === "pending" && t.id !== matchedTask!.id
    ).length;
    const completed =
      todaysTasks.filter((t) => t.status === "done").length;

    let response = `✅ **"${matchedTask.title}"** — done!\n\n`;
    response += `Progress: ${completed}/${todaysTasks.length} tasks today.`;

    if (remaining > 0) {
      const nextTask = todaysTasks.find(
        (t) => t.status === "pending" && t.id !== matchedTask!.id
      );
      if (nextTask) {
        response += `\n**Next:** "${nextTask.title}" at ${nextTask.startTime}`;
      }
    } else {
      response += `\n\nAll tasks for today are done. Solid work! 🔥`;
    }

    if (callback) {
      await callback({
        text: response,
        actions: ["MARK_DONE"],
      });
    }

    return {
      success: true,
      data: {
        taskId: matchedTask.id,
        taskTitle: matchedTask.title,
        remaining,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Done with the ElizaOS docs" },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: '✅ "Read ElizaOS docs" — done!\n\nProgress: 3/5 tasks today.\nNext: "Build task action" at 1:30 PM',
          actions: ["MARK_DONE"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── ACTION: Daily Report ───────────────────────────────────────────────────

const dailyReportAction: Action = {
  name: "DAILY_REPORT",
  description:
    "Generate an end-of-day summary showing what was accomplished, what slipped, and a preview of tomorrow. Use at EOD or when the user asks for a day summary.",
  similes: [
    "EOD",
    "END_OF_DAY",
    "DAY_SUMMARY",
    "HOW_DID_TODAY_GO",
    "WRAP_UP",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("eod") ||
      text.includes("end of day") ||
      text.includes("day summary") ||
      text.includes("how'd today") ||
      text.includes("how did today") ||
      text.includes("wrap up") ||
      text.includes("daily report")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    const todaysTasks = getTodaysTasks();
    const dayOfWeek = getDayOfWeekWAT();
    const today = getCurrentDateWAT();

    const completed = todaysTasks.filter((t) => t.status === "done");
    const missed = todaysTasks.filter((t) => t.status === "pending");
    const skipped = todaysTasks.filter((t) => t.status === "skipped");

    let response = `**📊 ${dayOfWeek} Wrap-Up (${today})**\n\n`;

    if (todaysTasks.length === 0) {
      response += "No tasks were scheduled today.\n";
    } else {
      const pct = Math.round(
        (completed.length / todaysTasks.length) * 100
      );
      response += `**Completion:** ${completed.length}/${todaysTasks.length} (${pct}%)\n\n`;

      if (completed.length > 0) {
        response += `**Done:**\n`;
        for (const t of completed) {
          response += `✅ ${t.title}\n`;
        }
        response += `\n`;
      }

      if (missed.length > 0) {
        response += `**Carrying over:**\n`;
        for (const t of missed) {
          response += `🔄 ${t.title}\n`;
        }
        response += `\n`;

        // Carry over to next work day
        const nextDay = new Date(today);
        nextDay.setDate(nextDay.getDate() + 1);
        // Skip weekends
        while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
          nextDay.setDate(nextDay.getDate() + 1);
        }
        const nextDateStr = nextDay.toISOString().split("T")[0];

        for (const t of missed) {
          const taskIdx = tasks.findIndex((task) => task.id === t.id);
          if (taskIdx !== -1) {
            tasks[taskIdx].status = "carried_over";
          }
          // Create carry-over task
          tasks.push({
            ...t,
            id: generateId(),
            scheduledDate: nextDateStr,
            status: "pending",
            createdAt: new Date().toISOString(),
            completedAt: null,
          });
        }
      }

      if (skipped.length > 0) {
        response += `**Skipped:** ${skipped.map((t) => t.title).join(", ")}\n\n`;
      }
    }

    // Preview tomorrow
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];
    const tomorrowTasks = tasks.filter(
      (t) => t.scheduledDate === tomorrowStr && t.status === "pending"
    );

    if (tomorrowTasks.length > 0) {
      response += `**Tomorrow's preview:**\n`;
      for (const t of tomorrowTasks) {
        response += `⬜ ${t.startTime}-${t.endTime} | ${t.title}\n`;
      }
    }

    if (callback) {
      await callback({
        text: response,
        actions: ["DAILY_REPORT"],
      });
    }

    return {
      success: true,
      data: {
        completed: completed.length,
        missed: missed.length,
        skipped: skipped.length,
        total: todaysTasks.length,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "How'd today go?" },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: "📊 Wednesday Wrap-Up\n\nCompletion: 4/5 (80%)\n\nDone:\n✅ Read plugin docs\n✅ Build action scaffold\n✅ Test locally\n✅ Write character file\n\nCarrying over:\n🔄 Deploy to Nosana",
          actions: ["DAILY_REPORT"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── ACTION: Weekly Summary ─────────────────────────────────────────────────

const weeklySummaryAction: Action = {
  name: "WEEKLY_SUMMARY",
  description:
    "Generate a weekly review with completion stats per project, wins, carry-overs, and reflections. Use on Saturday or when the user asks for a weekly review.",
  similes: [
    "WEEKLY_REVIEW",
    "WEEK_SUMMARY",
    "WEEKLY_REPORT",
    "WEEK_IN_REVIEW",
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("weekly") ||
      text.includes("week summary") ||
      text.includes("week review") ||
      text.includes("this week") ||
      text.includes("week report")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ) => {
    const weekTasks = getWeekTasks();
    const weekStart = getWeekStartDate();

    const completed = weekTasks.filter((t) => t.status === "done");
    const pending = weekTasks.filter((t) => t.status === "pending");
    const carried = weekTasks.filter((t) => t.status === "carried_over");
    const skipped = weekTasks.filter((t) => t.status === "skipped");

    const pct =
      weekTasks.length > 0
        ? Math.round((completed.length / weekTasks.length) * 100)
        : 0;

    // Progress bar
    const filled = Math.round(pct / 5);
    const progressBar = "█".repeat(filled) + "░".repeat(20 - filled);

    let response = `**📈 Weekly Summary (week of ${weekStart})**\n\n`;
    response += `${progressBar} ${pct}%\n`;
    response += `**${completed.length}** done · **${pending.length}** pending · **${carried.length}** carried over · **${skipped.length}** skipped\n\n`;

    // Per-project breakdown
    const activeProjects = projects.filter(
      (p) => p.weekStart === weekStart || p.status === "active"
    );
    if (activeProjects.length > 0) {
      response += `**By Project:**\n`;
      for (const project of activeProjects) {
        const projectTasks = weekTasks.filter(
          (t) => t.projectId === project.id
        );
        const projectDone = projectTasks.filter(
          (t) => t.status === "done"
        ).length;
        const projectPct =
          projectTasks.length > 0
            ? Math.round((projectDone / projectTasks.length) * 100)
            : 0;
        response += `- **${project.name}**: ${projectDone}/${projectTasks.length} (${projectPct}%)\n`;
      }
      response += `\n`;
    }

    if (completed.length > 0) {
      response += `**Wins this week:**\n`;
      for (const t of completed.slice(0, 10)) {
        response += `✅ ${t.title}\n`;
      }
      if (completed.length > 10) {
        response += `...and ${completed.length - 10} more\n`;
      }
      response += `\n`;
    }

    if (pending.length > 0) {
      response += `**Still pending (carrying to next week):**\n`;
      for (const t of pending) {
        response += `🔄 ${t.title}\n`;
      }
      response += `\n`;
    }

    response += `---\nReady to plan next week? Tell me what projects you want to tackle.`;

    if (callback) {
      await callback({
        text: response,
        actions: ["WEEKLY_SUMMARY"],
      });
    }

    return {
      success: true,
      data: {
        weekStart,
        completed: completed.length,
        pending: pending.length,
        carried: carried.length,
        skipped: skipped.length,
        total: weekTasks.length,
        completionRate: pct,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Give me the weekly summary" },
      } as ActionExample,
      {
        name: "Alexi",
        content: {
          text: "📈 Weekly Summary\n\n████████████████░░░░ 80%\n16 done · 2 pending · 2 carried over\n\nBy Project:\n- ElizaOS Agent: 10/12 (83%)\n- YouTube Pipeline: 6/8 (75%)",
          actions: ["WEEKLY_SUMMARY"],
        },
      } as ActionExample,
    ],
  ],
};

// ─── SERVICE: Telegram Reminders ────────────────────────────────────────────

function getTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return null;
  return { token, chatId };
}

async function sendTelegramMessage(text: string, replyMarkup?: unknown): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) {
    console.log("[TELEGRAM] Not configured (missing BOT_TOKEN or CHAT_ID)");
    return false;
  }
  try {
    const body: Record<string, unknown> = {
      chat_id: config.chatId,
      text,
      parse_mode: "Markdown",
    };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      console.error("[TELEGRAM] Send failed:", await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[TELEGRAM] Send error:", e);
    return false;
  }
}

function buildTaskButtons(todaysTasks: Task[]): unknown | null {
  const pending = todaysTasks.filter(t => t.status === "pending");
  if (pending.length === 0) return null;

  const rows: unknown[] = [];
  for (const t of pending) {
    // Task name row (non-clickable label using a no-op callback)
    rows.push([{ text: `📋 ${t.startTime} — ${t.title.slice(0, 35)}`, callback_data: `noop:${t.id}` }]);
    // Action buttons row
    rows.push([
      { text: "✅ Done", callback_data: `done:${t.id}` },
      { text: "⏭️ Skip", callback_data: `skip:${t.id}` },
      { text: "🔄 Later", callback_data: `carry:${t.id}` },
    ]);
  }

  return { inline_keyboard: rows };
}

async function answerCallbackQuery(token: string, callbackId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    });
  } catch { /* ignore */ }
}

async function handleCallbackQuery(
  token: string,
  callbackId: string,
  data: string,
  chatId: string
): Promise<void> {
  const [action, taskId] = data.split(":");
  if (!action || !taskId) return;

  const taskIdx = tasks.findIndex(t => t.id === taskId);
  if (taskIdx === -1) {
    await answerCallbackQuery(token, callbackId, "Task not found");
    return;
  }

  const task = tasks[taskIdx];
  const notion = getNotionConfig();

  if (action === "done") {
    tasks[taskIdx].status = "done";
    tasks[taskIdx].completedAt = new Date().toISOString();
    await answerCallbackQuery(token, callbackId, `Done: ${task.title.slice(0, 30)}`);

    // Update Notion
    if (notion && task.notionPageId) {
      await notionUpdatePage(notion.apiKey, task.notionPageId, {
        Status: { select: { name: "Done" } },
      });
    }

    const todaysTasks = getTodaysTasks();
    const completed = todaysTasks.filter(t => t.status === "done").length;
    const total = todaysTasks.length + 1; // +1 because we just changed it
    const nextTask = todaysTasks.find(t => t.status === "pending");
    let msg = `✅ *${task.title}* — done!\n\nProgress: ${completed}/${total}`;
    if (nextTask) msg += `\nNext: *${nextTask.title}* at ${nextTask.startTime}`;

    const buttons = buildTaskButtons(todaysTasks);
    await sendTelegramMessage(msg, buttons);

  } else if (action === "skip") {
    tasks[taskIdx].status = "skipped";
    await answerCallbackQuery(token, callbackId, `Skipped: ${task.title.slice(0, 30)}`);

    if (notion && task.notionPageId) {
      await notionUpdatePage(notion.apiKey, task.notionPageId, {
        Status: { select: { name: "Skipped" } },
      });
    }

    const todaysTasks = getTodaysTasks();
    await sendTelegramMessage(`⏭️ Skipped: *${task.title}*`, buildTaskButtons(todaysTasks));

  } else if (action === "carry") {
    tasks[taskIdx].status = "carried_over";
    await answerCallbackQuery(token, callbackId, `Carrying over: ${task.title.slice(0, 30)}`);

    if (notion && task.notionPageId) {
      await notionUpdatePage(notion.apiKey, task.notionPageId, {
        Status: { select: { name: "Carried Over" } },
      });
    }

    // Create carry-over task for next work day
    const today = getCurrentDateWAT();
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);
    while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
      nextDay.setDate(nextDay.getDate() + 1);
    }
    tasks.push({
      ...task,
      id: generateId(),
      scheduledDate: nextDay.toISOString().split("T")[0],
      status: "pending",
      notionPageId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });

    const todaysTasks = getTodaysTasks();
    await sendTelegramMessage(`🔄 Carrying over: *${task.title}* to next work day`, buildTaskButtons(todaysTasks));
  }
}

// Poll for Telegram button presses
let callbackPollInterval: ReturnType<typeof setInterval> | null = null;
let lastUpdateId = 0;

function startCallbackPoller(): void {
  const config = getTelegramConfig();
  if (!config) return;

  console.log("[TELEGRAM] Starting callback query poller");

  callbackPollInterval = setInterval(async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=1&allowed_updates=["callback_query"]`,
      );
      const data = await res.json() as any;
      if (!data.ok || !data.result?.length) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.callback_query) {
          const cb = update.callback_query;
          await handleCallbackQuery(
            config.token,
            cb.id,
            cb.data || "",
            String(cb.message?.chat?.id || config.chatId)
          );
        }
      }
    } catch (e) { console.error("[TELEGRAM] Poll error:", e); }
  }, 3000); // Poll every 3 seconds
}

function composeMorningBriefing(): string {
  const dayOfWeek = getDayOfWeekWAT();
  const todaysTasks = getTodaysTasks();
  const remainingHours = getRemainingHoursToday();

  if (todaysTasks.length === 0) {
    return `☀️ *Good afternoon, ${dayOfWeek}*\n\nNo tasks scheduled today. Want to plan something?`;
  }

  let msg = `☀️ *${dayOfWeek} Briefing*\n\n`;
  msg += `${todaysTasks.length} tasks today (${remainingHours}h in work window)\n\n`;
  for (const task of todaysTasks) {
    const icon = task.status === "done" ? "✅" : "⬜";
    msg += `${icon} ${task.startTime}-${task.endTime} | ${task.title}\n`;
  }
  msg += `\nFirst up: *${todaysTasks.find(t => t.status === "pending")?.title || "All done!"}*`;
  return msg;
}

function composeMiddayCheckin(): string {
  const todaysTasks = getTodaysTasks();
  const completed = todaysTasks.filter(t => t.status === "done").length;
  const total = todaysTasks.length;
  const currentTime = getCurrentTimeWAT();

  if (total === 0) return "";

  const currentTask = todaysTasks.find(
    t => t.status === "pending" && currentTime >= t.startTime && currentTime < t.endTime
  );
  const nextTask = todaysTasks.find(
    t => t.status === "pending" && currentTime < t.startTime
  );

  let msg = `🔔 *Midday Check-in*\n\nProgress: ${completed}/${total} tasks done\n\n`;
  if (currentTask) {
    msg += `Currently: *${currentTask.title}* (until ${currentTask.endTime})\n`;
  }
  if (nextTask) {
    msg += `Next: *${nextTask.title}* at ${nextTask.startTime}\n`;
  }
  if (completed === total) {
    msg += `All tasks done! Great work today. 🔥`;
  }
  return msg;
}

function composeEODWrapup(): string {
  const dayOfWeek = getDayOfWeekWAT();
  const todaysTasks = getTodaysTasks();
  const completed = todaysTasks.filter(t => t.status === "done");
  const missed = todaysTasks.filter(t => t.status === "pending");

  if (todaysTasks.length === 0) return "";

  const pct = Math.round((completed.length / todaysTasks.length) * 100);

  let msg = `📊 *${dayOfWeek} Wrap-Up*\n\n`;
  msg += `Completion: ${completed.length}/${todaysTasks.length} (${pct}%)\n\n`;

  if (completed.length > 0) {
    msg += `*Done:*\n`;
    for (const t of completed) msg += `✅ ${t.title}\n`;
    msg += `\n`;
  }
  if (missed.length > 0) {
    msg += `*Carrying over:*\n`;
    for (const t of missed) msg += `🔄 ${t.title}\n`;
  }
  return msg;
}

function composeWeeklyReview(): string {
  const weekTasks = getWeekTasks();
  if (weekTasks.length === 0) return "";

  const completed = weekTasks.filter(t => t.status === "done");
  const pending = weekTasks.filter(t => t.status === "pending");
  const pct = Math.round((completed.length / weekTasks.length) * 100);
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);

  let msg = `📈 *Weekly Review*\n\n`;
  msg += `${bar} ${pct}%\n`;
  msg += `${completed.length} done · ${pending.length} pending\n\n`;

  if (completed.length > 0) {
    msg += `*Wins:*\n`;
    for (const t of completed.slice(0, 5)) msg += `✅ ${t.title}\n`;
    if (completed.length > 5) msg += `...and ${completed.length - 5} more\n`;
  }
  msg += `\nReady to plan next week?`;
  return msg;
}

// Track which reminders have fired today to avoid duplicates
const firedReminders = new Set<string>();
let reminderInterval: ReturnType<typeof setInterval> | null = null;

function startReminderService(): void {
  if (reminderInterval) return; // Already running

  console.log("[REMINDER] Starting reminder service (checking every 60s)");

  reminderInterval = setInterval(async () => {
    const currentTime = getCurrentTimeWAT();
    const dayOfWeek = getDayOfWeekWAT();
    const today = getCurrentDateWAT();
    const reminderKey = (name: string) => `${today}-${name}`;

    // Reset fired set at midnight
    if (currentTime === "00:00" || currentTime === "00:01") {
      firedReminders.clear();
    }

    const isWeekday = !["Saturday", "Sunday"].includes(dayOfWeek);
    const isSaturday = dayOfWeek === "Saturday";

    // Morning briefing — 12:00 PM WAT, Mon-Fri (with task buttons)
    if (isWeekday && currentTime >= "12:00" && currentTime < "12:02" && !firedReminders.has(reminderKey("morning"))) {
      firedReminders.add(reminderKey("morning"));
      const msg = composeMorningBriefing();
      const buttons = buildTaskButtons(getTodaysTasks());
      if (msg) await sendTelegramMessage(msg, buttons);
    }

    // Midday check-in — 3:30 PM WAT, Mon-Fri
    if (isWeekday && currentTime >= "15:30" && currentTime < "15:32" && !firedReminders.has(reminderKey("midday"))) {
      firedReminders.add(reminderKey("midday"));
      const msg = composeMiddayCheckin();
      if (msg) await sendTelegramMessage(msg);
    }

    // EOD wrap-up — 7:00 PM WAT, Mon-Fri
    if (isWeekday && currentTime >= "19:00" && currentTime < "19:02" && !firedReminders.has(reminderKey("eod"))) {
      firedReminders.add(reminderKey("eod"));
      const msg = composeEODWrapup();
      if (msg) await sendTelegramMessage(msg);
    }

    // Weekly review — Saturday 12:00 PM WAT
    if (isSaturday && currentTime >= "12:00" && currentTime < "12:02" && !firedReminders.has(reminderKey("weekly"))) {
      firedReminders.add(reminderKey("weekly"));
      const msg = composeWeeklyReview();
      if (msg) await sendTelegramMessage(msg);
    }
  }, 60000); // Check every 60 seconds
}

// ─── Telegram Handler (replaces ElizaOS plugin to avoid getUpdates conflict) ──

function buildMainMenu(): unknown {
  return {
    inline_keyboard: [
      [{ text: "📋 View Today's Tasks", callback_data: "menu:today" }],
      [{ text: "📊 Daily Report", callback_data: "menu:report" }],
      [{ text: "📈 Weekly Summary", callback_data: "menu:weekly" }],
    ],
  };
}

async function sendStartupMessage(): Promise<void> {
  const config = getTelegramConfig();
  if (!config) return;

  await sendTelegramMessage(
    `👋 *Alexi is online!*\n\nYour personal project coach is ready.\n\n` +
    `Use the buttons below or type a message to chat.`,
    buildMainMenu()
  );
}

async function handleTelegramMessage(
  _token: string,
  _chatId: string,
  text: string
): Promise<void> {
  // Quick commands that don't need LLM
  const lower = text.toLowerCase();

  if (lower === "/start" || lower === "/menu") {
    await sendTelegramMessage(
      `👋 *Alexi is online!*\n\nUse the buttons or type a message.`,
      buildMainMenu()
    );
    return;
  }

  if (lower === "/tasks" || lower.includes("what's on today") || lower.includes("whats on")) {
    const todaysTasks = getTodaysTasks();
    if (todaysTasks.length === 0) {
      await sendTelegramMessage("📋 No tasks scheduled for today.\n\nPlan a project on the web UI first!", buildMainMenu());
      return;
    }
    const completed = todaysTasks.filter(t => t.status === "done").length;
    let msg = `📋 *Today's Tasks* (${completed}/${todaysTasks.length} done)\n\n`;
    for (const t of todaysTasks) {
      const icon = t.status === "done" ? "✅" : t.status === "skipped" ? "⏭️" : "⬜";
      msg += `${icon} ${t.startTime}-${t.endTime} | ${t.title}\n`;
    }
    const buttons = buildTaskButtons(todaysTasks);
    await sendTelegramMessage(msg, buttons || buildMainMenu());
    return;
  }

  // For anything else, forward to the Nosana LLM
  try {
    const baseUrl = process.env.OPENAI_BASE_URL || "";
    const model = process.env.OPENAI_LARGE_MODEL || "Qwen3.5-9B-FP8";
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY || "nosana"}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are Alexi, a personal project coach. Be concise and direct. Use emojis where appropriate. Your user works 12PM-7PM WAT, Mon-Fri." },
          { role: "user", content: text },
        ],
        max_tokens: 500,
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const data = await res.json() as any;
    const reply = data?.choices?.[0]?.message?.content || "Sorry, I couldn't process that. Try again!";
    await sendTelegramMessage(reply, buildMainMenu());
  } catch {
    await sendTelegramMessage("⚠️ Couldn't reach the LLM right now. Try again in a moment.", buildMainMenu());
  }
}

async function handleMenuCallback(
  token: string,
  callbackId: string,
  data: string,
  chatId: string
): Promise<void> {
  if (data === "menu:today") {
    await answerCallbackQuery(token, callbackId, "Loading tasks...");
    const todaysTasks = getTodaysTasks();
    if (todaysTasks.length === 0) {
      await sendTelegramMessage("📋 No tasks scheduled today.\n\nPlan a project on the web UI first!", buildMainMenu());
      return;
    }
    const completed = todaysTasks.filter(t => t.status === "done").length;
    let msg = `📋 *Today's Tasks* (${completed}/${todaysTasks.length} done)\n\n`;
    for (const t of todaysTasks) {
      const icon = t.status === "done" ? "✅" : t.status === "skipped" ? "⏭️" : "⬜";
      msg += `${icon} ${t.startTime}-${t.endTime} | ${t.title}\n`;
    }
    const buttons = buildTaskButtons(todaysTasks);
    await sendTelegramMessage(msg, buttons || buildMainMenu());
  } else if (data === "menu:report") {
    await answerCallbackQuery(token, callbackId, "Generating report...");
    const msg = composeEODWrapup();
    await sendTelegramMessage(msg || "📊 No tasks to report on today.", buildMainMenu());
  } else if (data === "menu:weekly") {
    await answerCallbackQuery(token, callbackId, "Loading summary...");
    const msg = composeWeeklyReview();
    await sendTelegramMessage(msg || "📈 No tasks this week yet.", buildMainMenu());
  } else if (data.startsWith("done:") || data.startsWith("skip:") || data.startsWith("carry:")) {
    await handleCallbackQuery(token, callbackId, data, chatId);
  } else if (data.startsWith("noop:")) {
    await answerCallbackQuery(token, callbackId, "");
  }
}

let telegramPollInterval: ReturnType<typeof setInterval> | null = null;
let telegramLastUpdateId = 0;

function startTelegramHandler(): void {
  const config = getTelegramConfig();
  if (!config) {
    console.log("[TELEGRAM] Not configured, skipping handler");
    return;
  }

  console.log("[TELEGRAM] Starting custom handler with buttons");

  // Send startup message after a short delay
  setTimeout(() => sendStartupMessage(), 3000);

  // Poll for messages and button presses
  telegramPollInterval = setInterval(async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.token}/getUpdates?offset=${telegramLastUpdateId + 1}&timeout=1`
      );
      const data = await res.json() as any;
      if (!data.ok || !data.result?.length) return;

      console.log(`[TELEGRAM] Got ${data.result.length} updates`);

      for (const update of data.result) {
        telegramLastUpdateId = update.update_id;

        // Handle button presses
        if (update.callback_query) {
          const cb = update.callback_query;
          console.log(`[TELEGRAM] Button pressed: ${cb.data}`);
          await handleMenuCallback(
            config.token,
            cb.id,
            cb.data || "",
            String(cb.message?.chat?.id || config.chatId)
          );
        }

        // Handle text messages
        if (update.message?.text) {
          console.log(`[TELEGRAM] Message from ${update.message.chat.id}: ${update.message.text.slice(0, 50)}`);
        }
        if (update.message?.text && String(update.message.chat.id) === config.chatId) {
          await handleTelegramMessage(
            config.token,
            config.chatId,
            update.message.text
          );
        }
      }
    } catch (e) { console.error("[TELEGRAM] Poll error:", e); }
  }, 2000);
}

// ─── PLUGIN EXPORT ──────────────────────────────────────────────────────────

export const alexiPlugin: Plugin = {
  name: "alexi-plugin",
  description:
    "Personal project coach — plans projects, schedules tasks, tracks progress, and provides daily/weekly reviews",
  init: async () => {
    startReminderService();
    startTelegramHandler();
    console.log("[ALEXI] Plugin initialized with reminders + Telegram handler");
  },
  actions: [
    planProjectAction,
    scheduleTasksAction,
    todaysTasksAction,
    markDoneAction,
    dailyReportAction,
    weeklySummaryAction,
  ],
  providers: [scheduleProvider],
  evaluators: [],
};

export default alexiPlugin;
