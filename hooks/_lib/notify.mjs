import { spawn } from "node:child_process";
import { platform } from "node:process";

const fire = (cmd, args) => {
  try {
    const c = spawn(cmd, args, { stdio: "ignore", detached: true });
    c.unref();
    c.on("error", () => {});
  } catch {}
};

const has = async (cmd) => {
  const { spawnSync } = await import("node:child_process");
  const which = platform === "win32" ? "where" : "which";
  return spawnSync(which, [cmd], { stdio: "ignore" }).status === 0;
};

export const notify = async (title, body) => {
  if (platform === "darwin") {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    fire("osascript", ["-e", script]);
    const termApp = process.env.TERM_PROGRAM || "Terminal";
    fire("osascript", ["-e", `tell application ${JSON.stringify(termApp)} to activate`]);
    return;
  }
  if (platform === "linux") {
    if (await has("notify-send")) {
      fire("notify-send", ["-u", "normal", "-i", "dialog-question", title, body]);
    }
    return;
  }
  if (platform === "win32") {
    const ps = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; ` +
      `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
      `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
      `$n.Visible = $true; ` +
      `$n.ShowBalloonTip(5000, ${JSON.stringify(title)}, ${JSON.stringify(body)}, [System.Windows.Forms.ToolTipIcon]::Info)`;
    fire("powershell", ["-NoProfile", "-Command", ps]);
  }
};
