-- `artef login` (§7.2) redirects the browser to a loopback listener on the
-- user's own machine. Sending the machine token in that redirect would write a
-- long-lived credential into browser history, the referrer header of anything
-- the callback page loads, and every proxy log on the way — so the redirect
-- carries a one-time code instead, and the CLI trades it for the token over a
-- direct POST. The token sits here in plaintext for the sixty seconds between
-- approval and collection: it has to, because a hash cannot be handed back. In
-- exchange, `machine_tokens` is only written when the code is actually spent,
-- so an approval nobody collected leaves no usable credential anywhere.
CREATE TABLE "cli_auth_codes" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cli_auth_codes" ADD CONSTRAINT "cli_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_codes" ADD CONSTRAINT "cli_auth_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;