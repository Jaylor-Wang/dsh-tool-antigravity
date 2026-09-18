import { spawn } from "node:child_process";

const AUTHORIZATION_HOST = "accounts.google.com";

export function isAntigravityAuthorizationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === AUTHORIZATION_HOST &&
      parsed.pathname.startsWith("/o/oauth2/")
    );
  } catch {
    return false;
  }
}

export async function openPlatformBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (!isAntigravityAuthorizationUrl(url)) {
    return false;
  }

  let command: string;
  let args: string[];
  let windowsVerbatimArguments = false;

  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", '""', `"${url}"`];
    windowsVerbatimArguments = true;
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
