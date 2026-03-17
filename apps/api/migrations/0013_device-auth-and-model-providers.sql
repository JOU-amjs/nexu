ALTER TABLE "desktop_device_authorizations" RENAME TO "device_authorizations";--> statement-breakpoint
ALTER INDEX "desktop_device_auth_device_id_idx" RENAME TO "device_auth_device_id_idx";--> statement-breakpoint
ALTER INDEX "desktop_device_auth_status_idx" RENAME TO "device_auth_status_idx";
