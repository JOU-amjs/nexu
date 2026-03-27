import { join } from "node:path";

import { devLogsPath, devTmpPath, repoRootPath } from "@nexu/dev-utils";

export const scriptsDevPath = join(repoRootPath, "scripts", "dev");
export const scriptsDevSourcePath = join(scriptsDevPath, "src");

export const controllerWorkingDirectoryPath = join(
  repoRootPath,
  "apps",
  "controller",
);
export const webWorkingDirectoryPath = join(repoRootPath, "apps", "web");
export const openclawWorkingDirectoryPath = repoRootPath;

export const controllerSupervisorPath = join(
  scriptsDevSourcePath,
  "supervisors",
  "controller.ts",
);
export const webSupervisorPath = join(
  scriptsDevSourcePath,
  "supervisors",
  "web.ts",
);
export const openclawSupervisorPath = join(
  scriptsDevSourcePath,
  "supervisors",
  "openclaw.ts",
);
export const controllerSourceDirectoryPath = join(
  controllerWorkingDirectoryPath,
  "src",
);

export const controllerDevLockPath = join(devTmpPath, "controller.pid");
export const webDevLockPath = join(devTmpPath, "web.pid");
export const openclawDevLockPath = join(devTmpPath, "openclaw.pid");

export function getControllerDevLogPath(runId: string): string {
  return join(devLogsPath, runId, "controller.log");
}

export function getWebDevLogPath(runId: string): string {
  return join(devLogsPath, runId, "web.log");
}

export function getOpenclawDevLogPath(runId: string): string {
  return join(devLogsPath, runId, "openclaw.log");
}
