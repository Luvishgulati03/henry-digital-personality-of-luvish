import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ActivityLog } from "./activity.ts";
import { ApprovalStore } from "./approval/store.ts";
import { HenryMemory } from "./memory/engram.ts";
import { KnowledgeBase } from "./knowledge/store.ts";
import { HenryAgent } from "./agent/henry.ts";
import { LunaOrchestrator } from "./orchestration/luna.ts";
import { GmailService } from "./integrations/gmail.ts";
import { WorkflowScheduler } from "./scheduler/scheduler.ts";
import { PullRequestReviewer } from "./pr/review.ts";
import { JobApplicationService } from "./jobs/service.ts";
import { JobScoutService } from "./jobs/scout.ts";
import { CoverLetterService } from "./jobs/cover.ts";
import { TailoredApplicationService } from "./jobs/tailor.ts";
import { MeetingShadowService } from "./meetings/service.ts";
import { ScreenshotSorterService } from "./screenshots/service.ts";
import { ResumeEditorService } from "./jobs/resume-editor.ts";
import { WorkflowEngine } from "./workflows/engine.ts";
import { GoalService } from "./goals/service.ts";
import { ReminderService, notifyReminder, type ReminderNotifier } from "./reminders/service.ts";
import { LinkedInDraftService } from "./social/linkedin.ts";
import { LaunchCrewService } from "./launch/service.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { MailWatchService } from "./mailwatch/service.ts";
import { StandupStore } from "./standup/store.ts";
import { StandupService } from "./standup/service.ts";
import { StandupPoller } from "./standup/poller.ts";
import { TelegramPump } from "./telegram/pump.ts";
import { TelegramBridge } from "./telegram/bridge.ts";
import { limitState } from "./providers/limits.ts";
import { DraftRepliesService } from "./gmail-drafts/service.ts";
import type { ProviderName, RunResult } from "./types.ts";

export class HenryRuntime {
  readonly activity: ActivityLog;
  readonly approvals: ApprovalStore;
  readonly memory: HenryMemory;
  readonly agent: HenryAgent;
  readonly luna: LunaOrchestrator;
  readonly gmail: GmailService;
  readonly scheduler: WorkflowScheduler;
  readonly reviewer: PullRequestReviewer;
  readonly jobs: JobApplicationService;
  readonly cover: CoverLetterService;
  readonly tailor: TailoredApplicationService;
  readonly resumeEditor: ResumeEditorService;
  readonly meetings: MeetingShadowService;
  readonly screenshots: ScreenshotSorterService;
  readonly goals: GoalService;
  readonly reminders: ReminderService;
  readonly linkedin: LinkedInDraftService;
  readonly launch: LaunchCrewService;
  readonly mailwatch: MailWatchService;
  readonly draftReplies: DraftRepliesService;
  private _knowledge?: KnowledgeBase;
  private _workflowEngine?: WorkflowEngine;
  private _standupStore?: StandupStore;
  private _standup?: StandupService;
  private _standupPoller?: StandupPoller;
  private _telegramBridge?: TelegramBridge;
  private _telegramPump?: TelegramPump;
  private _jobScout?: JobScoutService;

  /**
   * Composed operator-notification channel: console + osascript (via `notifyReminder`) then
   * a fire-and-forget Telegram send when configured. This is the one place reminders and
   * mail-watch alerts are wired together with Telegram — neither module imports the other or
   * imports `notify/telegram.ts` itself (doctrine rule 7); the runtime composition root does.
   */
  readonly notifyOperator: ReminderNotifier = async (message, title) => {
    await notifyReminder(message, title);
    // Telegram is fail-open by design, but the FAILURE must still be visible in the
    // logs page — "why didn't my phone buzz" was undebuggable while this was silent.
    void sendTelegram(this.config, title && title !== "Henry" ? `${title}: ${message}` : message)
      .then((ok) => { if (!ok && this.config.telegramBotToken) void this.activity.record("workflow.failed", "Telegram delivery failed (fail-open)", { telegram: true, title: title ?? "Henry" }); })
      .catch(() => undefined);
  };

