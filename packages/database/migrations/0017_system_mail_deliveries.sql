-- Keep durable rows, grants and referenced relation/index identities intact.
ALTER TABLE "app"."authentication_mail_deliveries" RENAME TO "system_mail_deliveries";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_deliveries_pkey" TO "system_mail_deliveries_pkey";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_active_has_payload" TO "system_mail_active_has_payload";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_attempts_bounded" TO "system_mail_attempts_bounded";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_expiry_after_creation" TO "system_mail_expiry_after_creation";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_lease_complete" TO "system_mail_lease_complete";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_payload_complete" TO "system_mail_payload_complete";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_purpose_valid" TO "system_mail_purpose_valid";
--> statement-breakpoint
ALTER TABLE "app"."system_mail_deliveries" RENAME CONSTRAINT "authentication_mail_status_valid" TO "system_mail_status_valid";
--> statement-breakpoint
ALTER INDEX "app"."authentication_mail_due_idx" RENAME TO "system_mail_due_idx";
--> statement-breakpoint
ALTER INDEX "app"."authentication_mail_retention_idx" RENAME TO "system_mail_retention_idx";
