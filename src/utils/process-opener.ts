import { spawn } from "node:child_process";

export async function openPlatformBrowser(url: string): Promise<boolean> {
  if (typeof url !== "string" || !url.startsWith("https://accounts.google.com/")) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let command: string;
    let args: string[];

    if (process.platform === "win32") {
      command = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