  private constructor(readonly config: HenryConfig) {
    this.activity = new ActivityLog(config.activityPath);
    this.approvals = new ApprovalStore(config.approvalsPath);
    this.memory = new HenryMemory(config, this.activity);
    this.gmail = new GmailService(config, this.activity, this.approvals);
    this.agent = new HenryAgent(config, this.activity, this.memory, () => this.knowledge);
    this.luna = new LunaOrchestrator(config, this.activity, this.memory);
    this.reminders = new ReminderService(config, this.activity);
    this.scheduler = new WorkflowScheduler(
      config, this.activity, this.memory, this.gmail, this.reminders,
      this.notifyOperator,
      (prompt) => this.agent.run(prompt).then((result) => result.response),
      (approvalId) => this.executeApproval(approvalId),
    );
    this.mailwatch = new MailWatchService(config, this.activity, this.agent.providerRunner, this.notifyOperator, this.memory);
    this.draftReplies = new DraftRepliesService(config, this.activity, this.agent.providerRunner, this.notifyOperator);
    this.reviewer = new PullRequestReviewer(config, this.activity, this.approvals, this.agent.providerRunner);
    this.jobs = new JobApplicationService(config, this.activity, this.approvals, this.memory, this.agent.providerRunner);
    this.cover = new CoverLetterService(config, this.activity, this.memory, this.agent.providerRunner, this.jobs);
    this.tailor = new TailoredApplicationService(config, this.activity, this.agent.providerRunner, this.cover, this.memory);
    this.resumeEditor = new ResumeEditorService(config, this.activity, this.memory, this.agent.providerRunner);
    this.meetings = new MeetingShadowService(config, this.activity, this.memory, this.agent.providerRunner);
    this.screenshots = new ScreenshotSorterService(config, this.activity, this.agent.providerRunner);
    this.goals = new GoalService(config, this.activity, this.memory, this.luna);
    this.linkedin = new LinkedInDraftService(config, this.activity, this.memory, this.agent.providerRunner);
    this.launch = new LaunchCrewService(config, this.activity, this.memory, () => this.knowledge, this.agent.providerRunner);
  }

  /** Lazily opens the organization's knowledge DB on first domain-relevant turn; keeps boot fast. */
  get knowledge(): KnowledgeBase {
    if (!this._knowledge) this._knowledge = new KnowledgeBase(this.config);
    return this._knowledge;
  }

  /**
   * Markdown workflow engine (`workflows/*.workflow.md`). Constructed on first use and
   * inert until `start()` — only the workflow/schedule daemons watch files and arm crons.
   */
  get workflowEngine(): WorkflowEngine {
    if (!this._workflowEngine) this._workflowEngine = new WorkflowEngine(this.config, this.activity, this.agent.providerRunner);
    return this._workflowEngine;
  }

  private get standupStore(): StandupStore {
    if (!this._standupStore) this._standupStore = new StandupStore(this.config);
    return this._standupStore;
  }

  /** Lazily opens data/standups.db on first standup-relevant call; inert until the Telegram group is configured. */
  get standup(): StandupService {
    if (!this._standup) {
      this._standup = new StandupService(this.config, this.activity, this.agent.providerRunner, this.standupStore, this.notifyOperator, this.memory);
    }
    return this._standup;
  }

  get standupPoller(): StandupPoller {
    if (!this._standupPoller) this._standupPoller = new StandupPoller(this.config, this.activity, this.standupStore);
    return this._standupPoller;
  }

  /**
   * Luvish's two-way DM. The composition root is the ONLY place the bridge meets the two
   * things it deliberately does not own: the brain (`agent.run`, same entry as the dashboard
   * chat — its own tiers, memory, and sessions apply) and the sender (`sendTelegram`, already
   * pinned to Luvish's chat, so no new outbound surface exists). readOnly is the rail: the
   * bridge is a conversation, and repo mutations stay in the terminal session.
   */
  get telegramBridge(): TelegramBridge {
    if (!this._telegramBridge) {
      this._telegramBridge = new TelegramBridge(this.config, this.activity, this.standupStore, {
        think: (prompt) => this.agent.run(prompt, { surface: "telegram", readOnly: true, role: "telegram-bridge" }).then((result) => result.response),
        send: (config, text) => sendTelegram(config, text),
      });
    }
    return this._telegramBridge;
  }

  /**
   * ONE getUpdates consumer for the whole bot token. Both inbound modules ride it: Luvish's
   * DM → the bridge, the standup group → standup's unchanged intake, anything else → counted
   * and dropped. Consumers with no chat id configured are never called.
   */
  get telegramPump(): TelegramPump {
    if (!this._telegramPump) {
      this._telegramPump = new TelegramPump(this.config, this.activity, this.standupStore, [this.telegramBridge, this.standupPoller]);
    }
    return this._telegramPump;
  }

  /**
   * Morning job scout, lazily constructed — browser and scout.db only open when
   * `jobs login`/`jobs scout` actually run. `--prepare` rides the EXISTING
   * approval-gated JobApplicationService.prepare; the scout itself never submits.
   */
  get jobScout(): JobScoutService {
    if (!this._jobScout) {
      this._jobScout = new JobScoutService(
        this.config, this.activity, this.agent.providerRunner, this.notifyOperator, this.memory,
        undefined,
        (url) => this.jobs.prepare(url).then((draft) => ({ id: draft.id, approvalId: draft.approvalId })),
      );
    }
    return this._jobScout;
  }

