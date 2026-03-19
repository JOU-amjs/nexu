import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

const minimalSkillSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  downloads: z.number(),
  stars: z.number(),
  tags: z.array(z.string()),
  version: z.string(),
  updatedAt: z.string(),
  homepage: z.string(),
});

const catalogMetaSchema = z.object({
  version: z.string(),
  updatedAt: z.string(),
  skillCount: z.number(),
});

const skillhubCatalogResponseSchema = z.object({
  skills: z.array(minimalSkillSchema),
  installedSlugs: z.array(z.string()),
  meta: catalogMetaSchema.nullable(),
});

const skillhubMutationResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
const skillhubRefreshResultSchema = z.object({
  ok: z.boolean(),
  skillCount: z.number(),
  error: z.string().optional(),
});
const skillhubDetailResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  downloads: z.number(),
  stars: z.number(),
  tags: z.array(z.string()),
  version: z.string(),
  updatedAt: z.string(),
  homepage: z.string(),
  installed: z.boolean(),
  skillContent: z.string().nullable(),
  files: z.array(z.string()),
});

const skillhubSlugSchema = z.string().min(1);

/**
 * SkillHub routes — cloud-ready stubs.
 *
 * In desktop mode, the Electron main process owns SkillHub operations via IPC:
 *   - CatalogManager (apps/desktop/main/skillhub/catalog-manager.ts) syncs the
 *     Tencent SkillHub catalog, runs `clawhub install/uninstall`, and manages
 *     curated skill lifecycle.
 *   - SkillDb (apps/desktop/main/skillhub/skill-db.ts) persists install/uninstall
 *     intent in SQLite, surviving directory wipes and app restarts.
 *   - The web layer calls IPC directly (window.nexuHost.invoke("skillhub:*"))
 *     and never hits these HTTP routes.
 *
 * These controller routes exist so the OpenAPI spec stays complete and the
 * generated web SDK compiles. They return locally-known skill state from the
 * controller's config store, which is sufficient for non-desktop (cloud)
 * deployments once a real SkillHub backend is wired in.
 *
 * TODO(cloud): Replace stub bodies with real SkillHub API integration —
 *   catalog fetch from remote registry, clawhub-based install/uninstall,
 *   and persistent install-state tracking.
 */
export function registerSkillhubRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  // GET /api/v1/skillhub/catalog
  // Desktop: bypassed (IPC → CatalogManager.getCatalog)
  // Cloud:   returns locally-known skills from controller config store
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/skillhub/catalog",
      tags: ["SkillHub"],
      responses: {
        200: {
          content: {
            "application/json": { schema: skillhubCatalogResponseSchema },
          },
          description: "SkillHub catalog",
        },
      },
    }),
    async (c) => {
      const skills = await container.skillService.getSkills();
      const installedSlugs = Object.entries(skills.items)
        .filter(([, item]) => item.enabled)
        .map(([slug]) => slug);
      return c.json(
        {
          skills: installedSlugs.map((slug) => ({
            slug,
            name: slug,
            description: "Local controller-managed skill",
            downloads: 0,
            stars: 0,
            tags: [],
            version: "1.0.0",
            updatedAt: new Date().toISOString(),
            homepage: "https://nexu.io",
          })),
          installedSlugs,
          meta: {
            version: "local",
            updatedAt: new Date().toISOString(),
            skillCount: installedSlugs.length,
          },
        },
        200,
      );
    },
  );

  // POST /api/v1/skillhub/install + /uninstall
  // Desktop: bypassed (IPC → CatalogManager.installSkill / uninstallSkill)
  // Cloud:   no-op stubs — TODO(cloud): wire real clawhub install/uninstall
  for (const [pathName, description] of [
    ["/api/v1/skillhub/install", "Install"],
    ["/api/v1/skillhub/uninstall", "Uninstall"],
  ] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: pathName,
        tags: ["SkillHub"],
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({ slug: skillhubSlugSchema }),
              },
            },
          },
        },
        responses: {
          200: {
            content: {
              "application/json": { schema: skillhubMutationResultSchema },
            },
            description,
          },
        },
      }),
      async (c) => {
        c.req.valid("json");
        return c.json({ ok: true }, 200);
      },
    );
  }

  // POST /api/v1/skillhub/refresh
  // Desktop: bypassed (IPC → CatalogManager.refreshCatalog)
  // Cloud:   returns current skill count from config store
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/skillhub/refresh",
      tags: ["SkillHub"],
      responses: {
        200: {
          content: {
            "application/json": { schema: skillhubRefreshResultSchema },
          },
          description: "Refresh",
        },
      },
    }),
    async (c) => {
      const skills = await container.skillService.getSkills();
      return c.json(
        { ok: true, skillCount: Object.keys(skills.items).length },
        200,
      );
    },
  );

  // GET /api/v1/skillhub/skills/{slug}
  // Desktop: bypassed (IPC → CatalogManager.getCatalog, detail resolved client-side)
  // Cloud:   returns skill detail from controller config store
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/skillhub/skills/{slug}",
      tags: ["SkillHub"],
      request: { params: z.object({ slug: skillhubSlugSchema }) },
      responses: {
        200: {
          content: {
            "application/json": { schema: skillhubDetailResponseSchema },
          },
          description: "Skill detail",
        },
        404: {
          content: {
            "application/json": { schema: z.object({ message: z.string() }) },
          },
          description: "Not found",
        },
      },
    }),
    async (c) => {
      const { slug } = c.req.valid("param");
      const skills = await container.skillService.getSkills();
      const skill = skills.items[slug];
      if (!skill) {
        return c.json({ message: "Skill not found" }, 404);
      }
      return c.json(
        {
          slug,
          name: slug,
          description: skill.metadata.description ?? "",
          downloads: 0,
          stars: 0,
          tags: skill.metadata.tags ?? [],
          version: "1.0.0",
          updatedAt: new Date().toISOString(),
          homepage: "https://nexu.io",
          installed: skill.enabled,
          skillContent: skill.content,
          files: Object.keys(skill.files),
        },
        200,
      );
    },
  );
}
