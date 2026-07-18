import type { RuntimeOs } from "./platform";

export type ServiceBackend = "launchd" | "systemd-user" | "windows-scheduled-task" | "foreground" | "unsupported";
export interface ServicePlan {
  backend: ServiceBackend;
  supported: boolean;
  dryRun: true;
  command?: { executable: string; args: string[] };
  losses: string[];
}
export interface PulseCapability {
  mode: "service" | "foreground" | "unsupported";
  healthUri?: string;
  audio: boolean;
  notifications: boolean;
  evidenceRequired: string[];
}

export function planService(input: { os: RuntimeOs; headless: boolean; managers: readonly string[]; unitName?: string }): ServicePlan {
  const unit = input.unitName ?? "lifeos-pulse";
  if (input.os === "darwin" && input.managers.includes("launchd")) return { backend: "launchd", supported: true, dryRun: true, command: { executable: "launchctl", args: ["bootstrap", "gui/$UID", `${unit}.plist`] }, losses: [] };
  if (input.os === "linux" && input.managers.includes("systemd-user")) return { backend: "systemd-user", supported: true, dryRun: true, command: { executable: "systemctl", args: ["--user", "enable", "--now", `${unit}.service`] }, losses: [] };
  if (input.os === "win32" && input.managers.includes("scheduled-task")) return { backend: "windows-scheduled-task", supported: true, dryRun: true, command: { executable: "schtasks.exe", args: ["/Create", "/TN", unit] }, losses: ["desktop session behavior requires native smoke evidence"] };
  if (input.os === "darwin" || input.os === "linux" || input.os === "win32") return { backend: "foreground", supported: true, dryRun: true, losses: ["no autostart; process must be supervised externally"] };
  return { backend: "unsupported", supported: false, dryRun: true, losses: ["no supported service or foreground platform"] };
}

export function pulseCapability(plan: ServicePlan, input: { healthUri?: string; audioObserved?: boolean; notificationsObserved?: boolean }): PulseCapability {
  return {
    mode: plan.backend === "unsupported" ? "unsupported" : plan.backend === "foreground" ? "foreground" : "service",
    healthUri: input.healthUri,
    audio: input.audioObserved === true,
    notifications: input.notificationsObserved === true,
    evidenceRequired: [
      ...(input.audioObserved ? [] : ["audio smoke evidence"]),
      ...(input.notificationsObserved ? [] : ["notification smoke evidence"]),
    ],
  };
}

export function renderStatusline(input: { adapterId: string; certification: string; degraded?: readonly string[]; sessionId?: string }): string {
  const degraded = input.degraded?.length ? ` degraded:${input.degraded.join(",")}` : "";
  const session = input.sessionId ? ` session:${input.sessionId}` : "";
  return `LifeOS | ${input.adapterId} ${input.certification}${degraded}${session}`;
}