  /**
   * Arms the ONE Telegram reader inside long-lived processes (repl / scheduler daemon).
   * Replaces the old standup-only `startStandupPoller` — same interval, same lock, same
   * offset row; it just routes to both consumers now. Safe no-op when unconfigured.
   */
  startTelegramPump(): { armed: boolean; bridge: boolean; standup: boolean } {
    const bridge = Boolean(this.telegramBridge.chatId);
    const standup = Boolean(this.config.telegramBotToken && this.config.telegramStandupChatId);
    return { armed: this.telegramPump.start(), bridge, standup };
  }

  static async create(rootDir?: string): Promise<HenryRuntime> {
    const runtime = new HenryRuntime(loadConfig(rootDir));
    await runtime.loadSettings();
    await runtime.activity.init();
    await runtime.approvals.init();
    await runtime.memory.init();
    await runtime.jobs.init();
    return runtime;
  }

  /** Persisted operator settings override env defaults; the dashboard toggle writes them. */
  private async loadSettings(): Promise<void> {
    try {
      const settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.provider === "codex" || settings.provider === "claude") this.config.provider = settings.provider;
      if (typeof settings.pmMode === "boolean") this.config.pmMode = settings.pmMode;
    } catch { /* No settings file yet; env/default provider applies. */ }
  }

  /** Toggles PM MODE (persisted) — Henry operates as a project manager until switched off. */
  async setPmMode(on: boolean): Promise<boolean> {
    this.config.pmMode = on;
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
    settings.pmMode = on;
    await fs.mkdir(path.dirname(this.config.settingsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.activity.record("provider.switched", `PM mode ${on ? "ON" : "OFF"}`, { pmMode: on });
    return on;
  }

  async setProvider(provider: ProviderName): Promise<ProviderName> {
    if (provider !== "codex" && provider !== "claude") throw new Error(`Unknown provider: ${String(provider)}`);
    this.config.provider = provider;
    // Read-merge-write (audit 2026-08-09 M2): a bare {provider} write was wiping
    // every other persisted setting — toggling provider silently disabled PM mode.
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
    settings.provider = provider;
    await fs.mkdir(path.dirname(this.config.settingsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.activity.record("provider.switched", `Primary provider switched to ${provider}`, { provider });
    return provider;
  }

  /** Full-access engineering task inside any local repository Luvish points Henry at. */
  async task(instruction: string, cwd?: string): Promise<RunResult> {
    const dir = path.resolve(cwd || this.config.rootDir);
    await fs.access(dir).catch(() => { throw new Error(`Task directory does not exist: ${dir}`); });
    await this.activity.record("task.started", `Codebase task in ${dir}`, { cwd: dir, instruction: instruction.slice(0, 240) });
    const result = await this.agent.run(
      [`Work inside the repository at ${dir}. Inspect it before changing anything, run the project's own checks after edits, and summarize every file you changed.`, instruction].join("\n\n"),
      { cwd: dir },
    );
    await this.activity.record("task.completed", `Codebase task finished in ${dir}`, { cwd: dir, exitCode: result.exitCode }, { runId: result.runId, provider: result.provider });
    return result;
  }

  async approve(id: string): Promise<void> {
    await this.approvals.setStatus(id, "approved");
    await this.activity.record("approval.approved", `Approved outbound action ${id}`, { approvalId: id });
  }

  async executeApproval(id: string): Promise<string> {
    const item = await this.approvals.claimForExecution(id);
    try {
      const result = item.kind === "gmail.send" ? await this.gmail.sendApproved(item)
        : item.kind === "job.application" ? await this.jobs.submitApproved(item)
        : item.kind === "github.merge" ? await this.reviewer.mergeApproved(item)
        : item.kind === "github.rollback" ? await this.reviewer.rollbackApproved(item)
        : await this.reviewer.postApproved(item);
      await this.approvals.setStatus(id, "executed", result);
      return result;
    } catch (error) {
      await this.approvals.setStatus(id, "failed", String(error));
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      name: "Henry", user: "Luvish", provider: this.config.provider,
      rootDir: this.config.rootDir, dashboard: `http://${this.config.host}:${this.config.port}`,
      approvals: (await this.approvals.list("pending")).length,
      jobs: await this.jobs.store.summary(),
      memory: this.memory.engine.stats(),
      // Live limit/cooldown state per provider CLI ({} when both are healthy) — the
      // failover layer's ledger (providers/limits.ts), surfaced for :status and the page.
      providers: limitState(),
    };
  }

  close(): void { this.memory.close(); this._knowledge?.close(); this.scheduler.stop(); this._workflowEngine?.stop(); this._telegramPump?.stop(); this._standupPoller?.stop(); this._standupStore?.close(); }
}
