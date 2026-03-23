/**
 * Plist Generator for Nexu Desktop launchd services.
 *
 * Generates launchd plist XML for Controller and OpenClaw services.
 */

import * as os from "node:os";
import * as path from "node:path";
import { SERVICE_LABELS } from "./launchd-manager";

export interface PlistEnv {
  isDev: boolean;
  logDir: string;
  controllerPort: number;
  openclawPort: number;
  /** Path to node binary */
  nodePath: string;
  /** Path to controller entry point */
  controllerEntryPath: string;
  /** Path to openclaw binary */
  openclawPath: string;
  /** OpenClaw config path */
  openclawConfigPath: string;
  /** OpenClaw state directory */
  openclawStateDir: string;
  /** Working directory for controller */
  controllerCwd: string;
  /** Working directory for openclaw */
  openclawCwd: string;
}

/**
 * Generate plist XML for a service.
 */
export function generatePlist(
  service: "controller" | "openclaw",
  env: PlistEnv,
): string {
  const label = SERVICE_LABELS[service](env.isDev);

  if (service === "controller") {
    return generateControllerPlist(label, env);
  }
  return generateOpenclawPlist(label, env);
}

function generateControllerPlist(label: string, env: PlistEnv): string {
  const logPath = path.join(env.logDir, "controller.log");
  const errorPath = path.join(env.logDir, "controller.error.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(env.nodePath)}</string>
        <string>${escapeXml(env.controllerEntryPath)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(env.controllerCwd)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${env.controllerPort}</string>
        <key>NODE_ENV</key>
        <string>${env.isDev ? "development" : "production"}</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(errorPath)}</string>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
}

function generateOpenclawPlist(label: string, env: PlistEnv): string {
  const logPath = path.join(env.logDir, "openclaw.log");
  const errorPath = path.join(env.logDir, "openclaw.error.log");
  const controllerLabel = SERVICE_LABELS.controller(env.isDev);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(env.openclawPath)}</string>
        <string>--config</string>
        <string>${escapeXml(env.openclawConfigPath)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(env.openclawCwd)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCLAW_STATE_DIR</key>
        <string>${escapeXml(env.openclawStateDir)}</string>
        <key>OPENCLAW_LAUNCHD_LABEL</key>
        <string>${label}</string>
        <key>OPENCLAW_SERVICE_MARKER</key>
        <string>launchd</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(errorPath)}</string>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>OtherJobEnabled</key>
        <dict>
            <key>${controllerLabel}</key>
            <true/>
        </dict>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
}

/**
 * Escape special XML characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
